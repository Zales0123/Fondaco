import { randomUUID } from 'node:crypto'
import { LockMode } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import {
  registerCommand,
  type CommandHandler,
  type CommandRuntimeContext,
  type CommandUndoLogEntry,
} from '@open-mercato/shared/lib/commands'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import type { CommandBus } from '@open-mercato/shared/lib/commands/command-bus'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { buildChanges, emitCrudSideEffects, emitCrudUndoSideEffects } from '@open-mercato/shared/lib/commands/helpers'
import { makeCreateRedo, resolveRedoSnapshot } from '@open-mercato/shared/lib/commands/redo'
import { extractUndoPayload, type UndoPayload } from '@open-mercato/shared/lib/commands/undo'
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
import type { CrudEmitContext, CrudEventsConfig, CrudIndexerConfig } from '@open-mercato/shared/lib/crud/types'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { EventBus } from '@open-mercato/events'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { E } from '@/.mercato/generated/entities.ids.generated'
import {
  GoodsReceipt,
  GoodsReceiptLine,
  Pallet,
  FROZEN_GOODS_RECEIPT_STATUSES,
  type GoodsReceiptCatalogSnapshot,
  type GoodsReceiptPurchaseOrderSnapshot,
  type GoodsReceiptStatus,
  type GoodsReceiptUomSnapshot,
  type GoodsReceiptWarehouseSnapshot,
} from '../data/entities'
import {
  parseGoodsReceiptWriteInput,
  utcToday,
  type GoodsReceiptWriteInput,
  type TranslateFn,
} from '../lib/goodsReceiptInput'
import {
  resolvePurchaseOrderReferences,
  type PurchaseOrderLineReference,
  type PurchaseOrderReferenceFailure,
} from '../lib/purchaseOrderReference'

const logger = createLogger('pz').child({ component: 'goods-receipt-commands' })

export const GOODS_RECEIPT_ENTITY_ID = E.pz.goods_receipt
export const DOCUMENT_NUMBER_UNIQUE_INDEX = 'pz_goods_receipts_document_number_unique_idx'

export type GoodsReceiptScope = { tenantId: string; organizationId: string }

export type SerializedGoodsReceiptLine = {
  id: string
  lineNumber: number
  catalogVariantId: string
  catalogProductId: string
  catalogSnapshot: GoodsReceiptCatalogSnapshot | null
  quantity: string
  unit: string | null
  uomSnapshot: GoodsReceiptUomSnapshot | null
  purchaseOrderId: string | null
  purchaseOrderLineId: string | null
  purchaseOrderSnapshot: GoodsReceiptPurchaseOrderSnapshot | null
}

/**
 * The whole aggregate, not just the header: undo and redo have to put back the document
 * a user was looking at, and a goods receipt without its lines is not that document.
 */
export type SerializedGoodsReceipt = {
  id: string
  tenantId: string
  organizationId: string
  documentNumber: string
  /** Calendar day, `YYYY-MM-DD`. */
  documentDate: string
  supplierName: string
  warehouseId: string
  warehouseSnapshot: GoodsReceiptWarehouseSnapshot | null
  status: GoodsReceiptStatus
  createdAt: string
  updatedAt: string
  lines: SerializedGoodsReceiptLine[]
}

export const goodsReceiptCrudEvents: CrudEventsConfig<GoodsReceipt> = {
  module: 'pz',
  entity: 'goods_receipt',
  persistent: true,
  buildPayload: (ctx: CrudEmitContext<GoodsReceipt>) => ({
    id: ctx.identifiers.id,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
    documentNumber: ctx.entity?.documentNumber ?? null,
    status: ctx.entity?.status ?? null,
  }),
}

export const goodsReceiptCrudIndexer: CrudIndexerConfig<GoodsReceipt> = {
  entityType: GOODS_RECEIPT_ENTITY_ID,
}

/**
 * The shared `badRequest` helper carries no field map, and the form needs one: a duplicate
 * Document Number has to land on the Document Number input rather than in a banner. The
 * `fields` key is the shape the installed data engine already emits and the shared client
 * error adapter already reads.
 */
export function goodsReceiptFieldError(message: string, fields: Record<string, string>): CrudHttpError {
  return new CrudHttpError(400, { error: message, fields })
}

function validationFailed(translate: TranslateFn): string {
  return translate('pz.goodsReceipts.errors.validationFailed', 'The goods receipt could not be saved.')
}

export function ensureGoodsReceiptScope(ctx: CommandRuntimeContext, translate: TranslateFn): GoodsReceiptScope {
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) {
    throw badRequest(translate('pz.goodsReceipts.errors.tenantRequired', 'Tenant context is required.'))
  }
  const organizationId = ctx.selectedOrganizationId ?? ctx.organizationScope?.selectedId ?? null
  if (!organizationId) {
    throw badRequest(translate('pz.goodsReceipts.errors.organizationRequired', 'Organization context is required.'))
  }
  return { tenantId, organizationId }
}

/**
 * Case-insensitive equality, not a prefix match: the pattern is escaped and carries no
 * wildcard, so it reproduces the `lower(document_number)` unique index in a readable way.
 * It is a courtesy check — the index is the actual guard, and `isUniqueViolation` maps the
 * race that slips past this read onto the same field error.
 */
async function findByDocumentNumber(
  em: EntityManager,
  scope: GoodsReceiptScope,
  documentNumber: string,
  excludeId?: string,
): Promise<GoodsReceipt | null> {
  const where: Record<string, unknown> = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
    documentNumber: { $ilike: escapeLikePattern(documentNumber) },
  }
  if (excludeId) where.id = { $ne: excludeId }
  return em.findOne(GoodsReceipt, where as FilterQuery<GoodsReceipt>)
}

type WarehouseRow = { id: string; name: string | null; code: string | null }

/**
 * Warehouses and catalog records are read through the installed query engine under the
 * caller's trusted scope — this module holds scalar ids only and never an ORM relation into
 * `wms` or `catalog` (ADR-0004).
 */
async function findWarehouse(
  ctx: CommandRuntimeContext,
  scope: GoodsReceiptScope,
  warehouseId: string,
): Promise<WarehouseRow | null> {
  const queryEngine = ctx.container.resolve<QueryEngine>('queryEngine')
  const result = await queryEngine.query<WarehouseRow>(E.wms.warehouse, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['id', 'name', 'code'],
    filters: { id: warehouseId },
    page: { page: 1, pageSize: 1 },
  })
  return result.items[0] ?? null
}

export async function requireWarehouse(
  ctx: CommandRuntimeContext,
  scope: GoodsReceiptScope,
  warehouseId: string,
  translate: TranslateFn,
): Promise<WarehouseRow> {
  const warehouse = await findWarehouse(ctx, scope, warehouseId)
  if (!warehouse) {
    throw goodsReceiptFieldError(validationFailed(translate), {
      warehouseId: translate('pz.goodsReceipts.errors.warehouseMissing', 'That warehouse no longer exists.'),
    })
  }
  return warehouse
}

type ProductRow = { id: string; title: string | null; sku: string | null; default_unit: string | null }
type VariantRow = { id: string; product_id: string; sku: string | null; is_default: boolean | null }

export type ResolvedCatalogLine = {
  catalogVariantId: string
  catalogSnapshot: GoodsReceiptCatalogSnapshot
  productDefaultUnit: string | null
}

/**
 * Users pick products; the document stores the variant, because that is how every `wms`
 * entity keys a product (ADR-0007). Resolution happens here rather than in the browser, so
 * neither the stored variant nor the snapshot can be chosen by the caller.
 *
 * Only variants flagged as the product's default are considered, and exactly one is
 * required. Falling back to "some other variant" would quietly file the delivery against a
 * product the paperwork never mentioned, which is worse than refusing the line.
 */
