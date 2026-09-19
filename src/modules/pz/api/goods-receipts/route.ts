import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { sanitizeSearchTerm } from '@open-mercato/shared/lib/query/sanitizeSearchTerm'
import { E } from '@/.mercato/generated/entities.ids.generated'
import {
  GoodsReceipt,
  type GoodsReceiptCatalogSnapshot,
  type GoodsReceiptPurchaseOrderSnapshot,
  type GoodsReceiptUomSnapshot,
  type GoodsReceiptWarehouseSnapshot,
} from '../../data/entities'
import {
  goodsReceiptListSchema,
  goodsReceiptWriteBodySchema,
  type GoodsReceiptListQuery,
} from '../../data/validators'
import { createPzCrudOpenApi, createPagedListResponseSchema } from '../openapi'
import {
  toGoodsReceiptLineItem,
  toGoodsReceiptListItem,
  type GoodsReceiptLineItem,
  type GoodsReceiptListItem,
  type GoodsReceiptListRow,
} from '../../lib/goodsReceiptListItem'

const F = {
  id: 'id',
  tenant_id: 'tenant_id',
  organization_id: 'organization_id',
  document_number: 'document_number',
  document_date: 'document_date',
  supplier_name: 'supplier_name',
  warehouse_id: 'warehouse_id',
  warehouse_snapshot: 'warehouse_snapshot',
  status: 'status',
  created_at: 'created_at',
  updated_at: 'updated_at',
} as const

/** A calendar day filter compared against a day-granular column, anchored at UTC midnight. */
function toCalendarDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

/** Matches nothing, for a search whose answer is "no document", which `$in: []` cannot say. */
const NO_SUCH_ID = '00000000-0000-0000-0000-000000000000'

/**
 * Resolves a free-text search to document ids with SQL, rather than handing an `$ilike` to
 * the query engine.
 *
 * The engine reroutes a base-column `like`/`ilike` through `search_tokens` by default, and
 * its own source says what that costs: tokenization splits on non-alphanumerics and drops
 * short tokens, so `ZK 1/2026` degrades to {202, 2026} and matches every document from that
 * year. Goods receipt numbers are full of separators — `PZ/1/2026` is the ordinary shape —
 * so the one search people rely on most is exactly the one that would break. This keeps the
 * match literal.
 *
 * It repeats the caller's tenant and organization predicates rather than trusting the outer
 * query to apply them: the ids it returns become an `id IN (...)` filter, and an id the
 * caller may not see would be a leak however the rest of the query is scoped.
 */
async function findGoodsReceiptIdsMatching(term: string, ctx: CrudCtx): Promise<string[]> {
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) return []
  const scopedOrgIds = resolveScopedOrganizationIds(ctx)
  if (scopedOrgIds !== null && scopedOrgIds.length === 0) return []

  const pattern = `%${escapeLikePattern(term)}%`
  const em = ctx.container.resolve<EntityManager>('em')
  const db = em.getKysely<PzReadDatabase>()
  let matching = db
    .selectFrom('pz_goods_receipts')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('deleted_at', 'is', null)
    .where((eb) => eb.or([
      eb('document_number', 'ilike', pattern),
      eb('supplier_name', 'ilike', pattern),
    ]))
  if (scopedOrgIds !== null) matching = matching.where('organization_id', 'in', scopedOrgIds)

  // Bounded: a search is a way to find a document, not a way to export the table, and the
  // page the caller asked for is taken from this set afterwards.
  const rows = await matching.limit(1000).execute()
  return rows.map((row) => String(row.id))
}

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.view'] },
  POST: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.manage'] },
}

/**
 * The command owns validation so a rejection can name the field that caused it; the route
 * passes the body through untouched.
 */
const rawBodySchema = z.object({}).passthrough()

/**
 * Line and pallet counts are per-page aggregates, not columns: the header stores no
 * denormalised total, and `transformItem` is synchronous. `afterList` is the one hook
 * that can issue the grouped count for exactly the ids the page already resolved.
 */
