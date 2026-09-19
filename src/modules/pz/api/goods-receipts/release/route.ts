import { z } from 'zod'
import type { AwilixContainer } from 'awilix'
import { getAuthFromRequest, type AuthContext } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import {
  resolveOrganizationScopeForRequest,
  type OrganizationScope,
} from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CommandBus } from '@open-mercato/shared/lib/commands/command-bus'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { getCommandInterceptorHttpRejection } from '@open-mercato/shared/lib/commands/errors'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { GOODS_RECEIPT_ENTITY_ID } from '../../../commands/goodsReceipts'
import type { GoodsReceipt } from '../../../data/entities'

const logger = createLogger('pz').child({ component: 'goods-receipt-release' })

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.manage'] },
}

const releaseRequestSchema = z.object({
  id: z.string().uuid(),
})

const releaseResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('receiving'),
  updatedAt: z.string().nullable(),
})

const errorSchema = z.object({ error: z.string() }).passthrough()

/**
 * Builds the command context the way `makeCrudRoute` builds it, because the command cannot
 * tell which route dispatched it and must not behave differently here.
 *
 * Two details matter and are easy to lose in a hand-written route. The scope carries its own
 * tenant, which is the selected one rather than the actor's for a superadmin working inside
 * a tenant; using the actor's would read and guard in the wrong tenant. And a selection the
 * scope rejected — a stale cookie, or access lost since it was set — must stop the request:
 * falling back to another organization would release a document somewhere the
 * caller never chose.
 */
function createRuntimeContext(
  container: AwilixContainer,
  auth: NonNullable<AuthContext>,
  scope: OrganizationScope,
  request: Request,
): CommandRuntimeContext {
  return {
    container,
    auth: { ...auth, tenantId: scope.tenantId ?? auth.tenantId, orgId: scope.selectedId ?? null },
    organizationScope: scope,
    selectedOrganizationId: scope.selectedId,
    organizationIds: scope.filterIds,
    request,
  }
}

export async function POST(request: Request) {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { translate } = await resolveTranslations()
  const parsed = releaseRequestSchema.safeParse(await readJsonSafe(request))
  if (!parsed.success) {
    return Response.json(
      { error: translate('pz.goodsReceipts.errors.idRequired', 'A goods receipt identifier is required.') },
      { status: 400 },
    )
  }

  const container = await createRequestContainer()
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request })
  if (scope.selectionRejected) {
    // Mirrors the factory: a write never silently targets a fallback organization, and the
    // stale selection is left in place so the caller has to re-select explicitly.
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
  const ctx = createRuntimeContext(container, auth, scope, request)

  const guardResult = await runRouteMutationGuards({
    container,
    req: request,
    auth: {
      userId: String(auth.sub),
      tenantId: auth.tenantId,
      organizationId: ctx.selectedOrganizationId ?? null,
    },
    input: {
      resourceKind: GOODS_RECEIPT_ENTITY_ID,
      resourceId: parsed.data.id,
      operation: 'custom',
      mutationPayload: { id: parsed.data.id },
    },
  })
  if (!guardResult.ok) return guardResult.response

  // A guard may rewrite the payload, so the revised value is parsed again rather than
  // trusted — the command must never see something the schema has not approved.
  const revised = guardResult.modifiedPayload
    ? releaseRequestSchema.safeParse({ ...parsed.data, ...guardResult.modifiedPayload })
    : parsed
  if (!revised.success) {
    return Response.json(
      { error: translate('pz.goodsReceipts.errors.idRequired', 'A goods receipt identifier is required.') },
      { status: 400 },
    )
  }

  const commandBus = container.resolve('commandBus') as CommandBus
  try {
    // `execute` resolves the envelope, not the command's own return value.
    const { result } = await commandBus.execute<Record<string, unknown>, GoodsReceipt>(
      'pz.goodsReceipts.release',
      { input: { id: revised.data.id }, ctx },
    )
    try {
      await guardResult.runAfterSuccess()
    } catch (error) {
      logger.warn('Mutation guard after-success failed for goods receipt release', { err: error })
    }
    return Response.json({
      id: String(result.id),
      status: result.status,
      updatedAt: result.updatedAt?.toISOString() ?? null,
    })
  } catch (error) {
    if (isCrudHttpError(error)) return Response.json(error.body, { status: error.status })
    // A command interceptor can refuse this command with a status and body of its own; the
    // bus wraps that in its own error type, and reporting it as a 500 would turn a
    // deliberate refusal into a broken endpoint.
    const rejection = getCommandInterceptorHttpRejection(error)
    if (rejection) return Response.json(rejection.body, { status: rejection.status })
    logger.error('Goods receipt release failed', { err: error })
    return Response.json(
      { error: translate('pz.goodsReceipts.errors.releaseFailed', 'The goods receipt could not be released to the floor.') },
      { status: 500 },
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Goods Receipts',
  summary: 'Release a goods receipt',
  methods: {
    POST: {
      summary: 'Release a goods receipt',
      description:
        'Releases a draft goods receipt to the floor for counting. The document and its lines become immutable while receiving. Send the record version in the `x-om-ext-optimistic-lock-expected-updated-at` header. Withdrawal is possible while no pallet exists. This action moves no stock.',
      tags: ['Goods Receipts'],
      requestBody: { schema: releaseRequestSchema },
      responses: [{ status: 200, description: 'The goods receipt is receiving.', schema: releaseResponseSchema }],
      errors: [
        { status: 400, description: 'Missing or malformed identifier', schema: errorSchema },
        { status: 401, description: 'Authentication required', schema: errorSchema },
        { status: 403, description: 'The caller does not hold pz.goodsReceipts.manage', schema: errorSchema },
        { status: 404, description: 'No such goods receipt in the caller scope', schema: errorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: errorSchema },
        {
          status: 409,
          description: 'The receipt is not draft, or the caller holds a stale version',
          schema: errorSchema,
        },
      ],
    },
  },
}
