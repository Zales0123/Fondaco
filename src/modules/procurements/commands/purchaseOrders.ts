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
  PurchaseOrder,
  PurchaseOrderLine,
  FROZEN_PURCHASE_ORDER_STATUSES,
  type PurchaseOrderCatalogSnapshot,
  type PurchaseOrderStatus,
  type PurchaseOrderSupplierSnapshot,
  type PurchaseOrderUomSnapshot,
  type PurchaseOrderWarehouseSnapshot,
} from '../data/entities'
import {
  parsePurchaseOrderWriteInput,
  type PurchaseOrderWriteInput,
  type TranslateFn,
} from '../lib/purchaseOrderInput'

const logger = createLogger('procurements').child({ component: 'purchase-order-commands' })

export const PURCHASE_ORDER_ENTITY_ID = E.procurements.purchase_order
export const DOCUMENT_NUMBER_UNIQUE_INDEX = 'procurements_purchase_orders_document_number_unique_idx'

export type PurchaseOrderScope = { tenantId: string; organizationId: string }

export type SerializedPurchaseOrderLine = {
  id: string
  lineNumber: number
  catalogVariantId: string
  catalogProductId: string
  catalogSnapshot: PurchaseOrderCatalogSnapshot | null
  quantityOrdered: string
  unit: string | null
  uomSnapshot: PurchaseOrderUomSnapshot | null
  unitPriceNet: string
  expectedDate: string | null
}

/**
 * The whole aggregate, not just the header: undo and redo have to put back the document a
 * user was looking at, and a purchase order without its lines is not that document.
 */
export type SerializedPurchaseOrder = {
  id: string
  tenantId: string
  organizationId: string
  documentNumber: string
  /** Calendar day, `YYYY-MM-DD`. */
  orderDate: string
  expectedDate: string | null
  supplierId: string | null
  supplierName: string
  supplierSnapshot: PurchaseOrderSupplierSnapshot | null
  warehouseId: string
  warehouseSnapshot: PurchaseOrderWarehouseSnapshot | null
  currencyCode: string
  status: PurchaseOrderStatus
  notes: string | null
  createdAt: string
  updatedAt: string
  lines: SerializedPurchaseOrderLine[]
}

export const purchaseOrderCrudEvents: CrudEventsConfig<PurchaseOrder> = {
  module: 'procurements',
  entity: 'purchase_order',
  persistent: true,
  buildPayload: (ctx: CrudEmitContext<PurchaseOrder>) => ({
    id: ctx.identifiers.id,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
    documentNumber: ctx.entity?.documentNumber ?? null,
    status: ctx.entity?.status ?? null,
  }),
}

export const purchaseOrderCrudIndexer: CrudIndexerConfig<PurchaseOrder> = {
  entityType: PURCHASE_ORDER_ENTITY_ID,
}

/**
 * The shared `badRequest` helper carries no field map, and the form needs one: a duplicate
 * Document Number has to land on the Document Number input rather than in a banner. The
 * `fields` key is the shape the installed data engine already emits and the shared client
 * error adapter already reads.
 */
export function purchaseOrderFieldError(message: string, fields: Record<string, string>): CrudHttpError {
  return new CrudHttpError(400, { error: message, fields })
}

function validationFailed(translate: TranslateFn): string {
  return translate('procurements.purchaseOrders.errors.validationFailed', 'The purchase order could not be saved.')
}

export function ensurePurchaseOrderScope(ctx: CommandRuntimeContext, translate: TranslateFn): PurchaseOrderScope {
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) {
    throw badRequest(translate('procurements.purchaseOrders.errors.tenantRequired', 'Tenant context is required.'))
  }
  const organizationId = ctx.selectedOrganizationId ?? ctx.organizationScope?.selectedId ?? null
  if (!organizationId) {
    throw badRequest(
      translate('procurements.purchaseOrders.errors.organizationRequired', 'Organization context is required.'),
    )
  }
  return { tenantId, organizationId }
}

/**
 * Case-insensitive equality, not a prefix match: the pattern is escaped and carries no
 * wildcard, so it reproduces the `lower(document_number)` unique index in a readable way. It
 * is a courtesy check — the index is the actual guard, and `isUniqueViolation` maps the race
 * that slips past this read onto the same field error.
 */
async function findByDocumentNumber(
  em: EntityManager,
  scope: PurchaseOrderScope,
  documentNumber: string,
  excludeId?: string,
): Promise<PurchaseOrder | null> {
  const where: Record<string, unknown> = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
    documentNumber: { $ilike: escapeLikePattern(documentNumber) },
  }
  if (excludeId) where.id = { $ne: excludeId }
  return em.findOne(PurchaseOrder, where as FilterQuery<PurchaseOrder>)
}

type WarehouseRow = { id: string; name: string | null; code: string | null }

/**
 * Warehouses and catalog records are read through the installed query engine under the
 * caller's trusted scope — this module holds scalar ids only and never an ORM relation into
 * `wms` or `catalog`.
 */
async function findWarehouse(
  ctx: CommandRuntimeContext,
  scope: PurchaseOrderScope,
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
  scope: PurchaseOrderScope,
  warehouseId: string,
  translate: TranslateFn,
): Promise<WarehouseRow> {
  const warehouse = await findWarehouse(ctx, scope, warehouseId)
  if (!warehouse) {
    throw purchaseOrderFieldError(validationFailed(translate), {
      warehouseId: translate('procurements.purchaseOrders.errors.warehouseMissing', 'That warehouse no longer exists.'),
    })
  }
  return warehouse
}

type ProductRow = { id: string; title: string | null; sku: string | null; default_unit: string | null }
type VariantRow = { id: string; product_id: string; sku: string | null; is_default: boolean | null }

export type ResolvedCatalogLine = {
  catalogVariantId: string
  catalogSnapshot: PurchaseOrderCatalogSnapshot
  productDefaultUnit: string | null
}

/**
 * Users pick products; the order stores the variant, because that is how every `wms` entity
 * keys a product and how a later delivery will match it. Resolution happens here rather than
 * in the browser, so neither the stored variant nor the snapshot can be chosen by the caller.
 *
 * Only variants flagged as the product's default are considered, and exactly one is required.
 * Falling back to "some other variant" would quietly order a product the paperwork never
 * mentioned, which is worse than refusing the line.
 */
