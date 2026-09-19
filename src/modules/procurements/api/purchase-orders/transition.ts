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
import { PURCHASE_ORDER_ENTITY_ID } from '../../commands/purchaseOrders'
import type { PurchaseOrder } from '../../data/entities'

const logger = createLogger('procurements').child({ component: 'purchase-order-transition' })

export const transitionRequestSchema = z.object({
  id: z.string().uuid(),
})

export const transitionErrorSchema = z.object({ error: z.string() }).passthrough()

/**
 * Builds the command context the way `makeCrudRoute` builds it, because the command cannot
 * tell which route dispatched it and must not behave differently here.
 *
 * Two details matter and are easy to lose in a hand-written route. The scope carries its own
 * tenant, which is the selected one rather than the actor's for a superadmin working inside a
 * tenant; using the actor's would read and guard in the wrong tenant. And a selection the
 * scope rejected — a stale cookie, or access lost since it was set — must stop the request:
 * falling back to another organization would release an order somewhere the caller never
 * chose.
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

/**
 * The one request path shared by release, withdraw and cancel. They differ only in the
 * command they dispatch and the message a failure gets, so the guard, scope and error
 * handling live here rather than in three copies that would drift apart.
 */
export async function handlePurchaseOrderTransition(
  request: Request,
  options: { commandId: string; failureKey: string; failureFallback: string },
): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { translate } = await resolveTranslations()
  const parsed = transitionRequestSchema.safeParse(await readJsonSafe(request))
  if (!parsed.success) {
    return Response.json(
      { error: translate('procurements.purchaseOrders.errors.idRequired', 'A purchase order identifier is required.') },
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
          'procurements.purchaseOrders.errors.organizationSelectionInvalid',
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
      resourceKind: PURCHASE_ORDER_ENTITY_ID,
      resourceId: parsed.data.id,
      operation: 'custom',
      mutationPayload: { id: parsed.data.id },
    },
  })
  if (!guardResult.ok) return guardResult.response

  // A guard may rewrite the payload, so the revised value is parsed again rather than trusted
  // — the command must never see something the schema has not approved.
  const revised = guardResult.modifiedPayload
    ? transitionRequestSchema.safeParse({ ...parsed.data, ...guardResult.modifiedPayload })
    : parsed
  if (!revised.success) {
    return Response.json(
      { error: translate('procurements.purchaseOrders.errors.idRequired', 'A purchase order identifier is required.') },
      { status: 400 },
    )
  }

  const commandBus = container.resolve('commandBus') as CommandBus
  try {
    // `execute` resolves the envelope, not the command's own return value.
    const { result } = await commandBus.execute<Record<string, unknown>, PurchaseOrder>(
      options.commandId,
      { input: { id: revised.data.id }, ctx },
    )
    try {
      await guardResult.runAfterSuccess()
    } catch (error) {
      logger.warn('Mutation guard after-success failed for purchase order transition', {
        err: error,
        commandId: options.commandId,
      })
    }
    return Response.json({
      id: String(result.id),
      status: result.status,
      updatedAt: result.updatedAt?.toISOString() ?? null,
    })
  } catch (error) {
    if (isCrudHttpError(error)) return Response.json(error.body, { status: error.status })
    // A command interceptor can refuse this command with a status and body of its own; the
    // bus wraps that in its own error type, and reporting it as a 500 would turn a deliberate
    // refusal into a broken endpoint.
    const rejection = getCommandInterceptorHttpRejection(error)
    if (rejection) return Response.json(rejection.body, { status: rejection.status })
    logger.error('Purchase order transition failed', { err: error, commandId: options.commandId })
    return Response.json(
      { error: translate(options.failureKey, options.failureFallback) },
      { status: 500 },
    )
  }
}
