import { randomUUID } from 'node:crypto'
import { LockMode } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { sql } from 'kysely'
import {
  registerCommand,
  type CommandHandler,
  type CommandRuntimeContext,
} from '@open-mercato/shared/lib/commands'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import {
  assertFound,
  badRequest,
  conflict,
  isUniqueViolation,
} from '@open-mercato/shared/lib/crud/errors'
import {
  assertOptimisticLock,
  readOptimisticLockExpected,
} from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { GoodsReceipt, Pallet, PalletLine, type PalletStatus } from '../data/entities'
import type { TranslateFn } from '../lib/goodsReceiptInput'
import { PALLET_CODE_PREFIX, nextPalletCode } from '../lib/palletCode'
import { ensureGoodsReceiptScope, type GoodsReceiptScope } from './goodsReceipts'

const logger = createLogger('pz').child({ component: 'pallet-commands' })

export const PALLET_ENTITY_ID = E.pz.pallet
export const PALLET_CODE_UNIQUE_INDEX = 'pz_pallets_code_unique_idx'

/** Bounded, because the retry exists to survive a race, not to keep trying under load. */
const PALLET_CODE_ATTEMPTS = 5

const MAX_LABEL_LENGTH = 120

export type SerializedPallet = {
  id: string
  goodsReceiptId: string
  tenantId: string
  organizationId: string
  code: string
  label: string | null
  status: PalletStatus
  closedAt: string | null
  createdAt: string
  updatedAt: string
}