type PzReadDatabase = {
  pz_goods_receipts: {
    id: string
    tenant_id: string
    organization_id: string
    document_number: string
    supplier_name: string
    deleted_at: Date | null
  }
  pz_goods_receipt_lines: {
    id: string
    goods_receipt_id: string
    tenant_id: string
    organization_id: string
    line_number: number
    catalog_product_id: string
    catalog_variant_id: string
    catalog_snapshot: GoodsReceiptCatalogSnapshot | null
    quantity: string
    unit: string | null
    uom_snapshot: GoodsReceiptUomSnapshot | null
    purchase_order_id: string | null
    purchase_order_line_id: string | null
    purchase_order_snapshot: GoodsReceiptPurchaseOrderSnapshot | null
  }
  pz_pallets: {
    id: string
    goods_receipt_id: string
    tenant_id: string
    organization_id: string
  }
}

/**
 * Lines ride along only on a single-record read — the edit and detail screens load exactly
 * that way. A grid page would pay for rows it never renders, so it gets the count instead.
 */
function isSingleRecordRequest(query: GoodsReceiptListQuery): boolean {
  if (typeof query.id === 'string' && query.id.length > 0) return true
  return typeof query.ids === 'string' && query.ids.trim().length > 0
}

/**
 * Mirrors the scope the CRUD factory applied to the headers themselves: `null` is the only
 * value that means unrestricted within the tenant, and an empty array is deny-all — the
 * factory short-circuits that case to an empty page, so widening it back to the selected
 * organization here would count lines the caller was refused the headers for.
 */
function resolveScopedOrganizationIds(ctx: CrudCtx): string[] | null {
  if (ctx.organizationIds === null) return null
  if (!Array.isArray(ctx.organizationIds)) return []
  return Array.from(
    new Set(ctx.organizationIds.filter((value): value is string => typeof value === 'string' && value.length > 0)),
  )
}

async function decorateCountsAndLines(
  payload: { items?: GoodsReceiptListItem[] },
  ctx: CrudCtx & { query: GoodsReceiptListQuery },
): Promise<void> {
  const items = Array.isArray(payload.items) ? payload.items : []
  if (items.length === 0) return
  // No trusted tenant means no trusted count. Leaving the counts at their serialised
  // 0 is the fail-closed answer; an unscoped aggregate is not.
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) return
  const scopedOrgIds = resolveScopedOrganizationIds(ctx)
  if (scopedOrgIds !== null && scopedOrgIds.length === 0) return

  const ids = items.map((item) => item.id)
  const em = ctx.container.resolve<EntityManager>('em')
  const db = em.getKysely<PzReadDatabase>()

  let countedPallets = db
    .selectFrom('pz_pallets')
    .select('goods_receipt_id')
    .select((eb) => eb.fn.count<string>('id').as('pallet_count'))
    .where('goods_receipt_id', 'in', ids)
    .where('tenant_id', '=', tenantId)
  if (scopedOrgIds !== null) countedPallets = countedPallets.where('organization_id', 'in', scopedOrgIds)
  const palletRows = await countedPallets.groupBy('goods_receipt_id').execute()
  const palletCounts = new Map(palletRows.map((row) => [String(row.goods_receipt_id), Number(row.pallet_count)]))
  for (const item of items) item.palletCount = palletCounts.get(item.id) ?? 0

  if (isSingleRecordRequest(ctx.query)) {
    let detail = db
      .selectFrom('pz_goods_receipt_lines')
      .selectAll()
      .where('goods_receipt_id', 'in', ids)
      .where('tenant_id', '=', tenantId)
    // The foreign key does not constrain a line's scope to its header's, so the read
    // repeats the caller's organization predicate instead of trusting the parent id alone.
    if (scopedOrgIds !== null) detail = detail.where('organization_id', 'in', scopedOrgIds)
    const rows = await detail.orderBy('line_number', 'asc').execute()

    const byReceipt = new Map<string, GoodsReceiptLineItem[]>()
    for (const row of rows) {
      const bucket = byReceipt.get(String(row.goods_receipt_id)) ?? []
      bucket.push(toGoodsReceiptLineItem(row))
      byReceipt.set(String(row.goods_receipt_id), bucket)
    }
    for (const item of items) {
      const lines = byReceipt.get(item.id) ?? []
      item.lines = lines
      item.lineCount = lines.length
    }
    return
  }

  let counted = db
    .selectFrom('pz_goods_receipt_lines')
    .select('goods_receipt_id')
    .select((eb) => eb.fn.count<string>('id').as('line_count'))
    .where('goods_receipt_id', 'in', ids)
    .where('tenant_id', '=', tenantId)
  if (scopedOrgIds !== null) counted = counted.where('organization_id', 'in', scopedOrgIds)
  const rows = await counted.groupBy('goods_receipt_id').execute()

  const counts = new Map(rows.map((row) => [String(row.goods_receipt_id), Number(row.line_count)]))
  for (const item of items) {
    item.lineCount = counts.get(item.id) ?? 0
  }
}

