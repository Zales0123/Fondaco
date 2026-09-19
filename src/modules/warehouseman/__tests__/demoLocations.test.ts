/**
 * The demo warehouse exists so a fresh environment can be shown to somebody without a
 * setup checklist being run first. Its Locations are the part that makes the floor
 * panel's Confirm reachable at all, so what is asserted here is the *outcome* — that at
 * least one destination `pz` will accept comes out of the seed — rather than the row
 * count, which is free to change.
 */
import { describe, expect, it } from '@jest/globals'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { Warehouse } from '@open-mercato/core/modules/wms/data/entities'
import { DEMO_WAREHOUSE_LOCATIONS, ensureDemoWarehouseLocations } from '../lib/demoLocations'

/**
 * Deliberately a local copy of `pz`'s `ELIGIBLE_DESTINATION_TYPES`, not an import of it.
 * A fixture in `warehouseman` must not depend on `pz`, and that holds for the test as
 * much as for the code: if the two lists ever diverge this suite should go red and make
 * somebody look, which importing the real one would prevent.
 */
const ELIGIBLE_TYPES = ['bin', 'slot', 'staging', 'dock']

type SeededRow = {
  warehouse: unknown
  code: string
  type: string
  parent: SeededRow | null
  isActive: boolean
  capacityUnits: string | null
  tenantId: string
  organizationId: string
}

const SCOPE = { tenantId: 'tenant-1', organizationId: 'org-1' }
const warehouse = { id: 'wh-1', code: 'DEMO-WH' } as unknown as Warehouse

type FakeEm = {
  em: EntityManager
  created: SeededRow[]
  flushes: number
  findArgs: unknown[]
}

/**
 * Stands in for the ORM. `create` hands back the payload untouched, which is enough:
 * the seeder only ever reads `code` back off a row, to resolve the next row's parent.
 */
function fakeEm(options: { existing?: Array<Partial<SeededRow>>; onFind?: () => never } = {}): FakeEm {
  const created: SeededRow[] = []
  const findArgs: unknown[] = []
  let flushes = 0
  const existing = (options.existing ?? []) as SeededRow[]

  const em = {
    find: async (_entity: unknown, where: unknown) => {
      findArgs.push(where)
      if (options.onFind) options.onFind()
      return existing
    },
    create: (_entity: unknown, data: unknown) => data,
    persist: (row: unknown) => {
      created.push(row as SeededRow)
    },
    flush: async () => {
      flushes += 1
    },
  } as unknown as EntityManager

  return {
    em,
    created,
    get flushes() {
      return flushes
    },
    findArgs,
  }
}

/** The rule `pz` applies, restated: leaf, active, eligible type. */
function eligibleCodes(rows: SeededRow[]): string[] {
  const parentCodes = new Set(rows.map((row) => row.parent?.code).filter(Boolean))
  return rows
    .filter((row) => row.isActive && !parentCodes.has(row.code) && ELIGIBLE_TYPES.includes(row.type))
    .map((row) => row.code)
    .sort()
}

describe('demo warehouse locations', () => {
  it('produces destinations pz will accept, and containers it will refuse', async () => {
    const fake = fakeEm()
    const created = await ensureDemoWarehouseLocations(fake.em, warehouse, SCOPE)

    expect(created).toBe(DEMO_WAREHOUSE_LOCATIONS.length)
    // The whole point of the fixture: `noEligibleDestination` can no longer be the answer.
    const eligible = eligibleCodes(fake.created)
    expect(eligible).toEqual(['RECV-DOCK', 'RECV-STG', 'STORE-01', 'STORE-02'])
    // And the tree is mixed, so the picker visibly filters something out.
    const refused = fake.created.filter((row) => !eligible.includes(row.code))
    expect(refused.map((row) => row.code).sort()).toEqual(['RECV', 'STORE'])
    expect(refused.every((row) => row.type === 'zone')).toBe(true)
  })

  it('hangs every child off the parent named in the fixture', async () => {
    const fake = fakeEm()
    await ensureDemoWarehouseLocations(fake.em, warehouse, SCOPE)

    const byCode = new Map(fake.created.map((row) => [row.code, row]))
    expect(byCode.get('RECV')?.parent).toBeNull()
    expect(byCode.get('RECV-DOCK')?.parent?.code).toBe('RECV')
    expect(byCode.get('RECV-STG')?.parent?.code).toBe('RECV')
    expect(byCode.get('STORE-01')?.parent?.code).toBe('STORE')
    expect(byCode.get('STORE-02')?.parent?.code).toBe('STORE')
  })

  it('scopes every row and attaches it to the warehouse it was given', async () => {
    const fake = fakeEm()
    await ensureDemoWarehouseLocations(fake.em, warehouse, SCOPE)

    for (const row of fake.created) {
      expect(row.tenantId).toBe('tenant-1')
      expect(row.organizationId).toBe('org-1')
      expect(row.warehouse).toBe(warehouse)
    }
    // The lookup that decides what already exists must be scoped too, or a re-run in one
    // organization would read another's rows and skip seeding.
    expect(fake.findArgs[0]).toMatchObject({ warehouse, tenantId: 'tenant-1', organizationId: 'org-1', deletedAt: null })
  })

  it('writes capacity as the string the numeric column round-trips', async () => {
    const fake = fakeEm()
    await ensureDemoWarehouseLocations(fake.em, warehouse, SCOPE)

    const byCode = new Map(fake.created.map((row) => [row.code, row]))
    expect(byCode.get('RECV-STG')?.capacityUnits).toBe('200')
    expect(byCode.get('RECV-DOCK')?.capacityUnits).toBeNull()
  })

  it('creates nothing on a second run', async () => {
    const existing = DEMO_WAREHOUSE_LOCATIONS.map((fixture) => ({ code: fixture.code, type: fixture.type }))
    const fake = fakeEm({ existing })

    const created = await ensureDemoWarehouseLocations(fake.em, warehouse, SCOPE)

    expect(created).toBe(0)
    expect(fake.created).toEqual([])
    // Nothing to write means nothing to flush — `mercato init` should not touch the row.
    expect(fake.flushes).toBe(0)
  })

  it('fills in only what is missing, reusing an existing row as the parent', async () => {
    // A run that died after the first row: the zone is there, its leaves are not.
    const recv = { code: 'RECV', type: 'zone' }
    const fake = fakeEm({ existing: [recv] })

    const created = await ensureDemoWarehouseLocations(fake.em, warehouse, SCOPE)

    expect(created).toBe(DEMO_WAREHOUSE_LOCATIONS.length - 1)
    expect(fake.created.map((row) => row.code)).not.toContain('RECV')
    // The surviving zone is adopted rather than duplicated — the unique index upstream is
    // (warehouse_id, code), so a second RECV would be a constraint violation, not a copy.
    expect(fake.created.find((row) => row.code === 'RECV-DOCK')?.parent).toBe(recv)
  })

  it('lets mercato init continue when wms is unavailable', async () => {
    const fake = fakeEm({
      onFind: () => {
        throw new Error('relation "wms_warehouse_locations" does not exist')
      },
    })
    // The demo account and its warehouse assignment matter more than the shelves; a
    // missing optional peer must not take the whole seed down with it. The WARN line and
    // stack this prints into the test output are the behaviour under test, not a failure.
    await expect(ensureDemoWarehouseLocations(fake.em, warehouse, SCOPE)).resolves.toBe(0)
    expect(fake.created).toEqual([])
  })
})
