import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { sanitizeSearchTerm } from '@open-mercato/shared/lib/query/sanitizeSearchTerm'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { PurchaseOrder } from '../../data/entities'
import {
  purchaseOrderListSchema,
  purchaseOrderWriteBodySchema,
  type PurchaseOrderListQuery,
} from '../../data/validators'
import { createProcurementsCrudOpenApi, createPagedListResponseSchema } from '../openapi'
import { sumDecimals } from '../../lib/decimal'
import {
  toPurchaseOrderLineItem,
  toPurchaseOrderListItem,
  type PurchaseOrderLineItem,
  type PurchaseOrderListItem,
  type PurchaseOrderListRow,
} from '../../lib/purchaseOrderListItem'
import {
  type ProcurementsReadDatabase,
  resolveScopedOrganizationIds,
} from '../readModel'
import { readAnnouncedQuantities, toAnnouncementLimits } from '../announcementReads'

const F = {
  id: 'id',
  tenant_id: 'tenant_id',
  organization_id: 'organization_id',
  document_number: 'document_number',
  order_date: 'order_date',
  expected_date: 'expected_date',
  supplier_id: 'supplier_id',
  supplier_name: 'supplier_name',
  supplier_snapshot: 'supplier_snapshot',
  warehouse_id: 'warehouse_id',
  warehouse_snapshot: 'warehouse_snapshot',
  currency_code: 'currency_code',
  status: 'status',
  notes: 'notes',
  created_at: 'created_at',
  updated_at: 'updated_at',
} as const

/** A calendar day filter compared against a day-granular column, anchored at UTC midnight. */
function toCalendarDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

/** Matches nothing, for a search whose answer is "no order", which `$in: []` cannot say. */
const NO_SUCH_ID = '00000000-0000-0000-0000-000000000000'

/**
 * Resolves a free-text search to order ids with SQL, rather than handing an `$ilike` to the
 * query engine.
 *
 * The engine reroutes a base-column `like`/`ilike` through `search_tokens` by default, and
 * tokenization splits on non-alphanumerics and drops short tokens — so `ZZ/1/2026` degrades
 * to {2026} and matches every order from that year. Purchase order numbers are full of
 * separators, so the one search buyers rely on most is exactly the one that would break. This
 * keeps the match literal.
 *
 * It repeats the caller's tenant and organization predicates rather than trusting the outer
 * query to apply them: the ids it returns become an `id IN (...)` filter, and an id the caller
 * may not see would be a leak however the rest of the query is scoped.
 */
async function findPurchaseOrderIdsMatching(term: string, ctx: CrudCtx): Promise<string[]> {
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) return []
  const scopedOrgIds = resolveScopedOrganizationIds(ctx)
  if (scopedOrgIds !== null && scopedOrgIds.length === 0) return []

  const pattern = `%${escapeLikePattern(term)}%`
  const em = ctx.container.resolve<EntityManager>('em')
  const db = em.getKysely<ProcurementsReadDatabase>()
  let matching = db
    .selectFrom('procurements_purchase_orders')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('deleted_at', 'is', null)
    .where((eb) => eb.or([
      eb('document_number', 'ilike', pattern),
      eb('supplier_name', 'ilike', pattern),
    ]))
  if (scopedOrgIds !== null) matching = matching.where('organization_id', 'in', scopedOrgIds)

  // Bounded: a search is a way to find an order, not a way to export the table, and the page
  // the caller asked for is taken from this set afterwards.
  const rows = await matching.limit(1000).execute()
  return rows.map((row) => String(row.id))
}

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['procurements.purchaseOrders.view'] },
  POST: { requireAuth: true, requireFeatures: ['procurements.purchaseOrders.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['procurements.purchaseOrders.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['procurements.purchaseOrders.manage'] },
}

/**
 * The command owns validation so a rejection can name the field that caused it; the route
 * passes the body through untouched.
 */
const rawBodySchema = z.object({}).passthrough()

/**
 * Lines ride along only on a single-record read — the edit and detail screens load exactly
 * that way. A grid page would pay for rows it never renders, so it gets the count and the
 * total instead.
 */
function isSingleRecordRequest(query: PurchaseOrderListQuery): boolean {
  if (typeof query.id === 'string' && query.id.length > 0) return true
  return typeof query.ids === 'string' && query.ids.trim().length > 0
}

/**
 * Line counts and net totals are per-page aggregates, not columns: the header stores no
 * denormalised total, and `transformItem` is synchronous. `afterList` is the one hook that can
 * read exactly the ids the page already resolved.
 *
 * The total is summed from the lines themselves rather than in SQL, so the order total is the
 * sum of the values printed beside each line — a `sum(quantity * price)` rounded once at the
 * end can differ from that by a cent and makes a document nobody can reconcile.
 */
