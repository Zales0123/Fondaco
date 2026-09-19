import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import {
  resolveOrganizationScopeForRequest,
  type OrganizationScope,
} from '@open-mercato/core/modules/directory/utils/organizationScope'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { sanitizeSearchTerm } from '@open-mercato/shared/lib/query/sanitizeSearchTerm'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { announcementLimit } from '../../../lib/announcementLimit'
import { toIsoDay } from '../../../lib/purchaseOrderListItem'
import type { ProcurementsReadDatabase } from '../../readModel'

const logger = createLogger('procurements').child({ component: 'announceable-lines' })

/**
 * The picker behind "which purchase order does this delivery settle?".
 *
 * Read-only, and gated on viewing purchase orders rather than managing them: the person
 * announcing a delivery is a planner or a warehouse clerk, who needs to see what was
 * ordered without being able to change it.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['procurements.purchaseOrders.view'] },
}

const announceableQuerySchema = z.object({
  /**
   * Narrows to the product the announcing line is for — the usual case. Keyed on the
   * product rather than the variant because that is what a product picker hands over, and
   * an order line stores both.
   */
  catalogProductId: z.string().uuid().optional(),
  /** Narrows to one supplier's orders, matched on the name the order carries. */
  supplierName: z.string().trim().min(1).max(200).optional(),
  warehouseId: z.string().uuid().optional(),
  purchaseOrderId: z.string().uuid().optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

const announceableLineSchema = z.object({
  purchaseOrderLineId: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
  documentNumber: z.string(),
  lineNumber: z.number().int(),
  supplierName: z.string(),
  warehouseId: z.string().uuid(),
  catalogVariantId: z.string().uuid(),
  catalogProductId: z.string().uuid(),
  productName: z.string().nullable(),
  sku: z.string().nullable(),
  unit: z.string().nullable(),
  quantityOrdered: z.string(),
  quantityAnnounced: z.string(),
  quantityFree: z.string(),
  expectedDate: z.string().nullable(),
})

const announceableResponseSchema = z.object({ items: z.array(announceableLineSchema) })

const errorSchema = z.object({ error: z.string() }).passthrough()

const DEFAULT_LIMIT = 25

/**
 * `null` is the only value that means unrestricted within the tenant; an empty array is
 * deny-all, and widening it back to the selected organization would offer lines the caller
 * was refused.
 */
function resolveScopedOrganizationIds(scope: OrganizationScope): string[] | null {
  if (scope.filterIds === null) return null
  if (!Array.isArray(scope.filterIds)) return []
  return Array.from(
    new Set(scope.filterIds.filter((value): value is string => typeof value === 'string' && value.length > 0)),
  )
}

type AnnounceableRead = {
  em: EntityManager
  tenantId: string
  organizationIds: string[] | null
}

type Candidate = {
  purchaseOrderLineId: string
  purchaseOrderId: string
  documentNumber: string
  lineNumber: number
  supplierName: string
  warehouseId: string
  catalogVariantId: string
  catalogProductId: string
  productName: string | null
  sku: string | null
  unit: string | null
  quantityOrdered: string
  expectedDate: string | null
}

/**
 * Candidate lines: positions of released orders, optionally narrowed to a product, a
 * supplier, a warehouse or one order.
 *
 * Deliberately over-reads. The free quantity cannot be filtered in SQL without duplicating
 * the limit rule there, so the ledger is applied afterwards in one place and fully used
 * lines drop out then. The read is bounded so an order book of any size stays one query.
 */
async function loadCandidates(
  read: AnnounceableRead,
  query: z.infer<typeof announceableQuerySchema>,
): Promise<Candidate[]> {
  const db = read.em.getKysely<ProcurementsReadDatabase>()
  let statement = db
    .selectFrom('procurements_purchase_order_lines as line')
    .innerJoin('procurements_purchase_orders as po', 'po.id', 'line.purchase_order_id')
    .select([
      'line.id as line_id',
      'line.purchase_order_id as purchase_order_id',
      'line.line_number as line_number',
      'line.catalog_variant_id as catalog_variant_id',
      'line.catalog_product_id as catalog_product_id',
      'line.catalog_snapshot as catalog_snapshot',
      'line.quantity_ordered as quantity_ordered',
      'line.unit as unit',
      'line.expected_date as expected_date',
      'po.document_number as document_number',
      'po.supplier_name as supplier_name',
      'po.warehouse_id as warehouse_id',
    ])
    .where('line.tenant_id', '=', read.tenantId)
    .where('po.tenant_id', '=', read.tenantId)
    .where('po.deleted_at', 'is', null)
    // Only a standing order can be announced against; the reservation refuses anything else
    // anyway, so offering it here would only invite a conflict the user cannot resolve.
    .where('po.status', '=', 'released')
  if (read.organizationIds !== null) {
    statement = statement
      .where('line.organization_id', 'in', read.organizationIds)
      .where('po.organization_id', 'in', read.organizationIds)
  }
  if (query.catalogProductId) statement = statement.where('line.catalog_product_id', '=', query.catalogProductId)
  if (query.warehouseId) statement = statement.where('po.warehouse_id', '=', query.warehouseId)
  if (query.purchaseOrderId) statement = statement.where('line.purchase_order_id', '=', query.purchaseOrderId)
  if (query.supplierName) statement = statement.where('po.supplier_name', '=', query.supplierName)

  const term = sanitizeSearchTerm(query.search)
  if (term) {
    const pattern = `%${escapeLikePattern(term)}%`
    statement = statement.where((eb) => eb.or([
      eb('po.document_number', 'ilike', pattern),
      eb('po.supplier_name', 'ilike', pattern),
    ]))
  }

  // Soonest first: a picker is answering "what is this delivery for?", and the nearest
  // expected date is the most likely answer.
  const rows = await statement
    .orderBy('line.expected_date', 'asc')
    .orderBy('po.document_number', 'asc')
    .orderBy('line.line_number', 'asc')
    .limit(500)
    .execute()

  return rows.map((row) => ({
    purchaseOrderLineId: String(row.line_id),
    purchaseOrderId: String(row.purchase_order_id),
    documentNumber: String(row.document_number),
    lineNumber: Number(row.line_number),
    supplierName: String(row.supplier_name),
    warehouseId: String(row.warehouse_id),
    catalogVariantId: String(row.catalog_variant_id),
    catalogProductId: String(row.catalog_product_id),
    productName: row.catalog_snapshot?.name ?? null,
    sku: row.catalog_snapshot?.sku ?? null,
    unit: row.unit ?? null,
    quantityOrdered: String(row.quantity_ordered),
    expectedDate: toIsoDay(row.expected_date),
  }))
}