export async function resolveCatalogLines(
  ctx: CommandRuntimeContext,
  scope: GoodsReceiptScope,
  productIds: string[],
  translate: TranslateFn,
): Promise<Map<string, ResolvedCatalogLine>> {
  const unique = Array.from(new Set(productIds))
  if (unique.length === 0) return new Map()
  const queryEngine = ctx.container.resolve<QueryEngine>('queryEngine')

  const [products, variants] = await Promise.all([
    queryEngine.query<ProductRow>(E.catalog.catalog_product, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      fields: ['id', 'title', 'sku', 'default_unit'],
      filters: { id: { $in: unique } },
      page: { page: 1, pageSize: unique.length },
    }),
    queryEngine.query<VariantRow>(E.catalog.catalog_product_variant, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      // `is_default` is projected as well as filtered: the engine resolves a filter
      // against the selected projection, so filtering on a column it was not asked to read
      // silently returns every variant.
      fields: ['id', 'product_id', 'sku', 'is_default'],
      filters: { product_id: { $in: unique }, is_default: { $eq: true } },
      // Room for more than one default per product so an ambiguous catalog is detected
      // rather than silently truncated to whichever row the page happened to include.
      page: { page: 1, pageSize: Math.min(unique.length * 4, 1000) },
    }),
  ])

  const defaultsByProduct = new Map<string, VariantRow[]>()
  for (const variant of variants.items) {
    const productId = String(variant.product_id)
    const bucket = defaultsByProduct.get(productId) ?? []
    bucket.push(variant)
    defaultsByProduct.set(productId, bucket)
  }

  const productsById = new Map(products.items.map((product) => [String(product.id), product]))
  const resolved = new Map<string, ResolvedCatalogLine>()

  for (const productId of unique) {
    const product = productsById.get(productId)
    if (!product) {
      throw goodsReceiptFieldError(validationFailed(translate), {
        lines: translate(
          'pz.goodsReceipts.errors.lineProductUnavailable',
          'One of the products is no longer available in the catalog.',
        ),
      })
    }
    const name = product.title ?? productId
    const defaults = defaultsByProduct.get(productId) ?? []
    if (defaults.length === 0) {
      throw goodsReceiptFieldError(validationFailed(translate), {
        lines: translate(
          'pz.goodsReceipts.errors.lineProductNoDefaultVariant',
          '{product} has no default variant, so it cannot be received.',
          { product: name },
        ),
      })
    }
    if (defaults.length > 1) {
      throw goodsReceiptFieldError(validationFailed(translate), {
        lines: translate(
          'pz.goodsReceipts.errors.lineProductAmbiguousVariant',
          '{product} has more than one default variant, so it cannot be received.',
          { product: name },
        ),
      })
    }
    const variant = defaults[0]
    resolved.set(productId, {
      catalogVariantId: String(variant.id),
      catalogSnapshot: {
        name,
        // The variant's SKU is the precise thing received; the product's is the fallback
        // for a single-variant product that carries its SKU on the product row.
        sku: variant.sku ?? product.sku ?? null,
      },
      productDefaultUnit: product.default_unit ?? null,
    })
  }

  return resolved
}

/**
 * Resolves whichever lines name a Purchase Order position, and refuses the save if any of
 * them cannot be honoured.
 *
 * Lines without a reference are left alone: a delivery that arrived without an order — a
 * sample, a warranty replacement — is an ordinary document here, not an incomplete one.
 */
export async function resolvePurchaseOrderLinks(
  ctx: CommandRuntimeContext,
  scope: GoodsReceiptScope,
  lines: readonly {
    catalogProductId: string
    purchaseOrderId: string | null
    purchaseOrderLineId: string | null
  }[],
  catalog: Map<string, ResolvedCatalogLine>,
  translate: TranslateFn,
): Promise<Map<string, PurchaseOrderLineReference>> {
  const requests = lines
    .filter((line) => line.purchaseOrderId && line.purchaseOrderLineId)
    .map((line) => ({
      purchaseOrderId: line.purchaseOrderId as string,
      purchaseOrderLineId: line.purchaseOrderLineId as string,
      // The variant the document will actually store, not something the caller supplied.
      catalogVariantId: (catalog.get(line.catalogProductId) as ResolvedCatalogLine).catalogVariantId,
    }))
  if (requests.length === 0) return new Map()

  const { resolved, failures } = await resolvePurchaseOrderReferences(ctx, scope, requests)
  if (failures.length > 0) {
    throw goodsReceiptFieldError(validationFailed(translate), {
      lines: purchaseOrderFailureMessage(failures[0], translate),
    })
  }
  return resolved
}

function purchaseOrderFailureMessage(
  failure: PurchaseOrderReferenceFailure,
  translate: TranslateFn,
): string {
  switch (failure.reason) {
    case 'order_not_released':
      return translate(
        'pz.goodsReceipts.errors.linePurchaseOrderNotReleased',
        'Only a released purchase order can be announced against.',
      )
    case 'variant_mismatch':
      return translate(
        'pz.goodsReceipts.errors.linePurchaseOrderVariantMismatch',
        'The purchase order line is for a different product than this position.',
      )
    case 'order_mismatch':
    case 'line_missing':
    default:
      return translate(
        'pz.goodsReceipts.errors.linePurchaseOrderUnavailable',
        'The purchase order line this position names is no longer available.',
      )
  }
}

export function buildUomSnapshot(unit: string | null, productDefaultUnit: string | null): GoodsReceiptUomSnapshot {
  return { code: unit ?? productDefaultUnit, productDefaultUnit }
}

/** The document date is a calendar day, so it is stored at UTC midnight of that day. */
export function toDocumentDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

