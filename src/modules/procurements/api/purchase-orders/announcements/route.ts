import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import {
  resolveOrganizationScopeForRequest,
  type OrganizationScope,
} from '@open-mercato/core/modules/directory/utils/organizationScope'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { toIsoTimestamp } from '../../../lib/purchaseOrderListItem'
import type { ProcurementsReadDatabase } from '../../readModel'

const logger = createLogger('procurements').child({ component: 'purchase-order-announcements' })

/**
 * What has been announced against one purchase order.
 *
 * The order's own view of the commitment ledger: which delivery announcement took what,
 * from which position, and whether it still holds it. It reports the announcing document by
 * the number captured when the claim was made rather than by reading the other module's
 * tables, so purchasing stays readable whatever happens over in the warehouse.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['procurements.purchaseOrders.view'] },
}

const announcementsQuerySchema = z.object({
  purchaseOrderId: z.string().uuid(),
  /** Released claims are history and hidden by default; the order's audit trail asks for them. */
  includeReleased: z.coerce.boolean().optional(),
})

const announcementSchema = z.object({
  id: z.string().uuid(),
  purchaseOrderLineId: z.string().uuid(),
  lineNumber: z.number().int().nullable(),
  catalogSnapshot: z.object({ name: z.string(), sku: z.string().nullable() }).nullable(),
  sourceType: z.string(),
  sourceDocumentId: z.string().uuid(),
  sourceDocumentNumber: z.string().nullable(),
  sourceLineNumber: z.number().int().nullable(),
  quantity: z.string(),
  status: z.string(),
  releasedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
})

const announcementsResponseSchema = z.object({ items: z.array(announcementSchema) })

const errorSchema = z.object({ error: z.string() }).passthrough()

function resolveScopedOrganizationIds(scope: OrganizationScope): string[] | null {
  if (scope.filterIds === null) return null
  if (!Array.isArray(scope.filterIds)) return []
  return Array.from(
    new Set(scope.filterIds.filter((value): value is string => typeof value === 'string' && value.length > 0)),
  )
}

export async function GET(request: Request) {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { translate } = await resolveTranslations()
  const params = new URL(request.url).searchParams
  const parsed = announcementsQuerySchema.safeParse({
    purchaseOrderId: params.get('purchaseOrderId') ?? undefined,
    includeReleased: params.get('includeReleased') ?? undefined,
  })
  if (!parsed.success) {
    return Response.json(
      {
        error: translate(
          'procurements.purchaseOrders.errors.idRequired',
          'A purchase order identifier is required.',
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
  if (organizationIds !== null && organizationIds.length === 0) return Response.json({ items: [] })

  try {
    const em = container.resolve('em') as EntityManager
    const tenantId = scope.tenantId ?? auth.tenantId
    const db = em.getKysely<ProcurementsReadDatabase>()

    // The line join is what lets the tab say which position was announced, in the order's
    // own words rather than by an opaque id.
    let statement = db
      .selectFrom('procurements_purchase_order_commitments as claim')
      .leftJoin('procurements_purchase_order_lines as line', 'line.id', 'claim.purchase_order_line_id')
      .select([
        'claim.id as id',
        'claim.purchase_order_line_id as purchase_order_line_id',
        'claim.source_type as source_type',
        'claim.source_document_id as source_document_id',
        'claim.source_snapshot as source_snapshot',
        'claim.quantity as quantity',
        'claim.status as status',
        'claim.released_at as released_at',
        'claim.created_at as created_at',
        'line.line_number as line_number',
        'line.catalog_snapshot as catalog_snapshot',
      ])
      .where('claim.purchase_order_id', '=', parsed.data.purchaseOrderId)
      .where('claim.tenant_id', '=', tenantId)
    if (organizationIds !== null) statement = statement.where('claim.organization_id', 'in', organizationIds)
    if (!parsed.data.includeReleased) statement = statement.where('claim.status', '=', 'outstanding')

    const rows = await statement
      .orderBy('line.line_number', 'asc')
      .orderBy('claim.created_at', 'asc')
      .limit(500)
      .execute()

    return Response.json({
      items: rows.map((row) => ({
        id: String(row.id),
        purchaseOrderLineId: String(row.purchase_order_line_id),
        lineNumber: row.line_number == null ? null : Number(row.line_number),
        catalogSnapshot: row.catalog_snapshot ?? null,
        sourceType: String(row.source_type),
        sourceDocumentId: String(row.source_document_id),
        sourceDocumentNumber: row.source_snapshot?.documentNumber ?? null,
        sourceLineNumber: row.source_snapshot?.lineNumber ?? null,
        quantity: String(row.quantity),
        status: String(row.status),
        releasedAt: toIsoTimestamp(row.released_at),
        createdAt: toIsoTimestamp(row.created_at),
      })),
    })
  } catch (error) {
    logger.error('Purchase order announcements failed', { err: error })
    return Response.json(
      {
        error: translate(
          'procurements.purchaseOrders.errors.announcementsFailed',
          'The announcements against this purchase order could not be read.',
        ),
      },
      { status: 500 },
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Purchase Orders',
  summary: 'Announcements against a purchase order',
  methods: {
    GET: {
      summary: 'List what delivery announcements have claimed from this order',
      description:
        'Returns one entry per claim a warehouse delivery announcement holds against a line of this purchase order, ordered by line. Outstanding claims only unless includeReleased is set; a released claim is one the announcement gave back when it was withdrawn. The announcing document is named by the number captured when the claim was made. Quantities are decimal strings at the storage precision. Read-only and scoped to the authenticated tenant and organization.',
      tags: ['Purchase Orders'],
      query: announcementsQuerySchema,
      responses: [
        { status: 200, description: 'Claims against this order.', schema: announcementsResponseSchema },
      ],
      errors: [
        { status: 400, description: 'Missing or malformed identifier', schema: errorSchema },
        { status: 401, description: 'Authentication required', schema: errorSchema },
        { status: 403, description: 'The caller does not hold procurements.purchaseOrders.view', schema: errorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: errorSchema },
      ],
    },
  },
}
