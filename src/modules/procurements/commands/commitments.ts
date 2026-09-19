import { randomUUID } from 'node:crypto'
import { LockMode } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import {
  registerCommand,
  type CommandHandler,
  type CommandRuntimeContext,
} from '@open-mercato/shared/lib/commands'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { badRequest, conflict } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import {
  PurchaseOrder,
  PurchaseOrderCommitment,
  PurchaseOrderLine,
  type PurchaseOrderCommitmentSource,
  type PurchaseOrderCommitmentSourceSnapshot,
} from '../data/entities'
import {
  announcementLimit,
  checkReservations,
  type AnnouncementLimit,
  type ReservationRefusal,
} from '../lib/announcementLimit'
import { compareDecimal, QUANTITY_SCALE } from '../lib/decimal'
import type { TranslateFn } from '../lib/purchaseOrderInput'

const logger = createLogger('procurements').child({ component: 'commitment-commands' })

export const RESERVE_COMMITMENTS_COMMAND = 'procurements.commitments.reserve'
export const RELEASE_COMMITMENTS_COMMAND = 'procurements.commitments.release'

export const ACTIVE_SOURCE_LINE_UNIQUE_INDEX = 'procurements_commitments_active_source_line_unique_idx'

type CommitmentScope = { tenantId: string; organizationId: string }

/**
 * One line of a reservation request: which order line it takes from, which announcing line
 * is taking it, and how much.
 */
export type ReserveCommitmentLine = {
  purchaseOrderLineId: string
  sourceLineId: string
  quantity: string
  lineNumber: number
}

export type ReserveCommitmentsInput = {
  sourceType: PurchaseOrderCommitmentSource
  sourceDocumentId: string
  sourceDocumentNumber: string
  lines: ReserveCommitmentLine[]
}

export type ReleaseCommitmentsInput = {
  sourceType: PurchaseOrderCommitmentSource
  sourceDocumentId: string
}

/**
 * The reservation's own scope, taken from the session like every other write.
 *
 * These commands carry no route of their own — the announcing module dispatches them over
 * the command bus — so this is the only place the scope can be established, and a missing
 * one has to refuse rather than fall back to something broader.
 */
function ensureCommitmentScope(ctx: CommandRuntimeContext, translate: TranslateFn): CommitmentScope {
  const tenantId = ctx.auth?.tenantId ?? null
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  if (!tenantId || !organizationId) {
    throw badRequest(
      translate(
        'procurements.commitments.errors.scopeRequired',
        'A tenant and an organization are required to reserve against a purchase order.',
      ),
    )
  }
  return { tenantId, organizationId }
}

function parseReserveInput(raw: unknown, translate: TranslateFn): ReserveCommitmentsInput {
  const input = (raw ?? {}) as Partial<ReserveCommitmentsInput>
  const sourceDocumentId = typeof input.sourceDocumentId === 'string' ? input.sourceDocumentId : ''
  const lines = Array.isArray(input.lines) ? input.lines : []
  if (!sourceDocumentId || lines.length === 0) {
    throw badRequest(
      translate(
        'procurements.commitments.errors.inputRequired',
        'A reservation needs a source document and at least one line.',
      ),
    )
  }
  return {
    sourceType: input.sourceType === 'awizo' ? 'awizo' : 'awizo',
    sourceDocumentId,
    sourceDocumentNumber: typeof input.sourceDocumentNumber === 'string' ? input.sourceDocumentNumber : '',
    lines: lines.map((line) => ({
      purchaseOrderLineId: String(line?.purchaseOrderLineId ?? ''),
      sourceLineId: String(line?.sourceLineId ?? ''),
      quantity: String(line?.quantity ?? '0'),
      lineNumber: Number(line?.lineNumber ?? 0),
    })),
  }
}

/**
 * Locks the named order lines for the rest of the transaction.
 *
 * Sorted by id so two announcements touching the same pair of lines always take them in the
 * same order; taking them in request order would let two transactions each hold what the
 * other needs.
 */
async function lockOrderLines(
  em: EntityManager,
  scope: CommitmentScope,
  lineIds: readonly string[],
): Promise<Map<string, PurchaseOrderLine>> {
  const ordered = Array.from(new Set(lineIds)).sort()
  if (ordered.length === 0) return new Map()
  const lines = await em.find(
    PurchaseOrderLine,
    {
      id: { $in: ordered },
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    } as FilterQuery<PurchaseOrderLine>,
    { orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE, populate: ['purchaseOrder'] },
  )
  return new Map(lines.map((line) => [line.id, line]))
}