function toIsoDay(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function serializeGoodsReceiptLine(line: GoodsReceiptLine): SerializedGoodsReceiptLine {
  return {
    id: String(line.id),
    lineNumber: line.lineNumber,
    catalogVariantId: line.catalogVariantId,
    catalogProductId: line.catalogProductId,
    catalogSnapshot: line.catalogSnapshot ?? null,
    quantity: line.quantity,
    unit: line.unit ?? null,
    uomSnapshot: line.uomSnapshot ?? null,
    purchaseOrderId: line.purchaseOrderId ?? null,
    purchaseOrderLineId: line.purchaseOrderLineId ?? null,
    purchaseOrderSnapshot: line.purchaseOrderSnapshot ?? null,
  }
}

export function serializeGoodsReceipt(
  receipt: GoodsReceipt,
  lines: readonly GoodsReceiptLine[],
): SerializedGoodsReceipt {
  return {
    id: String(receipt.id),
    tenantId: receipt.tenantId,
    organizationId: receipt.organizationId,
    documentNumber: receipt.documentNumber,
    documentDate: toIsoDay(receipt.documentDate),
    supplierName: receipt.supplierName,
    warehouseId: receipt.warehouseId,
    warehouseSnapshot: receipt.warehouseSnapshot ?? null,
    status: receipt.status,
    createdAt: toIso(receipt.createdAt),
    updatedAt: toIso(receipt.updatedAt),
    lines: [...lines]
      .sort((left, right) => left.lineNumber - right.lineNumber)
      .map(serializeGoodsReceiptLine),
  }
}


/**
 * Reads the aggregate back for a snapshot instead of trusting an in-memory collection.
 * A redo restores the header through a shared single-row helper, which hands back an
 * entity whose `lines` collection was never initialised — reading it there would throw
 * after the restore had already committed and emitted its effects.
 */
/**
 * Snapshots captured by the write itself, while it still held the row lock. Re-reading the
 * lines after the commit would let another writer's change into a snapshot this command
 * never persisted, so the reload below is only the fallback for entities that did not come
 * from one of this module's writes (a redo restores through a shared helper).
 */
const capturedAggregates = new WeakMap<GoodsReceipt, SerializedGoodsReceipt>()

/**
 * Redo results that changed nothing. They must not produce an undoable log entry: undoing
 * work that never happened is how one actor's edit gets overwritten by another's no-op.
 */
const redoNoOps = new WeakSet<GoodsReceipt>()

async function snapshotAggregate(
  ctx: CommandRuntimeContext,
  receipt: GoodsReceipt,
): Promise<SerializedGoodsReceipt> {
  const captured = capturedAggregates.get(receipt)
  if (captured) return captured
  const em = (ctx.container.resolve('em') as EntityManager).fork()
  return serializeGoodsReceipt(receipt, await findScopedLines(em, receipt.id, receipt))
}

/**
 * The foreign key does not constrain a line's duplicated scope to its header's, so every
 * read of an aggregate's lines repeats the header's trusted tenant and organization rather
 * than trusting the parent id alone.
 */
async function findScopedLines(
  em: EntityManager,
  receiptId: string,
  scope: { tenantId: string; organizationId: string },
): Promise<GoodsReceiptLine[]> {
  return em.find(GoodsReceiptLine, {
    goodsReceipt: receiptId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  } as FilterQuery<GoodsReceiptLine>)
}

async function parseInput(raw: unknown, translate: TranslateFn): Promise<GoodsReceiptWriteInput> {
  const parsed = parseGoodsReceiptWriteInput(raw, translate, { today: utcToday() })
  if (!parsed.ok) throw goodsReceiptFieldError(parsed.message, parsed.fields)
  return parsed.value
}

export function duplicateDocumentNumberError(translate: TranslateFn): CrudHttpError {
  return goodsReceiptFieldError(validationFailed(translate), {
    documentNumber: translate(
      'pz.goodsReceipts.errors.documentNumberTaken',
      'This Document Number is already used in your organization.',
    ),
  })
}

export function buildGoodsReceiptLine(
  em: EntityManager,
  args: {
    receipt: GoodsReceipt
    scope: GoodsReceiptScope
    lineNumber: number
    catalogProductId: string
    quantity: string
    unit: string | null
    resolved: ResolvedCatalogLine
    purchaseOrderId?: string | null
    purchaseOrderLineId?: string | null
    purchaseOrderSnapshot?: GoodsReceiptPurchaseOrderSnapshot | null
    now: Date
  },
): GoodsReceiptLine {
  return em.create(GoodsReceiptLine, {
    id: randomUUID(),
    goodsReceipt: args.receipt,
    tenantId: args.scope.tenantId,
    organizationId: args.scope.organizationId,
    lineNumber: args.lineNumber,
    catalogVariantId: args.resolved.catalogVariantId,
    catalogProductId: args.catalogProductId,
    catalogSnapshot: args.resolved.catalogSnapshot,
    quantity: args.quantity,
    unit: args.unit ?? args.resolved.productDefaultUnit,
    uomSnapshot: buildUomSnapshot(args.unit, args.resolved.productDefaultUnit),
    purchaseOrderId: args.purchaseOrderId ?? null,
    purchaseOrderLineId: args.purchaseOrderLineId ?? null,
    purchaseOrderSnapshot: args.purchaseOrderSnapshot ?? null,
    createdAt: args.now,
    updatedAt: args.now,
  })
}

/** Rebuilds the header seed from a snapshot; `lines` are restored separately. */
function headerSeedFromSnapshot(snapshot: SerializedGoodsReceipt): Record<string, unknown> {
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    organizationId: snapshot.organizationId,
    documentNumber: snapshot.documentNumber,
    documentDate: toDocumentDate(snapshot.documentDate),
    supplierName: snapshot.supplierName,
    warehouseId: snapshot.warehouseId,
    warehouseSnapshot: snapshot.warehouseSnapshot,
    status: snapshot.status,
    createdAt: new Date(snapshot.createdAt),
    updatedAt: new Date(snapshot.updatedAt),
    deletedAt: null,
  }
}

/**
 * Undo and redo run outside any route, so the scope they may act under is the caller's
 * current one — and it has to match the scope the snapshot was taken in. Both halves are
 * compared: an undo issued while another organization is selected is refused, not quietly
 * consumed against no row.
 */
function requireUndoScope(
  ctx: CommandRuntimeContext,
  snapshot: Pick<SerializedGoodsReceipt, 'tenantId' | 'organizationId'>,
  translate: TranslateFn,
): GoodsReceiptScope {
  const scope = ensureGoodsReceiptScope(ctx, translate)
  if (snapshot.tenantId !== scope.tenantId || snapshot.organizationId !== scope.organizationId) {
    throw new CrudHttpError(403, {
      error: translate('pz.goodsReceipts.errors.undoScope', 'Undo is not allowed from this tenant and organization.'),
    })
  }
  return scope
}

function restoreHeaderFromSnapshot(receipt: GoodsReceipt, snapshot: SerializedGoodsReceipt): void {
  receipt.documentNumber = snapshot.documentNumber
  receipt.documentDate = toDocumentDate(snapshot.documentDate)
  receipt.supplierName = snapshot.supplierName
  receipt.warehouseId = snapshot.warehouseId
  receipt.warehouseSnapshot = snapshot.warehouseSnapshot
  receipt.status = snapshot.status
  receipt.updatedAt = new Date(snapshot.updatedAt)
}

/** Rebuilds one line exactly as it was, under its original id. */
function createLineFromSnapshot(
  em: EntityManager,
  receipt: GoodsReceipt,
  snapshot: SerializedGoodsReceipt,
  line: SerializedGoodsReceiptLine,
): GoodsReceiptLine {
  return em.create(GoodsReceiptLine, {
    id: line.id,
    goodsReceipt: receipt,
    tenantId: snapshot.tenantId,
    organizationId: snapshot.organizationId,
    lineNumber: line.lineNumber,
    catalogVariantId: line.catalogVariantId,
    catalogProductId: line.catalogProductId,
    catalogSnapshot: line.catalogSnapshot,
    quantity: line.quantity,
    unit: line.unit,
    uomSnapshot: line.uomSnapshot,
    // Restored verbatim: undo has to put back the document as it stood, and re-resolving
    // the reference could quietly drop a link whose order has since been withdrawn.
    purchaseOrderId: line.purchaseOrderId,
    purchaseOrderLineId: line.purchaseOrderLineId,
    purchaseOrderSnapshot: line.purchaseOrderSnapshot,
    createdAt: new Date(snapshot.createdAt),
    updatedAt: new Date(snapshot.updatedAt),
  })
}

const restoreCreatedGoodsReceipt = makeCreateRedo<GoodsReceipt, SerializedGoodsReceipt, Record<string, unknown>, GoodsReceipt>({
  entityClass: GoodsReceipt,
  getSnapshotId: (snapshot) => snapshot.id,
  seedFromSnapshot: headerSeedFromSnapshot,
  buildResult: (entity) => entity,
  events: goodsReceiptCrudEvents,
  indexer: goodsReceiptCrudIndexer,
  transaction: true,
  afterRestore: async ({ em, entity, snapshot }) => {
    if (!snapshot.lines.length) return
    const existing = await findScopedLines(em, entity.id, snapshot)
    const present = new Set(existing.map((line) => String(line.id)))
    for (const line of snapshot.lines) {
      if (present.has(line.id)) continue
      em.persist(
        em.create(GoodsReceiptLine, {
          id: line.id,
          goodsReceipt: entity,
          tenantId: snapshot.tenantId,
          organizationId: snapshot.organizationId,
          lineNumber: line.lineNumber,
          catalogVariantId: line.catalogVariantId,
          catalogProductId: line.catalogProductId,
          catalogSnapshot: line.catalogSnapshot,
          quantity: line.quantity,
          unit: line.unit,
          uomSnapshot: line.uomSnapshot,
          createdAt: new Date(snapshot.createdAt),
          updatedAt: new Date(snapshot.updatedAt),
        }),
      )
    }
  },
})

