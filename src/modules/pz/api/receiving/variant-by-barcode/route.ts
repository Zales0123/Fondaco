import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createVariantBarcodeLookup, resolveVariantByBarcode } from '../../../lib/barcodeResolution'

const logger = createLogger('pz').child({ component: 'variant-by-barcode' })

/**
 * The counting screen's first step: turn what the scanner sent into the variant the count is
 * filed against. It is a read, so it gates on the same feature as viewing a goods receipt
 * and runs no mutation guards; the count itself is what requires `pz.receiving.count`.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.view'] },
}

const variantResponseSchema = z.object({
  catalogVariantId: z.string().uuid(),
  catalogProductId: z.string().uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  barcode: z.string(),
  quantityMultiplier: z.number().int().positive(),
})

const errorSchema = z.object({ error: z.string() }).passthrough()

export async function GET(request: Request) {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { translate } = await resolveTranslations()
  const container = await createRequestContainer()
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request })
  if (scope.selectionRejected) {
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

  const tenantId = scope.tenantId ?? auth.tenantId
  const organizationId = scope.selectedId ?? null
  if (!organizationId) {
    return Response.json(
      { error: translate('pz.goodsReceipts.errors.organizationRequired', 'Organization context is required.') },
      { status: 400 },
    )
  }

  const queryEngine = container.resolve<QueryEngine>('queryEngine')
  const lookup = createVariantBarcodeLookup(queryEngine, { tenantId, organizationId })

  try {
    const resolution = await resolveVariantByBarcode(
      new URL(request.url).searchParams.get('barcode'),
      lookup,
    )
    if (resolution.kind === 'barcode-required') {
      return Response.json(
        { error: translate('pz.palletLines.errors.barcodeRequired', 'Scan or type a barcode.') },
        { status: 400 },
      )
    }
    if (resolution.kind === 'unknown') {
      // An ordinary outcome, not a failure: the client opens the product picker with the
      // scanned code preserved, so the barcode is echoed back for it to show.
      return Response.json(
        {
          error: translate(
            'pz.palletLines.errors.variantBarcodeUnknown',
            'No product in the catalog has barcode {barcode}.',
            { barcode: resolution.barcode },
          ),
          barcode: resolution.barcode,
        },
        { status: 404 },
      )
    }
    return Response.json(resolution.variant)
  } catch (error) {
    logger.error('Barcode lookup failed', { err: error })
    return Response.json(
      { error: translate('pz.palletLines.errors.countFailed', 'The count could not be recorded.') },
      { status: 500 },
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Goods Receipts',
  summary: 'Resolve a scanned barcode to a catalog variant',
  methods: {
    GET: {
      summary: 'Resolve a scanned barcode to a catalog variant',
      description:
        'Resolves one catalog product variant by barcode, scoped to the authenticated tenant and organization. The barcode is normalised first, so the padding and terminator a scanner appends are ignored. Both the variant\'s own barcode and its optional bulk (carton) barcode are checked; a bulk match reports quantityMultiplier as the bulk_quantity custom field, otherwise it is 1. A code that matches no variant — or, because the floor cannot adjudicate a catalog problem mid-count, more than one — is answered with 404 and the client falls back to the catalog product picker.',
      tags: ['Goods Receipts'],
      query: z.object({ barcode: z.string().min(1) }),
      responses: [{ status: 200, description: 'The variant the barcode identifies, with its counting multiplier.', schema: variantResponseSchema }],
      errors: [
        { status: 400, description: 'Missing barcode or organization context', schema: errorSchema },
        { status: 401, description: 'Authentication required', schema: errorSchema },
        { status: 403, description: 'The caller does not hold pz.goodsReceipts.view', schema: errorSchema },
        { status: 404, description: 'No single variant in scope carries that barcode', schema: errorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: errorSchema },
      ],
    },
  },
}