export async function resolveCatalogLines(
  ctx: CommandRuntimeContext,
  scope: PurchaseOrderScope,
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
      // `is_default` is projected as well as filtered: the engine resolves a filter against
      // the selected projection, so filtering on a column it was not asked to read silently
      // returns every variant.
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
      throw purchaseOrderFieldError(validationFailed(translate), {
        lines: translate(
          'procurements.purchaseOrders.errors.lineProductUnavailable',
          'One of the products is no longer available in the catalog.',
        ),
      })
    }
    const name = product.title ?? productId
    const defaults = defaultsByProduct.get(productId) ?? []
    if (defaults.length === 0) {
      throw purchaseOrderFieldError(validationFailed(translate), {
        lines: translate(
          'procurements.purchaseOrders.errors.lineProductNoDefaultVariant',
          '{product} has no default variant, so it cannot be ordered.',
          { product: name },
        ),
      })
    }
    if (defaults.length > 1) {
      throw purchaseOrderFieldError(validationFailed(translate), {
        lines: translate(
          'procurements.purchaseOrders.errors.lineProductAmbiguousVariant',
          '{product} has more than one default variant, so it cannot be ordered.',
          { product: name },
        ),
      })
    }
    const variant = defaults[0]
    resolved.set(productId, {
      catalogVariantId: String(variant.id),
      catalogSnapshot: {
        name,
        // The variant's SKU is the precise thing ordered; the product's is the fallback for
        // a single-variant product that carries its SKU on the product row.
        sku: variant.sku ?? product.sku ?? null,
      },
      productDefaultUnit: product.default_unit ?? null,
    })
  }

  return resolved
}

export function buildUomSnapshot(unit: string | null, productDefaultUnit: string | null): PurchaseOrderUomSnapshot {
  return { code: unit ?? productDefaultUnit, productDefaultUnit }
}

/** A calendar day is stored at UTC midnight of that day. */
export function toCalendarDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

function toIsoDay(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}

