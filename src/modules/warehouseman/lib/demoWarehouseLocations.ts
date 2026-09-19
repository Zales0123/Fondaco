import type { WarehouseLocationType } from '@open-mercato/core/modules/wms/data/entities'

/**
 * One Warehouse Location of the demo warehouse. Mirrors the shape `wms_fixtures`
 * uses for `WH-MAIN`/`WH-RET` (`lib/data.ts`), down to the code vocabulary, so the
 * three demo warehouses read as one estate rather than three conventions.
 */
export type DemoLocationFixture = {
  code: string
  type: WarehouseLocationType
  /** Resolved against an already-created location, so parents precede children below. */
  parentCode?: string
  capacityUnits?: number
}

/**
 * The demo warehouse's locations.
 *
 * `DEMO-WH` exists so a fresh environment can walk the receiving flow end to end, and
 * since ADR-0011 that flow ends in a posting into a Warehouse Location: confirmation is
 * refused outright when the warehouse offers no eligible destination, which a warehouse
 * with no locations never does. Eligible means active, in this warehouse, childless and
 * of type `bin`, `slot`, `staging` or `dock` — so the three `zone` roots below are
 * structure only, and every leaf is a place a delivery can actually land.
 *
 * Small on purpose: enough that the destination picker looks like a warehouse rather
 * than a single stub row, and not so much that it competes with `wms_fixtures` for the
 * dashboards' attention.
 */
export const DEMO_LOCATIONS: readonly DemoLocationFixture[] = [
  { code: 'RECV', type: 'zone' },
  { code: 'DOCK-IN', type: 'dock', parentCode: 'RECV' },
  { code: 'STG-RECV', type: 'staging', parentCode: 'RECV', capacityUnits: 400 },
  { code: 'PICK', type: 'zone' },
  { code: 'PICK-01', type: 'slot', parentCode: 'PICK', capacityUnits: 40 },
  { code: 'PICK-02', type: 'slot', parentCode: 'PICK', capacityUnits: 40 },
  { code: 'BULK', type: 'zone' },
  { code: 'BULK-01', type: 'bin', parentCode: 'BULK', capacityUnits: 200 },
]

/**
 * The location the demo warehouse preselects as its Default Destination. Receiving
 * staging is where a counted delivery belongs before anybody puts it away, and it is
 * the one leaf of the receiving zone with a capacity worth showing.
 */
export const DEMO_DEFAULT_DESTINATION_CODE = 'STG-RECV'

export type CreateDemoLocation = (input: {
  code: string
  type: WarehouseLocationType
  parentId: string | null
  capacityUnits?: number
}) => Promise<string>

/**
 * Creates whatever of {@link DEMO_LOCATIONS} the warehouse does not already have, and
 * answers with every fixture code the warehouse holds afterwards, mapped to its id.
 *
 * Convergence is by code rather than by an all-or-nothing guard: `mercato init` runs
 * more than once over the same database, a location code is unique per warehouse (the
 * create command refuses a duplicate outright), and a run interrupted halfway must be
 * finishable by running it again. A code somebody else already used is left alone — the
 * seed's job is to make the demo work, not to own the warehouse.
 */
export async function seedDemoLocations(opts: {
  /** The warehouse's existing locations, by code. */
  existing: ReadonlyMap<string, string>
  createLocation: CreateDemoLocation
}): Promise<Map<string, string>> {
  const byCode = new Map(opts.existing)
  for (const fixture of DEMO_LOCATIONS) {
    if (byCode.has(fixture.code)) continue
    const parentId = fixture.parentCode ? byCode.get(fixture.parentCode) ?? null : null
    const id = await opts.createLocation({
      code: fixture.code,
      type: fixture.type,
      parentId,
      capacityUnits: fixture.capacityUnits,
    })
    byCode.set(fixture.code, id)
  }
  return byCode
}