/**
 * Sums what is already claimed against each of the given order lines.
 *
 * `ignoreSourceLineIds` holds the announcing lines whose own claims this very request is
 * about to replace. Counting those would make a re-released announcement compete with the
 * quantity it already holds and refuse itself.
 */
async function readOutstandingByLine(
  em: EntityManager,
  scope: CommitmentScope,
  lineIds: readonly string[],
  ignoreSourceLineIds: ReadonlySet<string>,
): Promise<Map<string, string[]>> {
  const byLine = new Map<string, string[]>()
  for (const lineId of lineIds) byLine.set(lineId, [])
  if (lineIds.length === 0) return byLine

  const rows = await em.find(PurchaseOrderCommitment, {
    purchaseOrderLine: { $in: Array.from(new Set(lineIds)) },
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    status: 'outstanding',
  } as FilterQuery<PurchaseOrderCommitment>)

  for (const row of rows) {
    if (ignoreSourceLineIds.has(row.sourceLineId)) continue
    const lineId = (row.purchaseOrderLine as unknown as { id: string }).id
    const bucket = byLine.get(lineId)
    if (bucket) bucket.push(String(row.quantity))
  }
  return byLine
}

function refusalMessage(refusals: readonly ReservationRefusal[], translate: TranslateFn): string {
  const overLimit = refusals.find((refusal) => refusal.reason === 'over_limit')
  if (overLimit && overLimit.reason === 'over_limit') {
    return translate(
      'procurements.commitments.errors.overLimit',
      'This announcement asks for more than the purchase order still has free to announce. Refresh and adjust the quantities.',
    )
  }
  if (refusals.some((refusal) => refusal.reason === 'not_positive')) {
    return translate(
      'procurements.commitments.errors.notPositive',
      'An announced quantity must be greater than zero.',
    )
  }
  return translate(
    'procurements.commitments.errors.inconsistent',
    'The purchase order line cannot be announced against right now. Refresh the order and try again.',
  )
}

/**
 * Reserves part of one or more Purchase Order lines for a warehouse announcement.
 *
 * Idempotent on `(sourceType, sourceDocumentId)`: replaying the same request leaves the same
 * claims in place rather than doubling them, which matters because the announcing module
 * commits this in its own transaction before it freezes its document. If that later step
 * fails, the retry lands here again with the same payload.
 *
 * The trade that makes this safe: a claim can briefly outlive a document that never got
 * released, which understates the free quantity. It can never overstate it — and the
 * announcing module's withdraw path gives the claim back.
 */
