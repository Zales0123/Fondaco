import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { GoodsReceipt, Pallet } from '../../../data/entities'
import { palletStatusSchema } from '../../../data/validators'
import { normalizePalletCode } from '../../../lib/palletCode'

const logger = createLogger('pz').child({ component: 'pallet-by-code' })

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.view'] },
}

const byCodeQuerySchema = z.object({
  code: z.string(),
  goodsReceiptId: z.string().uuid(),
})

const byCodeResponseSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  goodsReceiptId: z.string().uuid(),
  status: palletStatusSchema,
})

const errorSchema = z.object({ error: z.string() }).passthrough()

/**
 * Case-insensitive equality reproducing the `lower(code)` unique index: the pattern is
 * escaped and carries no wildcard, so a scanner that upper-cases still finds its pallet and
 * nobody can turn the lookup into a prefix search.
 */
async function findPalletByCode(
  em: EntityManager,
  scope: { tenantId: string; organizationIds: string[] | null },
  code: string,
): Promise<Pallet | null> {
  const where: Record<string, unknown> = {
    tenantId: scope.tenantId,
    code: { $ilike: escapeLikePattern(code) },
  }
  if (scope.organizationIds !== null) where.organizationId = { $in: scope.organizationIds }
  return em.findOne(Pallet, where as FilterQuery<Pallet>)
}

export async function GET(request: Request) {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { translate } = await resolveTranslations()
  const url = new URL(request.url)
  const parsed = byCodeQuerySchema.safeParse({
    code: url.searchParams.get('code') ?? '',
    goodsReceiptId: url.searchParams.get('goodsReceiptId') ?? '',
  })
  if (!parsed.success) {
    return Response.json(
      { error: translate('pz.goodsReceipts.errors.idRequired', 'A goods receipt identifier is required.') },
      { status: 400 },
    )
  }

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

  const code = normalizePalletCode(parsed.data.code)
  if (!code) {
    // A blank scan is answered the same way an unknown one is. This endpoint says "no such
    // pallet here" and nothing else, because anything richer is an enumeration oracle.
    return Response.json(
      { error: translate('pz.pallets.errors.codeRequired', 'Scan or type a pallet code.') },
      { status: 404 },
    )
  }

  // The lookup is scoped to the trusted tenant and the resolved organizations rather than to
  // the document: the scanner holds a physical label and has not said which document it
  // means. An unscoped lookup would let anyone discover another tenant's pallets by guessing
  // codes, so anything outside scope is a 404 rather than a refusal that confirms existence.
  const em = (container.resolve('em') as EntityManager).fork()
  const notFound = Response.json(
    { error: translate('pz.pallets.errors.notFound', 'That pallet no longer exists.') },
    { status: 404 },
  )
  try {
    const pallet = await findPalletByCode(
      em,
      { tenantId: scope.tenantId ?? auth.tenantId, organizationIds: scope.filterIds },
      code,
    )
    if (!pallet) return notFound

    const goodsReceiptId = String(pallet.goodsReceipt.id)
    if (goodsReceiptId === parsed.data.goodsReceiptId) {
      return Response.json({
        id: String(pallet.id),
        code: pallet.code,
        goodsReceiptId,
        status: pallet.status,
      })
    }

    const other = await em.findOne(GoodsReceipt, {
      id: goodsReceiptId,
      tenantId: scope.tenantId ?? auth.tenantId,
      deletedAt: null,
      ...(scope.filterIds !== null ? { organizationId: { $in: scope.filterIds } } : {}),
    } as FilterQuery<GoodsReceipt>)
    // Naming the other document is the whole point of the refusal — following the scan would
    // file goods against the wrong delivery — but nothing else of it is returned.
    if (!other) return notFound
    return Response.json(
      {
        error: translate(
          'pz.pallets.errors.palletOtherReceipt',
          'Pallet {code} belongs to goods receipt {documentNumber}, not this one.',
          { code: pallet.code, documentNumber: other.documentNumber },
        ),
      },
      { status: 409 },
    )
  } catch (error) {
    logger.error('Pallet code lookup failed', { err: error })
    return Response.json(
      { error: translate('pz.pallets.errors.notFound', 'That pallet no longer exists.') },
      { status: 500 },
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Pallets',
  summary: 'Find a pallet by its scanned code',
  methods: {
    GET: {
      summary: 'Find a pallet by its scanned code',
      description:
        'Resolves a scanned pallet code within the caller trusted tenant and organization scope, for one goods receipt. A code belonging to another goods receipt is refused with 409 naming that document, because following the scan would file goods against the wrong delivery. Anything outside scope answers 404 rather than confirming that the code exists.',
      tags: ['Pallets'],
      query: byCodeQuerySchema,
      responses: [{ status: 200, description: 'The pallet of this goods receipt.', schema: byCodeResponseSchema }],
      errors: [
        { status: 400, description: 'Missing or malformed goods receipt identifier', schema: errorSchema },
        { status: 401, description: 'Authentication required', schema: errorSchema },
        { status: 403, description: 'The caller does not hold pz.goodsReceipts.view', schema: errorSchema },
        { status: 404, description: 'No pallet with that code in the caller scope, or no code was sent', schema: errorSchema },
        { status: 409, description: 'The pallet belongs to another goods receipt', schema: errorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: errorSchema },
      ],
    },
  },
}
