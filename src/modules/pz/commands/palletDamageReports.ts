import { randomUUID } from 'node:crypto'
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
} from '@open-mercato/shared/lib/crud/errors'
import {
  assertOptimisticLock,
  readOptimisticLockExpected,
} from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { E } from '@/.mercato/generated/entities.ids.generated'
import {
  Pallet,
  PalletDamageReport,
  type PalletDamageReportStatus,
  type PalletLineCatalogSnapshot,
} from '../data/entities'
import { normalizeQuantity, type TranslateFn } from '../lib/goodsReceiptInput'
import { ensureGoodsReceiptScope, type GoodsReceiptScope } from './goodsReceipts'
import { requireOpenPallet, resolveCountedVariant } from './palletLines'

export const PALLET_DAMAGE_REPORT_ENTITY_ID = E.pz.pallet_damage_report
/** The `entityId` a photo is uploaded under, so the office can list a report's own photos
 *  through the installed attachments endpoint without this module owning any file storage. */
export const PALLET_DAMAGE_REPORT_ATTACHMENT_ENTITY_ID = 'pz:pallet_damage_report'

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/
const NOTE_MAX_LENGTH = 2000

export type SerializedPalletDamageReport = {
  id: string
  palletId: string
  tenantId: string
  organizationId: string
  catalogVariantId: string
  catalogProductId: string
  catalogSnapshot: PalletLineCatalogSnapshot | null
  quantity: string
  photoAttachmentId: string | null
  note: string | null
  status: PalletDamageReportStatus
  resolutionNote: string | null
  reportedBy: string
  resolvedBy: string | null
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function serializePalletDamageReport(report: PalletDamageReport): SerializedPalletDamageReport {
  return {
    id: String(report.id),
    palletId: String(report.pallet.id),
    tenantId: report.tenantId,
    organizationId: report.organizationId,
    catalogVariantId: report.catalogVariantId,
    catalogProductId: report.catalogProductId,
    catalogSnapshot: report.catalogSnapshot ?? null,
    quantity: report.quantity,
    photoAttachmentId: report.photoAttachmentId ?? null,
    note: report.note ?? null,
    status: report.status,
    resolutionNote: report.resolutionNote ?? null,
    reportedBy: report.reportedBy,
    resolvedBy: report.resolvedBy ?? null,
    resolvedAt: report.resolvedAt ? toIso(report.resolvedAt) : null,
    createdAt: toIso(report.createdAt),
    updatedAt: toIso(report.updatedAt),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function requireUuid(value: unknown, message: string): string {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (!UUID.test(candidate)) throw badRequest(message)
  return candidate
}

function optionalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value.trim()) ? value.trim() : null
}

function requireQuantity(value: unknown, translate: TranslateFn): string {
  const quantity = normalizeQuantity(value)
  if (quantity === null) {
    throw badRequest(translate('pz.palletDamageReports.errors.quantityInvalid', 'Quantity must be greater than zero.'))
  }
  return quantity
}

function parseNote(value: unknown, translate: TranslateFn): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > NOTE_MAX_LENGTH) {
    throw badRequest(translate('pz.palletDamageReports.errors.noteTooLong', 'The note is too long.'))
  }
  return trimmed
}

/**
 * The CRUD factory hands a create or update the body itself but a delete `{ body, query }`,
 * so every id is looked for in all three places rather than once per command.
 */
function requireReportId(raw: unknown, translate: TranslateFn): string {
  const source = asRecord(raw)
  const id = [source.id, asRecord(source.body).id, asRecord(source.query).id].find(
    (value) => typeof value === 'string' && UUID.test(value),
  )
  if (typeof id !== 'string') {
    throw badRequest(
      translate('pz.palletDamageReports.errors.idRequired', 'A damage report identifier is required.'),
    )
  }
  return id
}

function requireActorUserId(ctx: CommandRuntimeContext, translate: TranslateFn): string {
  const userId = ctx.auth?.sub
  if (!userId) {
    throw badRequest(translate('pz.palletDamageReports.errors.userRequired', 'A signed-in user is required.'))
  }
  return String(userId)
}

