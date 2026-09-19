import { randomUUID } from 'node:crypto'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import {
  registerCommand,
  type CommandHandler,
  type CommandRuntimeContext,
} from '@open-mercato/shared/lib/commands'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import { emitCrudUndoSideEffects } from '@open-mercato/shared/lib/commands/helpers'
import { extractUndoPayload, type UndoPayload } from '@open-mercato/shared/lib/commands/undo'
import { CrudHttpError, badRequest, isUniqueViolation } from '@open-mercato/shared/lib/crud/errors'
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
  type GoodsReceiptUomSnapshot,
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

export type SerializedGoodsReceipt = {
  id: string
  documentNumber: string
  status: string
  tenantId: string
  organizationId: string
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
    throw goodsReceiptFieldError(
      translate('pz.goodsReceipts.errors.validationFailed', 'The goods receipt could not be saved.'),
      { warehouseId: translate('pz.goodsReceipts.errors.warehouseMissing', 'That warehouse no longer exists.') },
    )
  }
  return warehouse
}

type ProductRow = { id: string; title: string | null; sku: string | null; default_unit: string | null }
type VariantRow = {
  id: string
  product_id: string
  sku: string | null
  is_default: boolean | null
  created_at: Date | string | null
}

export type ResolvedCatalogLine = {
  catalogVariantId: string
  catalogSnapshot: GoodsReceiptCatalogSnapshot
  productDefaultUnit: string | null
}

function compareVariants(left: VariantRow, right: VariantRow): number {
  if (Boolean(left.is_default) !== Boolean(right.is_default)) return left.is_default ? -1 : 1
  const leftTime = left.created_at ? new Date(left.created_at).getTime() : 0
  const rightTime = right.created_at ? new Date(right.created_at).getTime() : 0
  if (leftTime !== rightTime) return leftTime - rightTime
  return left.id.localeCompare(right.id)
}

/**
 * Users pick products; the document stores the variant, because that is how every `wms`
 * entity keys a product (ADR-0007). Resolution happens here rather than in the browser, so
 * neither the stored variant nor the snapshot can be chosen by the caller.
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
      fields: ['id', 'product_id', 'sku', 'is_default', 'created_at'],
      filters: { product_id: { $in: unique } },
      page: { page: 1, pageSize: Math.min(unique.length * 50, 1000) },
    }),
  ])

  const variantsByProduct = new Map<string, VariantRow[]>()
  for (const variant of variants.items) {
    const bucket = variantsByProduct.get(String(variant.product_id)) ?? []
    bucket.push(variant)
    variantsByProduct.set(String(variant.product_id), bucket)
  }

  const resolved = new Map<string, ResolvedCatalogLine>()
  for (const product of products.items) {
    const productId = String(product.id)
    const variant = (variantsByProduct.get(productId) ?? []).slice().sort(compareVariants)[0]
    if (!variant) continue
    resolved.set(productId, {
      catalogVariantId: String(variant.id),
      catalogSnapshot: {
        name: product.title ?? productId,
        // The variant's SKU is the precise thing received; the product's is the fallback
        // for a single-variant product that carries its SKU on the product row.
        sku: variant.sku ?? product.sku ?? null,
      },
      productDefaultUnit: product.default_unit ?? null,
    })
  }

  for (const productId of unique) {
    if (resolved.has(productId)) continue
    throw goodsReceiptFieldError(
      translate('pz.goodsReceipts.errors.validationFailed', 'The goods receipt could not be saved.'),
      {
        lines: translate(
          'pz.goodsReceipts.errors.lineProductUnavailable',
          'One of the products is no longer available in the catalog.',
        ),
      },
    )
  }

  return resolved
}

export function buildUomSnapshot(unit: string | null, productDefaultUnit: string | null): GoodsReceiptUomSnapshot {
  return { code: unit ?? productDefaultUnit, productDefaultUnit }
}

export function serializeGoodsReceipt(receipt: GoodsReceipt): SerializedGoodsReceipt {
  return {
    id: String(receipt.id),
    documentNumber: receipt.documentNumber,
    status: receipt.status,
    tenantId: receipt.tenantId,
    organizationId: receipt.organizationId,
  }
}

/** The document date is a calendar day, so it is stored at UTC midnight of that day. */
export function toDocumentDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

async function parseInput(raw: unknown, translate: TranslateFn): Promise<GoodsReceiptWriteInput> {
  const parsed = parseGoodsReceiptWriteInput(raw, translate, { today: utcToday() })
  if (!parsed.ok) throw goodsReceiptFieldError(parsed.message, parsed.fields)
  return parsed.value
}

export function duplicateDocumentNumberError(translate: TranslateFn): CrudHttpError {
  return goodsReceiptFieldError(
    translate('pz.goodsReceipts.errors.validationFailed', 'The goods receipt could not be saved.'),
    {
      documentNumber: translate(
        'pz.goodsReceipts.errors.documentNumberTaken',
        'This Document Number is already used in your organization.',
      ),
    },
  )
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
  captureAfter: (_input, result) => serializeGoodsReceipt(result),
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('pz.audit.goodsReceipts.create', 'Create goods receipt'),
      resourceKind: 'pz.goods_receipt',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: serializeGoodsReceipt(result),
    }
  },
  async undo({ logEntry, ctx }) {
    const snapshot = extractUndoPayload<UndoPayload<SerializedGoodsReceipt>>(logEntry)?.after ?? null
    const id = snapshot?.id ?? logEntry.resourceId ?? null
    if (!id) throw new Error('[internal] Missing goods receipt id for undo')
    const { translate } = await resolveTranslations()
    const scope = ensureGoodsReceiptScope(ctx, translate)
    if (snapshot && snapshot.tenantId !== scope.tenantId) {
      throw new CrudHttpError(403, {
        error: translate('pz.goodsReceipts.errors.undoScope', 'Undo scope does not match this tenant.'),
      })
    }

    const dataEngine = ctx.container.resolve<DataEngine>('dataEngine')
    const removed = await dataEngine.deleteOrmEntity({
      entity: GoodsReceipt,
      where: {
        id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      } as FilterQuery<GoodsReceipt>,
      soft: true,
      softDeleteField: 'deletedAt',
    })
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
}

registerCommand(createGoodsReceiptCommand)
