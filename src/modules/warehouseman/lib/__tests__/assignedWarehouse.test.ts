import { describe, expect, it, jest } from '@jest/globals'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import {
  resolveAssignedWarehouse,
  type AssignedWarehouseIdReader,
  type PanelScope,
} from '../assignedWarehouse'

const TENANT = 'tenant-1'
const ORGANIZATION = 'org-1'
const USER = 'user-1'
const WAREHOUSE = 'warehouse-1'

const auth: AuthContext = { sub: USER, tenantId: TENANT, orgId: ORGANIZATION }

type Rows = Record<string, unknown>[]

/** Records the scope of every read so the tests can prove nothing escapes the session. */
function fakeDeps(assignedId: string | null, warehouses: Rows) {
  const scopes: PanelScope[] = []
  const queries: Array<{ entity: string; opts: Record<string, unknown> }> = []

  const readAssignedWarehouseId = jest.fn(async (_userId: string, scope: PanelScope) => {
    scopes.push(scope)
    return assignedId
  }) as jest.MockedFunction<AssignedWarehouseIdReader>

  const query = jest.fn(async (entity: string, opts: Record<string, unknown>) => {
    queries.push({ entity, opts })
    return { items: warehouses, total: warehouses.length }
  })

  return {
    deps: { readAssignedWarehouseId, queryEngine: { query } as unknown as QueryEngine },
    scopes,
    queries,
  }
}

describe('resolveAssignedWarehouse', () => {
  it('returns the warehouse assigned to the signed-in user', async () => {
    const { deps, scopes, queries } = fakeDeps(WAREHOUSE, [{ id: WAREHOUSE, name: 'Magazyn Centralny' }])

    await expect(resolveAssignedWarehouse(deps, auth)).resolves.toEqual({
      id: WAREHOUSE,
      name: 'Magazyn Centralny',
    })
    expect(scopes).toEqual([{ tenantId: TENANT, organizationId: ORGANIZATION }])
    expect(queries[0].opts).toMatchObject({ tenantId: TENANT, organizationId: ORGANIZATION })
  })

  it('returns nothing when the user has no assignment', async () => {
    const { deps, queries } = fakeDeps(null, [{ id: WAREHOUSE, name: 'Magazyn Centralny' }])
    await expect(resolveAssignedWarehouse(deps, auth)).resolves.toBeNull()
    // No assignment means no warehouse lookup at all.
    expect(queries).toHaveLength(0)
  })

  it('returns nothing when the assigned warehouse is outside the session scope', async () => {
    // The stored id survives, but the scoped read finds nothing — which is exactly what
    // a warehouse belonging to another organization looks like from here.
    const { deps } = fakeDeps(WAREHOUSE, [])
    await expect(resolveAssignedWarehouse(deps, auth)).resolves.toBeNull()
  })

  it('fails closed when the session carries no organization', async () => {
    const { deps, scopes, queries } = fakeDeps(WAREHOUSE, [{ id: WAREHOUSE, name: 'Magazyn Centralny' }])
    await expect(
      resolveAssignedWarehouse(deps, { sub: USER, tenantId: TENANT, orgId: null }),
    ).resolves.toBeNull()
    // Missing scope must never fall back to an unscoped read.
    expect(scopes).toHaveLength(0)
    expect(queries).toHaveLength(0)
  })

  it('fails closed when there is no session at all', async () => {
    const { deps, scopes, queries } = fakeDeps(WAREHOUSE, [{ id: WAREHOUSE, name: 'Magazyn Centralny' }])
    await expect(resolveAssignedWarehouse(deps, null)).resolves.toBeNull()
    expect(scopes).toHaveLength(0)
    expect(queries).toHaveLength(0)
  })
})
