import { z } from 'zod'
import { sql } from 'kysely'
import type { EntityManager } from '@mikro-orm/postgresql'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { sanitizeSearchTerm } from '@open-mercato/shared/lib/query/sanitizeSearchTerm'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { PurchaseOrderLine } from '../../data/entities'
import { purchaseOrderLineListSchema, type PurchaseOrderLineListQuery } from '../../data/validators'
import { createProcurementsCrudOpenApi, createPagedListResponseSchema } from '../openapi'
import {
  toIsoDay,
  toIsoTimestamp,
  toPurchaseOrderLineItem,
  toPurchaseOrderStatus,
  type PurchaseOrderLineListItem,
  type PurchaseOrderLineRow,
} from '../../lib/purchaseOrderListItem'
import { type ProcurementsReadDatabase, resolveScopedOrganizationIds } from '../readModel'
import { readAnnouncedQuantities, toAnnouncementLimits } from '../announcementReads'

const F = {
  id: 'id',
  tenant_id: 'tenant_id',
  organization_id: 'organization_id',
  purchase_order_id: 'purchase_order_id',
  line_number: 'line_number',
  catalog_product_id: 'catalog_product_id',
  catalog_variant_id: 'catalog_variant_id',
  catalog_snapshot: 'catalog_snapshot',
  quantity_ordered: 'quantity_ordered',
  unit: 'unit',
  uom_snapshot: 'uom_snapshot',
  unit_price_net: 'unit_price_net',
  expected_date: 'expected_date',
  created_at: 'created_at',
  updated_at: 'updated_at',
} as const

function toCalendarDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

/** Matches nothing, for a filter whose answer is "no order", which `$in: []` cannot say. */
const NO_SUCH_ID = '00000000-0000-0000-0000-000000000000'

type OrderHeader = {
  id: string
  documentNumber: string
  supplierName: string
  warehouseId: string
  status: PurchaseOrderLineListItem['status']
  currencyCode: string
  orderDate: string | null
}

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['procurements.purchaseOrders.view'] },
}

/**
 * Resolves the header-level part of a line query to a set of order ids.
 *
 * A line carries no copy of its order's status, supplier or warehouse — denormalising them
 * would be a second source of truth that drifts the moment an order is withdrawn — so the
 * filters that name those facts are answered here and handed to the line query as an
 * `purchase_order_id IN (...)` predicate.
 *
 * Returning `null` means "no header filter was asked for"; an empty array means "asked for,
 * and nothing matches", which the caller turns into an empty page rather than an unfiltered
 * one. The read repeats the caller's tenant and organization predicates, because the ids it
 * produces decide which lines are visible.
 */
async function resolveHeaderFilter(
  query: PurchaseOrderLineListQuery,
  ctx: CrudCtx,
): Promise<string[] | null> {
  const term = sanitizeSearchTerm(query.search)
  const wantsHeaderFilter = Boolean(query.status || query.warehouseId || term)
  if (!wantsHeaderFilter) return null

  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) return []
  const scopedOrgIds = resolveScopedOrganizationIds(ctx)
  if (scopedOrgIds !== null && scopedOrgIds.length === 0) return []

  const em = ctx.container.resolve<EntityManager>('em')
  const db = em.getKysely<ProcurementsReadDatabase>()
  let matching = db
    .selectFrom('procurements_purchase_orders')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('deleted_at', 'is', null)
  if (scopedOrgIds !== null) matching = matching.where('organization_id', 'in', scopedOrgIds)
  if (query.status) matching = matching.where('status', '=', query.status)
  if (query.warehouseId) matching = matching.where('warehouse_id', '=', query.warehouseId)
  if (term) {
    const pattern = `%${escapeLikePattern(term)}%`
    matching = matching.where((eb) => eb.or([
      eb('document_number', 'ilike', pattern),
      eb('supplier_name', 'ilike', pattern),
    ]))
  }

  const rows = await matching.limit(2000).execute()
  return rows.map((row) => String(row.id))
}

/**
 * The product half of a free-text search.
 *
 * A buyer types one thing and means either the order it is on or the product on it, so the
 * search is the union of both. The product side matches the line's own stored snapshot rather
 * than the live catalog: the snapshot is what the document says, and joining out to `catalog`
 * would make this module depend on a table it deliberately only references by id.
 */