function requireExpectedVersion(ctx: CommandRuntimeContext, translate: TranslateFn): string {
  const expected = readOptimisticLockExpected(ctx.request ?? null)
  const parsed = expected ? new Date(expected) : null
  if (!expected || !parsed || Number.isNaN(parsed.getTime())) {
    throw badRequest(
      translate(
        'pz.palletDamageReports.errors.versionRequired',
        'Send the record version you are working from in the optimistic-lock header.',
      ),
    )
  }
  return expected
}

function assertDamageReportVersion(id: string, expected: string, current: Date, translate: TranslateFn): void {
  try {
    assertOptimisticLock({
      resourceKind: PALLET_DAMAGE_REPORT_ENTITY_ID,
      resourceId: id,
      expected,
      current,
    })
  } catch (error) {
    if (isCrudHttpError(error) && error.status === 409) {
      throw new CrudHttpError(409, {
        ...error.body,
        error: translate(
          'pz.palletDamageReports.errors.stale',
          'Somebody changed this damage report while you were working on it. Reload it and try again.',
        ),
      })
    }
    throw error
  }
}

async function lockOpenPalletForReport(
  em: EntityManager,
  scope: GoodsReceiptScope,
  palletId: string,
  translate: TranslateFn,
): Promise<Pallet> {
  const pallet = assertFound(
    await em.findOne(
      Pallet,
      { id: palletId, tenantId: scope.tenantId, organizationId: scope.organizationId } as FilterQuery<Pallet>,
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    ),
    translate('pz.pallets.errors.notFound', 'That pallet no longer exists.'),
  )
  requireOpenPallet(pallet, translate)
  return pallet
}

async function lockDamageReportForWrite(
  em: EntityManager,
  scope: GoodsReceiptScope,
  id: string,
  translate: TranslateFn,
): Promise<PalletDamageReport> {
  return assertFound(
    await em.findOne(
      PalletDamageReport,
      { id, tenantId: scope.tenantId, organizationId: scope.organizationId } as FilterQuery<PalletDamageReport>,
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    ),
    translate('pz.palletDamageReports.errors.notFound', 'That damage report no longer exists.'),
  )
}

/**
 * The photo has to already belong to this report before it can be attached to it: the client
 * uploads it first, under a client-minted report id and this module's `entityId`, and only
 * then creates the report under that same id. Anything else — another tenant's attachment, a
 * mismatched `recordId`, one that was never uploaded — is refused rather than linked, because
 * a `photoAttachmentId` the caller merely typed would let one report borrow another's photo.
 */
async function requireOwnedPhotoAttachment(
  em: EntityManager,
  scope: GoodsReceiptScope,
  reportId: string,
  attachmentId: string,
  translate: TranslateFn,
): Promise<void> {
  const { Attachment } = await import('@open-mercato/core/modules/attachments/data/entities')
  const attachment = await em.findOne(Attachment, {
    id: attachmentId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  } as FilterQuery<InstanceType<typeof Attachment>>)
  if (
    !attachment ||
    attachment.entityId !== PALLET_DAMAGE_REPORT_ATTACHMENT_ENTITY_ID ||
    attachment.recordId !== reportId
  ) {
    throw badRequest(
      translate('pz.palletDamageReports.errors.photoUnavailable', 'That photo is no longer available. Upload it again.'),
    )
  }
}

type CreateInput = {
  id: string | null
  palletId: string
  catalogVariantId: string
  quantity: string
  note: string | null
  photoAttachmentId: string | null
}

function parseCreateInput(raw: unknown, translate: TranslateFn): CreateInput {
  const source = asRecord(raw)
  return {
    id: optionalUuid(source.id),
    palletId: requireUuid(
      source.palletId,
      translate('pz.pallets.errors.idRequired', 'A pallet identifier is required.'),
    ),
    catalogVariantId: requireUuid(
      source.catalogVariantId,
      translate('pz.palletDamageReports.errors.variantRequired', 'Choose the damaged product.'),
    ),
    quantity: requireQuantity(source.quantity, translate),
    note: parseNote(source.note, translate),
    photoAttachmentId: optionalUuid(source.photoAttachmentId),
  }
}

