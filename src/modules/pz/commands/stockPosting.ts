import { LockMode } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import {
  registerCommand,
  type CommandHandler,
  type CommandRuntimeContext,
} from '@open-mercato/shared/lib/commands'
import { CommandBus } from '@open-mercato/shared/lib/commands/command-bus'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import { assertFound, badRequest, conflict, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { GoodsReceipt, type StockPostingFailureReason } from '../data/entities'
import { loadWarehouseDestinations } from '../lib/destinations'
import { loadCountedLines } from '../lib/receivingConfirmation'
import { aggregatePostableQuantities, type PostableQuantity } from '../lib/stockPosting'
import type { TranslateFn } from '../lib/goodsReceiptInput'
import { quantityToNumber } from '../lib/quantity'
import {
  GOODS_RECEIPT_ENTITY_ID,
  goodsReceiptCrudEvents,
  goodsReceiptCrudIndexer,
  type GoodsReceiptScope,
} from './goodsReceipts'

const logger = createLogger('pz').child({ component: 'stock-posting' })

/**
 * The reference every movement of one delivery carries. `manual` is the closest thing the
 * installed movement reference enum has to "a goods receipt somebody typed in", and it is
 * what ADR-0005 named when it left this seam open.
 */
export const STOCK_POSTING_REFERENCE_TYPE = 'manual' as const

export type StockPostingResult = {
  id: string
  status: 'posted' | 'failed'
  /** Movements this run asked `wms` for; a replayed one is counted here as well. */
  posted: number
  reason: StockPostingFailureReason | null
}

/**
 * Posts one confirmed delivery's counted goods into `wms` stock.
 *
 * It is dispatched by the `pz.goods_receipt.confirmed` subscriber and, after a failure, by
 * the office's retry action — the same command both times, so a retry cannot post anything
 * a first attempt would not have.
 *
 * Why a retry is safe: the movement idempotency key `wms` builds covers the reference, the
 * warehouse, the location, the variant and the quantity, and every one of those is fixed
 * once the document is confirmed. A replay therefore matches the movement it already wrote
 * and changes nothing, so only the variants that never landed are posted (ADR-0011).
 *
 * The document row is locked for the whole run. That holds a transaction open across the
 * `wms` writes, which is normally the wrong shape — it is deliberate here, because it is
 * what makes two concurrent retries impossible, and a crashed process releases the lock
 * rather than leaving a document stuck mid-posting. The `wms` commands run in their own
 * transactions against their own tables, so neither waits on the other.
 */
const postStockCommand: CommandHandler<Record<string, unknown>, StockPostingResult> = {
  id: 'pz.goodsReceipts.postStock',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const input = parseInput(rawInput, translate)
    const scope = resolvePostingScope(ctx, input, translate)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    let receipt!: GoodsReceipt
    let outcome: StockPostingResult = { id: input.id, status: 'posted', posted: 0, reason: null }

    await runCrudCommandWrite<GoodsReceipt>({
      ctx,
      em,
      entityId: GOODS_RECEIPT_ENTITY_ID,
      action: 'updated',
      scope,
      events: goodsReceiptCrudEvents,
      indexer: goodsReceiptCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: tx }) => {
          receipt = assertFound(
            await tx.findOne(
              GoodsReceipt,
              {
                id: input.id,
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
                deletedAt: null,
              } as FilterQuery<GoodsReceipt>,
              { lockMode: LockMode.PESSIMISTIC_WRITE },
            ),
            translate('pz.goodsReceipts.errors.notFound', 'That goods receipt no longer exists.'),
          )
          if (receipt.status !== 'confirmed') {
            throw conflict(
              translate(
                'pz.receiving.errors.postingNotConfirmed',
                'Only a confirmed goods receipt has stock to post.',
              ),
            )
          }
          if (receipt.stockPostingStatus !== 'pending' && receipt.stockPostingStatus !== 'failed') {
            throw conflict(
              translate('pz.receiving.errors.postingNotPending', 'This delivery has nothing left to post.'),
            )
          }
          if (input.destinationLocationId) {
            await repinDestination(ctx, scope, receipt, input.destinationLocationId, translate)
          }
        },
        async ({ em: tx }) => {
          outcome = await postCountedGoods(ctx, tx, scope, receipt)
          receipt.stockPostingStatus = outcome.status
          receipt.stockPostedAt = outcome.status === 'posted' ? new Date() : null
          receipt.stockPostingError = outcome.reason
          receipt.updatedAt = new Date()
          tx.persist(receipt)
        },
      ],
      sideEffect: () => ({
        entity: receipt,
        identifiers: { id: input.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    return outcome
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('pz.audit.goodsReceipts.postStock', 'Post goods receipt stock'),
      resourceKind: 'pz.goods_receipt',
      resourceId: result.id,
    }
  },
}

type StockPostingInput = {
  id: string
  tenantId: string | null
  organizationId: string | null
  destinationLocationId: string | null
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function parseInput(raw: unknown, translate: TranslateFn): StockPostingInput {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const id = readString(source, 'id')
  if (!id) {
    throw badRequest(translate('pz.goodsReceipts.errors.idRequired', 'A goods receipt identifier is required.'))
  }
  return {
    id,
    tenantId: readString(source, 'tenantId'),
    organizationId: readString(source, 'organizationId'),
    destinationLocationId: readString(source, 'destinationLocationId'),
  }
}

/**
 * Scope for a command with two very different callers.
 *
 * A request carries an authenticated actor, and that actor's scope is the only one allowed —
 * an id in the payload can never widen it. A subscriber carries no actor at all, so the
 * scope comes from the event this module emitted about its own record; the locked read below
 * then only finds the document if that scope really owns it.
 */
function resolvePostingScope(
  ctx: CommandRuntimeContext,
  input: StockPostingInput,
  translate: TranslateFn,
): GoodsReceiptScope {
  const actorTenantId = ctx.auth?.tenantId ?? null
  const actorOrganizationId = ctx.selectedOrganizationId ?? ctx.organizationScope?.selectedId ?? null
  const tenantId = actorTenantId ?? input.tenantId
  const organizationId = actorOrganizationId ?? input.organizationId
  if (!tenantId || !organizationId) {
    throw badRequest(translate('pz.goodsReceipts.errors.tenantRequired', 'Tenant context is required.'))
  }
  return { tenantId, organizationId }
}

/**
 * Moving the pinned destination before a retry.
 *
 * Allowed only while nothing has posted. Once a movement exists, the pinned location is part
 * of the key that makes a replay a no-op: re-pinning would give every already-posted variant
 * a new key, and the retry would stock the delivery a second time (ADR-0011). Whether
 * anything posted is read under the document's lock, so a posting in flight cannot slip
 * between the check and the change.
 */
async function repinDestination(
  ctx: CommandRuntimeContext,
  scope: GoodsReceiptScope,
  receipt: GoodsReceipt,
  destinationLocationId: string,
  translate: TranslateFn,
): Promise<void> {
  if (receipt.stockPostingLocationId === destinationLocationId) return

  const queryEngine = ctx.container.resolve<QueryEngine>('queryEngine')
  if (await hasPostedMovements(queryEngine, scope, String(receipt.id))) {
    throw conflict(
      translate(
        'pz.receiving.errors.destinationPinned',
        'Part of this delivery has already been posted, so its destination can no longer be changed.',
      ),
    )
  }

  const destinations = await loadWarehouseDestinations(queryEngine, scope, receipt.warehouseId)
  if (!destinations.some((destination) => destination.id === destinationLocationId)) {
    throw conflict(
      translate('pz.receiving.errors.destinationInvalid', 'That destination is not a location of this warehouse.'),
    )
  }
  receipt.stockPostingLocationId = destinationLocationId
}

type MovementRow = { id: string }

async function hasPostedMovements(
  queryEngine: QueryEngine,
  scope: GoodsReceiptScope,
  goodsReceiptId: string,
): Promise<boolean> {
  const result = await queryEngine.query<MovementRow>(E.wms.inventory_movement, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['id'],
    filters: { reference_type: STOCK_POSTING_REFERENCE_TYPE, reference_id: goodsReceiptId },
    page: { page: 1, pageSize: 1 },
  })
  return result.items.length > 0
}

/**
 * One `wms.inventory.receive` per counted variant.
 *
 * A refusal `wms` states — an unusable location, a variant it will not receive without a lot
 * — is terminal: retrying it unchanged would fail the same way, so it is recorded as a
 * failure the office can see and act on. Anything else is treated as transient and rethrown,
 * which leaves the posting pending and lets the durable event queue try again.
 */
async function postCountedGoods(
  ctx: CommandRuntimeContext,
  em: EntityManager,
  scope: GoodsReceiptScope,
  receipt: GoodsReceipt,
): Promise<StockPostingResult> {
  const id = String(receipt.id)
  const destinationLocationId = receipt.stockPostingLocationId
  const performedBy = receipt.confirmedBy ?? (typeof ctx.auth?.sub === 'string' ? ctx.auth.sub : null)
  const postable = aggregatePostableQuantities(await loadCountedLines(em, scope, id))

  if (postable.length === 0) return { id, status: 'posted', posted: 0, reason: null }
  if (!destinationLocationId || !performedBy) {
    logger.error('Goods receipt stock posting is missing what the movement needs', {
      goodsReceiptId: id,
      hasDestination: Boolean(destinationLocationId),
      hasPerformer: Boolean(performedBy),
    })
    return { id, status: 'failed', posted: 0, reason: 'destination_unusable' }
  }

  const commandBus = ctx.container.resolve<CommandBus>('commandBus')
  let posted = 0
  for (const entry of postable) {
    try {
      await commandBus.execute('wms.inventory.receive', {
        input: buildReceiveInput(receipt, scope, destinationLocationId, performedBy, entry),
        ctx: buildWmsContext(ctx, scope),
      })
      posted += 1
    } catch (error) {
      const reason = terminalFailureReason(error)
      if (!reason) throw error
      logger.error('Goods receipt stock posting was refused', {
        err: error,
        goodsReceiptId: id,
        catalogVariantId: entry.catalogVariantId,
        reason,
      })
      return { id, status: 'failed', posted, reason }
    }
  }
  return { id, status: 'posted', posted, reason: null }
}

function buildReceiveInput(
  receipt: GoodsReceipt,
  scope: GoodsReceiptScope,
  locationId: string,
  performedBy: string,
  entry: PostableQuantity,
): Record<string, unknown> {
  return {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    warehouseId: receipt.warehouseId,
    locationId,
    catalogVariantId: entry.catalogVariantId,
    quantity: quantityToNumber(entry.quantity),
    referenceType: STOCK_POSTING_REFERENCE_TYPE,
    referenceId: String(receipt.id),
    performedBy,
    // The delivery's own date, not the moment the queue got round to it: a movement dated by
    // worker latency would make the stock ledger disagree with the paperwork.
    receivedAt: receipt.confirmedAt ?? undefined,
    metadata: {
      source: 'pz.goods_receipt',
      goodsReceiptId: String(receipt.id),
      documentNumber: receipt.documentNumber,
    },
  }
}

/**
 * The shape the installed inventory commands expect from an automation: no actor, and the
 * organization stated explicitly. Their own guards compare the ids in the input against it.
 */
function buildWmsContext(ctx: CommandRuntimeContext, scope: GoodsReceiptScope): CommandRuntimeContext {
  return {
    container: ctx.container,
    auth: null,
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  }
}

function terminalFailureReason(error: unknown): StockPostingFailureReason | null {
  if (!isCrudHttpError(error)) return null
  const code = typeof error.body?.error === 'string' ? error.body.error : ''
  if (code === 'lot_required' || code === 'serial_required') return 'variant_tracking_required'
  if (code === 'invalid_location') return 'destination_unusable'
  // Every other refusal `wms` states is still a refusal: repeating it unchanged would be
  // refused again, so it is recorded rather than retried forever.
  return error.status >= 400 && error.status < 500 ? 'posting_rejected' : null
}

registerCommand(postStockCommand)

export default postStockCommand