async function findLineIdsMatchingProduct(term: string, ctx: CrudCtx): Promise<string[]> {
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) return []
  const scopedOrgIds = resolveScopedOrganizationIds(ctx)
  if (scopedOrgIds !== null && scopedOrgIds.length === 0) return []

  const pattern = `%${escapeLikePattern(term)}%`
  const em = ctx.container.resolve<EntityManager>('em')
  const db = em.getKysely<ProcurementsReadDatabase>()
  let matching = db
    .selectFrom('procurements_purchase_order_lines')
    .select('id')
    .where('tenant_id', '=', tenantId)
    // The snapshot is jsonb; `->>` yields text, which is what `ilike` needs. Written as SQL
    // because the match is over two keys of one document, not two columns.
    .where(
      sql<boolean>`("catalog_snapshot"->>'name' ilike ${pattern} or "catalog_snapshot"->>'sku' ilike ${pattern})`,
    )
  if (scopedOrgIds !== null) matching = matching.where('organization_id', 'in', scopedOrgIds)

  const rows = await matching.limit(2000).execute()
  return rows.map((row) => String(row.id))
}

/**
 * Reads the few header facts the cross-order view shows beside each line.
 *
 * Only for the ids on the page, and only the columns the table renders — this is a display
 * join, not a second read path into the order aggregate.
 */
async function decorateHeaders(
  payload: { items?: PurchaseOrderLineListItem[] },
  ctx: CrudCtx,
): Promise<void> {
  const items = Array.isArray(payload.items) ? payload.items : []
  if (items.length === 0) return
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) return
  const scopedOrgIds = resolveScopedOrganizationIds(ctx)
  if (scopedOrgIds !== null && scopedOrgIds.length === 0) return

  const orderIds = Array.from(new Set(items.map((item) => item.purchaseOrderId).filter((id) => id.length > 0)))
  if (orderIds.length === 0) return

  const em = ctx.container.resolve<EntityManager>('em')
  const db = em.getKysely<ProcurementsReadDatabase>()
  let headers = db
    .selectFrom('procurements_purchase_orders')
    .select(['id', 'document_number', 'supplier_name', 'warehouse_id', 'status', 'currency_code', 'order_date'])
    .where('id', 'in', orderIds)
    .where('tenant_id', '=', tenantId)
    .where('deleted_at', 'is', null)
  if (scopedOrgIds !== null) headers = headers.where('organization_id', 'in', scopedOrgIds)
  const rows = await headers.execute()

  const byId = new Map<string, OrderHeader>(
    rows.map((row) => [
      String(row.id),
      {
        id: String(row.id),
        documentNumber: String(row.document_number),
        supplierName: String(row.supplier_name),
        warehouseId: String(row.warehouse_id),
        status: toPurchaseOrderStatus(row.status),
        currencyCode: String(row.currency_code ?? 'PLN'),
        orderDate: toIsoDay(row.order_date),
      },
    ]),
  )

  for (const item of items) {
    const header = byId.get(item.purchaseOrderId)
    if (!header) continue
    item.documentNumber = header.documentNumber
    item.supplierName = header.supplierName
    item.warehouseId = header.warehouseId
    item.status = header.status
    item.currencyCode = header.currencyCode
    item.orderDate = header.orderDate
  }
}

type PurchaseOrderLineListRow = PurchaseOrderLineRow & {
  updated_at: Date | string | null
}

/**
 * The header fields start blank and are filled by `afterList`. They are never guessed: a line
 * whose header the caller may not read keeps an empty number and a `draft` status rather than
 * borrowing another row's.
 */
function toPurchaseOrderLineListItem(row: PurchaseOrderLineListRow): PurchaseOrderLineListItem {
  return {
    ...toPurchaseOrderLineItem(row),
    purchaseOrderId: String(row.purchase_order_id),
    documentNumber: '',
    supplierName: '',
    warehouseId: '',
    status: 'draft',
    currencyCode: '',
    orderDate: null,
    updatedAt: toIsoTimestamp(row.updated_at),
  }
}