/**
 * A document number freed by the undo may legitimately have been taken by someone else in
 * the meantime. The shared helper reports that as an untranslated developer message, which
 * is not what the person clicking redo should read.
 */
async function restoreGoodsReceipt(args: {
  input: Record<string, unknown>
  ctx: CommandRuntimeContext
  logEntry: CommandUndoLogEntry
}): Promise<GoodsReceipt> {
  try {
    return await restoreCreatedGoodsReceipt(args)
  } catch (error) {
    if (isUniqueViolation(error) || (isCrudHttpError(error) && error.status === 409)) {
      const { translate } = await resolveTranslations()
      throw conflict(
        translate(
          'pz.goodsReceipts.errors.redoDocumentNumberTaken',
          'This Document Number has been used by another goods receipt since, so this one cannot be restored.',
        ),
      )
    }
    throw error
  }
}

const createGoodsReceiptCommand: CommandHandler<Record<string, unknown>, GoodsReceipt> = {
  id: 'pz.goodsReceipts.create',
  isUndoable: true,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const input = await parseInput(rawInput, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    if (await findByDocumentNumber(em, scope, input.documentNumber)) {
      throw duplicateDocumentNumberError(translate)
    }
    await requireWarehouse(ctx, scope, input.warehouseId, translate)
    const catalog = await resolveCatalogLines(
      ctx,
      scope,
      input.lines.map((line) => line.catalogProductId),
      translate,
    )
    const purchaseOrderLinks = await resolvePurchaseOrderLinks(ctx, scope, input.lines, catalog, translate)

    const now = new Date()
    const receipt = em.create(GoodsReceipt, {
      id: randomUUID(),
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      documentNumber: input.documentNumber,
      documentDate: toDocumentDate(input.documentDate),
      supplierName: input.supplierName,
      warehouseId: input.warehouseId,
      // The warehouse snapshot is taken at confirmation, not here: a draft still points at
      // live warehouse state and is allowed to follow a rename (ADR-0007).
      warehouseSnapshot: null,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    })
    const lines = input.lines.map((line, index) => {
      const link = line.purchaseOrderLineId ? purchaseOrderLinks.get(line.purchaseOrderLineId) : undefined
      return buildGoodsReceiptLine(em, {
        receipt,
        scope,
        lineNumber: index + 1,
        catalogProductId: line.catalogProductId,
        quantity: line.quantity,
        unit: line.unit,
        resolved: catalog.get(line.catalogProductId) as ResolvedCatalogLine,
        purchaseOrderId: link?.purchaseOrderId ?? null,
        purchaseOrderLineId: link?.purchaseOrderLineId ?? null,
        purchaseOrderSnapshot: link?.snapshot ?? null,
        now,
      })
    })

    try {
      await runCrudCommandWrite<GoodsReceipt>({
        ctx,
        em,
        entityId: GOODS_RECEIPT_ENTITY_ID,
        action: 'created',
        scope,
        events: goodsReceiptCrudEvents,
        indexer: goodsReceiptCrudIndexer,
        syncOrigin: ctx.syncOrigin,
        // Header and lines commit together or not at all, so a failed save leaves no
        // header behind for someone to find later and wonder about.
        phases: [
          ({ em: tx }) => {
            tx.persist(receipt)
          },
          ({ em: tx }) => {
            for (const line of lines) tx.persist(line)
          },
        ],
        sideEffect: () => ({
          entity: receipt,
          identifiers: {
            id: String(receipt.id),
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
          },
        }),
      })
    } catch (error) {
      // The unique index is the real guard against two people entering the same delivery
      // at once; the read above only makes the common case a friendly message.
      if (isUniqueViolation(error, DOCUMENT_NUMBER_UNIQUE_INDEX)) throw duplicateDocumentNumberError(translate)
      throw error
    }

    capturedAggregates.set(receipt, serializeGoodsReceipt(receipt, lines))
    return receipt
  },
  captureAfter: (_input, result, ctx) => snapshotAggregate(ctx, result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('pz.audit.goodsReceipts.create', 'Create goods receipt'),
      resourceKind: 'pz.goods_receipt',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      // `captureAfter` already read the aggregate back; reloading it here would open a
      // second post-commit failure window and could log something the command never returned.
      snapshotAfter: snapshots.after as SerializedGoodsReceipt,
    }
  },
  async undo({ logEntry, ctx }) {
    const snapshot = extractUndoPayload<UndoPayload<SerializedGoodsReceipt>>(logEntry)?.after ?? null
    const id = snapshot?.id ?? logEntry.resourceId ?? null
    if (!id) throw new Error('[internal] Missing goods receipt id for undo')
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    // Both halves of the scope, not just the tenant: an undo issued while another
    // organization is selected must be refused, not quietly consumed against no row.
    if (snapshot && (snapshot.tenantId !== scope.tenantId || snapshot.organizationId !== scope.organizationId)) {
      throw new CrudHttpError(403, {
        error: translate('pz.goodsReceipts.errors.undoScope', 'Undo scope does not match this tenant and organization.'),
      })
    }

    const dataEngine = ctx.container.resolve<DataEngine>('dataEngine')
    const removed = await dataEngine.deleteOrmEntity({
      entity: GoodsReceipt,
      where: {
        id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      } as FilterQuery<GoodsReceipt>,
      soft: true,
      softDeleteField: 'deletedAt',
    })
    // Already undone — a retry after a partial failure must not re-emit effects for a
    // removal that has already happened.
    if (!removed) return
    await emitCrudUndoSideEffects({
      dataEngine,
      action: 'deleted',
      entity: removed,
      identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      syncOrigin: ctx.syncOrigin,
      events: goodsReceiptCrudEvents,
      // Undo runs outside any route, so no route-level indexer declaration is active here.
      indexer: goodsReceiptCrudIndexer,
    })
  },
  /**
   * Redo restores the original aggregate under its original ids rather than replaying
   * `execute`, which would mint a new goods receipt and leave the first one's lines
   * pointing at a soft-deleted header.
   */
  redo: (args) => restoreGoodsReceipt(args),
}

registerCommand(createGoodsReceiptCommand)

/**
 * Reads a goods receipt for a write and holds it until the transaction commits.
 *
 * The row is locked, so scope, status and version cannot change between their checks and
 * the write. Checking outside the transaction
 * would leave a window in which a concurrent confirmation commits and this write then
 * overwrites or deletes a confirmed document (ADR-0006).
 */
async function lockReceiptForWrite(
  em: EntityManager,
  scope: GoodsReceiptScope,
  id: string,
  translate: TranslateFn,
): Promise<GoodsReceipt> {
  const receipt = assertFound(
    await em.findOne(
      GoodsReceipt,
      {
        id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      } as FilterQuery<GoodsReceipt>,
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    ),
    translate('pz.goodsReceipts.errors.notFound', 'That goods receipt no longer exists.'),
  )
  return receipt
}

function assertGoodsReceiptVersion(receipt: GoodsReceipt, id: string, expectedVersion: string): void {
  assertOptimisticLock({
    resourceKind: GOODS_RECEIPT_ENTITY_ID,
    resourceId: id,
    expected: expectedVersion,
    current: receipt.updatedAt,
  })
}