/** Sums the outstanding claims for the candidate lines, in one read. */
async function loadAnnounced(
  read: AnnounceableRead,
  lineIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byLine = new Map<string, string[]>()
  for (const id of lineIds) byLine.set(id, [])
  if (lineIds.length === 0) return byLine

  const db = read.em.getKysely<ProcurementsReadDatabase>()
  let statement = db
    .selectFrom('procurements_purchase_order_commitments')
    .select(['purchase_order_line_id', 'quantity'])
    .where('purchase_order_line_id', 'in', Array.from(new Set(lineIds)))
    .where('tenant_id', '=', read.tenantId)
    .where('status', '=', 'outstanding')
  if (read.organizationIds !== null) statement = statement.where('organization_id', 'in', read.organizationIds)

  for (const row of await statement.execute()) {
    byLine.get(String(row.purchase_order_line_id))?.push(String(row.quantity))
  }
  return byLine
}

export async function GET(request: Request) {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { translate } = await resolveTranslations()
  const params = new URL(request.url).searchParams
  const parsed = announceableQuerySchema.safeParse({
    catalogProductId: params.get('catalogProductId') ?? undefined,
    supplierName: params.get('supplierName') ?? undefined,
    warehouseId: params.get('warehouseId') ?? undefined,
    purchaseOrderId: params.get('purchaseOrderId') ?? undefined,
    search: params.get('search') ?? undefined,
    limit: params.get('limit') ?? undefined,
  })
  if (!parsed.success) {
    return Response.json(
      {
        error: translate(
          'procurements.purchaseOrderLines.errors.announceableQueryInvalid',
          'The purchase order line filter is not valid.',
        ),
      },
      { status: 400 },
    )
  }

  const container = await createRequestContainer()
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request })
  if (scope.selectionRejected) {
    return Response.json(
      {
        error: translate(
          'procurements.purchaseOrders.errors.organizationSelectionInvalid',
          'Your selected organization is no longer available. Please re-select an organization and try again.',
        ),
        code: 'organization_selection_invalid',
      },
      { status: 422 },
    )
  }

  const organizationIds = resolveScopedOrganizationIds(scope)
  // Deny-all is answered as an empty page, never as an unfiltered one.
  if (organizationIds !== null && organizationIds.length === 0) return Response.json({ items: [] })

  try {
    const read: AnnounceableRead = {
      em: container.resolve('em') as EntityManager,
      tenantId: scope.tenantId ?? auth.tenantId,
      organizationIds,
    }
    const candidates = await loadCandidates(read, parsed.data)
    const announced = await loadAnnounced(read, candidates.map((candidate) => candidate.purchaseOrderLineId))

    const items: z.infer<typeof announceableLineSchema>[] = []
    const limit = parsed.data.limit ?? DEFAULT_LIMIT
    for (const candidate of candidates) {
      const computed = announcementLimit(
        candidate.quantityOrdered,
        announced.get(candidate.purchaseOrderLineId) ?? [],
      )
      // Nothing left to announce, or a line whose ledger does not add up: neither is a
      // choice worth offering, and the second is surfaced on the order itself instead.
      if (!computed.isConsistent) continue
      if (computed.free === '0.0000') continue
      items.push({
        ...candidate,
        quantityAnnounced: computed.announced,
        quantityFree: computed.free,
      })
      if (items.length >= limit) break
    }

    return Response.json({ items })
  } catch (error) {
    logger.error('Announceable purchase order lines failed', { err: error })
    return Response.json(
      {
        error: translate(
          'procurements.purchaseOrderLines.errors.announceableFailed',
          'The purchase order lines available to announce could not be read.',
        ),
      },
      { status: 500 },
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Purchase Order Lines',
  summary: 'Purchase order lines still free to announce',
  methods: {
    GET: {
      summary: 'List purchase order lines a delivery announcement can still draw on',
      description:
        'Returns positions of released purchase orders that still have a quantity free to announce, newest expected date first. Free is the ordered quantity minus everything outstanding announcements already hold; a line with nothing left, or whose ledger holds more than was ordered, is omitted. Quantities are decimal strings at the storage precision, because a JSON number cannot carry numeric(18,4) faithfully. Read-only and scoped to the authenticated tenant and organization.',
      tags: ['Purchase Order Lines'],
      query: announceableQuerySchema,
      responses: [
        { status: 200, description: 'Lines still free to announce.', schema: announceableResponseSchema },
      ],
      errors: [
        { status: 400, description: 'Malformed filter', schema: errorSchema },
        { status: 401, description: 'Authentication required', schema: errorSchema },
        { status: 403, description: 'The caller does not hold procurements.purchaseOrders.view', schema: errorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: errorSchema },
      ],
    },
  },
}
