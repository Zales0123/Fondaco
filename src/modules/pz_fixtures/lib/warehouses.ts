/**
 * What the fixtures need to know about the Warehouses in scope: which ones exist, and for
 * each one the Locations a delivery may be posted into plus whatever Default Destination is
 * already configured.
 *
 * Both reads go through `pz`'s own helpers rather than a query of our own. Eligibility is
 * `pz`'s rule, not `wms`'s — `wms.inventory.receive` accepts any Location of the Warehouse —
 * so a fixture that decided for itself which Locations count would drift from the rule the
 * confirmation actually enforces, and would preselect Locations the floor is then refused.
 */
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { loadWarehouseDestinations, readDefaultDestinationId } from '@/modules/pz/lib/destinations'
import type { PzFixtureScope } from './scope'
import type { WarehouseDefaultState } from './postingPlan'

export type WarehouseRow = { id: string; name: string }

/**
 * Ordered by name so the document series lands on the same Warehouses on every machine: the
 * builder assigns Warehouses by rotation, and a rotation over an unordered read would place
 * the guaranteed documents somewhere different each run.
 */
export async function readWarehouses(em: EntityManager, scope: PzFixtureScope): Promise<WarehouseRow[]> {
  return (await em.getConnection().execute(
    `select id, name
       from wms_warehouses
      where tenant_id = ? and organization_id = ? and deleted_at is null and is_active = true
      order by name asc, id asc`,
    [scope.tenantId, scope.organizationId],
  )) as WarehouseRow[]
}

export async function readWarehouseDefaultStates(
  em: EntityManager,
  container: AwilixContainer,
  scope: PzFixtureScope,
  warehouses: readonly WarehouseRow[],
): Promise<WarehouseDefaultState[]> {
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  const states: WarehouseDefaultState[] = []
  // Sequentially: a fixture run is not on a hot path, and one Warehouse at a time keeps a
  // failure attributable to the Warehouse that caused it.
  for (const warehouse of warehouses) {
    const eligible = await loadWarehouseDestinations(queryEngine, scope, warehouse.id)
    const currentDefaultId = await readDefaultDestinationId(em, scope, warehouse.id)
    states.push({
      warehouseId: warehouse.id,
      warehouseName: warehouse.name,
      eligible: eligible.map(({ id, code }) => ({ id, code })),
      currentDefaultId,
    })
  }
  return states
}
