import { LockMode } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import {
  registerCommand,
  type CommandHandler,
  type CommandRuntimeContext,
} from '@open-mercato/shared/lib/commands'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import {
  CrudHttpError,
  assertFound,
  badRequest,
  conflict,
  isCrudHttpError,
  isUniqueViolation,
} from '@open-mercato/shared/lib/crud/errors'
import {
  assertOptimisticLock,
  readOptimisticLockExpected,
} from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { Pallet, PalletLine, type PalletLineCatalogSnapshot } from '../data/entities'
import { toCountedVariant, type CountedVariant } from '../lib/barcodeResolution'
import { normalizeQuantity, QUANTITY_SCALE, type TranslateFn } from '../lib/goodsReceiptInput'
import { ensureGoodsReceiptScope, type GoodsReceiptScope } from './goodsReceipts'

export const PALLET_LINE_ENTITY_ID = E.pz.pallet_line
export const PALLET_LINE_UNIQUE_INDEX = 'pz_pallet_lines_pallet_variant_unique_idx'

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/

export type SerializedPalletLine = {
  id: string
  palletId: string
  tenantId: string
  organizationId: string
  catalogVariantId: string
  catalogProductId: string
  catalogSnapshot: PalletLineCatalogSnapshot | null
  quantity: string
  createdAt: string
  updatedAt: string
}

