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

const logger = createLogger('pz').child({ component: 'pallet-close' })

/**
 * Closing a pallet is a domain action with its own permission, not a status written through
 * the update endpoint. `makeCrudRoute` has no slot for one, so this route does what the
 * factory would: run the mutation guards, dispatch the registered command, and run the
 * guards' after-success callbacks only once the write has committed.
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['pz.receiving.count'] },
}

const closeRequestSchema = z.object({
  id: z.string().uuid(),
})

const closeResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('closed'),
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
  const parsed = closeRequestSchema.safeParse(await readJsonSafe(request))
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
    ? closeRequestSchema.safeParse({ ...parsed.data, ...guardResult.modifiedPayload })
    : parsed
  if (!revised.success) {
    return Response.json(
      { error: translate('pz.pallets.errors.idRequired', 'A pallet identifier is required.') },
      { status: 400 },
    )
  }

  const commandBus = container.resolve('commandBus') as CommandBus
  try {
    const { result } = await commandBus.execute<Record<string, unknown>, Pallet>('pz.pallets.close', {
      input: { id: revised.data.id },
      ctx,
    })
    try {
      await guardResult.runAfterSuccess()
    } catch (error) {
      logger.warn('Mutation guard after-success failed for pallet close', { err: error })
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
    logger.error('Pallet close failed', { err: error })
    return Response.json(
      { error: translate('pz.pallets.errors.closeFailed', 'The pallet could not be closed.') },
      { status: 500 },
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Pallets',
  summary: 'Declare a pallet counted',
  methods: {
    POST: {
      summary: 'Declare a pallet counted',
      description:
        'Moves a pallet from `open` to `closed` and stamps `closed_at`. Closing is how the floor says it has finished counting onto this carrier; the office cannot confirm the goods receipt while any pallet is still open. It is reversible through `/api/pz/pallets/reopen` until the document is confirmed. Send the record version in the `x-om-ext-optimistic-lock-expected-updated-at` header.',
      tags: ['Pallets'],
      requestBody: { schema: closeRequestSchema },
      responses: [{ status: 200, description: 'The pallet is closed.', schema: closeResponseSchema }],
      errors: [
        { status: 400, description: 'Missing or malformed identifier, or no record version', schema: errorSchema },
        { status: 401, description: 'Authentication required', schema: errorSchema },
        { status: 403, description: 'The caller does not hold pz.receiving.count', schema: errorSchema },
        { status: 404, description: 'No such pallet in the caller scope', schema: errorSchema },
        { status: 409, description: 'Already closed, or the caller holds a stale version', schema: errorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: errorSchema },
      ],
    },
  },
}