async function decorateAggregates(
  payload: { items?: PurchaseOrderListItem[] },
  ctx: CrudCtx & { query: PurchaseOrderListQuery },
): Promise<void> {
  const items = Array.isArray(payload.items) ? payload.items : []
  if (items.length === 0) return
  // No trusted tenant means no trusted aggregate. Leaving the count at 0 and the total at
  // `null` is the fail-closed answer; an unscoped aggregate is not.
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) return
  const scopedOrgIds = resolveScopedOrganizationIds(ctx)
  if (scopedOrgIds !== null && scopedOrgIds.length === 0) return

  const ids = items.map((item) => item.id)
  const em = ctx.container.resolve<EntityManager>('em')
  const db = em.getKysely<ProcurementsReadDatabase>()

  let detail = db
    .selectFrom('procurements_purchase_order_lines')
    .selectAll()
    .where('purchase_order_id', 'in', ids)
    .where('tenant_id', '=', tenantId)
  // The foreign key does not constrain a line's scope to its header's, so the read repeats
  // the caller's organization predicate instead of trusting the parent id alone.
  if (scopedOrgIds !== null) detail = detail.where('organization_id', 'in', scopedOrgIds)
  const rows = await detail.orderBy('line_number', 'asc').execute()

  const byOrder = new Map<string, PurchaseOrderLineItem[]>()
  for (const row of rows) {
    const bucket = byOrder.get(String(row.purchase_order_id)) ?? []
    bucket.push(toPurchaseOrderLineItem(row))
    byOrder.set(String(row.purchase_order_id), bucket)
  }

  const withLines = isSingleRecordRequest(ctx.query)
  for (const item of items) {
    const lines = byOrder.get(item.id) ?? []
    item.lineCount = lines.length
    const values = lines.map((line) => line.netValue)
    // One unreadable line makes the whole total unreadable rather than quietly smaller.
    item.netTotal = values.some((value) => value === null)
      ? null
      : sumDecimals(values as string[])
    if (withLines) item.lines = lines
  }

  // Only the detail view renders the lines, so only it pays for reading the ledger.
  if (!withLines) return
  const lineItems = items.flatMap((item) => item.lines ?? [])
  if (lineItems.length === 0) return
  const announced = await readAnnouncedQuantities(ctx, lineItems.map((line) => line.id))
  const limits = toAnnouncementLimits(
    lineItems.map((line) => ({ id: line.id, quantityOrdered: line.quantityOrdered })),
    announced,
  )
  for (const line of lineItems) {
    const limit = limits.get(line.id)
    if (!limit) continue
    line.quantityAnnounced = limit.announced
    line.quantityFree = limit.isConsistent ? limit.free : null
  }
}

export const { metadata, GET, POST, PUT, DELETE } = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: PurchaseOrder,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  indexer: { entityType: E.procurements.purchase_order },
  list: {
    schema: purchaseOrderListSchema,
    entityId: E.procurements.purchase_order,
    fields: [
      F.id,
      F.tenant_id,
      F.organization_id,
      F.document_number,
      F.order_date,
      F.expected_date,
      F.supplier_id,
      F.supplier_name,
      F.supplier_snapshot,
      F.warehouse_id,
      F.warehouse_snapshot,
      F.currency_code,
      F.status,
      F.notes,
      F.created_at,
      F.updated_at,
    ],
    sortFieldMap: {
      documentNumber: F.document_number,
      orderDate: F.order_date,
      expectedDate: F.expected_date,
      status: F.status,
      createdAt: F.created_at,
      updatedAt: F.updated_at,
    },
    defaultSort: { field: 'orderDate', dir: 'desc' },
    // Order Date is day-granular, so same-day orders would otherwise come back in the
    // database's arbitrary row order and duplicate or skip rows across pages. Document Number
    // is unique within a tenant and organization, so it settles every tie on its own.
    tiebreakSortField: 'documentNumber',
    // A freshly created purchase order has to be in the index it redirects to.
    disableListCache: true,
    buildFilters: async (query: PurchaseOrderListQuery, ctx: CrudCtx) => {
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
      // the columns store a day rather than an instant, so no end-of-day arithmetic applies.
      const orderDate: Record<string, Date> = {}
      if (query.orderDateFrom) orderDate.$gte = toCalendarDay(query.orderDateFrom)
      if (query.orderDateTo) orderDate.$lte = toCalendarDay(query.orderDateTo)
      if (Object.keys(orderDate).length > 0) filters[F.order_date] = orderDate

      const expectedDate: Record<string, Date> = {}
      if (query.expectedDateFrom) expectedDate.$gte = toCalendarDay(query.expectedDateFrom)
      if (query.expectedDateTo) expectedDate.$lte = toCalendarDay(query.expectedDateTo)
      if (Object.keys(expectedDate).length > 0) filters[F.expected_date] = expectedDate

      // Free text is one question over two columns — people search for whatever they were
      // given, a document number or a supplier, without saying which it is.
      const term = sanitizeSearchTerm(query.search)
      if (term) {
        const matched = await findPurchaseOrderIdsMatching(term, ctx)
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
    transformItem: (item: PurchaseOrderListRow): PurchaseOrderListItem => toPurchaseOrderListItem(item),
  },
  actions: {
    create: {
      commandId: 'procurements.purchaseOrders.create',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => parsed,
      response: ({ result }) => ({
        id: String((result as PurchaseOrder).id),
        updatedAt: (result as PurchaseOrder).updatedAt?.toISOString() ?? null,
      }),
      status: 201,
    },
    update: {
      commandId: 'procurements.purchaseOrders.update',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => parsed,
      response: ({ result }) => ({
        id: String((result as PurchaseOrder).id),
        updatedAt: (result as PurchaseOrder).updatedAt?.toISOString() ?? null,
      }),
    },
    delete: {
      commandId: 'procurements.purchaseOrders.delete',
      response: () => ({ ok: true }),
    },
  },
  hooks: {
    afterList: async (payload, ctx) => {
      await decorateAggregates(payload as { items?: PurchaseOrderListItem[] }, ctx)
    },
  },
})

