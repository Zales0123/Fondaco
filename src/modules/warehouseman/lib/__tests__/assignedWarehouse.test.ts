import { describe, expect, it, jest } from '@jest/globals'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import { E } from '#generated/entities.ids.generated'
import {
  resolveAssignedWarehouse,
  type AssignedWarehouseIdReader,
  type PanelScope,
} from '../assignedWarehouse'

const TENANT = 'tenant-1'
const ORGANIZATION = 'org-1'
const USER = 'user-1'
const OTHER_USER = 'user-2'
const WAREHOUSE = 'warehouse-1'
const WAREHOUSE_NAME = 'Magazyn Centralny'

const auth: AuthContext = { sub: USER, tenantId: TENANT, orgId: ORGANIZATION }

type WarehouseRow = { id: string; name: string; tenantId: string; organizationId: string }

/**
 * A store rather than a stub: the reader answers per user, and the query honours the
 * entity, the id filter and the scope it is given. A resolver that read another
 * user's assignment, dropped the id filter, or queried outside the session would
 * therefore fail these tests instead of sailing through a canned array.
 */
function fakeDeps(options: {
  assignmentsByUser?: Record<string, string>
  warehouses?: WarehouseRow[]
}) {
  const assignmentsByUser = options.assignmentsByUser ?? {}
  const warehouses = options.warehouses ?? []
  const scopes: PanelScope[] = []
  const queries: Array<{ entity: string; opts: Record<string, unknown> }> = []

  const readAssignedWarehouseId = jest.fn(async (userId: string, scope: PanelScope) => {
    scopes.push(scope)
    return assignmentsByUser[userId] ?? null
  }) as jest.MockedFunction<AssignedWarehouseIdReader>

  const query = jest.fn(async (entity: string, opts: Record<string, unknown>) => {
    queries.push({ entity, opts })
    const filters = (opts.filters ?? {}) as { id?: string }
    const items = warehouses.filter((row) =>
      row.tenantId === opts.tenantId
      && row.organizationId === opts.organizationId
      && (filters.id === undefined || row.id === filters.id),
    )
    return { items, total: items.length }
  })

  return {
    deps: { readAssignedWarehouseId, queryEngine: { query } as unknown as QueryEngine },
    scopes,
    queries,
  }
}

const inScopeWarehouse: WarehouseRow = {
  id: WAREHOUSE,
  name: WAREHOUSE_NAME,
  tenantId: TENANT,
  organizationId: ORGANIZATION,
}

describe('resolveAssignedWarehouse', () => {
  it('returns the warehouse assigned to the signed-in user', async () => {
    const { deps, scopes, queries } = fakeDeps({
      assignmentsByUser: { [USER]: WAREHOUSE, [OTHER_USER]: 'warehouse-9' },
      warehouses: [inScopeWarehouse, { ...inScopeWarehouse, id: 'warehouse-9', name: 'Wrong one' }],
    })

    await expect(resolveAssignedWarehouse(deps, auth)).resolves.toEqual({
      id: WAREHOUSE,
      name: WAREHOUSE_NAME,
    })
    expect(deps.readAssignedWarehouseId).toHaveBeenCalledWith(USER, {
      tenantId: TENANT,
      organizationId: ORGANIZATION,
    })
    expect(scopes).toEqual([{ tenantId: TENANT, organizationId: ORGANIZATION }])
    expect(queries).toHaveLength(1)
    expect(queries[0].entity).toBe(E.wms.warehouse)
    expect(queries[0].opts).toMatchObject({
      tenantId: TENANT,
      organizationId: ORGANIZATION,
      filters: { id: WAREHOUSE },
    })
  })

  it('returns nothing when the user has no assignment', async () => {
    const { deps, queries } = fakeDeps({
      assignmentsByUser: { [OTHER_USER]: WAREHOUSE },
      warehouses: [inScopeWarehouse],
    })
    await expect(resolveAssignedWarehouse(deps, auth)).resolves.toBeNull()
    // No assignment means no warehouse lookup at all.
    expect(queries).toHaveLength(0)
  })

  it('returns nothing when the assigned warehouse belongs to another organization', async () => {
    const { deps } = fakeDeps({
      assignmentsByUser: { [USER]: WAREHOUSE },
      warehouses: [{ ...inScopeWarehouse, organizationId: 'org-2' }],
    })
    await expect(resolveAssignedWarehouse(deps, auth)).resolves.toBeNull()
  })

  it('returns nothing when the assigned warehouse belongs to another tenant', async () => {
    const { deps } = fakeDeps({
      assignmentsByUser: { [USER]: WAREHOUSE },
      warehouses: [{ ...inScopeWarehouse, tenantId: 'tenant-2' }],
    })
    await expect(resolveAssignedWarehouse(deps, auth)).resolves.toBeNull()
  })

  it.each([
    ['no organization', { sub: USER, tenantId: TENANT, orgId: null }],
    ['no tenant', { sub: USER, tenantId: null, orgId: ORGANIZATION }],
    ['no session', null],
  ])('fails closed with %s', async (_label, context) => {
    const { deps, scopes, queries } = fakeDeps({
      assignmentsByUser: { [USER]: WAREHOUSE },
      warehouses: [inScopeWarehouse],
    })

    await expect(resolveAssignedWarehouse(deps, context as AuthContext)).resolves.toBeNull()
    // Missing scope must never fall back to an unscoped read.
    expect(scopes).toHaveLength(0)
    expect(queries).toHaveLength(0)
  })
})