function toNullableIsoDay(value: Date | string | null | undefined): string | null {
  return value == null ? null : toIsoDay(value)
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function serializePurchaseOrderLine(line: PurchaseOrderLine): SerializedPurchaseOrderLine {
  return {
    id: String(line.id),
    lineNumber: line.lineNumber,
    catalogVariantId: line.catalogVariantId,
    catalogProductId: line.catalogProductId,
    catalogSnapshot: line.catalogSnapshot ?? null,
    quantityOrdered: line.quantityOrdered,
    unit: line.unit ?? null,
    uomSnapshot: line.uomSnapshot ?? null,
    unitPriceNet: line.unitPriceNet,
    expectedDate: toNullableIsoDay(line.expectedDate),
  }
}

export function serializePurchaseOrder(
  order: PurchaseOrder,
  lines: readonly PurchaseOrderLine[],
): SerializedPurchaseOrder {
  return {
    id: String(order.id),
    tenantId: order.tenantId,
    organizationId: order.organizationId,
    documentNumber: order.documentNumber,
    orderDate: toIsoDay(order.orderDate),
    expectedDate: toNullableIsoDay(order.expectedDate),
    supplierId: order.supplierId ?? null,
    supplierName: order.supplierName,
    supplierSnapshot: order.supplierSnapshot ?? null,
    warehouseId: order.warehouseId,
    warehouseSnapshot: order.warehouseSnapshot ?? null,
    currencyCode: order.currencyCode,
    status: order.status,
    notes: order.notes ?? null,
    createdAt: toIso(order.createdAt),
    updatedAt: toIso(order.updatedAt),
    lines: [...lines]
      .sort((left, right) => left.lineNumber - right.lineNumber)
      .map(serializePurchaseOrderLine),
  }
}

/**
 * Snapshots captured by the write itself, while it still held the row lock. Re-reading the
 * lines after the commit would let another writer's change into a snapshot this command
 * never persisted, so the reload below is only the fallback for entities that did not come
 * from one of this module's writes (a redo restores through a shared helper, which hands
 * back an entity whose `lines` collection was never initialised).
 */
const capturedAggregates = new WeakMap<PurchaseOrder, SerializedPurchaseOrder>()

/**
 * Redo results that changed nothing. They must not produce an undoable log entry: undoing
 * work that never happened is how one actor's edit gets overwritten by another's no-op.
 */
const redoNoOps = new WeakSet<PurchaseOrder>()

async function snapshotAggregate(
  ctx: CommandRuntimeContext,
  order: PurchaseOrder,
): Promise<SerializedPurchaseOrder> {
  const captured = capturedAggregates.get(order)
  if (captured) return captured
  const em = (ctx.container.resolve('em') as EntityManager).fork()
  return serializePurchaseOrder(order, await findScopedLines(em, order.id, order))
}

/**
 * The foreign key does not constrain a line's duplicated scope to its header's, so every
 * read of an aggregate's lines repeats the header's trusted tenant and organization rather
 * than trusting the parent id alone.
 */
async function findScopedLines(
  em: EntityManager,
  orderId: string,
  scope: { tenantId: string; organizationId: string },
): Promise<PurchaseOrderLine[]> {
  return em.find(PurchaseOrderLine, {
    purchaseOrder: orderId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  } as FilterQuery<PurchaseOrderLine>)
}

async function parseInput(raw: unknown, translate: TranslateFn): Promise<PurchaseOrderWriteInput> {
  const parsed = parsePurchaseOrderWriteInput(raw, translate)
  if (!parsed.ok) throw purchaseOrderFieldError(parsed.message, parsed.fields)
  return parsed.value
}

export function duplicateDocumentNumberError(translate: TranslateFn): CrudHttpError {
  return purchaseOrderFieldError(validationFailed(translate), {
    documentNumber: translate(
      'procurements.purchaseOrders.errors.documentNumberTaken',
      'This Document Number is already used in your organization.',
    ),
  })
}

export function buildPurchaseOrderLine(
  em: EntityManager,
  args: {
    order: PurchaseOrder
    scope: PurchaseOrderScope
    lineNumber: number
    catalogProductId: string
    quantityOrdered: string
    unit: string | null
    unitPriceNet: string
    expectedDate: string | null
    resolved: ResolvedCatalogLine
    now: Date
  },
): PurchaseOrderLine {
  return em.create(PurchaseOrderLine, {
    id: randomUUID(),
    purchaseOrder: args.order,
    tenantId: args.scope.tenantId,
    organizationId: args.scope.organizationId,
    lineNumber: args.lineNumber,
    catalogVariantId: args.resolved.catalogVariantId,
    catalogProductId: args.catalogProductId,
    catalogSnapshot: args.resolved.catalogSnapshot,
    quantityOrdered: args.quantityOrdered,
    unit: args.unit ?? args.resolved.productDefaultUnit,
    uomSnapshot: buildUomSnapshot(args.unit, args.resolved.productDefaultUnit),
    unitPriceNet: args.unitPriceNet,
    expectedDate: args.expectedDate ? toCalendarDate(args.expectedDate) : null,
    createdAt: args.now,
    updatedAt: args.now,
  })
}

/** Rebuilds the header seed from a snapshot; `lines` are restored separately. */
function headerSeedFromSnapshot(snapshot: SerializedPurchaseOrder): Record<string, unknown> {
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    organizationId: snapshot.organizationId,
    documentNumber: snapshot.documentNumber,
    orderDate: toCalendarDate(snapshot.orderDate),
    expectedDate: snapshot.expectedDate ? toCalendarDate(snapshot.expectedDate) : null,
    supplierId: snapshot.supplierId,
    supplierName: snapshot.supplierName,
    supplierSnapshot: snapshot.supplierSnapshot,
    warehouseId: snapshot.warehouseId,
    warehouseSnapshot: snapshot.warehouseSnapshot,
    currencyCode: snapshot.currencyCode,
    status: snapshot.status,
    notes: snapshot.notes,
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
  snapshot: Pick<SerializedPurchaseOrder, 'tenantId' | 'organizationId'>,
  translate: TranslateFn,
): PurchaseOrderScope {
  const scope = ensurePurchaseOrderScope(ctx, translate)
  if (snapshot.tenantId !== scope.tenantId || snapshot.organizationId !== scope.organizationId) {
    throw new CrudHttpError(403, {
      error: translate(
        'procurements.purchaseOrders.errors.undoScope',
        'Undo is not allowed from this tenant and organization.',
      ),
    })
  }
  return scope
}

function restoreHeaderFromSnapshot(order: PurchaseOrder, snapshot: SerializedPurchaseOrder): void {
  order.documentNumber = snapshot.documentNumber
  order.orderDate = toCalendarDate(snapshot.orderDate)
  order.expectedDate = snapshot.expectedDate ? toCalendarDate(snapshot.expectedDate) : null
  order.supplierId = snapshot.supplierId
  order.supplierName = snapshot.supplierName
  order.supplierSnapshot = snapshot.supplierSnapshot
  order.warehouseId = snapshot.warehouseId
  order.warehouseSnapshot = snapshot.warehouseSnapshot
  order.currencyCode = snapshot.currencyCode
  order.status = snapshot.status
  order.notes = snapshot.notes
  order.updatedAt = new Date(snapshot.updatedAt)
}

/** Rebuilds one line exactly as it was, under its original id. */
function createLineFromSnapshot(
  em: EntityManager,
  order: PurchaseOrder,
  snapshot: SerializedPurchaseOrder,
  line: SerializedPurchaseOrderLine,
): PurchaseOrderLine {
  return em.create(PurchaseOrderLine, {
    id: line.id,
    purchaseOrder: order,
    tenantId: snapshot.tenantId,
    organizationId: snapshot.organizationId,
    lineNumber: line.lineNumber,
    catalogVariantId: line.catalogVariantId,
    catalogProductId: line.catalogProductId,
    catalogSnapshot: line.catalogSnapshot,
    quantityOrdered: line.quantityOrdered,
    unit: line.unit,
    uomSnapshot: line.uomSnapshot,
    unitPriceNet: line.unitPriceNet,
    expectedDate: line.expectedDate ? toCalendarDate(line.expectedDate) : null,
    createdAt: new Date(snapshot.createdAt),
    updatedAt: new Date(snapshot.updatedAt),
  })
}

const restoreCreatedPurchaseOrder = makeCreateRedo<
  PurchaseOrder,
  SerializedPurchaseOrder,
  Record<string, unknown>,
  PurchaseOrder
>({
  entityClass: PurchaseOrder,
  getSnapshotId: (snapshot) => snapshot.id,
  seedFromSnapshot: headerSeedFromSnapshot,
  buildResult: (entity) => entity,
  events: purchaseOrderCrudEvents,
  indexer: purchaseOrderCrudIndexer,
  transaction: true,
  afterRestore: async ({ em, entity, snapshot }) => {
    if (!snapshot.lines.length) return
    const existing = await findScopedLines(em, entity.id, snapshot)
    const present = new Set(existing.map((line) => String(line.id)))
    for (const line of snapshot.lines) {
      if (present.has(line.id)) continue
      em.persist(createLineFromSnapshot(em, entity, snapshot, line))
    }
  },
})

/**
 * A document number freed by the undo may legitimately have been taken by someone else in
 * the meantime. The shared helper reports that as an untranslated developer message, which
 * is not what the person clicking redo should read.
 */
async function restorePurchaseOrder(args: {
  input: Record<string, unknown>
  ctx: CommandRuntimeContext
  logEntry: CommandUndoLogEntry
}): Promise<PurchaseOrder> {
  try {
    return await restoreCreatedPurchaseOrder(args)
  } catch (error) {
    if (isUniqueViolation(error) || (isCrudHttpError(error) && error.status === 409)) {
      const { translate } = await resolveTranslations()
      throw conflict(
        translate(
          'procurements.purchaseOrders.errors.redoDocumentNumberTaken',
          'This Document Number has been used by another purchase order since, so this one cannot be restored.',
        ),
      )
    }
    throw error
  }
}

const createPurchaseOrderCommand: CommandHandler<Record<string, unknown>, PurchaseOrder> = {
  id: 'procurements.purchaseOrders.create',
  isUndoable: true,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensurePurchaseOrderScope(ctx, translate)
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

    const now = new Date()
    const order = em.create(PurchaseOrder, {
      id: randomUUID(),
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      documentNumber: input.documentNumber,
      orderDate: toCalendarDate(input.orderDate),
      expectedDate: input.expectedDate ? toCalendarDate(input.expectedDate) : null,
      // The supplier register is issue #51; until it exists an order carries the typed name
      // and no id, and the picker that fills this in is the last thing stage 1 is waiting on.
      supplierId: null,
      supplierName: input.supplierName,
      // Supplier and warehouse snapshots are taken at release, not here: a draft still points
      // at live state and is allowed to follow a rename.
      supplierSnapshot: null,
      warehouseId: input.warehouseId,
      warehouseSnapshot: null,
      currencyCode: input.currencyCode,
      status: 'draft',
      notes: input.notes,
      createdAt: now,
      updatedAt: now,
    })
    const lines = input.lines.map((line, index) =>
      buildPurchaseOrderLine(em, {
        order,
        scope,
        lineNumber: index + 1,
        catalogProductId: line.catalogProductId,
        quantityOrdered: line.quantityOrdered,
        unit: line.unit,
        unitPriceNet: line.unitPriceNet,
        expectedDate: line.expectedDate,
        resolved: catalog.get(line.catalogProductId) as ResolvedCatalogLine,
        now,
      }),
    )

    try {
      await runCrudCommandWrite<PurchaseOrder>({
        ctx,
        em,
        entityId: PURCHASE_ORDER_ENTITY_ID,
        action: 'created',
        scope,
        events: purchaseOrderCrudEvents,
        indexer: purchaseOrderCrudIndexer,
        syncOrigin: ctx.syncOrigin,
        // Header and lines commit together or not at all, so a failed save leaves no header
        // behind for someone to find later and wonder about.
        phases: [
          ({ em: tx }) => {
            tx.persist(order)
          },
          ({ em: tx }) => {
            for (const line of lines) tx.persist(line)
          },
        ],
        sideEffect: () => ({
          entity: order,
          identifiers: {
            id: String(order.id),
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
          },
        }),
      })
    } catch (error) {
      // The unique index is the real guard against two buyers using the same number at once;
      // the read above only makes the common case a friendly message.
      if (isUniqueViolation(error, DOCUMENT_NUMBER_UNIQUE_INDEX)) throw duplicateDocumentNumberError(translate)
      throw error
    }

    capturedAggregates.set(order, serializePurchaseOrder(order, lines))
    return order
  },
  captureAfter: (_input, result, ctx) => snapshotAggregate(ctx, result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('procurements.audit.purchaseOrders.create', 'Create purchase order'),
      resourceKind: 'procurements.purchase_order',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      // `captureAfter` already read the aggregate back; reloading it here would open a second
      // post-commit failure window and could log something the command never returned.
      snapshotAfter: snapshots.after as SerializedPurchaseOrder,
    }
  },
  async undo({ logEntry, ctx }) {
    const snapshot = extractUndoPayload<UndoPayload<SerializedPurchaseOrder>>(logEntry)?.after ?? null
    const id = snapshot?.id ?? logEntry.resourceId ?? null
    if (!id) throw new Error('[internal] Missing purchase order id for undo')
    const { translate } = await resolveTranslations()
    const scope = ensurePurchaseOrderScope(ctx, translate)
    // Both halves of the scope, not just the tenant: an undo issued while another
    // organization is selected must be refused, not quietly consumed against no row.
    if (snapshot && (snapshot.tenantId !== scope.tenantId || snapshot.organizationId !== scope.organizationId)) {
      throw new CrudHttpError(403, {
        error: translate(
          'procurements.purchaseOrders.errors.undoScope',
          'Undo scope does not match this tenant and organization.',
        ),
      })
    }

    const dataEngine = ctx.container.resolve<DataEngine>('dataEngine')
    const removed = await dataEngine.deleteOrmEntity({
      entity: PurchaseOrder,
      where: {
        id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      } as FilterQuery<PurchaseOrder>,
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
      events: purchaseOrderCrudEvents,
      // Undo runs outside any route, so no route-level indexer declaration is active here.
      indexer: purchaseOrderCrudIndexer,
    })
  },
  /**
   * Redo restores the original aggregate under its original ids rather than replaying
   * `execute`, which would mint a new purchase order and leave the first one's lines pointing
   * at a soft-deleted header.
   */
  redo: (args) => restorePurchaseOrder(args),
}