export const { metadata, GET } = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: PurchaseOrderLine,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    // Lines are hard-deleted with their order's replacement; there is no soft-delete column.
    softDeleteField: null,
  },
  indexer: { entityType: E.procurements.purchase_order_line },
  list: {
    schema: purchaseOrderLineListSchema,
    entityId: E.procurements.purchase_order_line,
    fields: [
      F.id,
      F.tenant_id,
      F.organization_id,
      F.purchase_order_id,
      F.line_number,
      F.catalog_product_id,
      F.catalog_variant_id,
      F.catalog_snapshot,
      F.quantity_ordered,
      F.unit,
      F.uom_snapshot,
      F.unit_price_net,
      F.expected_date,
      F.created_at,
      F.updated_at,
    ],
    sortFieldMap: {
      lineNumber: F.line_number,
      expectedDate: F.expected_date,
      quantityOrdered: F.quantity_ordered,
      createdAt: F.created_at,
      updatedAt: F.updated_at,
      id: F.id,
    },
    // What is due next is the question this view exists to answer.
    defaultSort: { field: 'expectedDate', dir: 'asc' },
    // Expected Date is day-granular and lines share it freely, so without a unique tiebreak
    // the same row could appear on two pages. The primary key settles every tie.
    tiebreakSortField: 'id',
    disableListCache: true,
    buildFilters: async (query: PurchaseOrderLineListQuery, ctx: CrudCtx) => {
      const filters: Record<string, unknown> = {}
      if (query.id) filters[F.id] = query.id
      if (typeof query.ids === 'string' && query.ids.trim().length > 0) {
        const ids = query.ids
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
        if (ids.length > 0) filters[F.id] = { $in: ids }
      }

      const expectedDate: Record<string, Date> = {}
      if (query.expectedDateFrom) expectedDate.$gte = toCalendarDay(query.expectedDateFrom)
      if (query.expectedDateTo) expectedDate.$lte = toCalendarDay(query.expectedDateTo)
      if (Object.keys(expectedDate).length > 0) filters[F.expected_date] = expectedDate

      const headerIds = await resolveHeaderFilter(query, ctx)
      const explicitOrderId = query.purchaseOrderId || null
      let orderIds: string[] | null = headerIds
      if (explicitOrderId) {
        // An explicit order plus header filters stays an AND: the order has to satisfy both.
        orderIds = headerIds === null
          ? [explicitOrderId]
          : headerIds.filter((id) => id === explicitOrderId)
      }
      if (orderIds !== null) {
        filters[F.purchase_order_id] = orderIds.length > 0 ? { $in: orderIds } : { $eq: NO_SUCH_ID }
      }

      // A free-text term matches either the order or the product, so the product half is a
      // union with — not a narrowing of — the header half already applied above.
      const term = sanitizeSearchTerm(query.search)
      if (term) {
        const productLineIds = await findLineIdsMatchingProduct(term, ctx)
        if (productLineIds.length > 0) {
          const headerPredicate = filters[F.purchase_order_id]
          delete filters[F.purchase_order_id]
          const alternatives: Record<string, unknown>[] = [{ [F.id]: { $in: productLineIds } }]
          // Only a header predicate that can still match anything is worth keeping in the OR.
          if (headerPredicate && !isImpossibleIdPredicate(headerPredicate)) {
            alternatives.push({ [F.purchase_order_id]: headerPredicate })
          }
          filters.$or = alternatives
        }
      }

      return filters
    },
    transformItem: (item: PurchaseOrderLineListRow): PurchaseOrderLineListItem =>
      toPurchaseOrderLineListItem(item),
  },
  hooks: {
    afterList: async (payload, ctx) => {
      await decorateHeaders(payload as { items?: PurchaseOrderLineListItem[] }, ctx)
      await decorateAnnouncementLimits(payload as { items?: PurchaseOrderLineListItem[] }, ctx)
    },
  },
})

/**
 * Fills each row's announced and free quantities from the commitment ledger.
 *
 * Only for the ids on the page. A line whose limit is inconsistent — more announced than
 * ordered — keeps `null` rather than a clamped zero: the buyer needs to see that the
 * numbers do not add up, not a figure that hides it.
 */
async function decorateAnnouncementLimits(
  payload: { items?: PurchaseOrderLineListItem[] },
  ctx: CrudCtx,
): Promise<void> {
  const items = Array.isArray(payload.items) ? payload.items : []
  if (items.length === 0) return
  const announced = await readAnnouncedQuantities(ctx, items.map((item) => item.id))
  const limits = toAnnouncementLimits(
    items.map((item) => ({ id: item.id, quantityOrdered: item.quantityOrdered })),
    announced,
  )
  for (const item of items) {
    const limit = limits.get(item.id)
    if (!limit) continue
    item.quantityAnnounced = limit.announced
    item.quantityFree = limit.isConsistent ? limit.free : null
  }
}

/** The `{ $eq: NO_SUCH_ID }` sentinel above; anything else may still match a row. */
function isImpossibleIdPredicate(predicate: unknown): boolean {
  return (
    !!predicate
    && typeof predicate === 'object'
    && (predicate as { $eq?: unknown }).$eq === NO_SUCH_ID
  )
}

const purchaseOrderLineListItemSchema = z.object({
  id: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
  documentNumber: z.string(),
  supplierName: z.string(),
  warehouseId: z.string(),
  status: z.enum(['draft', 'released', 'cancelled']),
  currencyCode: z.string(),
  orderDate: z.string().nullable(),
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
  updatedAt: z.string().nullable(),
})

export const openApi: OpenApiRouteDoc = createProcurementsCrudOpenApi({
  resourceName: 'Purchase Order Line',
  pluralName: 'Purchase Order Lines',
  querySchema: purchaseOrderLineListSchema,
  listResponseSchema: createPagedListResponseSchema(purchaseOrderLineListItemSchema),
})
