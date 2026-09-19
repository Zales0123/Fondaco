import { describe, expect, it } from '@jest/globals'
import { isEligibleDestination, type DestinationCandidate } from '@/modules/pz/lib/stockPosting'
import {
  DEMO_DEFAULT_DESTINATION_CODE,
  DEMO_LOCATIONS,
  seedDemoLocations,
  type CreateDemoLocation,
} from '../demoWarehouseLocations'

const WAREHOUSE = 'warehouse-1'

type CreatedLocation = {
  code: string
  type: string
  parentId: string | null
  capacityUnits?: number
}

/**
 * A warehouse rather than a stub: it hands back a fresh id per call and records what it
 * was asked to create, so a seeder that re-created a location it already had, or pointed
 * a child at nothing, fails here instead of sailing through a counter.
 */
function fakeWarehouse(existing: Record<string, string> = {}) {
  const created: CreatedLocation[] = []
  const createLocation: CreateDemoLocation = async (input) => {
    created.push({ ...input })
    return `loc-${created.length}`
  }
  return { existing: new Map(Object.entries(existing)), created, createLocation }
}

/** The fixtures as the eligibility rule in `pz` sees them once they are in the database. */
function asCandidates(): DestinationCandidate[] {
  const parents = new Set(
    DEMO_LOCATIONS.map((location) => location.parentCode).filter((code): code is string => Boolean(code)),
  )
  return DEMO_LOCATIONS.map((location) => ({
    id: location.code,
    code: location.code,
    type: location.type,
    warehouseId: WAREHOUSE,
    isActive: true,
    hasChildren: parents.has(location.code),
  }))
}

describe('seedDemoLocations', () => {
  it('creates the whole set on a fresh warehouse', async () => {
    const warehouse = fakeWarehouse()

    const result = await seedDemoLocations(warehouse)

    expect(warehouse.created.map((location) => location.code)).toEqual(DEMO_LOCATIONS.map((l) => l.code))
    expect(result.size).toBe(DEMO_LOCATIONS.length)
  })

  it('creates nothing on a second run, so repeated inits converge', async () => {
    const first = fakeWarehouse()
    const seeded = await seedDemoLocations(first)

    const second = fakeWarehouse(Object.fromEntries(seeded))
    const again = await seedDemoLocations(second)

    expect(second.created).toEqual([])
    expect(again).toEqual(seeded)
  })

  it('fills in only what a half-finished run is missing', async () => {
    const warehouse = fakeWarehouse({ RECV: 'existing-recv' })

    const result = await seedDemoLocations(warehouse)

    expect(warehouse.created.map((location) => location.code)).toEqual(
      DEMO_LOCATIONS.filter((location) => location.code !== 'RECV').map((location) => location.code),
    )
    expect(result.get('RECV')).toBe('existing-recv')
  })

  it('points every child at the parent it names, including one it did not create', async () => {
    const warehouse = fakeWarehouse({ RECV: 'existing-recv' })

    const result = await seedDemoLocations(warehouse)

    for (const fixture of DEMO_LOCATIONS) {
      const created = warehouse.created.find((location) => location.code === fixture.code)
      if (!created) continue
      expect(created.parentId).toBe(fixture.parentCode ? result.get(fixture.parentCode) : null)
    }
    expect(warehouse.created.find((location) => location.code === 'DOCK-IN')?.parentId).toBe('existing-recv')
  })

  it('carries the fixture capacity through to the create', async () => {
    const warehouse = fakeWarehouse()

    await seedDemoLocations(warehouse)

    expect(warehouse.created.find((location) => location.code === 'STG-RECV')?.capacityUnits).toBe(400)
  })
})

describe('DEMO_LOCATIONS', () => {
  it('names every location once, because a code is unique within a warehouse', () => {
    const codes = DEMO_LOCATIONS.map((location) => location.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('declares parents before their children, so a parent id is resolvable', () => {
    const seen = new Set<string>()
    for (const location of DEMO_LOCATIONS) {
      if (location.parentCode) expect(seen.has(location.parentCode)).toBe(true)
      seen.add(location.code)
    }
  })

  it('leaves the warehouse with destinations a goods receipt can be posted into', () => {
    const eligible = asCandidates().filter((candidate) => isEligibleDestination(candidate, WAREHOUSE))
    expect(eligible.length).toBeGreaterThan(1)
    // A dock, a staging and pickable locations: the set the destination picker shows.
    expect(new Set(eligible.map((candidate) => candidate.type))).toEqual(new Set(['dock', 'staging', 'slot', 'bin']))
  })

  it('preselects a default destination that is itself eligible', () => {
    const candidate = asCandidates().find((entry) => entry.code === DEMO_DEFAULT_DESTINATION_CODE)
    expect(candidate).toBeDefined()
    expect(isEligibleDestination(candidate!, WAREHOUSE)).toBe(true)
  })
})