export function assertGoodsReceiptEditable(
  receipt: Pick<GoodsReceipt, 'status'>,
  translate: TranslateFn,
): void {
  if (!FROZEN_GOODS_RECEIPT_STATUSES.includes(receipt.status)) return
  throw conflict(
    receipt.status === 'receiving'
      ? translate(
          'pz.goodsReceipts.errors.receivingImmutable',
          'This goods receipt is being counted against and can no longer be changed.',
        )
      : translate(
          'pz.goodsReceipts.errors.confirmedImmutable',
          'A confirmed goods receipt can no longer be changed.',
        ),
  )
}

async function lockDraftForWrite(
  em: EntityManager,
  scope: GoodsReceiptScope,
  id: string,
  expectedVersion: string,
  translate: TranslateFn,
): Promise<GoodsReceipt> {
  const receipt = await lockReceiptForWrite(em, scope, id, translate)
  assertGoodsReceiptEditable(receipt, translate)
  assertGoodsReceiptVersion(receipt, id, expectedVersion)
  return receipt
}

/** Loads the aggregate for a before-snapshot, without taking a lock. */
async function readAggregateForSnapshot(
  em: EntityManager,
  scope: GoodsReceiptScope,
  id: string,
  translate: TranslateFn,
): Promise<SerializedGoodsReceipt> {
  const receipt = assertFound(
    await em.findOne(GoodsReceipt, {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<GoodsReceipt>),
    translate('pz.goodsReceipts.errors.notFound', 'That goods receipt no longer exists.'),
  )
  return serializeGoodsReceipt(receipt, await findScopedLines(em, String(receipt.id), scope))
}

/**
 * The installed lock helper is deliberately additive: it does nothing when the caller sends
 * no version, so every existing consumer keeps working. A goods receipt cannot afford that
 * — an edit or a delete issued without a version would silently win over whatever anyone
 * else had saved — so this module requires one.
 */
function requireExpectedVersion(ctx: CommandRuntimeContext, translate: TranslateFn): string {
  const expected = readOptimisticLockExpected(ctx.request ?? null)
  // An unparseable token is worse than a missing one: `assertOptimisticLock` cannot compare
  // it and returns silently, so `garbage` would sail through the guard it looks like it
  // satisfied. Both are refused here.
  const parsed = expected ? new Date(expected) : null
  if (!expected || !parsed || Number.isNaN(parsed.getTime())) {
    throw badRequest(
      translate(
        'pz.goodsReceipts.errors.versionRequired',
        'Send the record version you are working from, as an ISO timestamp, in the optimistic-lock header.',
      ),
    )
  }
  return expected
}

function requireRecordId(raw: unknown, translate: TranslateFn): string {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const body = source.body && typeof source.body === 'object' ? (source.body as Record<string, unknown>) : {}
  const query = source.query && typeof source.query === 'object' ? (source.query as Record<string, unknown>) : {}
  const id = [source.id, body.id, query.id].find((value) => typeof value === 'string' && value.length > 0)
  if (typeof id !== 'string') {
    throw badRequest(translate('pz.goodsReceipts.errors.idRequired', 'A goods receipt identifier is required.'))
  }
  return id
}

/**
 * Stable text for a snapshot, with object keys sorted.
 *
 * The jsonb columns come back with their keys in Postgres' own order — `{ sku, name }`
 * where the code wrote `{ name, sku }` — so a plain `JSON.stringify` comparison would call
 * an untouched document changed.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  return value
}

/** Compares an aggregate against a snapshot, ignoring the version stamp that always moves. */
function aggregateMatchesSnapshot(
  receipt: GoodsReceipt,
  lines: readonly GoodsReceiptLine[],
  snapshot: SerializedGoodsReceipt,
): boolean {
  const strip = ({ updatedAt: _updatedAt, ...rest }: SerializedGoodsReceipt) => rest
  const current = JSON.stringify(canonicalize(strip(serializeGoodsReceipt(receipt, lines))))
  return current === JSON.stringify(canonicalize(strip(snapshot)))
}

/**
 * Undo is only safe while the record still looks exactly as the action left it. Anything
 * else — a later edit, a confirmation, a second undo — means restoring the snapshot would
 * throw away work nobody asked to lose, so it is refused instead. Restoring onto a
 * confirmed document would also reopen a one-way transition through the back door.
 */
function assertUndoableState(
  receipt: GoodsReceipt,
  lines: readonly GoodsReceiptLine[],
  after: SerializedGoodsReceipt | null,
  translate: TranslateFn,
): void {
  if (!after || !aggregateMatchesSnapshot(receipt, lines, after)) {
    throw conflict(
      translate(
        'pz.goodsReceipts.errors.undoStale',
        'This goods receipt has changed since that action, so it can no longer be undone.',
      ),
    )
  }
}

/**
 * Re-applies an aggregate snapshot under the row lock.
 *
 * Redo cannot simply replay `execute`: the standard redo UI sends only a log id, and these
 * commands require the record version a caller was shown — replaying would fail every time
 * with "send the version". So redo restores the state the action produced, and only from
 * the state its undo left behind. Already being in the target state is success with no
 * further effects, so a retry is harmless.
 */
async function redoAggregateState(
  ctx: CommandRuntimeContext,
  target: SerializedGoodsReceipt,
  expected: SerializedGoodsReceipt | null,
  options: { deleted: boolean },
): Promise<GoodsReceipt> {
  const { translate } = await resolveTranslations()
  const scope = requireUndoScope(ctx, target, translate)
  const em = (ctx.container.resolve('em') as EntityManager).fork()
  let receipt!: GoodsReceipt
  let redoneLines: GoodsReceiptLine[] = []
  let alreadyApplied = false

  try {
    await withAtomicFlush(
      em,
      [
        async () => {
          receipt = assertFound(
            await em.findOne(
              GoodsReceipt,
              {
                id: target.id,
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
              } as FilterQuery<GoodsReceipt>,
              { lockMode: LockMode.PESSIMISTIC_WRITE },
            ),
            translate('pz.goodsReceipts.errors.notFound', 'That goods receipt no longer exists.'),
          )
          const lines = await findScopedLines(em, target.id, scope)

          // Redoing a delete never treats an already-deleted row as a quiet success: it
          // could have been deleted by someone else in the meantime, and a no-op would
          // still mint an undoable delete log — undoing which would restore THEIR deletion.
          if (!options.deleted && receipt.deletedAt == null && aggregateMatchesSnapshot(receipt, lines, target)) {
            alreadyApplied = true
            // Taken under the lock even on this path, so nothing reloads the lines after
            // the transaction and picks up a later actor's edit.
            capturedAggregates.set(receipt, serializeGoodsReceipt(receipt, lines))
            redoNoOps.add(receipt)
            return
          }

          if (receipt.deletedAt != null || !expected || !aggregateMatchesSnapshot(receipt, lines, expected)) {
            throw conflict(
              translate(
                'pz.goodsReceipts.errors.redoStale',
                'This goods receipt has changed since that action was undone, so it cannot be redone.',
              ),
            )
          }
          if (!options.deleted) for (const line of lines) em.remove(line)
        },
        () => {
          if (alreadyApplied) return
          if (options.deleted) {
            const now = new Date()
            receipt.deletedAt = now
            receipt.updatedAt = now
            em.persist(receipt)
            return
          }
          restoreHeaderFromSnapshot(receipt, target)
          em.persist(receipt)
          redoneLines = target.lines.map((line) => createLineFromSnapshot(em, receipt, target, line))
          for (const line of redoneLines) em.persist(line)
        },
        () => {
          if (alreadyApplied) return
          // Recorded while the lock is still held: reloading after the commit could pick
          // up another actor's lines and put them in this redo's log, so undoing the redo
          // would overwrite their edit.
          capturedAggregates.set(receipt, options.deleted ? target : serializeGoodsReceipt(receipt, redoneLines))
        },
      ],
      { transaction: true },
    )
  } catch (error) {
    // Undo freed the Document Number, and someone may legitimately have taken it before
    // the redo. That is an answer the user can act on, not a write failure.
    if (isUniqueViolation(error, DOCUMENT_NUMBER_UNIQUE_INDEX)) {
      throw conflict(
        translate(
          'pz.goodsReceipts.errors.redoDocumentNumberTaken',
          'This Document Number has been used by another goods receipt since, so this one cannot be redone.',
        ),
      )
    }
    throw error
  }

  if (!alreadyApplied) {
    const dataEngine = ctx.container.resolve<DataEngine>('dataEngine')
    await emitCrudSideEffects({
      dataEngine,
      action: options.deleted ? 'deleted' : 'updated',
      entity: receipt,
      identifiers: { id: target.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      syncOrigin: ctx.syncOrigin,
      events: goodsReceiptCrudEvents,
      indexer: goodsReceiptCrudIndexer,
    })
  }

  return receipt
}


const updateGoodsReceiptCommand: CommandHandler<Record<string, unknown>, GoodsReceipt> = {
  id: 'pz.goodsReceipts.update',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return { before: await readAggregateForSnapshot(em, scope, requireRecordId(rawInput, translate), translate) }
  },
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const id = requireRecordId(rawInput, translate)
    const expectedVersion = requireExpectedVersion(ctx, translate)
    const input = await parseInput(rawInput, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    await requireWarehouse(ctx, scope, input.warehouseId, translate)
    const catalog = await resolveCatalogLines(
      ctx,
      scope,
      input.lines.map((line) => line.catalogProductId),
      translate,
    )
    const purchaseOrderLinks = await resolvePurchaseOrderLinks(ctx, scope, input.lines, catalog, translate)

    let receipt!: GoodsReceipt
    let replacements: GoodsReceiptLine[] = []
    try {
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
            receipt = await lockDraftForWrite(tx, scope, id, expectedVersion, translate)
          },
          async ({ em: tx }) => {
            if (await findByDocumentNumber(tx, scope, input.documentNumber, id)) {
              throw duplicateDocumentNumberError(translate)
            }
            // Lines are replaced wholesale: they carry no identity a user recognises, and
            // reconciling them row by row would only invent one.
            for (const line of await findScopedLines(tx, id, scope)) tx.remove(line)
          },
          ({ em: tx }) => {
            const now = new Date()
            receipt.documentNumber = input.documentNumber
            receipt.documentDate = toDocumentDate(input.documentDate)
            receipt.supplierName = input.supplierName
            receipt.warehouseId = input.warehouseId
            receipt.updatedAt = now
            replacements = input.lines.map((line, index) => {
              const link = line.purchaseOrderLineId ? purchaseOrderLinks.get(line.purchaseOrderLineId) : undefined
              return buildGoodsReceiptLine(tx, {
                receipt,
                scope,
                lineNumber: index + 1,
                catalogProductId: line.catalogProductId,
                quantity: line.quantity,
                unit: line.unit,
                resolved: catalog.get(line.catalogProductId) as ResolvedCatalogLine,
                purchaseOrderId: link?.purchaseOrderId ?? null,
                purchaseOrderLineId: link?.purchaseOrderLineId ?? null,
                purchaseOrderSnapshot: link?.snapshot ?? null,
                now,
              })
            })
            tx.persist(receipt)
            for (const line of replacements) tx.persist(line)
          },
        ],
        sideEffect: () => ({
          entity: receipt,
          identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
        }),
      })
    } catch (error) {
      if (isUniqueViolation(error, DOCUMENT_NUMBER_UNIQUE_INDEX)) throw duplicateDocumentNumberError(translate)
      throw error
    }

    capturedAggregates.set(receipt, serializeGoodsReceipt(receipt, replacements))
    return receipt
  },
  captureAfter: (_input, result, ctx) => snapshotAggregate(ctx, result),
  buildLog: async ({ result, snapshots }) => {
    // A redo that found the document already in its target state changed nothing, and an
    // undoable log for it would let a later undo overwrite whatever came after.
    if (redoNoOps.has(result)) return { skipLog: true }
    const { translate } = await resolveTranslations()
    const before = (snapshots.before as SerializedGoodsReceipt | undefined) ?? null
    const after = snapshots.after as SerializedGoodsReceipt
    return {
      actionLabel: translate('pz.audit.goodsReceipts.update', 'Update goods receipt'),
      resourceKind: 'pz.goods_receipt',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      changes: buildChanges(before, after as unknown as Record<string, unknown>, [
        'documentNumber',
        'documentDate',
        'supplierName',
        'warehouseId',
      ]),
      snapshotBefore: before,
      snapshotAfter: after,
    }
  },
  async undo({ logEntry, ctx }) {
    const payload = extractUndoPayload<UndoPayload<SerializedGoodsReceipt>>(logEntry)
    const before = payload?.before ?? null
    const after = payload?.after ?? null
    if (!before?.id) throw new Error('[internal] Missing previous goods receipt snapshot for undo')
    const { translate } = await resolveTranslations()
    const scope = requireUndoScope(ctx, before, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let receipt: GoodsReceipt | null = null
    let alreadyRestored = false

    await withAtomicFlush(
      em,
      [
        async () => {
          receipt = await em.findOne(
            GoodsReceipt,
            {
              id: before.id,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
            } as FilterQuery<GoodsReceipt>,
            { lockMode: LockMode.PESSIMISTIC_WRITE },
          )
          if (!receipt) return
          if (receipt.deletedAt != null) {
            // The document was deleted after this edit. Undoing the edit would mutate a
            // deleted record and burn the undo, and undoing the delete afterwards would
            // then restore the post-edit state nobody asked for.
            throw conflict(
              translate(
                'pz.goodsReceipts.errors.undoDeleted',
                'This goods receipt has since been deleted, so that edit can no longer be undone.',
              ),
            )
          }
          const lines = await findScopedLines(em, before.id, scope)
          // A retry after a partial failure finds the snapshot already back in place;
          // repeating the write — and its effects — would be the bug, not the fix.
          if (aggregateMatchesSnapshot(receipt, lines, before)) {
            alreadyRestored = true
            return
          }
          assertUndoableState(receipt, lines, after, translate)
          for (const line of lines) em.remove(line)
        },
        () => {
          if (!receipt || alreadyRestored) return
          restoreHeaderFromSnapshot(receipt, before)
          em.persist(receipt)
          for (const line of before.lines) em.persist(createLineFromSnapshot(em, receipt, before, line))
        },
      ],
      { transaction: true },
    )

    // Nothing to put back, or nothing left to do.
    if (!receipt || alreadyRestored) return

    const dataEngine = ctx.container.resolve<DataEngine>('dataEngine')
    await emitCrudUndoSideEffects({
      dataEngine,
      action: 'updated',
      entity: receipt,
      identifiers: { id: before.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      syncOrigin: ctx.syncOrigin,
      events: goodsReceiptCrudEvents,
      indexer: goodsReceiptCrudIndexer,
    })
  },
  async redo({ logEntry, ctx }) {
    const after = resolveRedoSnapshot<SerializedGoodsReceipt>(logEntry)
    const before = extractUndoPayload<UndoPayload<SerializedGoodsReceipt>>(logEntry)?.before ?? null
    if (!after?.id) throw new Error('[internal] Missing goods receipt snapshot for redo')
    return redoAggregateState(ctx, after, before, { deleted: false })
  },
}

const deleteGoodsReceiptCommand: CommandHandler<Record<string, unknown>, GoodsReceipt> = {
  id: 'pz.goodsReceipts.delete',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return { before: await readAggregateForSnapshot(em, scope, requireRecordId(rawInput, translate), translate) }
  },
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const id = requireRecordId(rawInput, translate)
    const expectedVersion = requireExpectedVersion(ctx, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let receipt!: GoodsReceipt

    await runCrudCommandWrite<GoodsReceipt>({
      ctx,
      em,
      entityId: GOODS_RECEIPT_ENTITY_ID,
      action: 'deleted',
      scope,
      events: goodsReceiptCrudEvents,
      indexer: goodsReceiptCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: tx }) => {
          receipt = await lockDraftForWrite(tx, scope, id, expectedVersion, translate)
        },
        ({ em: tx }) => {
          // Soft, and inside the same transaction that verified the draft: the partial
          // unique index stops seeing the row, so the Document Number is free again the
          // moment this commits.
          const now = new Date()
          receipt.deletedAt = now
          receipt.updatedAt = now
          tx.persist(receipt)
        },
      ],
      sideEffect: () => ({
        entity: receipt,
        identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    return receipt
  },
  buildLog: async ({ snapshots, input }) => {
    const { translate } = await resolveTranslations()
    const before = (snapshots.before as SerializedGoodsReceipt | undefined) ?? null
    return {
      actionLabel: translate('pz.audit.goodsReceipts.delete', 'Delete goods receipt'),
      resourceKind: 'pz.goods_receipt',
      resourceId: before?.id ?? requireRecordId(input, translate),
      tenantId: before?.tenantId ?? null,
      organizationId: before?.organizationId ?? null,
      snapshotBefore: before,
    }
  },
  async undo({ logEntry, ctx }) {
    const before = extractUndoPayload<UndoPayload<SerializedGoodsReceipt>>(logEntry)?.before ?? null
    if (!before?.id) throw new Error('[internal] Missing goods receipt snapshot for undo')
    const { translate } = await resolveTranslations()
    const scope = requireUndoScope(ctx, before, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let receipt: GoodsReceipt | null = null
    let alreadyRestored = false

    try {
      await withAtomicFlush(
        em,
        [
          async () => {
            receipt = await em.findOne(
              GoodsReceipt,
              {
                id: before.id,
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
              } as FilterQuery<GoodsReceipt>,
              { lockMode: LockMode.PESSIMISTIC_WRITE },
            )
            if (!receipt) return
            // Undoing a delete twice must not re-emit effects.
            if (receipt.deletedAt == null) {
              alreadyRestored = true
              return
            }
            receipt.deletedAt = null
            restoreHeaderFromSnapshot(receipt, before)
            em.persist(receipt)
          },
          async () => {
            if (!receipt || alreadyRestored) return
            const present = new Set((await findScopedLines(em, before.id, scope)).map((line) => String(line.id)))
            for (const line of before.lines) {
              if (present.has(line.id)) continue
              em.persist(createLineFromSnapshot(em, receipt, before, line))
            }
          },
        ],
        { transaction: true },
      )
    } catch (error) {
      // Deleting a draft frees its Document Number, and someone may legitimately have
      // taken it since. That is a real answer, not a write failure.
      if (isUniqueViolation(error, DOCUMENT_NUMBER_UNIQUE_INDEX)) {
        throw conflict(
          translate(
            'pz.goodsReceipts.errors.undoDocumentNumberTaken',
            'This Document Number has been used by another goods receipt since, so this one cannot be restored.',
          ),
        )
      }
      throw error
    }

    if (!receipt || alreadyRestored) return

    const dataEngine = ctx.container.resolve<DataEngine>('dataEngine')
    await emitCrudUndoSideEffects({
      dataEngine,
      action: 'updated',
      entity: receipt,
      identifiers: { id: before.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      syncOrigin: ctx.syncOrigin,
      events: goodsReceiptCrudEvents,
      indexer: goodsReceiptCrudIndexer,
    })
  },
  async redo({ logEntry, ctx }) {
    // Redoing a delete means deleting again, from exactly the state its undo restored.
    const before = extractUndoPayload<UndoPayload<SerializedGoodsReceipt>>(logEntry)?.before ?? null
    if (!before?.id) throw new Error('[internal] Missing goods receipt snapshot for redo')
    return redoAggregateState(ctx, before, before, { deleted: true })
  },
}

registerCommand(updateGoodsReceiptCommand)
registerCommand(deleteGoodsReceiptCommand)

/**
 * Claims each linked line's quantity on the purchase order it names.
 *
 * `pz` owns the announcement; `procurements` owns how much of an order may still be
 * announced. The two meet over the command bus — a command id, not an import — so neither
 * module compiles against the other's entities and a build without `procurements` still has
 * a working goods receipt.
 *
 * The reservation commits in its own transaction, so it is deliberately idempotent on the
 * document id: if this release fails after it, the retry reuses the same claims instead of
 * adding a second set. The residue that leaves — a claim held by a document that never
 * reached the floor — understates what is free to announce and is cleared by withdrawing.
 * The opposite residue, a released document holding no claim, would let the same order be
 * announced twice, so the order of these two steps is not interchangeable.
 */
async function reservePurchaseOrderQuantities(
  ctx: CommandRuntimeContext,
  scope: GoodsReceiptScope,
  receipt: GoodsReceipt,
  lines: readonly GoodsReceiptLine[],
  translate: TranslateFn,
): Promise<void> {
  const linked = lines.filter((line) => line.purchaseOrderId && line.purchaseOrderLineId)
  if (linked.length === 0) return

  const commandBus = ctx.container.resolve('commandBus') as CommandBus
  try {
    await commandBus.execute('procurements.commitments.reserve', {
      input: {
        sourceType: 'awizo',
        sourceDocumentId: String(receipt.id),
        sourceDocumentNumber: receipt.documentNumber,
        lines: linked.map((line) => ({
          purchaseOrderLineId: String(line.purchaseOrderLineId),
          sourceLineId: String(line.id),
          quantity: String(line.quantity),
          lineNumber: line.lineNumber,
        })),
      },
      ctx,
    })
  } catch (error) {
    // A refusal from purchasing is the user's answer — over the free limit, or an order that
    // is no longer released — and reaches the caller unchanged.
    if (isCrudHttpError(error)) throw error
    logger.error('Reserving purchase order quantities failed', { err: error, receiptId: String(receipt.id) })
    throw conflict(
      translate(
        'pz.goodsReceipts.errors.purchaseOrderReserveFailed',
        'The purchase order quantities this delivery announces could not be reserved, so it was not released.',
      ),
    )
  }
}

/**
 * Hands a document's claims back. Releasing nothing is success: a delivery with no purchase
 * order behind it must still be withdrawable.
 */
async function releasePurchaseOrderQuantities(
  ctx: CommandRuntimeContext,
  receiptId: string,
): Promise<void> {
  const commandBus = ctx.container.resolve('commandBus') as CommandBus
  await commandBus.execute('procurements.commitments.release', {
    input: { sourceType: 'awizo', sourceDocumentId: receiptId },
    ctx,
  })
}

const releaseGoodsReceiptCommand: CommandHandler<Record<string, unknown>, GoodsReceipt> = {
  id: 'pz.goodsReceipts.release',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const id = requireRecordId(rawInput, translate)
    const expectedVersion = requireExpectedVersion(ctx, translate)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let receipt!: GoodsReceipt

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
          receipt = await lockReceiptForWrite(tx, scope, id, translate)
          if (receipt.status !== 'draft') {
            throw conflict(translate('pz.goodsReceipts.errors.notDraft', 'Only a draft goods receipt can be released.'))
          }
          assertGoodsReceiptVersion(receipt, id, expectedVersion)
        },
        async ({ em: tx }) => {
          // Releasing to the floor is the moment an announcement becomes a claim on the
          // purchase order. It happens after the state and version have been checked under
          // lock, so nothing is claimed for a document that is not about to be released.
          await reservePurchaseOrderQuantities(ctx, scope, receipt, await findScopedLines(tx, id, scope), translate)
        },
        ({ em: tx }) => {
          receipt.status = 'receiving'
          receipt.updatedAt = new Date()
          tx.persist(receipt)
        },
      ],
      sideEffect: () => ({
        entity: receipt,
        identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })
    return receipt
  },
  captureAfter: (_input, result, ctx) => snapshotAggregate(ctx, result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('pz.audit.goodsReceipts.release', 'Release goods receipt to receiving'),
      resourceKind: 'pz.goods_receipt',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: snapshots.after as SerializedGoodsReceipt,
    }
  },
}

