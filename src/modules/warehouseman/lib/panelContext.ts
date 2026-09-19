import 'server-only'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { loadCustomFieldValues } from '@open-mercato/shared/lib/crud/custom-fields'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { E } from '#generated/entities.ids.generated'
import { resolveAssignedWarehouse, type AssignedWarehouse, type PanelScope } from './assignedWarehouse'
import { ASSIGNED_WAREHOUSE_FIELD_KEY } from './customFields'

export type PanelContext = {
  userLabel: string
  warehouse: AssignedWarehouse | null
}

/**
 * Everything the panel shell shows about who is signed in and where they work.
 * The route gate has already refused anyone without panel access by the time a page
 * calls this, so an absent session here means the request never should have rendered.
 */
export async function loadPanelContext(): Promise<PanelContext> {
  const auth = await getAuthFromCookies()
  if (!auth) return { userLabel: '', warehouse: null }

  const sessionEmail = typeof auth.email === 'string' ? auth.email : ''
  try {
    const container = await createRequestContainer()
    const queryEngine = container.resolve('queryEngine') as QueryEngine
    const em = container.resolve('em') as EntityManager

    const warehouse = await resolveAssignedWarehouse(
      { queryEngine, readAssignedWarehouseId: makeAssignedWarehouseIdReader(em) },
      auth,
    )
    return { userLabel: await resolveUserLabel(queryEngine, auth), warehouse }
  } catch {
    // Everything this function adds is a convenience on top of a session the route
    // gate already accepted. A transient failure reading it must not 500 the panel
    // home and every stub route; fall back to what the session itself carries.
    return { userLabel: sessionEmail, warehouse: null }
  }
}

async function resolveUserLabel(
  queryEngine: QueryEngine,
  auth: NonNullable<Awaited<ReturnType<typeof getAuthFromCookies>>>,
): Promise<string> {
  const email = typeof auth.email === 'string' ? auth.email : ''
  if (!auth.tenantId || !auth.orgId) return email
  try {
    const users = await queryEngine.query<Record<string, unknown>>(E.auth.user, {
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
      fields: ['id', 'name'],
      filters: { id: auth.sub },
      page: { page: 1, pageSize: 1 },
    })
    const name = users.items?.[0]?.name
    return typeof name === 'string' && name.trim() ? name.trim() : email
  } catch {
    // A missing display name must never cost the warehouseman their screen.
    return email
  }
}

/**
 * The assignment lives in the custom-field store, not on the user row, so it is read
 * with the installed loader rather than through the query engine.
 */
function makeAssignedWarehouseIdReader(em: EntityManager) {
  return async (userId: string, scope: PanelScope): Promise<string | null> => {
    const values = await loadCustomFieldValues({
      em,
      entityId: E.auth.user,
      recordIds: [userId],
      tenantIdByRecord: { [userId]: scope.tenantId },
      organizationIdByRecord: { [userId]: scope.organizationId },
      tenantFallbacks: [scope.tenantId],
    })
    // The loader returns values under the `cf_` prefixed key, not the bare field key.
    const raw = values[userId]?.[`cf_${ASSIGNED_WAREHOUSE_FIELD_KEY}`]
    return typeof raw === 'string' ? raw : null
  }
}