type PalletCodeDatabase = {
  pz_pallets: {
    code: string
    tenant_id: string
    organization_id: string
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function serializePallet(pallet: Pallet): SerializedPallet {
  return {
    id: String(pallet.id),
    goodsReceiptId: String(pallet.goodsReceipt.id),
    tenantId: pallet.tenantId,
    organizationId: pallet.organizationId,
    code: pallet.code,
    label: pallet.label ?? null,
    status: pallet.status,
    closedAt: pallet.closedAt ? toIso(pallet.closedAt) : null,
    createdAt: toIso(pallet.createdAt),
    updatedAt: toIso(pallet.updatedAt),
  }
}

function requirePalletId(raw: unknown, translate: TranslateFn): string {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const body = source.body && typeof source.body === 'object' ? (source.body as Record<string, unknown>) : {}
  const query = source.query && typeof source.query === 'object' ? (source.query as Record<string, unknown>) : {}
  const id = [source.id, body.id, query.id].find((value) => typeof value === 'string' && value.length > 0)
  if (typeof id !== 'string') {
    throw badRequest(translate('pz.pallets.errors.idRequired', 'A pallet identifier is required.'))
  }
  return id
}

/**
 * The installed lock helper is additive — it does nothing when the caller sends no version —
 * and a pallet cannot afford that: two warehousemen work the same document at once, so a
 * write issued without a version would silently win over whatever the other one saved.
 */
function requireExpectedVersion(ctx: CommandRuntimeContext, translate: TranslateFn): string {
  const expected = readOptimisticLockExpected(ctx.request ?? null)
  const parsed = expected ? new Date(expected) : null
  if (!expected || !parsed || Number.isNaN(parsed.getTime())) {
    throw badRequest(
      translate(
        'pz.pallets.errors.versionRequired',
        'Send the record version you are working from in the optimistic-lock header.',
      ),
    )
  }
  return expected
}

function readLabel(raw: unknown, translate: TranslateFn): string | null {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const value = source.label
  if (value == null) return null
  const label = String(value).trim()
  if (label.length === 0) return null
  if (label.length > MAX_LABEL_LENGTH) {
    throw badRequest(translate('pz.pallets.errors.labelTooLong', 'The pallet note is too long.'))
  }
  return label
}

function requireGoodsReceiptId(raw: unknown, translate: TranslateFn): string {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const id = source.goodsReceiptId
  if (typeof id !== 'string' || id.length === 0) {
    throw badRequest(translate('pz.goodsReceipts.errors.idRequired', 'A goods receipt identifier is required.'))
  }
  return id
}

/**
 * Holds the document until the pallet commits. Releasing a receipt to the floor and taking it
 * back are both status writes on this row, so without the lock a withdrawal could commit
 * between the status check and the insert and leave a pallet hanging off a draft — exactly the
 * state the withdraw guard exists to prevent.
 */
async function lockReceivingReceipt(
  em: EntityManager,
  scope: GoodsReceiptScope,
  goodsReceiptId: string,
  translate: TranslateFn,
): Promise<GoodsReceipt> {
  const receipt = assertFound(
    await em.findOne(
      GoodsReceipt,
      {
        id: goodsReceiptId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      } as FilterQuery<GoodsReceipt>,
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    ),
    translate('pz.pallets.errors.receiptNotFound', 'That goods receipt no longer exists.'),
  )
  if (receipt.status !== 'receiving') {
    throw conflict(
      translate(
        'pz.pallets.errors.receiptNotReceiving',
        'Pallets can only be created for a goods receipt that has been released to the floor.',
      ),
    )
  }
  return receipt
}

/**
 * The next code for the Organization, derived from the highest one it already holds.
 *
 * Ordering is by width first and text second: `PAL-1000000` is a larger sequence than
 * `PAL-999999`, and plain text ordering says the opposite. The unique index is the real
 * authority — this read only proposes a candidate, and the caller retries what it refuses.
 */
async function deriveNextCode(em: EntityManager, scope: GoodsReceiptScope): Promise<string> {
  const db = em.getKysely<PalletCodeDatabase>()
  const highest = await db
    .selectFrom('pz_pallets')
    .select('code')
    .where('tenant_id', '=', scope.tenantId)
    .where('organization_id', '=', scope.organizationId)
    .where('code', 'like', `${PALLET_CODE_PREFIX}%`)
    .orderBy(sql`length(code)`, 'desc')
    .orderBy('code', 'desc')
    .limit(1)
    .executeTakeFirst()
  return nextPalletCode(highest?.code ?? null)
}

async function loadPalletForSnapshot(
  em: EntityManager,
  scope: GoodsReceiptScope,
  id: string,
  translate: TranslateFn,
): Promise<SerializedPallet> {
  return serializePallet(
    assertFound(
      await em.findOne(Pallet, {
        id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      } as FilterQuery<Pallet>),
      translate('pz.pallets.errors.notFound', 'That pallet no longer exists.'),
    ),
  )
}

/**
 * Reads a pallet for a write and holds it until the transaction commits, so that it exists in
 * the caller's scope and still carries the version they were shown cannot stop being true
 * between the check and the write.
 */
async function lockPalletForWrite(
  em: EntityManager,
  scope: GoodsReceiptScope,
  id: string,
  expectedVersion: string,
  translate: TranslateFn,
): Promise<Pallet> {
  const pallet = assertFound(
    await em.findOne(
      Pallet,
      {
        id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      } as FilterQuery<Pallet>,
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    ),
    translate('pz.pallets.errors.notFound', 'That pallet no longer exists.'),
  )
  assertOptimisticLock({
    resourceKind: PALLET_ENTITY_ID,
    resourceId: id,
    expected: expectedVersion,
    current: pallet.updatedAt,
  })
  return pallet
}

function assertOpen(pallet: Pallet, translate: TranslateFn): void {
  if (pallet.status !== 'open') {
    throw conflict(translate('pz.pallets.errors.closed', 'This pallet is closed. Reopen it before changing it.'))
  }
}

async function prepareBeforeSnapshot(
  rawInput: unknown,
  ctx: CommandRuntimeContext,
): Promise<{ before: SerializedPallet }> {
  const { translate } = await resolveTranslations()
  const scope = ensureGoodsReceiptScope(ctx, translate)
  const em = (ctx.container.resolve('em') as EntityManager).fork()
  return { before: await loadPalletForSnapshot(em, scope, requirePalletId(rawInput, translate), translate) }
}

function buildPalletLog(actionLabel: string, pallet: SerializedPallet, before?: SerializedPallet | null) {
  return {
    actionLabel,
    resourceKind: 'pz.pallet',
    resourceId: pallet.id,
    tenantId: pallet.tenantId,
    organizationId: pallet.organizationId,
    snapshotBefore: before ?? undefined,
    snapshotAfter: pallet,
  }
}

async function persistPallet(
  ctx: CommandRuntimeContext,
  scope: GoodsReceiptScope,
  input: { goodsReceiptId: string; label: string | null },
  translate: TranslateFn,
): Promise<Pallet> {
  const em = (ctx.container.resolve('em') as EntityManager).fork()
  let pallet!: Pallet

  await runCrudCommandWrite<Pallet>({
    ctx,
    em,
    entityId: PALLET_ENTITY_ID,
    action: 'created',
    scope,
    syncOrigin: ctx.syncOrigin,
    phases: [
      async ({ em: tx }) => {
        const receipt = await lockReceivingReceipt(tx, scope, input.goodsReceiptId, translate)
        const now = new Date()
        pallet = tx.create(Pallet, {
          id: randomUUID(),
          goodsReceipt: receipt,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          code: await deriveNextCode(tx, scope),
          label: input.label,
          status: 'open',
          closedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        tx.persist(pallet)
      },
    ],
    sideEffect: () => ({
      entity: pallet,
      identifiers: { id: String(pallet.id), tenantId: scope.tenantId, organizationId: scope.organizationId },
    }),
  })

  return pallet
}

const createPalletCommand: CommandHandler<Record<string, unknown>, Pallet> = {
  id: 'pz.pallets.create',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const input = {
      goodsReceiptId: requireGoodsReceiptId(rawInput, translate),
      label: readLabel(rawInput, translate),
    }

    // The unique index is the authority on the code, so a collision is re-derived rather than
    // reported: two warehousemen creating a pallet at the same moment is ordinary, not an error.
    for (let attempt = 0; attempt < PALLET_CODE_ATTEMPTS; attempt += 1) {
      try {
        return await persistPallet(ctx, scope, input, translate)
      } catch (error) {
        if (!isUniqueViolation(error, PALLET_CODE_UNIQUE_INDEX)) throw error
        logger.warn('Pallet code collided, re-deriving', { attempt: attempt + 1, goodsReceiptId: input.goodsReceiptId })
      }
    }
    throw conflict(
      translate('pz.pallets.errors.codeGenerationFailed', 'A pallet code could not be generated. Try again.'),
    )
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return buildPalletLog(translate('pz.audit.pallets.create', 'Create pallet'), serializePallet(result))
  },
}

const updatePalletCommand: CommandHandler<Record<string, unknown>, Pallet> = {
  id: 'pz.pallets.update',
  isUndoable: false,
  prepare: prepareBeforeSnapshot,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const id = requirePalletId(rawInput, translate)
    const expectedVersion = requireExpectedVersion(ctx, translate)
    const label = readLabel(rawInput, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let pallet!: Pallet

    await runCrudCommandWrite<Pallet>({
      ctx,
      em,
      entityId: PALLET_ENTITY_ID,
      action: 'updated',
      scope,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: tx }) => {
          pallet = await lockPalletForWrite(tx, scope, id, expectedVersion, translate)
          assertOpen(pallet, translate)
        },
        ({ em: tx }) => {
          // Only the note is editable. The code is the physical label somebody has already
          // stuck on the pallet, so nothing here may change it.
          pallet.label = label
          pallet.updatedAt = new Date()
          tx.persist(pallet)
        },
      ],
      sideEffect: () => ({
        entity: pallet,
        identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    return pallet
  },
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return buildPalletLog(
      translate('pz.audit.pallets.update', 'Update pallet'),
      serializePallet(result),
      (snapshots.before as SerializedPallet | undefined) ?? null,
    )
  },
}

const deletePalletCommand: CommandHandler<Record<string, unknown>, SerializedPallet> = {
  id: 'pz.pallets.delete',
  isUndoable: false,
  prepare: prepareBeforeSnapshot,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const id = requirePalletId(rawInput, translate)
    const expectedVersion = requireExpectedVersion(ctx, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let removed!: SerializedPallet

    await runCrudCommandWrite<SerializedPallet>({
      ctx,
      em,
      entityId: PALLET_ENTITY_ID,
      action: 'deleted',
      scope,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: tx }) => {
          const pallet = await lockPalletForWrite(tx, scope, id, expectedVersion, translate)
          assertOpen(pallet, translate)
          await assertNoLines(tx, scope, id, translate)
          // Hard, and inside the transaction that verified it is empty: the unique index
          // stops seeing the row, so the code is free again the moment this commits.
          removed = serializePallet(pallet)
          tx.remove(pallet)
        },
      ],
      sideEffect: () => ({
        entity: removed,
        identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    return removed
  },
  buildLog: async ({ snapshots, input }) => {
    const { translate } = await resolveTranslations()
    const before = (snapshots.before as SerializedPallet | undefined) ?? null
    return {
      actionLabel: translate('pz.audit.pallets.delete', 'Delete pallet'),
      resourceKind: 'pz.pallet',
      resourceId: before?.id ?? requirePalletId(input, translate),
      tenantId: before?.tenantId ?? null,
      organizationId: before?.organizationId ?? null,
      snapshotBefore: before,
    }
  },
}

/**
 * The foreign key does not constrain a pallet line's duplicated scope to its pallet's, so the
 * emptiness check repeats the caller's tenant and organization rather than trusting the parent
 * id alone.
 */
async function assertNoLines(
  em: EntityManager,
  scope: GoodsReceiptScope,
  palletId: string,
  translate: TranslateFn,
): Promise<void> {
  const lines = await em.count(PalletLine, {
    pallet: palletId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  } as FilterQuery<PalletLine>)
  if (lines > 0) {
    throw conflict(
      translate(
        'pz.pallets.errors.hasLines',
        'This pallet still has counted goods on it, so it cannot be deleted. Remove them first.',
      ),
    )
  }
}

/**
 * Closing and reopening are the same write with opposite ends, so they share one runner: both
 * hold the row, refuse the transition they are already in, and move `closedAt` with the status.
 */
async function transitionPallet(
  rawInput: unknown,
  ctx: CommandRuntimeContext,
  target: PalletStatus,
  refuseAlreadyThere: (translate: TranslateFn) => never,
  guard?: (args: { em: EntityManager; pallet: Pallet; scope: GoodsReceiptScope; translate: TranslateFn }) => Promise<void>,
): Promise<Pallet> {
  const { translate } = await resolveTranslations()
  const scope = ensureGoodsReceiptScope(ctx, translate)
  const id = requirePalletId(rawInput, translate)
  const expectedVersion = requireExpectedVersion(ctx, translate)

  const em = (ctx.container.resolve('em') as EntityManager).fork()
  let pallet!: Pallet

  await runCrudCommandWrite<Pallet>({
    ctx,
    em,
    entityId: PALLET_ENTITY_ID,
    action: 'updated',
    scope,
    syncOrigin: ctx.syncOrigin,
    phases: [
      async ({ em: tx }) => {
        pallet = await lockPalletForWrite(tx, scope, id, expectedVersion, translate)
        if (pallet.status === target) refuseAlreadyThere(translate)
        if (guard) await guard({ em: tx, pallet, scope, translate })
      },
      ({ em: tx }) => {
        const now = new Date()
        pallet.status = target
        pallet.closedAt = target === 'closed' ? now : null
        pallet.updatedAt = now
        tx.persist(pallet)
      },
    ],
    sideEffect: () => ({
      entity: pallet,
      identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    }),
  })

  return pallet
}

/**
 * Reopening a pallet under a confirmed document would reopen a one-way transition through the
 * back door: confirmation asserts the floor counted this, and that assertion cannot be edited
 * afterwards (ADR-0006).
 */
async function assertReceiptReopenable(args: {
  em: EntityManager
  pallet: Pallet
  scope: GoodsReceiptScope
  translate: TranslateFn
}): Promise<void> {
  const receipt = assertFound(
    await args.em.findOne(GoodsReceipt, {
      id: args.pallet.goodsReceipt.id,
      tenantId: args.scope.tenantId,
      organizationId: args.scope.organizationId,
      deletedAt: null,
    } as FilterQuery<GoodsReceipt>),
    args.translate('pz.pallets.errors.receiptNotFound', 'That goods receipt no longer exists.'),
  )
  if (receipt.status === 'confirmed') {
    throw conflict(
      args.translate(
        'pz.pallets.errors.reopenConfirmed',
        'This goods receipt is confirmed, so its pallets can no longer be reopened.',
      ),
    )
  }
}

const closePalletCommand: CommandHandler<Record<string, unknown>, Pallet> = {
  id: 'pz.pallets.close',
  isUndoable: false,
  execute: (rawInput, ctx) =>
    transitionPallet(rawInput, ctx, 'closed', (translate) => {
      throw conflict(translate('pz.pallets.errors.alreadyClosed', 'This pallet is already closed.'))
    }),
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return buildPalletLog(translate('pz.audit.pallets.close', 'Close pallet'), serializePallet(result))
  },
}

const reopenPalletCommand: CommandHandler<Record<string, unknown>, Pallet> = {
  id: 'pz.pallets.reopen',
  isUndoable: false,
  execute: (rawInput, ctx) =>
    transitionPallet(
      rawInput,
      ctx,
      'open',
      (translate) => {
        throw conflict(translate('pz.pallets.errors.alreadyOpen', 'This pallet is already open.'))
      },
      assertReceiptReopenable,
    ),
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return buildPalletLog(translate('pz.audit.pallets.reopen', 'Reopen pallet'), serializePallet(result))
  },
}

registerCommand(createPalletCommand)
registerCommand(updatePalletCommand)
registerCommand(deletePalletCommand)
registerCommand(closePalletCommand)
registerCommand(reopenPalletCommand)