const withdrawGoodsReceiptCommand: CommandHandler<Record<string, unknown>, GoodsReceipt> = {
  id: 'pz.goodsReceipts.withdraw',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const id = requireRecordId(rawInput, translate)
    const expectedVersion = requireExpectedVersion(ctx, translate)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let receipt!: GoodsReceipt

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
          receipt = await lockReceiptForWrite(tx, scope, id, translate)
          if (receipt.status !== 'receiving') {
            throw conflict(translate('pz.goodsReceipts.errors.notReceiving', 'This goods receipt is not receiving.'))
          }
          assertGoodsReceiptVersion(receipt, id, expectedVersion)
          const palletCount = await tx.count(Pallet, {
            goodsReceipt: id,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
          } as FilterQuery<Pallet>)
          if (palletCount > 0) {
            throw conflict(
              translate('pz.goodsReceipts.errors.withdrawHasPallets', 'A goods receipt with pallets cannot be withdrawn.'),
            )
          }
        },
        async () => {
          // Back to a draft means the delivery is no longer scheduled, so whatever it claimed
          // from its purchase orders goes back to their free quantity.
          await releasePurchaseOrderQuantities(ctx, id)
        },
        ({ em: tx }) => {
          receipt.status = 'draft'
          receipt.updatedAt = new Date()
          tx.persist(receipt)
        },
      ],
      sideEffect: () => ({
        entity: receipt,
        identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })
    return receipt
  },
  captureAfter: (_input, result, ctx) => snapshotAggregate(ctx, result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('pz.audit.goodsReceipts.withdraw', 'Withdraw goods receipt to draft'),
      resourceKind: 'pz.goods_receipt',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: snapshots.after as SerializedGoodsReceipt,
    }
  },
}

