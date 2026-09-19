import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import { E } from '#generated/entities.ids.generated'

export type AssignedWarehouse = { id: string; name: string }

export type PanelScope = { tenantId: string; organizationId: string }

/** Reads the raw `assigned_warehouse` custom field value for one user, or nothing. */
export type AssignedWarehouseIdReader = (
  userId: string,
  scope: PanelScope,
) => Promise<string | null>

export type AssignedWarehouseDeps = {
  readAssignedWarehouseId: AssignedWarehouseIdReader
  queryEngine: QueryEngine
}

/**
 * Resolves the warehouse prefilled for the signed-in warehouseman, or nothing.
 *
 * Nothing is the normal answer in three cases, and they are deliberately
 * indistinguishable to the caller: the user has no assignment, the assignment points
 * at a warehouse outside the session's scope, or the session carries no usable scope
 * at all. A warehouse the session may not see is never named, and a missing scope is
 * never treated as permission to look tenant-wide.
 *
 * Scope comes from the trusted session context only; nothing here reads a request
 * payload. This is the one seam the panel's later operations will call, which is why
 * both reads arrive as dependencies rather than being resolved in here.
 */
export async function resolveAssignedWarehouse(
  deps: AssignedWarehouseDeps,
  auth: AuthContext,
): Promise<AssignedWarehouse | null> {
  const tenantId = auth?.tenantId ?? null
  const organizationId = auth?.orgId ?? null
  const userId = auth?.sub ?? null
  if (!tenantId || !organizationId || !userId) return null

  const scope: PanelScope = { tenantId, organizationId }
  const warehouseId = (await deps.readAssignedWarehouseId(userId, scope))?.trim()
  if (!warehouseId) return null

  // Re-read the warehouse in the session's scope rather than trusting the stored id:
  // an assignment written before a user moved organization would otherwise leak a
  // warehouse name across the boundary.
  const warehouses = await deps.queryEngine.query<Record<string, unknown>>(E.wms.warehouse, {
    ...scope,
    fields: ['id', 'name'],
    filters: { id: warehouseId },
    page: { page: 1, pageSize: 1 },
  })
  const warehouse = warehouses.items?.[0]
  if (!warehouse) return null

  return {
    id: String(warehouse.id),
    name: typeof warehouse.name === 'string' ? warehouse.name : '',
  }
}