registerCommand(createPurchaseOrderCommand)

/**
 * Reads a purchase order for a write and holds it until the transaction commits.
 *
 * The row is locked, so scope, status and version cannot change between their checks and the
 * write. Checking outside the transaction would leave a window in which a concurrent release
 * commits and this write then overwrites or deletes a released order.
 */
async function lockOrderForWrite(
  em: EntityManager,
  scope: PurchaseOrderScope,
  id: string,
  translate: TranslateFn,
): Promise<PurchaseOrder> {
  return assertFound(
    await em.findOne(
      PurchaseOrder,
      {
        id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      } as FilterQuery<PurchaseOrder>,
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    ),
    translate('procurements.purchaseOrders.errors.notFound', 'That purchase order no longer exists.'),
  )
}

function assertPurchaseOrderVersion(order: PurchaseOrder, id: string, expectedVersion: string): void {
  assertOptimisticLock({
    resourceKind: PURCHASE_ORDER_ENTITY_ID,
    resourceId: id,
    expected: expectedVersion,
    current: order.updatedAt,
  })
}

export function assertPurchaseOrderEditable(
  order: Pick<PurchaseOrder, 'status'>,
  translate: TranslateFn,
): void {
  if (!FROZEN_PURCHASE_ORDER_STATUSES.includes(order.status)) return
  throw conflict(
    order.status === 'released'
      ? translate(
          'procurements.purchaseOrders.errors.releasedImmutable',
          'This purchase order has been released and can no longer be changed. Withdraw it to draft first.',
        )
      : translate(
          'procurements.purchaseOrders.errors.cancelledImmutable',
          'A cancelled purchase order can no longer be changed.',
        ),
  )
}

async function lockDraftForWrite(
  em: EntityManager,
  scope: PurchaseOrderScope,
  id: string,
  expectedVersion: string,
  translate: TranslateFn,
): Promise<PurchaseOrder> {
  const order = await lockOrderForWrite(em, scope, id, translate)
  assertPurchaseOrderEditable(order, translate)
  assertPurchaseOrderVersion(order, id, expectedVersion)
  return order
}