export const { metadata, GET, POST, PUT, DELETE } = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: GoodsReceipt,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  indexer: { entityType: E.pz.goods_receipt },
  list: {
    schema: goodsReceiptListSchema,
    entityId: E.pz.goods_receipt,
    fields: [
      F.id,
      F.tenant_id,
      F.organization_id,
      F.document_number,
      F.document_date,
      F.supplier_name,
      F.warehouse_id,
      F.warehouse_snapshot,
      F.status,
      F.created_at,
      F.updated_at,
    ],
    sortFieldMap: {
      documentNumber: F.document_number,
      documentDate: F.document_date,
      status: F.status,
      createdAt: F.created_at,
      updatedAt: F.updated_at,
    },
    defaultSort: { field: 'documentDate', dir: 'desc' },
    // Document Date is day-granular, so same-day receipts would otherwise come back in the
    // database's arbitrary row order and duplicate or skip rows across pages. Document
    // Number is the secondary key and is unique within a tenant and organization, so it
    // settles every tie on its own.
    tiebreakSortField: 'documentNumber',
    // A freshly created goods receipt has to be in the index it redirects to.
    disableListCache: true,
    buildFilters: async (query: GoodsReceiptListQuery, ctx: CrudCtx) => {
      const filters: Record<string, unknown> = {}
      if (query.id) filters[F.id] = query.id
      if (typeof query.ids === 'string' && query.ids.trim().length > 0) {
        const ids = query.ids
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
        if (ids.length > 0) filters[F.id] = { $in: ids }
      }

      if (query.status) filters[F.status] = query.status
      if (query.warehouseId) filters[F.warehouse_id] = query.warehouseId

      // Both ends are inclusive: a user asking for the 3rd to the 5th means three days, and
      // the column stores a day rather than an instant, so no end-of-day arithmetic applies.
      const documentDate: Record<string, Date> = {}
      if (query.documentDateFrom) documentDate.$gte = toCalendarDay(query.documentDateFrom)
      if (query.documentDateTo) documentDate.$lte = toCalendarDay(query.documentDateTo)
      if (Object.keys(documentDate).length > 0) filters[F.document_date] = documentDate

      // Free text is one question over two columns — people search for whatever they were
      // given, a document number or a supplier, without saying which it is.
      const term = sanitizeSearchTerm(query.search)
      if (term) {
        const matched = await findGoodsReceiptIdsMatching(term, ctx)
        const existing = filters[F.id]
        // `$in` of the intersection, so a search combined with an explicit id stays an AND.
        const narrowed = Array.isArray((existing as { $in?: string[] } | undefined)?.$in)
          ? (existing as { $in: string[] }).$in.filter((id) => matched.includes(id))
          : typeof existing === 'string'
            ? (matched.includes(existing) ? [existing] : [])
            : matched
        filters[F.id] = narrowed.length > 0 ? { $in: narrowed } : { $eq: NO_SUCH_ID }
      }

      return filters
    },
    transformItem: (item: GoodsReceiptListRow): GoodsReceiptListItem => toGoodsReceiptListItem(item),
  },
  actions: {
    create: {
      commandId: 'pz.goodsReceipts.create',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => parsed,
      response: ({ result }) => ({
        id: String((result as GoodsReceipt).id),
        updatedAt: (result as GoodsReceipt).updatedAt?.toISOString() ?? null,
      }),
      status: 201,
    },
    update: {
      commandId: 'pz.goodsReceipts.update',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => parsed,
      response: ({ result }) => ({
        id: String((result as GoodsReceipt).id),
        updatedAt: (result as GoodsReceipt).updatedAt?.toISOString() ?? null,
      }),
    },
    delete: {
      commandId: 'pz.goodsReceipts.delete',
      response: () => ({ ok: true }),
    },
  },
  hooks: {
    afterList: async (payload, ctx) => {
      await decorateCountsAndLines(payload as { items?: GoodsReceiptListItem[] }, ctx)
    },
  },
})

