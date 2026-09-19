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
import { PALLET_ENTITY_ID } from '../../../commands/pallets'
import type { Pallet } from '../../../data/entities'

const logger = createLogger('pz').child({ component: 'pallet-reopen' })

/**
 * Reopening is the correction path for a pallet declared counted too early. It is a domain
 * action with its own permission rather than a status written through the update endpoint,
 * so this route does what `makeCrudRoute` would: run the mutation guards, dispatch the
 * registered command, and run the guards' after-success callbacks once the write commits.
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['pz.receiving.count'] },
}

const reopenRequestSchema = z.object({
  id: z.string().uuid(),
})

const reopenResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('open'),
  updatedAt: z.string().nullable(),
})

const errorSchema = z.object({ error: z.string() }).passthrough()

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
  const parsed = reopenRequestSchema.safeParse(await readJsonSafe(request))
  if (!parsed.success) {
    return Response.json(
      { error: translate('pz.pallets.errors.idRequired', 'A pallet identifier is required.') },
      { status: 400 },
    )
  }

  const container = await createRequestContainer()
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request })
  if (scope.selectionRejected) {
    // A write never silently targets a fallback organization, and the stale selection is
    // left in place so the caller has to re-select explicitly.
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
      resourceKind: PALLET_ENTITY_ID,
      resourceId: parsed.data.id,
      operation: 'custom',
      mutationPayload: { id: parsed.data.id },
    },
  })
  if (!guardResult.ok) return guardResult.response

  // A guard may rewrite the payload, so the revised value is parsed again rather than
  // trusted — the command must never see something the schema has not approved.
  const revised = guardResult.modifiedPayload
    ? reopenRequestSchema.safeParse({ ...parsed.data, ...guardResult.modifiedPayload })
    : parsed
  if (!revised.success) {
    return Response.json(
      { error: translate('pz.pallets.errors.idRequired', 'A pallet identifier is required.') },
      { status: 400 },
    )
  }

  const commandBus = container.resolve('commandBus') as CommandBus
  try {
    const { result } = await commandBus.execute<Record<string, unknown>, Pallet>('pz.pallets.reopen', {
      input: { id: revised.data.id },
      ctx,
    })
    try {
      await guardResult.runAfterSuccess()
    } catch (error) {
      logger.warn('Mutation guard after-success failed for pallet reopen', { err: error })
    }
    return Response.json({
      id: String(result.id),
      status: result.status,
      updatedAt: result.updatedAt?.toISOString() ?? null,
    })
  } catch (error) {
    if (isCrudHttpError(error)) return Response.json(error.body, { status: error.status })
    const rejection = getCommandInterceptorHttpRejection(error)
    if (rejection) return Response.json(rejection.body, { status: rejection.status })
    logger.error('Pallet reopen failed', { err: error })
    return Response.json(
      { error: translate('pz.pallets.errors.reopenFailed', 'The pallet could not be reopened.') },
      { status: 500 },
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Pallets',
  summary: 'Reopen a closed pallet',
  methods: {
    POST: {
      summary: 'Reopen a closed pallet',
      description:
        'Moves a pallet from `closed` back to `open` and clears `closed_at`, so the floor can correct a pallet it declared counted too early. Refused once the goods receipt is confirmed: confirmation asserts that the floor counted this document, and that assertion is one-way. Send the record version in the `x-om-ext-optimistic-lock-expected-updated-at` header.',
      tags: ['Pallets'],
      requestBody: { schema: reopenRequestSchema },
      responses: [{ status: 200, description: 'The pallet is open again.', schema: reopenResponseSchema }],
      errors: [
        { status: 400, description: 'Missing or malformed identifier, or no record version', schema: errorSchema },
        { status: 401, description: 'Authentication required', schema: errorSchema },
        { status: 403, description: 'The caller does not hold pz.receiving.count', schema: errorSchema },
        { status: 404, description: 'No such pallet in the caller scope', schema: errorSchema },
        { status: 409, description: 'Already open, the goods receipt is confirmed, or the caller holds a stale version', schema: errorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: errorSchema },
      ],
    },
  },
}
