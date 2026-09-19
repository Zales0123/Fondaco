import type { EntityManager } from '@mikro-orm/postgresql'
import {
  Warehouse,
  WarehouseLocation,
  type WarehouseLocationType,
} from '@open-mercato/core/modules/wms/data/entities'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('warehouseman:setup')

/**
 * One row of the demo warehouse's Location tree. Deliberately the same shape as
 * `wms_fixtures/lib/data.ts` → `LocationFixture`, minus the `warehouseCode`: every row
 * here belongs to `DEMO-WH`, so carrying the code on each one would only invite it to
 * drift from the warehouse the seeder was handed.
 *
 * `parentCode` is resolved against rows that already exist — the fixture list below is
 * ordered parents-first for that reason, exactly as the wms fixtures are.
 */
export type DemoLocationFixture = {
  code: string
  type: WarehouseLocationType
  parentCode?: string
  /** Numeric upstream; stringified on write because the column is `numeric`, not `int`. */
  capacityUnits?: number
}

/**
 * Why these Locations live in `warehouseman` and not in `wms_fixtures`.
 *
 * `wms_fixtures` owns the WMS demo dataset, so at first glance it is the natural home for
 * a demo warehouse's shelves. It cannot be: `DEMO-WH` is created by this module's
 * `seedExamples`, and `seedExamples` hooks run in `src/modules.ts` order, where
 * `wms_fixtures` comes *before* `warehouseman`. By the time the WMS fixtures run there is
 * no `DEMO-WH` row to hang Locations off, and by the time `DEMO-WH` exists the WMS
 * fixtures are long finished. Reordering the module list to fix that would make an
 * unrelated module's position load-bearing for this one's data; whoever creates the
 * warehouse creates its insides, which is this module.
 *
 * Why *these* types. `pz`'s Stock Posting only accepts a destination that is a leaf of the
 * Location tree, is active, belongs to the target warehouse, and is one of
 * `bin | slot | staging | dock` (see `isEligibleDestination` in
 * `src/modules/pz/lib/stockPosting.ts` — not imported here, because a fixture must not
 * couple `warehouseman` to `pz`; a container such as a `zone`, `aisle` or `rack` is
 * refused because "the pallet is somewhere in aisle A" is not a place anyone can go and
 * pick from). A warehouse with no such Location makes Confirm permanently impossible on
 * the floor panel, reported as the `noEligibleDestination` blocker — which is exactly
 * what `DEMO-WH` looked like before this fixture existed.
 *
 * So the tree is deliberately mixed rather than a flat list of bins: the two `zone` roots
 * are ineligible and their four leaves are eligible. A demo that offers only valid
 * choices never shows that the destination picker filters anything, and the filtering is
 * the part worth looking at.
 */
export const DEMO_WAREHOUSE_LOCATIONS: DemoLocationFixture[] = [
  // Receiving: where a counted delivery actually lands. `RECV-STG` is the default-looking
  // choice for a whole pallet; `RECV-DOCK` is the "it never left the dock" one.
  { code: 'RECV', type: 'zone' },
  { code: 'RECV-DOCK', type: 'dock', parentCode: 'RECV' },
  { code: 'RECV-STG', type: 'staging', parentCode: 'RECV', capacityUnits: 200 },
  // Storage: two bins, so the picker has more than one plausible answer and the demo can
  // show a choice being made rather than a single option being rubber-stamped.
  { code: 'STORE', type: 'zone' },
  { code: 'STORE-01', type: 'bin', parentCode: 'STORE', capacityUnits: 100 },
  { code: 'STORE-02', type: 'bin', parentCode: 'STORE', capacityUnits: 100 },
]

export type DemoLocationScope = { tenantId: string; organizationId: string }

/**
 * Gives the demo warehouse a Location tree, so the floor panel's Confirm has somewhere to
 * post to on a freshly initialised environment. Returns how many rows it created.
 *
 * Idempotent by (warehouse, code): the unique index upstream is
 * `(warehouse_id, code) where deleted_at is null`, so the same key is used to decide what
 * is already there. A code that exists is skipped and still serves as a parent for the
 * rows below it, which means a half-finished earlier run heals on the next one instead of
 * colliding.
 *
 * Never throws. `wms` is an optional peer of this module — `ensureDemoWarehouse` already
 * treats a missing `wms_warehouses` table as "no warehouse, carry on" — and a demo
 * environment with a warehouse but no shelves is still a working panel demo. Breaking
 * `mercato init` over fixture data would be far worse than the blocker this removes, so
 * the failure is logged and swallowed exactly like the warehouse's own.
 */
export async function ensureDemoWarehouseLocations(
  em: EntityManager,
  warehouse: Warehouse,
  scope: DemoLocationScope,
): Promise<number> {
  try {
    const existing = await em.find(WarehouseLocation, {
      warehouse,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    })
    const byCode = new Map<string, WarehouseLocation>(existing.map((location) => [location.code, location]))

    let created = 0
    for (const fixture of DEMO_WAREHOUSE_LOCATIONS) {
      if (byCode.has(fixture.code)) continue

      const parent = fixture.parentCode ? byCode.get(fixture.parentCode) ?? null : null
      if (fixture.parentCode && !parent) {
        // Only reachable if someone edits the list out of parents-first order. Hanging the
        // child off the warehouse root instead would silently turn a leaf into a sibling of
        // its own zone, so it is skipped and said out loud.
        logger.warn('Skipping a demo warehouse location: its parent is missing', {
          code: fixture.code,
          parentCode: fixture.parentCode,
        })
        continue
      }

      const location = em.create(WarehouseLocation, {
        warehouse,
        code: fixture.code,
        type: fixture.type,
        parent,
        isActive: true,
        // `numeric(16,4)` round-trips as a string through MikroORM, so the fixture's number
        // is converted here rather than leaving the entity holding a type it never reads back.
        capacityUnits: fixture.capacityUnits === undefined ? null : String(fixture.capacityUnits),
        // Scope is set explicitly on every row. These columns carry no default and the
        // warehouse's own scope is not inherited through the relation, so an unset one would
        // be an unscoped row rather than a rejected write.
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      } as unknown as WarehouseLocation)
      em.persist(location)
      // Flushed per row so a child is always inserted against a parent that already has an
      // id. Six rows on `mercato init` is not a cost worth trading for a dependency on how
      // the unit of work happens to order self-referencing inserts.
      await em.flush()
      byCode.set(fixture.code, location)
      created += 1
    }

    if (created > 0) logger.info('Seeded the demo warehouse locations', { created })
    return created
  } catch (error) {
    logger.warn('Skipping the demo warehouse locations: the wms module is unavailable', { err: error })
    return 0
  }
}