export function serializePalletLine(line: PalletLine): SerializedPalletLine {
  return {
    id: String(line.id),
    palletId: String(line.pallet.id),
    tenantId: line.tenantId,
    organizationId: line.organizationId,
    catalogVariantId: line.catalogVariantId,
    catalogProductId: line.catalogProductId,
    catalogSnapshot: line.catalogSnapshot ?? null,
    quantity: line.quantity,
    createdAt: line.createdAt.toISOString(),
    updatedAt: line.updatedAt.toISOString(),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * The CRUD factory hands a create or update the body itself but a delete `{ body, query }`,
 * so every id is looked for in all three places rather than once per command.
 */
function requirePalletLineId(raw: unknown, translate: TranslateFn): string {
  const source = asRecord(raw)
  const id = [source.id, asRecord(source.body).id, asRecord(source.query).id].find(
    (value) => typeof value === 'string' && UUID.test(value),
  )
  if (typeof id !== 'string') {
    throw badRequest(translate('pz.palletLines.errors.idRequired', 'A pallet line identifier is required.'))
  }
  return id
}

function requireUuid(value: unknown, message: string): string {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (!UUID.test(candidate)) throw badRequest(message)
  return candidate
}

function requireQuantity(value: unknown, translate: TranslateFn): string {
  const quantity = normalizeQuantity(value)
  if (quantity === null) {
    throw badRequest(translate('pz.palletLines.errors.quantityInvalid', 'Quantity must be greater than zero.'))
  }
  return quantity
}

/**
 * Same reasoning as the goods receipt itself: the installed lock helper is a no-op when the
 * caller sends no version, and a correction issued without one would silently win over
 * whatever the other person counted, so a version is required here rather than optional.
 */
function requireExpectedVersion(ctx: CommandRuntimeContext, translate: TranslateFn): string {
  const expected = readOptimisticLockExpected(ctx.request ?? null)
  const parsed = expected ? new Date(expected) : null
  if (!expected || !parsed || Number.isNaN(parsed.getTime())) {
    throw badRequest(
      translate(
        'pz.palletLines.errors.versionRequired',
        'Send the record version you are working from in the optimistic-lock header.',
      ),
    )
  }
  return expected
}

/**
 * The structured conflict body is what the shared conflict bar reads, so its code and both
 * timestamps are preserved; only the sentence is replaced, because the floor needs to be
 * told that the number moved under them rather than that a version did not match.
 */
function assertPalletLineVersion(id: string, expected: string, current: Date, translate: TranslateFn): void {
  try {
    assertOptimisticLock({
      resourceKind: PALLET_LINE_ENTITY_ID,
      resourceId: id,
      expected,
      current,
    })
  } catch (error) {
    if (isCrudHttpError(error) && error.status === 409) {
      throw new CrudHttpError(409, {
        ...error.body,
        error: translate(
          'pz.palletLines.errors.stale',
          'Somebody counted onto this product while you were correcting it.',
        ),
      })
    }
    throw error
  }
}

/** Both operands are canonical decimal strings at the column's scale, so the sum is exact. */
function addQuantities(left: string, right: string): string {
  const total = toScaledInteger(left) + toScaledInteger(right)
  const digits = total.toString().padStart(QUANTITY_SCALE + 1, '0')
  return `${digits.slice(0, -QUANTITY_SCALE)}.${digits.slice(-QUANTITY_SCALE)}`
}

function toScaledInteger(value: string): bigint {
  const [integer = '0', fraction = ''] = value.split('.')
  return BigInt(`${integer}${fraction.padEnd(QUANTITY_SCALE, '0').slice(0, QUANTITY_SCALE)}`)
}

/**
 * Holds the Pallet until the transaction commits, so the two things a count has to agree on
 * — the pallet is open and its document is still being counted — cannot stop being true
 * between the check and the write. It also serialises two scanners on one pallet, which is
 * what makes accumulating into one row safe.
 */
async function lockPalletForCount(
  em: EntityManager,
  scope: GoodsReceiptScope,
  palletId: string,
  translate: TranslateFn,
): Promise<Pallet> {
  const pallet = assertFound(
    await em.findOne(
      Pallet,
      { id: palletId, tenantId: scope.tenantId, organizationId: scope.organizationId } as FilterQuery<Pallet>,
      { lockMode: LockMode.PESSIMISTIC_WRITE, populate: ['goodsReceipt'] },
    ),
    translate('pz.pallets.errors.notFound', 'That pallet no longer exists.'),
  )
  if (pallet.goodsReceipt.status !== 'receiving') {
    throw conflict(
      translate('pz.goodsReceipts.errors.notReceiving', 'This goods receipt has not been released to the floor.'),
    )
  }
  requireOpenPallet(pallet, translate)
  return pallet
}

export function requireOpenPallet(pallet: Pallet, translate: TranslateFn): void {
  if (pallet.status !== 'open') {
    throw conflict(
      translate(
        'pz.palletLines.errors.palletClosed',
        'This pallet is closed, so nothing can be counted onto it. Reopen it first.',
      ),
    )
  }
}

async function lockPalletLineForWrite(
  em: EntityManager,
  scope: GoodsReceiptScope,
  id: string,
  translate: TranslateFn,
): Promise<PalletLine> {
  const line = assertFound(
    await em.findOne(
      PalletLine,
      { id, tenantId: scope.tenantId, organizationId: scope.organizationId } as FilterQuery<PalletLine>,
      { lockMode: LockMode.PESSIMISTIC_WRITE, populate: ['pallet'] },
    ),
    translate('pz.palletLines.errors.notFound', 'That counted product is no longer on this pallet.'),
  )
  requireOpenPallet(line.pallet, translate)
  return line
}

type VariantRow = {
  id: string
  product_id: string
  name: string | null
  sku: string | null
  barcode: string | null
}

type ProductRow = { id: string; title: string | null }

/**
 * The snapshot is taken from the catalog rather than from the client: what is counted onto a
 * pallet must be a product this caller may actually see, and its name must be the one the
 * catalog held at that moment (ADR-0007).
 */
export async function resolveCountedVariant(
  ctx: CommandRuntimeContext,
  scope: GoodsReceiptScope,
  catalogVariantId: string,
  translate: TranslateFn,
): Promise<CountedVariant> {
  const queryEngine = ctx.container.resolve<QueryEngine>('queryEngine')
  const variants = await queryEngine.query<VariantRow>(E.catalog.catalog_product_variant, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['id', 'product_id', 'name', 'sku', 'barcode'],
    filters: { id: catalogVariantId },
    page: { page: 1, pageSize: 1 },
  })
  const variant = variants.items[0]
  if (!variant) {
    throw badRequest(
      translate('pz.palletLines.errors.variantUnavailable', 'That product is no longer available in the catalog.'),
    )
  }
  const products = await queryEngine.query<ProductRow>(E.catalog.catalog_product, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['id', 'title'],
    filters: { id: String(variant.product_id) },
    page: { page: 1, pageSize: 1 },
  })
  return toCountedVariant(variant, products.items[0]?.title ?? null, variant.barcode ?? '')
}

async function findLineForVariant(
  em: EntityManager,
  scope: GoodsReceiptScope,
  pallet: Pallet,
  catalogVariantId: string,
): Promise<PalletLine | null> {
  return em.findOne(PalletLine, {
    pallet,
    catalogVariantId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  } as FilterQuery<PalletLine>)
}

type CountInput = { palletId: string; catalogVariantId: string; quantity: string }

function parseCountInput(raw: unknown, translate: TranslateFn): CountInput {
  const source = asRecord(raw)
  return {
    palletId: requireUuid(
      source.palletId,
      translate('pz.pallets.errors.idRequired', 'A pallet identifier is required.'),
    ),
    catalogVariantId: requireUuid(
      source.catalogVariantId,
      translate('pz.palletLines.errors.variantRequired', 'Choose a product to count.'),
    ),
    quantity: requireQuantity(source.quantity, translate),
  }
}