registerCommand(releaseGoodsReceiptCommand)
registerCommand(withdrawGoodsReceiptCommand)

/**
 * Confirmation is where the warehouse stops being a live reference and becomes part of the
 * record. A warehouse that has since been deleted is a data problem to surface rather than
 * something to snapshot around, so it refuses instead of freezing a name nobody can look up
 * any more (ADR-0007).
 */
async function snapshotWarehouseForConfirmation(
  ctx: CommandRuntimeContext,
  scope: GoodsReceiptScope,
  warehouseId: string,
  translate: TranslateFn,
): Promise<GoodsReceiptWarehouseSnapshot> {
  const warehouse = await findWarehouse(ctx, scope, warehouseId)
  if (!warehouse) {
    throw conflict(
      translate(
        'pz.goodsReceipts.errors.confirmWarehouseMissing',
        'This goods receipt names a warehouse that no longer exists, so it cannot be confirmed.',
      ),
    )
  }
  return { name: warehouse.name ?? '', code: warehouse.code ?? '' }
}

/**
 * Confirming records that a delivery happened. It moves no stock: no `wms` balance,
 * movement, lot or reservation is created or changed, and `wms.inventory.receive` is not
 * called (ADR-0005). What it emits is `pz.goods_receipt.confirmed`, carrying the header and
 * its lines, which is the seam a stock-posting subscriber would attach to later without
 * touching this module.
 *
 * It is its own command rather than a status written through update, because it carries its
 * own permission and its own one-way transition (ADR-0006), and it is deliberately not
 * undoable: the answer to a wrong quantity is a correcting document, not a reversal.
 */