const reserveCommitmentsCommand: CommandHandler<Record<string, unknown>, PurchaseOrderCommitment[]> = {
  id: 'procurements.commitments.reserve',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureCommitmentScope(ctx, translate)
    const input = parseReserveInput(rawInput, translate)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let reserved: PurchaseOrderCommitment[] = []

    await withAtomicFlush(
      em,
      [
        async () => {
          const requestedSourceLineIds = new Set(input.lines.map((line) => line.sourceLineId))

          // What this document already holds. Anything of its own is set aside from the limit
          // maths below, then either kept as-is or replaced.
          const existing = await em.find(PurchaseOrderCommitment, {
            sourceType: input.sourceType,
            sourceDocumentId: input.sourceDocumentId,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            status: 'outstanding',
          } as FilterQuery<PurchaseOrderCommitment>)
          const existingBySourceLine = new Map(existing.map((row) => [row.sourceLineId, row]))

          const lineIds = input.lines.map((line) => line.purchaseOrderLineId)
          const lockedLines = await lockOrderLines(em, scope, lineIds)

          for (const line of input.lines) {
            const orderLine = lockedLines.get(line.purchaseOrderLineId)
            if (!orderLine) {
              throw conflict(
                translate(
                  'procurements.commitments.errors.lineMissing',
                  'This announcement names a purchase order line that no longer exists.',
                ),
              )
            }
            const order = orderLine.purchaseOrder as unknown as PurchaseOrder
            if (order.deletedAt) {
              throw conflict(
                translate(
                  'procurements.commitments.errors.orderMissing',
                  'This announcement names a purchase order that no longer exists.',
                ),
              )
            }
            // Only a standing order can be announced against: a draft is still being written
            // and a cancelled one will not be delivered.
            if (order.status !== 'released') {
              throw conflict(
                translate(
                  'procurements.commitments.errors.orderNotReleased',
                  'Only a released purchase order can be announced against.',
                ),
              )
            }
          }

          const outstandingByLine = await readOutstandingByLine(
            em,
            scope,
            lineIds,
            requestedSourceLineIds,
          )

          const limits = new Map<string, AnnouncementLimit>()
          for (const [lineId, quantities] of outstandingByLine) {
            const orderLine = lockedLines.get(lineId)
            if (!orderLine) continue
            limits.set(lineId, announcementLimit(String(orderLine.quantityOrdered), quantities))
          }

          const refusals = checkReservations(
            input.lines.map((line) => ({
              purchaseOrderLineId: line.purchaseOrderLineId,
              quantity: line.quantity,
            })),
            limits,
          )
          if (refusals.length > 0) {
            logger.info('Announcement reservation refused', {
              sourceDocumentId: input.sourceDocumentId,
              refusals,
            })
            throw conflict(refusalMessage(refusals, translate))
          }

          const snapshotFor = (lineNumber: number): PurchaseOrderCommitmentSourceSnapshot => ({
            documentNumber: input.sourceDocumentNumber,
            lineNumber,
          })

          const kept: PurchaseOrderCommitment[] = []
          for (const line of input.lines) {
            const previous = existingBySourceLine.get(line.sourceLineId)
            const unchanged =
              previous
              && compareDecimal(String(previous.quantity), line.quantity, QUANTITY_SCALE) === 0
              && (previous.purchaseOrderLine as unknown as { id: string }).id === line.purchaseOrderLineId
            if (unchanged && previous) {
              // A replay of the identical request: leave the existing claim alone so the
              // partial unique index is never asked to hold two rows for one announcing line.
              previous.sourceSnapshot = snapshotFor(line.lineNumber)
              em.persist(previous)
              kept.push(previous)
              continue
            }
            if (previous) {
              previous.status = 'released'
              previous.releasedAt = new Date()
              em.persist(previous)
            }
            const orderLine = lockedLines.get(line.purchaseOrderLineId)!
            const createdAt = new Date()
            const commitment = em.create(PurchaseOrderCommitment, {
              id: randomUUID(),
              purchaseOrder: orderLine.purchaseOrder,
              purchaseOrderLine: orderLine,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              sourceType: input.sourceType,
              sourceDocumentId: input.sourceDocumentId,
              sourceLineId: line.sourceLineId,
              sourceSnapshot: snapshotFor(line.lineNumber),
              quantity: line.quantity,
              status: 'outstanding',
              releasedAt: null,
              createdAt,
              updatedAt: createdAt,
            })
            em.persist(commitment)
            kept.push(commitment)
          }

          // Lines this document used to announce and no longer does give their quantity back.
          for (const row of existing) {
            if (requestedSourceLineIds.has(row.sourceLineId)) continue
            row.status = 'released'
            row.releasedAt = new Date()
            em.persist(row)
          }

          reserved = kept
        },
      ],
      { transaction: true, label: RESERVE_COMMITMENTS_COMMAND },
    )

    return reserved
  },
}

/**
 * Gives a whole announcement's claims back to the orders it took them from.
 *
 * Releasing what is already released is a no-op, so withdrawing twice — or withdrawing a
 * document that never announced against an order at all — succeeds quietly rather than
 * failing a legitimate warehouse action on a purchasing detail.
 */
const releaseCommitmentsCommand: CommandHandler<Record<string, unknown>, number> = {
  id: 'procurements.commitments.release',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureCommitmentScope(ctx, translate)
    const input = (rawInput ?? {}) as Partial<ReleaseCommitmentsInput>
    const sourceDocumentId = typeof input.sourceDocumentId === 'string' ? input.sourceDocumentId : ''
    if (!sourceDocumentId) {
      throw badRequest(
        translate(
          'procurements.commitments.errors.inputRequired',
          'A reservation needs a source document and at least one line.',
        ),
      )
    }
    const sourceType: PurchaseOrderCommitmentSource = 'awizo'
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let releasedCount = 0

    await withAtomicFlush(
      em,
      [
        async () => {
          const rows = await em.find(
            PurchaseOrderCommitment,
            {
              sourceType,
              sourceDocumentId,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              status: 'outstanding',
            } as FilterQuery<PurchaseOrderCommitment>,
            { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' } },
          )
          const now = new Date()
          for (const row of rows) {
            row.status = 'released'
            row.releasedAt = now
            em.persist(row)
          }
          releasedCount = rows.length
        },
      ],
      { transaction: true, label: RELEASE_COMMITMENTS_COMMAND },
    )

    return releasedCount
  },
}

registerCommand(reserveCommitmentsCommand)
registerCommand(releaseCommitmentsCommand)