const supplierSnapshotSchema = z
  .object({ name: z.string(), code: z.string().nullable() })
  .nullable()

const warehouseSnapshotSchema = z.object({ name: z.string(), code: z.string() }).nullable()

const purchaseOrderLineItemSchema = z.object({
  id: z.string().uuid(),
  lineNumber: z.number().int(),
  catalogProductId: z.string().uuid(),
  catalogVariantId: z.string().uuid(),
  catalogSnapshot: z.object({ name: z.string(), sku: z.string().nullable() }).nullable(),
  quantityOrdered: z.string(),
  unit: z.string().nullable(),
  uomSnapshot: z.object({ code: z.string().nullable(), productDefaultUnit: z.string().nullable() }).nullable(),
  unitPriceNet: z.string(),
  netValue: z.string().nullable(),
  expectedDate: z.string().nullable(),
  quantityAnnounced: z.string().nullable(),
  quantityFree: z.string().nullable(),
})

const purchaseOrderListItemSchema = z.object({
  id: z.string().uuid(),
  documentNumber: z.string(),
  orderDate: z.string().nullable(),
  expectedDate: z.string().nullable(),
  supplierId: z.string().uuid().nullable(),
  supplierName: z.string(),
  supplierSnapshot: supplierSnapshotSchema,
  warehouseId: z.string().uuid(),
  warehouseSnapshot: warehouseSnapshotSchema,
  currencyCode: z.string(),
  status: z.enum(['draft', 'released', 'cancelled']),
  notes: z.string().nullable(),
  lineCount: z.number().int(),
  netTotal: z.string().nullable(),
  lines: z.array(purchaseOrderLineItemSchema).nullable(),
  updatedAt: z.string().nullable(),
})

const purchaseOrderCreatedSchema = z.object({
  id: z.string().uuid(),
  updatedAt: z.string().nullable(),
})

const purchaseOrderUpdateBodySchema = purchaseOrderWriteBodySchema.extend({ id: z.string().uuid() })

const purchaseOrderDeleteBodySchema = z.object({ id: z.string().uuid() })

const purchaseOrderOkSchema = z.object({ ok: z.literal(true) })

export const openApi: OpenApiRouteDoc = createProcurementsCrudOpenApi({
  resourceName: 'Purchase Order',
  pluralName: 'Purchase Orders',
  querySchema: purchaseOrderListSchema,
  listResponseSchema: createPagedListResponseSchema(purchaseOrderListItemSchema),
  create: {
    schema: purchaseOrderWriteBodySchema,
    responseSchema: purchaseOrderCreatedSchema,
    description:
      'Creates a draft purchase order and all of its lines in one transaction. Tenant and organization scope come from the session, never from the body.',
  },
  update: {
    schema: purchaseOrderUpdateBodySchema,
    responseSchema: purchaseOrderCreatedSchema,
    description:
      'Replaces a draft purchase order and all of its lines in one transaction. Released and cancelled orders are refused. Send the record version in the `x-om-ext-optimistic-lock-expected-updated-at` header; a stale version is answered with 409.',
  },
  del: {
    schema: purchaseOrderDeleteBodySchema,
    responseSchema: purchaseOrderOkSchema,
    description:
      'Soft-deletes a draft purchase order, freeing its Document Number for reuse. A released order is cancelled instead, never deleted.',
  },
})