/**
 * Filed by the floor against a product on an open pallet (same rule as counting:
 * `requireOpenPallet`). Product is always required — reporting damage to a whole pallet with
 * no product named is out of scope for this feature.
 */
const createPalletDamageReportCommand: CommandHandler<Record<string, unknown>, PalletDamageReport> = {
  id: 'pz.palletDamageReports.create',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const input = parseCreateInput(rawInput, translate)
    const reportId = input.id ?? randomUUID()
    const reportedBy = requireActorUserId(ctx, translate)
    const variant = await resolveCountedVariant(ctx, scope, input.catalogVariantId, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    if (input.photoAttachmentId) {
      await requireOwnedPhotoAttachment(em, scope, reportId, input.photoAttachmentId, translate)
    }

    let report!: PalletDamageReport

    await runCrudCommandWrite<PalletDamageReport>({
      ctx,
      em,
      entityId: PALLET_DAMAGE_REPORT_ENTITY_ID,
      action: 'created',
      scope,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: tx }) => {
          const pallet = await lockOpenPalletForReport(tx, scope, input.palletId, translate)
          const now = new Date()
          report = tx.create(PalletDamageReport, {
            id: reportId,
            pallet,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            catalogVariantId: variant.catalogVariantId,
            catalogProductId: variant.catalogProductId,
            catalogSnapshot: { name: variant.name, sku: variant.sku },
            quantity: input.quantity,
            photoAttachmentId: input.photoAttachmentId,
            note: input.note,
            status: 'open',
            reportedBy,
            createdAt: now,
            updatedAt: now,
          })
          tx.persist(report)
        },
      ],
      sideEffect: () => ({
        entity: report,
        identifiers: { id: reportId, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    return report
  },
  captureAfter: (_input, result) => serializePalletDamageReport(result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('pz.audit.palletDamageReports.create', 'Report damaged goods'),
      resourceKind: 'pz.pallet_damage_report',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: snapshots.after as SerializedPalletDamageReport,
    }
  },
}

/**
 * Resolved by the office independently of the Goods Receipt's own status (ADR-0006 does not
 * apply: a damage report is its own entity, not a document line), and independently of the
 * pallet's status — a pallet closed or reopened after the report was filed does not change
 * whether the damage it names was dealt with.
 */
const resolvePalletDamageReportCommand: CommandHandler<Record<string, unknown>, PalletDamageReport> = {
  id: 'pz.palletDamageReports.resolve',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const id = requireReportId(rawInput, translate)
    const expectedVersion = requireExpectedVersion(ctx, translate)
    const resolutionNote = parseNote(asRecord(rawInput).resolutionNote, translate)
    const resolvedBy = requireActorUserId(ctx, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let report!: PalletDamageReport

    await runCrudCommandWrite<PalletDamageReport>({
      ctx,
      em,
      entityId: PALLET_DAMAGE_REPORT_ENTITY_ID,
      action: 'updated',
      scope,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: tx }) => {
          report = await lockDamageReportForWrite(tx, scope, id, translate)
          assertDamageReportVersion(id, expectedVersion, report.updatedAt, translate)
          if (report.status === 'resolved') {
            throw conflict(
              translate(
                'pz.palletDamageReports.errors.alreadyResolved',
                'This damage report has already been marked as resolved.',
              ),
            )
          }
          const now = new Date()
          report.status = 'resolved'
          report.resolutionNote = resolutionNote
          report.resolvedBy = resolvedBy
          report.resolvedAt = now
          report.updatedAt = now
          tx.persist(report)
        },
      ],
      sideEffect: () => ({
        entity: report,
        identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    return report
  },
  captureAfter: (_input, result) => serializePalletDamageReport(result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('pz.audit.palletDamageReports.resolve', 'Resolve a damage report'),
      resourceKind: 'pz.pallet_damage_report',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: snapshots.after as SerializedPalletDamageReport,
    }
  },
}

registerCommand(createPalletDamageReportCommand)
registerCommand(resolvePalletDamageReportCommand)