/** Loads the aggregate for a before-snapshot, without taking a lock. */
async function readAggregateForSnapshot(
  em: EntityManager,
  scope: PurchaseOrderScope,
  id: string,
  translate: TranslateFn,
): Promise<SerializedPurchaseOrder> {
  const order = assertFound(
    await em.findOne(PurchaseOrder, {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PurchaseOrder>),
    translate('procurements.purchaseOrders.errors.notFound', 'That purchase order no longer exists.'),
  )
  return serializePurchaseOrder(order, await findScopedLines(em, String(order.id), scope))
}

/**
 * The installed lock helper is deliberately additive: it does nothing when the caller sends
 * no version, so every existing consumer keeps working. A purchase order cannot afford that
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
        'procurements.purchaseOrders.errors.versionRequired',
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
    throw badRequest(
      translate('procurements.purchaseOrders.errors.idRequired', 'A purchase order identifier is required.'),
    )
  }
  return id
}

/**
 * Stable text for a snapshot, with object keys sorted.
 *
 * The jsonb columns come back with their keys in Postgres' own order — `{ sku, name }` where
 * the code wrote `{ name, sku }` — so a plain `JSON.stringify` comparison would call an
 * untouched document changed.
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
  order: PurchaseOrder,
  lines: readonly PurchaseOrderLine[],
  snapshot: SerializedPurchaseOrder,
): boolean {
  const strip = ({ updatedAt: _updatedAt, ...rest }: SerializedPurchaseOrder) => rest
  const current = JSON.stringify(canonicalize(strip(serializePurchaseOrder(order, lines))))
  return current === JSON.stringify(canonicalize(strip(snapshot)))
}

/**
 * Undo is only safe while the record still looks exactly as the action left it. Anything else
 * — a later edit, a release, a second undo — means restoring the snapshot would throw away
 * work nobody asked to lose, so it is refused instead.
 */
function assertUndoableState(
  order: PurchaseOrder,
  lines: readonly PurchaseOrderLine[],
  after: SerializedPurchaseOrder | null,
  translate: TranslateFn,
): void {
  if (!after || !aggregateMatchesSnapshot(order, lines, after)) {
    throw conflict(
      translate(
        'procurements.purchaseOrders.errors.undoStale',
        'This purchase order has changed since that action, so it can no longer be undone.',
      ),
    )
  }
}

/**
 * Re-applies an aggregate snapshot under the row lock.
 *
 * Redo cannot simply replay `execute`: the standard redo UI sends only a log id, and these
 * commands require the record version a caller was shown — replaying would fail every time
 * with "send the version". So redo restores the state the action produced, and only from the
 * state its undo left behind. Already being in the target state is success with no further
 * effects, so a retry is harmless.
 */
async function redoAggregateState(
  ctx: CommandRuntimeContext,
  target: SerializedPurchaseOrder,
  expected: SerializedPurchaseOrder | null,
  options: { deleted: boolean },
): Promise<PurchaseOrder> {
  const { translate } = await resolveTranslations()
  const scope = requireUndoScope(ctx, target, translate)
  const em = (ctx.container.resolve('em') as EntityManager).fork()
  let order!: PurchaseOrder
  let redoneLines: PurchaseOrderLine[] = []
  let alreadyApplied = false

  try {
    await withAtomicFlush(
      em,
      [
        async () => {
          order = assertFound(
            await em.findOne(
              PurchaseOrder,
              {
                id: target.id,
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
              } as FilterQuery<PurchaseOrder>,
              { lockMode: LockMode.PESSIMISTIC_WRITE },
            ),
            translate('procurements.purchaseOrders.errors.notFound', 'That purchase order no longer exists.'),
          )
          const lines = await findScopedLines(em, target.id, scope)

          // Redoing a delete never treats an already-deleted row as a quiet success: it could
          // have been deleted by someone else in the meantime, and a no-op would still mint
          // an undoable delete log — undoing which would restore THEIR deletion.
          if (!options.deleted && order.deletedAt == null && aggregateMatchesSnapshot(order, lines, target)) {
            alreadyApplied = true
            // Taken under the lock even on this path, so nothing reloads the lines after the
            // transaction and picks up a later actor's edit.
            capturedAggregates.set(order, serializePurchaseOrder(order, lines))
            redoNoOps.add(order)
            return
          }

          if (order.deletedAt != null || !expected || !aggregateMatchesSnapshot(order, lines, expected)) {
            throw conflict(
              translate(
                'procurements.purchaseOrders.errors.redoStale',
                'This purchase order has changed since that action was undone, so it cannot be redone.',
              ),
            )
          }
          if (!options.deleted) for (const line of lines) em.remove(line)
        },
        () => {
          if (alreadyApplied) return
          if (options.deleted) {
            const now = new Date()
            order.deletedAt = now
            order.updatedAt = now
            em.persist(order)
            return
          }
          restoreHeaderFromSnapshot(order, target)
          em.persist(order)
          redoneLines = target.lines.map((line) => createLineFromSnapshot(em, order, target, line))
          for (const line of redoneLines) em.persist(line)
        },
        () => {
          if (alreadyApplied) return
          // Recorded while the lock is still held: reloading after the commit could pick up
          // another actor's lines and put them in this redo's log, so undoing the redo would
          // overwrite their edit.
          capturedAggregates.set(order, options.deleted ? target : serializePurchaseOrder(order, redoneLines))
        },
      ],
      { transaction: true },
    )
  } catch (error) {
    // Undo freed the Document Number, and someone may legitimately have taken it before the
    // redo. That is an answer the user can act on, not a write failure.
    if (isUniqueViolation(error, DOCUMENT_NUMBER_UNIQUE_INDEX)) {
      throw conflict(
        translate(
          'procurements.purchaseOrders.errors.redoDocumentNumberTaken',
          'This Document Number has been used by another purchase order since, so this one cannot be redone.',
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
      entity: order,
      identifiers: { id: target.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      syncOrigin: ctx.syncOrigin,
      events: purchaseOrderCrudEvents,
      indexer: purchaseOrderCrudIndexer,
    })
  }

  return order
}

const updatePurchaseOrderCommand: CommandHandler<Record<string, unknown>, PurchaseOrder> = {
  id: 'procurements.purchaseOrders.update',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensurePurchaseOrderScope(ctx, translate)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return { before: await readAggregateForSnapshot(em, scope, requireRecordId(rawInput, translate), translate) }
  },
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensurePurchaseOrderScope(ctx, translate)
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

    let order!: PurchaseOrder
    let replacements: PurchaseOrderLine[] = []
    try {
      await runCrudCommandWrite<PurchaseOrder>({
        ctx,
        em,
        entityId: PURCHASE_ORDER_ENTITY_ID,
        action: 'updated',
        scope,
        events: purchaseOrderCrudEvents,
        indexer: purchaseOrderCrudIndexer,
        syncOrigin: ctx.syncOrigin,
        phases: [
          async ({ em: tx }) => {
            order = await lockDraftForWrite(tx, scope, id, expectedVersion, translate)
          },
          async ({ em: tx }) => {
            if (await findByDocumentNumber(tx, scope, input.documentNumber, id)) {
              throw duplicateDocumentNumberError(translate)
            }
            // Lines are replaced wholesale while the order is still a draft: nothing
            // downstream references a line id yet, so reconciling them row by row would only
            // invent an identity. Stage 2 changes this — once an arrival notice commits
            // against a line, that line has to survive an edit.
            for (const line of await findScopedLines(tx, id, scope)) tx.remove(line)
          },
          ({ em: tx }) => {
            const now = new Date()
            order.documentNumber = input.documentNumber
            order.orderDate = toCalendarDate(input.orderDate)
            order.expectedDate = input.expectedDate ? toCalendarDate(input.expectedDate) : null
            order.supplierName = input.supplierName
            order.warehouseId = input.warehouseId
            order.currencyCode = input.currencyCode
            order.notes = input.notes
            order.updatedAt = now
            replacements = input.lines.map((line, index) =>
              buildPurchaseOrderLine(tx, {
                order,
                scope,
                lineNumber: index + 1,
                catalogProductId: line.catalogProductId,
                quantityOrdered: line.quantityOrdered,
                unit: line.unit,
                unitPriceNet: line.unitPriceNet,
                expectedDate: line.expectedDate,
                resolved: catalog.get(line.catalogProductId) as ResolvedCatalogLine,
                now,
              }),
            )
            tx.persist(order)
            for (const line of replacements) tx.persist(line)
          },
        ],
        sideEffect: () => ({
          entity: order,
          identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
        }),
      })
    } catch (error) {
      if (isUniqueViolation(error, DOCUMENT_NUMBER_UNIQUE_INDEX)) throw duplicateDocumentNumberError(translate)
      throw error
    }

    capturedAggregates.set(order, serializePurchaseOrder(order, replacements))
    return order
  },
  captureAfter: (_input, result, ctx) => snapshotAggregate(ctx, result),
  buildLog: async ({ result, snapshots }) => {
    // A redo that found the order already in its target state changed nothing, and an
    // undoable log for it would let a later undo overwrite whatever came after.
    if (redoNoOps.has(result)) return { skipLog: true }
    const { translate } = await resolveTranslations()
    const before = (snapshots.before as SerializedPurchaseOrder | undefined) ?? null
    const after = snapshots.after as SerializedPurchaseOrder
    return {
      actionLabel: translate('procurements.audit.purchaseOrders.update', 'Update purchase order'),
      resourceKind: 'procurements.purchase_order',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      changes: buildChanges(before, after as unknown as Record<string, unknown>, [
        'documentNumber',
        'orderDate',
        'expectedDate',
        'supplierName',
        'warehouseId',
        'currencyCode',
        'notes',
      ]),
      snapshotBefore: before,
      snapshotAfter: after,
    }
  },
  async undo({ logEntry, ctx }) {
    const payload = extractUndoPayload<UndoPayload<SerializedPurchaseOrder>>(logEntry)
    const before = payload?.before ?? null
    const after = payload?.after ?? null
    if (!before?.id) throw new Error('[internal] Missing previous purchase order snapshot for undo')
    const { translate } = await resolveTranslations()
    const scope = requireUndoScope(ctx, before, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let order: PurchaseOrder | null = null
    let alreadyRestored = false

    await withAtomicFlush(
      em,
      [
        async () => {
          order = await em.findOne(
            PurchaseOrder,
            {
              id: before.id,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
            } as FilterQuery<PurchaseOrder>,
            { lockMode: LockMode.PESSIMISTIC_WRITE },
          )
          if (!order) return
          if (order.deletedAt != null) {
            // The order was deleted after this edit. Undoing the edit would mutate a deleted
            // record and burn the undo, and undoing the delete afterwards would then restore
            // the post-edit state nobody asked for.
            throw conflict(
              translate(
                'procurements.purchaseOrders.errors.undoDeleted',
                'This purchase order has since been deleted, so that edit can no longer be undone.',
              ),
            )
          }
          const lines = await findScopedLines(em, before.id, scope)
          // A retry after a partial failure finds the snapshot already back in place;
          // repeating the write — and its effects — would be the bug, not the fix.
          if (aggregateMatchesSnapshot(order, lines, before)) {
            alreadyRestored = true
            return
          }
          assertUndoableState(order, lines, after, translate)
          for (const line of lines) em.remove(line)
        },
        () => {
          if (!order || alreadyRestored) return
          restoreHeaderFromSnapshot(order, before)
          em.persist(order)
          for (const line of before.lines) em.persist(createLineFromSnapshot(em, order, before, line))
        },
      ],
      { transaction: true },
    )

    // Nothing to put back, or nothing left to do.
    if (!order || alreadyRestored) return

    const dataEngine = ctx.container.resolve<DataEngine>('dataEngine')
    await emitCrudUndoSideEffects({
      dataEngine,
      action: 'updated',
      entity: order,
      identifiers: { id: before.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      syncOrigin: ctx.syncOrigin,
      events: purchaseOrderCrudEvents,
      indexer: purchaseOrderCrudIndexer,
    })
  },
  async redo({ logEntry, ctx }) {
    const after = resolveRedoSnapshot<SerializedPurchaseOrder>(logEntry)
    const before = extractUndoPayload<UndoPayload<SerializedPurchaseOrder>>(logEntry)?.before ?? null
    if (!after?.id) throw new Error('[internal] Missing purchase order snapshot for redo')
    return redoAggregateState(ctx, after, before, { deleted: false })
  },
}

const deletePurchaseOrderCommand: CommandHandler<Record<string, unknown>, PurchaseOrder> = {
  id: 'procurements.purchaseOrders.delete',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensurePurchaseOrderScope(ctx, translate)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return { before: await readAggregateForSnapshot(em, scope, requireRecordId(rawInput, translate), translate) }
  },
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensurePurchaseOrderScope(ctx, translate)
    const id = requireRecordId(rawInput, translate)
    const expectedVersion = requireExpectedVersion(ctx, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let order!: PurchaseOrder

    await runCrudCommandWrite<PurchaseOrder>({
      ctx,
      em,
      entityId: PURCHASE_ORDER_ENTITY_ID,
      action: 'deleted',
      scope,
      events: purchaseOrderCrudEvents,
      indexer: purchaseOrderCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: tx }) => {
          order = await lockDraftForWrite(tx, scope, id, expectedVersion, translate)
        },
        ({ em: tx }) => {
          // Soft, and inside the same transaction that verified the draft: the partial unique
          // index stops seeing the row, so the Document Number is free again the moment this
          // commits. A released order is never deleted — it is cancelled, and stays on record.
          const now = new Date()
          order.deletedAt = now
          order.updatedAt = now
          tx.persist(order)
        },
      ],
      sideEffect: () => ({
        entity: order,
        identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    return order
  },
  buildLog: async ({ snapshots, input }) => {
    const { translate } = await resolveTranslations()
    const before = (snapshots.before as SerializedPurchaseOrder | undefined) ?? null
    return {
      actionLabel: translate('procurements.audit.purchaseOrders.delete', 'Delete purchase order'),
      resourceKind: 'procurements.purchase_order',
      resourceId: before?.id ?? requireRecordId(input, translate),
      tenantId: before?.tenantId ?? null,
      organizationId: before?.organizationId ?? null,
      snapshotBefore: before,
    }
  },
  async undo({ logEntry, ctx }) {
    const before = extractUndoPayload<UndoPayload<SerializedPurchaseOrder>>(logEntry)?.before ?? null
    if (!before?.id) throw new Error('[internal] Missing purchase order snapshot for undo')
    const { translate } = await resolveTranslations()
    const scope = requireUndoScope(ctx, before, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let order: PurchaseOrder | null = null
    let alreadyRestored = false

    try {
      await withAtomicFlush(
        em,
        [
          async () => {
            order = await em.findOne(
              PurchaseOrder,
              {
                id: before.id,
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
              } as FilterQuery<PurchaseOrder>,
              { lockMode: LockMode.PESSIMISTIC_WRITE },
            )
            if (!order) return
            // Undoing a delete twice must not re-emit effects.
            if (order.deletedAt == null) {
              alreadyRestored = true
              return
            }
            order.deletedAt = null
            restoreHeaderFromSnapshot(order, before)
            em.persist(order)
          },
          async () => {
            if (!order || alreadyRestored) return
            const present = new Set((await findScopedLines(em, before.id, scope)).map((line) => String(line.id)))
            for (const line of before.lines) {
              if (present.has(line.id)) continue
              em.persist(createLineFromSnapshot(em, order, before, line))
            }
          },
        ],
        { transaction: true },
      )
    } catch (error) {
      // Deleting a draft frees its Document Number, and someone may legitimately have taken
      // it since. That is a real answer, not a write failure.
      if (isUniqueViolation(error, DOCUMENT_NUMBER_UNIQUE_INDEX)) {
        throw conflict(
          translate(
            'procurements.purchaseOrders.errors.undoDocumentNumberTaken',
            'This Document Number has been used by another purchase order since, so this one cannot be restored.',
          ),
        )
      }
      throw error
    }

    if (!order || alreadyRestored) return

    const dataEngine = ctx.container.resolve<DataEngine>('dataEngine')
    await emitCrudUndoSideEffects({
      dataEngine,
      action: 'updated',
      entity: order,
      identifiers: { id: before.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      syncOrigin: ctx.syncOrigin,
      events: purchaseOrderCrudEvents,
      indexer: purchaseOrderCrudIndexer,
    })
  },
  async redo({ logEntry, ctx }) {
    // Redoing a delete means deleting again, from exactly the state its undo restored.
    const before = extractUndoPayload<UndoPayload<SerializedPurchaseOrder>>(logEntry)?.before ?? null
    if (!before?.id) throw new Error('[internal] Missing purchase order snapshot for redo')
    return redoAggregateState(ctx, before, before, { deleted: true })
  },
}

registerCommand(updatePurchaseOrderCommand)
registerCommand(deletePurchaseOrderCommand)

/**
 * Release is where the supplier and warehouse stop being live references and become part of
 * the record. A warehouse that has since been deleted is a data problem to surface rather
 * than something to snapshot around, so it refuses instead of freezing a name nobody can look
 * up any more.
 */
async function snapshotWarehouseForRelease(
  ctx: CommandRuntimeContext,
  scope: PurchaseOrderScope,
  warehouseId: string,
  translate: TranslateFn,
): Promise<PurchaseOrderWarehouseSnapshot> {
  const warehouse = await findWarehouse(ctx, scope, warehouseId)
  if (!warehouse) {
    throw conflict(
      translate(
        'procurements.purchaseOrders.errors.releaseWarehouseMissing',
        'This purchase order names a warehouse that no longer exists, so it cannot be released.',
      ),
    )
  }
  return { name: warehouse.name ?? '', code: warehouse.code ?? '' }
}

/**
 * Releasing makes the order the organization's standing commitment: it freezes the document,
 * takes the supplier and warehouse snapshots, and emits the event stage 2's arrival notices
 * will draw on. It does NOT send anything to the supplier and moves no stock.
 *
 * It is its own command rather than a status written through update, because it carries its
 * own permission and its own transition. It is reversible through `withdraw` while nothing
 * downstream depends on it, which is why it is not in the undo log: the domain action is the
 * honest way back, not an audit-log reversal.
 */
const releasePurchaseOrderCommand: CommandHandler<Record<string, unknown>, PurchaseOrder> = {
  id: 'procurements.purchaseOrders.release',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensurePurchaseOrderScope(ctx, translate)
    const id = requireRecordId(rawInput, translate)
    const expectedVersion = requireExpectedVersion(ctx, translate)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let order!: PurchaseOrder
    let lines: PurchaseOrderLine[] = []

    await runCrudCommandWrite<PurchaseOrder>({
      ctx,
      em,
      entityId: PURCHASE_ORDER_ENTITY_ID,
      action: 'updated',
      scope,
      events: purchaseOrderCrudEvents,
      indexer: purchaseOrderCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: tx }) => {
          order = await lockOrderForWrite(tx, scope, id, translate)
          if (order.status !== 'draft') {
            throw conflict(
              translate('procurements.purchaseOrders.errors.notDraft', 'Only a draft purchase order can be released.'),
            )
          }
          assertPurchaseOrderVersion(order, id, expectedVersion)
          lines = await findScopedLines(tx, id, scope)
        },
        async ({ em: tx }) => {
          if (lines.length === 0) {
            // Create and update both refuse an order without lines, so this is not reachable
            // through the public API — but release is where the rule finally matters, so it
            // is enforced rather than assumed.
            throw conflict(
              translate(
                'procurements.purchaseOrders.errors.releaseNoLines',
                'A purchase order without lines cannot be released.',
              ),
            )
          }
          order.warehouseSnapshot = await snapshotWarehouseForRelease(ctx, scope, order.warehouseId, translate)
          // Until the supplier register exists (issue #51) the snapshot is the typed name and
          // no code. When it does, this is where the register's record is frozen onto the
          // document, and `supplierId` stops being null.
          order.supplierSnapshot = { name: order.supplierName, code: null }
          order.status = 'released'
          order.updatedAt = new Date()
          tx.persist(order)
        },
      ],
      sideEffect: () => ({
        entity: order,
        identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    const released = serializePurchaseOrder(order, lines)
    capturedAggregates.set(order, released)
    await emitLifecycle(ctx, 'procurements.purchase_order.released', released)
    return order
  },
  captureAfter: (_input, result, ctx) => snapshotAggregate(ctx, result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('procurements.audit.purchaseOrders.release', 'Release purchase order'),
      resourceKind: 'procurements.purchase_order',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: snapshots.after as SerializedPurchaseOrder,
    }
  },
}

/**
 * Withdrawing takes a released order back to draft so it can be corrected.
 *
 * In stage 1 nothing downstream can depend on a released order, so this is always allowed.
 * Stage 2 must refuse it once an arrival notice holds a commitment against a line —
 * otherwise an edit would silently move ground somebody is already standing on.
 */
const withdrawPurchaseOrderCommand: CommandHandler<Record<string, unknown>, PurchaseOrder> = {
  id: 'procurements.purchaseOrders.withdraw',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensurePurchaseOrderScope(ctx, translate)
    const id = requireRecordId(rawInput, translate)
    const expectedVersion = requireExpectedVersion(ctx, translate)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let order!: PurchaseOrder

    await runCrudCommandWrite<PurchaseOrder>({
      ctx,
      em,
      entityId: PURCHASE_ORDER_ENTITY_ID,
      action: 'updated',
      scope,
      events: purchaseOrderCrudEvents,
      indexer: purchaseOrderCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: tx }) => {
          order = await lockOrderForWrite(tx, scope, id, translate)
          if (order.status !== 'released') {
            throw conflict(
              translate(
                'procurements.purchaseOrders.errors.notReleased',
                'Only a released purchase order can be withdrawn to draft.',
              ),
            )
          }
          assertPurchaseOrderVersion(order, id, expectedVersion)
        },
        ({ em: tx }) => {
          order.status = 'draft'
          // The snapshots go with the release that took them: a draft points at live supplier
          // and warehouse state again, and keeping a stale snapshot would make the next
          // release look like it had already happened.
          order.supplierSnapshot = null
          order.warehouseSnapshot = null
          order.updatedAt = new Date()
          tx.persist(order)
        },
      ],
      sideEffect: () => ({
        entity: order,
        identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })
    return order
  },
  captureAfter: (_input, result, ctx) => snapshotAggregate(ctx, result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('procurements.audit.purchaseOrders.withdraw', 'Withdraw purchase order to draft'),
      resourceKind: 'procurements.purchase_order',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: snapshots.after as SerializedPurchaseOrder,
    }
  },
}

/**
 * Cancelling ends a released order that will not be fulfilled. It stays on record with its
 * snapshots intact — a cancelled order is evidence, not a mistake to erase — which is why a
 * draft is deleted instead and only a released order can be cancelled.
 *
 * Deliberately not undoable: the answer to a wrong cancellation is a new order, not a
 * reversal, and stage 2 will hang commitment release off the event rather than off an undo.
 */
const cancelPurchaseOrderCommand: CommandHandler<Record<string, unknown>, PurchaseOrder> = {
  id: 'procurements.purchaseOrders.cancel',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const { translate } = await resolveTranslations()
    const scope = ensurePurchaseOrderScope(ctx, translate)
    const id = requireRecordId(rawInput, translate)
    const expectedVersion = requireExpectedVersion(ctx, translate)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let order!: PurchaseOrder
    let lines: PurchaseOrderLine[] = []

    await runCrudCommandWrite<PurchaseOrder>({
      ctx,
      em,
      entityId: PURCHASE_ORDER_ENTITY_ID,
      action: 'updated',
      scope,
      events: purchaseOrderCrudEvents,
      indexer: purchaseOrderCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: tx }) => {
          order = await lockOrderForWrite(tx, scope, id, translate)
          if (order.status !== 'released') {
            throw conflict(
              order.status === 'cancelled'
                ? translate(
                    'procurements.purchaseOrders.errors.alreadyCancelled',
                    'This purchase order is already cancelled.',
                  )
                : translate(
                    'procurements.purchaseOrders.errors.cancelNotReleased',
                    'Only a released purchase order can be cancelled. Delete a draft instead.',
                  ),
            )
          }
          assertPurchaseOrderVersion(order, id, expectedVersion)
          lines = await findScopedLines(tx, id, scope)
        },
        ({ em: tx }) => {
          order.status = 'cancelled'
          order.updatedAt = new Date()
          tx.persist(order)
        },
      ],
      sideEffect: () => ({
        entity: order,
        identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    const cancelled = serializePurchaseOrder(order, lines)
    capturedAggregates.set(order, cancelled)
    await emitLifecycle(ctx, 'procurements.purchase_order.cancelled', cancelled)
    return order
  },
  captureAfter: (_input, result, ctx) => snapshotAggregate(ctx, result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('procurements.audit.purchaseOrders.cancel', 'Cancel purchase order'),
      resourceKind: 'procurements.purchase_order',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: snapshots.after as SerializedPurchaseOrder,
    }
  },
}

