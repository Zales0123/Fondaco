import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { GoodsReceipt } from '../../../data/entities'
import { loadWarehouseDestinations, readDefaultDestinationId } from '../../../lib/destinations'

const logger = createLogger('pz').child({ component: 'receiving-destinations' })

/**
 * The picker's option source: the Locations one document's goods may be put into, and the
 * one its Warehouse preselects.
 *
 * It is scoped to a document rather than to a warehouse id from the caller, so the floor
 * never has to know which Warehouse it is asking about, and a caller cannot enumerate the
 * Locations of a Warehouse whose documents they cannot read.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.view'] },
}

const destinationsQuerySchema = z.object({ goodsReceiptId: z.string().uuid() })

const destinationSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  type: z.string(),
})

const destinationsResponseSchema = z.object({
  items: z.array(destinationSchema),
  defaultLocationId: z.string().uuid().nullable(),
})

const errorSchema = z.object({ error: z.string() }).passthrough()

export async function GET(request: Request) {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { translate } = await resolveTranslations()
  const parsed = destinationsQuerySchema.safeParse({
    goodsReceiptId: new URL(request.url).searchParams.get('goodsReceiptId') ?? undefined,
  })
  if (!parsed.success) {
    return Response.json(
      { error: translate('pz.receiving.errors.idRequired', 'A goods receipt identifier is required.') },
      { status: 400 },
    )
  }

  const container = await createRequestContainer()
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request })
  if (scope.selectionRejected || !scope.selectedId || !scope.tenantId) {
    return Response.json(
      {
        error: translate(
          'pz.goodsReceipts.errors.organizationSelectionInvalid',
          'Your selected organization is no longer available. Please re-select an organization and try again.',
        ),
        code: 'organization_selection_invalid',
      },
      { status: 422 },
    )
  }

  const destinationScope = { tenantId: scope.tenantId, organizationId: scope.selectedId }
  try {
    const em = container.resolve('em') as EntityManager
    const receipt = await em.findOne(GoodsReceipt, {
      id: parsed.data.goodsReceiptId,
      tenantId: destinationScope.tenantId,
      organizationId: destinationScope.organizationId,
      deletedAt: null,
    } as FilterQuery<GoodsReceipt>)
    if (!receipt) {
      return Response.json(
        { error: translate('pz.goodsReceipts.errors.notFound', 'That goods receipt no longer exists.') },
        { status: 404 },
      )
    }

    const queryEngine = container.resolve('queryEngine') as QueryEngine
    const [items, defaultLocationId] = await Promise.all([
      loadWarehouseDestinations(queryEngine, destinationScope, receipt.warehouseId),
      readDefaultDestinationId(em, destinationScope, receipt.warehouseId),
    ])
    // A default pointing at something no longer eligible preselects nothing: the picker must
    // never offer a Location confirmation would then refuse.
    const eligibleDefault = items.some((item) => item.id === defaultLocationId) ? defaultLocationId : null
    return Response.json({ items, defaultLocationId: eligibleDefault })
  } catch (error) {
    logger.error('Receiving destinations lookup failed', { err: error })
    return Response.json(
      { error: translate('pz.receiving.errors.destinationsFailed', 'The destinations could not be loaded.') },
      { status: 500 },
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Goods Receipts',
  summary: 'Destinations a goods receipt may be posted into',
  methods: {
    GET: {
      summary: 'List the eligible destinations for a goods receipt',
      description:
        "Returns the warehouse locations the goods receipt's counted goods may be put into, ordered by code, together with the location its warehouse preselects. Eligible means active, belonging to that warehouse, of type bin, slot, staging or dock, and holding no child locations — stock posted into a zone, an aisle or a rack is a balance nobody can pick from. The preselected location is reported only when it is itself eligible.",
      tags: ['Goods Receipts'],
      query: destinationsQuerySchema,
      responses: [{ status: 200, description: 'The eligible destinations.', schema: destinationsResponseSchema }],
      errors: [
        { status: 400, description: 'Missing or malformed identifier', schema: errorSchema },
        { status: 401, description: 'Authentication required', schema: errorSchema },
        { status: 403, description: 'The caller does not hold pz.goodsReceipts.view', schema: errorSchema },
        { status: 404, description: 'No such goods receipt in the caller scope', schema: errorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: errorSchema },
      ],
    },
  },
}
