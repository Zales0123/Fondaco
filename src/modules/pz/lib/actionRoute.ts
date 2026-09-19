import type { z } from 'zod'
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
import { GOODS_RECEIPT_ENTITY_ID } from '../commands/goodsReceipts'

/**
 * One shape for every goods receipt action route.
 *
 * `makeCrudRoute` has no slot for a domain action, so each of these is hand-written — and
 * hand-written five times over is five chances to drop one of the steps the factory never
 * forgets: the mutation guards, the revised payload the guards may have rewritten, the
 * rejected organization selection, the command context built from the selected tenant rather
 * than the actor's, and the after-success callbacks that must run only once the write has
 * committed. The steps live here once; a route says which command it dispatches.
 */
export type GoodsReceiptActionRoute<TBody extends { id: string }, TResult> = {
  /** The command dispatched. Its own permission gate is the route's `metadata`. */
  commandId: string
  requestSchema: z.ZodType<TBody>
  /** Stable name for diagnostics; never shown to a caller. */
  component: string
  /** What the command receives. The parsed body only — never anything read off the request. */
  toInput: (body: TBody) => Record<string, unknown>
  toResponse: (result: TResult) => unknown
  /** Translation key for a failure the command did not state itself. */
  failureKey: string
  failureFallback: string
}

export async function runGoodsReceiptAction<TBody extends { id: string }, TResult>(
  request: Request,
  route: GoodsReceiptActionRoute<TBody, TResult>,
): Promise<Response> {
  const logger = createLogger('pz').child({ component: route.component })
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { translate } = await resolveTranslations()
  const parsed = route.requestSchema.safeParse(await readJsonSafe(request))
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
      mutationPayload: { ...parsed.data },
    },
  })
  if (!guardResult.ok) return guardResult.response

  // A guard may rewrite the payload, so the revised value is parsed again rather than
  // trusted — the command must never see something the schema has not approved.
  const revised = guardResult.modifiedPayload
    ? route.requestSchema.safeParse({ ...parsed.data, ...guardResult.modifiedPayload })
    : parsed
  if (!revised.success) {
    return Response.json(
      { error: translate('pz.goodsReceipts.errors.idRequired', 'A goods receipt identifier is required.') },
      { status: 400 },
    )
  }

  try {
    // `execute` resolves the envelope, not the command's own return value.
    const { result } = await container
      .resolve<CommandBus>('commandBus')
      .execute<Record<string, unknown>, TResult>(route.commandId, { input: route.toInput(revised.data), ctx })
    try {
      await guardResult.runAfterSuccess()
    } catch (error) {
      logger.warn('Mutation guard after-success failed', { err: error })
    }
    return Response.json(route.toResponse(result))
  } catch (error) {
    if (isCrudHttpError(error)) return Response.json(error.body, { status: error.status })
    // A command interceptor can refuse this command with a status and body of its own; the
    // bus wraps that in its own error type, and reporting it as a 500 would turn a
    // deliberate refusal into a broken endpoint.
    const rejection = getCommandInterceptorHttpRejection(error)
    if (rejection) return Response.json(rejection.body, { status: rejection.status })
    logger.error('Goods receipt action failed', { err: error, commandId: route.commandId })
    return Response.json({ error: translate(route.failureKey, route.failureFallback) }, { status: 500 })
  }
}

/**
 * Builds the command context the way `makeCrudRoute` builds it, because the command cannot
 * tell which route dispatched it and must not behave differently here.
 *
 * The scope carries its own tenant, which is the selected one rather than the actor's for a
 * superadmin working inside a tenant; using the actor's would read and guard in the wrong
 * tenant.
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