async function runCountAttempt(
  ctx: CommandRuntimeContext,
  scope: GoodsReceiptScope,
  input: CountInput,
  variant: CountedVariant,
  translate: TranslateFn,
): Promise<PalletLine> {
  const em = (ctx.container.resolve('em') as EntityManager).fork()
  let line!: PalletLine

  await runCrudCommandWrite<PalletLine>({
    ctx,
    em,
    entityId: PALLET_LINE_ENTITY_ID,
    action: 'updated',
    scope,
    syncOrigin: ctx.syncOrigin,
    phases: [
      async ({ em: tx }) => {
        const pallet = await lockPalletForCount(tx, scope, input.palletId, translate)
        const existing = await findLineForVariant(tx, scope, pallet, input.catalogVariantId)
        const now = new Date()
        if (existing) {
          existing.quantity = addQuantities(existing.quantity, input.quantity)
          existing.updatedAt = now
          line = existing
        } else {
          line = tx.create(PalletLine, {
            pallet,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            catalogVariantId: variant.catalogVariantId,
            catalogProductId: variant.catalogProductId,
            catalogSnapshot: { name: variant.name, sku: variant.sku },
            quantity: input.quantity,
            createdAt: now,
            updatedAt: now,
          })
        }
        tx.persist(line)
      },
    ],
    sideEffect: () => ({
      entity: line,
      identifiers: { id: String(line.id), tenantId: scope.tenantId, organizationId: scope.organizationId },
    }),
  })

  return line
}

/**
 * Counting adds rather than replaces: two identical scans legitimately mean two items, so a
 * count is idempotent per request and never per barcode.
 *
 * The pallet lock already serialises two scanners on the same pallet, but the unique index
 * is the actual guarantee of one row per (pallet, variant) — a first scan that loses the
 * race to it is retried, and lands as an add onto the row the winner created.
 */
const countPalletLineCommand: CommandHandler<Record<string, unknown>, PalletLine> = {
  id: 'pz.palletLines.count',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const input = parseCountInput(rawInput, translate)
    const variant = await resolveCountedVariant(ctx, scope, input.catalogVariantId, translate)

    try {
      return await runCountAttempt(ctx, scope, input, variant, translate)
    } catch (error) {
      if (!isUniqueViolation(error, PALLET_LINE_UNIQUE_INDEX)) throw error
      return runCountAttempt(ctx, scope, input, variant, translate)
    }
  },
  captureAfter: (_input, result) => serializePalletLine(result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('pz.audit.palletLines.count', 'Count goods onto a pallet'),
      resourceKind: 'pz.pallet_line',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: snapshots.after as SerializedPalletLine,
    }
  },
}

/**
 * Correcting replaces the number, because the floor corrects a miscount by writing down what
 * is actually there rather than by working out a delta.
 */
const updatePalletLineCommand: CommandHandler<Record<string, unknown>, PalletLine> = {
  id: 'pz.palletLines.update',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const id = requirePalletLineId(rawInput, translate)
    const quantity = requireQuantity(asRecord(rawInput).quantity, translate)
    const expectedVersion = requireExpectedVersion(ctx, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let line!: PalletLine

    await runCrudCommandWrite<PalletLine>({
      ctx,
      em,
      entityId: PALLET_LINE_ENTITY_ID,
      action: 'updated',
      scope,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: tx }) => {
          line = await lockPalletLineForWrite(tx, scope, id, translate)
          assertPalletLineVersion(id, expectedVersion, line.updatedAt, translate)
          line.quantity = quantity
          line.updatedAt = new Date()
          tx.persist(line)
        },
      ],
      sideEffect: () => ({
        entity: line,
        identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    return line
  },
  captureAfter: (_input, result) => serializePalletLine(result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('pz.audit.palletLines.update', 'Correct a counted quantity'),
      resourceKind: 'pz.pallet_line',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: snapshots.after as SerializedPalletLine,
    }
  },
}

/**
 * Hard delete: a pallet line asserts that this product is on this pallet, so removing the
 * product removes the row. A quantity of zero would assert presence and absence at once.
 */
const deletePalletLineCommand: CommandHandler<Record<string, unknown>, SerializedPalletLine> = {
  id: 'pz.palletLines.delete',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const id = requirePalletLineId(rawInput, translate)
    const expectedVersion = requireExpectedVersion(ctx, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let removed!: SerializedPalletLine

    await runCrudCommandWrite<SerializedPalletLine>({
      ctx,
      em,
      entityId: PALLET_LINE_ENTITY_ID,
      action: 'deleted',
      scope,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: tx }) => {
          const line = await lockPalletLineForWrite(tx, scope, id, translate)
          assertPalletLineVersion(id, expectedVersion, line.updatedAt, translate)
          removed = serializePalletLine(line)
          tx.remove(line)
        },
      ],
      sideEffect: () => ({
        entity: removed,
        identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    return removed
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('pz.audit.palletLines.delete', 'Remove a counted product'),
      resourceKind: 'pz.pallet_line',
      resourceId: result.id,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotBefore: result,
    }
  },
}

registerCommand(countPalletLineCommand)
registerCommand(updatePalletLineCommand)
registerCommand(deletePalletLineCommand)