const warehouseSnapshotSchema: z.ZodType<GoodsReceiptWarehouseSnapshot | null> = z
  .object({ name: z.string(), code: z.string() })
  .nullable()

const goodsReceiptLineItemSchema = z.object({
  id: z.string().uuid(),
  lineNumber: z.number().int(),
  catalogProductId: z.string().uuid(),
  catalogVariantId: z.string().uuid(),
  catalogSnapshot: z.object({ name: z.string(), sku: z.string().nullable() }).nullable(),
  quantity: z.string(),
  unit: z.string().nullable(),
  uomSnapshot: z.object({ code: z.string().nullable(), productDefaultUnit: z.string().nullable() }).nullable(),
  purchaseOrderId: z.string().uuid().nullable(),
  purchaseOrderLineId: z.string().uuid().nullable(),
  purchaseOrderSnapshot: z
    .object({ documentNumber: z.string(), lineNumber: z.number().int() })
    .nullable(),
})

const goodsReceiptListItemSchema = z.object({
  id: z.string().uuid(),
  documentNumber: z.string(),
  documentDate: z.string().nullable(),
  supplierName: z.string(),
  warehouseId: z.string().uuid(),
  warehouseSnapshot: warehouseSnapshotSchema,
  status: z.enum(['draft', 'receiving', 'confirmed']),
  lineCount: z.number().int(),
  palletCount: z.number().int(),
  lines: z.array(goodsReceiptLineItemSchema).nullable(),
  updatedAt: z.string().nullable(),
})

const goodsReceiptCreatedSchema = z.object({
  id: z.string().uuid(),
  updatedAt: z.string().nullable(),
})

const goodsReceiptUpdateBodySchema = goodsReceiptWriteBodySchema.extend({ id: z.string().uuid() })

const goodsReceiptDeleteBodySchema = z.object({ id: z.string().uuid() })

const goodsReceiptOkSchema = z.object({ ok: z.literal(true) })

export const openApi: OpenApiRouteDoc = createPzCrudOpenApi({
  resourceName: 'Goods Receipt',
  pluralName: 'Goods Receipts',
  querySchema: goodsReceiptListSchema,
  listResponseSchema: createPagedListResponseSchema(goodsReceiptListItemSchema),
  create: {
    schema: goodsReceiptWriteBodySchema,
    responseSchema: goodsReceiptCreatedSchema,
    description:
      'Creates a goods receipt and all of its lines in one transaction. Tenant and organization scope come from the session, never from the body.',
  },
  update: {
    schema: goodsReceiptUpdateBodySchema,
    responseSchema: goodsReceiptCreatedSchema,
    description:
      'Replaces a draft goods receipt and all of its lines in one transaction. Receiving and confirmed documents are refused. Send the record version in the `x-om-ext-optimistic-lock-expected-updated-at` header; a stale version is answered with 409.',
  },
  del: {
    schema: goodsReceiptDeleteBodySchema,
    responseSchema: goodsReceiptOkSchema,
    description:
      'Soft-deletes a draft goods receipt, freeing its Document Number for reuse. Receiving and confirmed documents are refused.',
  },
})
