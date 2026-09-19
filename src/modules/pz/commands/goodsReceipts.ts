import { randomUUID } from 'node:crypto'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import {
  registerCommand,
  type CommandHandler,
  type CommandRuntimeContext,
  type CommandUndoLogEntry,
} from '@open-mercato/shared/lib/commands'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import { emitCrudUndoSideEffects } from '@open-mercato/shared/lib/commands/helpers'
import { makeCreateRedo } from '@open-mercato/shared/lib/commands/redo'
import { extractUndoPayload, type UndoPayload } from '@open-mercato/shared/lib/commands/undo'
import { CrudHttpError, badRequest, conflict, isCrudHttpError, isUniqueViolation } from '@open-mercato/shared/lib/crud/errors'
import type { CrudEmitContext, CrudEventsConfig, CrudIndexerConfig } from '@open-mercato/shared/lib/crud/types'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { E } from '@/.mercato/generated/entities.ids.generated'
import {
  GoodsReceipt,
  GoodsReceiptLine,
  type GoodsReceiptCatalogSnapshot,
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
export async function requireWarehouse(
  ctx: CommandRuntimeContext,
  scope: GoodsReceiptScope,
  warehouseId: string,
  translate: TranslateFn,
): Promise<WarehouseRow> {
  const queryEngine = ctx.container.resolve<QueryEngine>('queryEngine')
  const result = await queryEngine.query<WarehouseRow>(E.wms.warehouse, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['id', 'name', 'code'],
    filters: { id: warehouseId },
    page: { page: 1, pageSize: 1 },
  })
  const warehouse = result.items[0]
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
async function snapshotAggregate(
  ctx: CommandRuntimeContext,
  receipt: GoodsReceipt,
): Promise<SerializedGoodsReceipt> {
  const em = (ctx.container.resolve('em') as EntityManager).fork()
  const lines = await em.find(GoodsReceiptLine, { goodsReceipt: receipt.id } as FilterQuery<GoodsReceiptLine>)
  return serializeGoodsReceipt(receipt, lines)
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
    const existing = await em.find(GoodsReceiptLine, {
      goodsReceipt: entity.id,
    } as FilterQuery<GoodsReceiptLine>)
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
    const lines = input.lines.map((line, index) =>
      buildGoodsReceiptLine(em, {
        receipt,
        scope,
        lineNumber: index + 1,
        catalogProductId: line.catalogProductId,
        quantity: line.quantity,
        unit: line.unit,
        resolved: catalog.get(line.catalogProductId) as ResolvedCatalogLine,
        now,
      }),
    )

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

    return receipt
  },
  captureAfter: (_input, result, ctx) => snapshotAggregate(ctx, result),
  buildLog: async ({ result, ctx }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('pz.audit.goodsReceipts.create', 'Create goods receipt'),
      resourceKind: 'pz.goods_receipt',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: await snapshotAggregate(ctx, result),
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