const confirmGoodsReceiptCommand: CommandHandler<Record<string, unknown>, GoodsReceipt> = {
  id: 'pz.goodsReceipts.confirm',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    const id = requireRecordId(rawInput, translate)
    const expectedVersion = requireExpectedVersion(ctx, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()

    let receipt!: GoodsReceipt
    let lines: GoodsReceiptLine[] = []
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
          receipt = await lockReceiptForWrite(tx, scope, id, translate)
          if (receipt.status !== 'receiving') {
            throw conflict(
              translate('pz.goodsReceipts.errors.confirmNotReceiving', 'Only a receiving goods receipt can be confirmed.'),
            )
          }
          assertGoodsReceiptVersion(receipt, id, expectedVersion)
          const openPallets = await tx.find(Pallet, {
            goodsReceipt: id,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            status: 'open',
          } as FilterQuery<Pallet>)
          if (openPallets.length > 0) {
            throw conflict(
              translate(
                'pz.goodsReceipts.errors.confirmPalletsOpen',
                '{count} pallet(s) are still open: {pallets}.',
                { count: openPallets.length, pallets: openPallets.map((pallet) => pallet.code).sort().join(', ') },
              ),
            )
          }
          lines = await findScopedLines(tx, id, scope)
        },
        async ({ em: tx }) => {
          if (lines.length === 0) {
            // Create and update both refuse a goods receipt without lines, so this is not
            // reachable through the public API — but confirmation is where the rule finally
            // matters, so it is enforced rather than assumed.
            throw conflict(
              translate(
                'pz.goodsReceipts.errors.confirmNoLines',
                'A goods receipt without lines cannot be confirmed.',
              ),
            )
          }
          receipt.warehouseSnapshot = await snapshotWarehouseForConfirmation(
            ctx,
            scope,
            receipt.warehouseId,
            translate,
          )
          receipt.status = 'confirmed'
          receipt.updatedAt = new Date()
          tx.persist(receipt)
        },
      ],
      sideEffect: () => ({
        entity: receipt,
        identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    const confirmed = serializeGoodsReceipt(receipt, lines)
    capturedAggregates.set(receipt, confirmed)
    await emitConfirmed(ctx, confirmed)
    return receipt
  },
  captureAfter: (_input, result, ctx) => snapshotAggregate(ctx, result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('pz.audit.goodsReceipts.confirm', 'Confirm goods receipt'),
      resourceKind: 'pz.goods_receipt',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: snapshots.after as SerializedGoodsReceipt,
    }
  },
}

/**
 * Emitted after the commit, so a subscriber can never act on a confirmation that did not
 * happen. It is persistent because the whole point of the event is that work can be hung off
 * it later; losing it because a subscriber was momentarily unavailable would make it useless
 * as a seam.
 *
 * The commit has already landed by the time this runs, so a failure cannot be turned into a
 * failed request: the document IS confirmed, and telling the caller otherwise would be a
 * worse lie than a missing broadcast. The cost is real and worth stating — if the queue
 * itself refuses the enqueue, the confirmation stands with no durable event behind it, so
 * this is logged at error rather than warn and is the signal to replay from the record.
 */
async function emitConfirmed(ctx: CommandRuntimeContext, document: SerializedGoodsReceipt): Promise<void> {
  try {
    const bus = ctx.container.resolve<EventBus>('eventBus')
    await bus.emit('pz.goods_receipt.confirmed', document, {
      persistent: true,
      tenantId: document.tenantId,
      organizationId: document.organizationId,
    })
  } catch (error) {
    logger.error('Goods receipt confirmation broadcast failed', { err: error, goodsReceiptId: document.id })
  }
}

registerCommand(confirmGoodsReceiptCommand)