/**
 * Emitted after the commit, so a subscriber can never act on a transition that did not
 * happen. Persistent because the whole point of these events is that stage 2's work hangs off
 * them; losing one because a subscriber was momentarily unavailable would make them useless
 * as a seam.
 *
 * The commit has already landed by the time this runs, so a failure cannot be turned into a
 * failed request: the order IS released, and telling the caller otherwise would be a worse lie
 * than a missing broadcast. The cost is real and worth stating — if the queue itself refuses
 * the enqueue, the transition stands with no durable event behind it, so this is logged at
 * error rather than warn and is the signal to replay from the record.
 */
async function emitLifecycle(
  ctx: CommandRuntimeContext,
  eventId: 'procurements.purchase_order.released' | 'procurements.purchase_order.cancelled',
  document: SerializedPurchaseOrder,
): Promise<void> {
  try {
    const bus = ctx.container.resolve<EventBus>('eventBus')
    await bus.emit(eventId, document, {
      persistent: true,
      tenantId: document.tenantId,
      organizationId: document.organizationId,
    })
  } catch (error) {
    logger.error('Purchase order lifecycle broadcast failed', { err: error, eventId, purchaseOrderId: document.id })
  }
}

registerCommand(releasePurchaseOrderCommand)
registerCommand(withdrawPurchaseOrderCommand)
registerCommand(cancelPurchaseOrderCommand)
