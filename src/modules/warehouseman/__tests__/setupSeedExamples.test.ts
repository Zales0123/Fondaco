/**
 * `seedExamples` has two jobs that used to be welded together: making sure the demo
 * warehouse exists (with the Locations that make the floor panel's Confirm reachable),
 * and handing that warehouse to a newly created demo account.
 *
 * They are separate on purpose. The account is only assigned a warehouse when it is
 * freshly seeded — re-running the seed must never overwrite an assignment somebody made
 * deliberately — but the warehouse and its Locations have to be ensured on *every* run,
 * or an environment initialised before the Locations fixture existed would never gain
 * them and `DEMO-WH` would stay a warehouse nobody can post stock into.
 *
 * That distinction is what this suite pins down, because it is invisible in the types
 * and a single misplaced early return silently undoes it.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const setCustomFieldsIfAny = jest.fn(async () => {})
const resolveSeedWarehouseman = jest.fn(() => ({
  email: 'warehouseman@acme.com',
  password: 'Warehouse123!',
}))
const ensureDemoWarehouseLocations = jest.fn(async () => 2)

jest.mock('@open-mercato/shared/lib/commands/helpers', () => ({ setCustomFieldsIfAny }))
jest.mock('../lib/demoCredentials', () => ({ resolveSeedWarehouseman }))
jest.mock('../lib/demoLocations', () => ({ ensureDemoWarehouseLocations }))
jest.mock('@open-mercato/core/modules/auth/lib/setup-app', () => ({ ensureRoles: jest.fn(async () => {}) }))
jest.mock('@open-mercato/core/modules/auth/lib/emailHash', () => ({ computeEmailHash: () => 'email-hash' }))
// bcrypt is slow and its output is never asserted; the account either gets a hash or it does not.
jest.mock('bcryptjs', () => ({ hash: async () => 'hashed' }))

// Imported after the mocks above only in source order: `jest.mock` is hoisted, so the
// module under test still loads with every dependency replaced.
import { setup } from '../setup'

const SCOPE = { tenantId: 'tenant-1', organizationId: 'org-1' }

type Row = Record<string, unknown>

/**
 * Stands in for the ORM. `findOne` is answered per entity name so a test can say "the
 * warehouse is already there, the user is not" — which is the shape of every case here.
 */
function fakeEm(present: { user?: Row | null; warehouse?: Row | null } = {}) {
  const created: Row[] = []
  const em = {
    findOne: async (entity: unknown, _where: unknown) => {
      const name = (entity as { name?: string })?.name ?? String(entity)
      if (name.includes('Warehouse')) return present.warehouse ?? null
      if (name.includes('Role')) return { id: 'role-1', name: 'warehouseman' }
      if (name.includes('User')) return present.user ?? null
      return null
    },
    create: (_entity: unknown, data: Row) => ({ id: `new-${created.length + 1}`, ...data }),
    persist: (row: Row) => {
      created.push(row)
    },
    flush: async () => {},
  }
  return { em: em as never, created }
}

const container = { resolve: () => ({}) } as never

function runSeed(em: unknown) {
  return setup.seedExamples!({ em, container, ...SCOPE } as never)
}

beforeEach(() => {
  setCustomFieldsIfAny.mockClear()
  ensureDemoWarehouseLocations.mockClear()
  resolveSeedWarehouseman.mockClear()
})

describe('warehouseman seedExamples', () => {
  it('ensures the demo warehouse Locations even when the account already exists', async () => {
    // The regression this file exists for: an environment seeded before the Locations
    // fixture shipped. The account is present, so nothing about it needs doing — but the
    // warehouse must still be brought up to date.
    const { em } = fakeEm({ user: { id: 'user-1' }, warehouse: { id: 'wh-1' } })

    await runSeed(em)

    expect(ensureDemoWarehouseLocations).toHaveBeenCalledTimes(1)
    // ...and the pre-existing account keeps whatever warehouse it was given.
    expect(setCustomFieldsIfAny).not.toHaveBeenCalled()
  })

  it('assigns the warehouse only to a freshly seeded account', async () => {
    const { em } = fakeEm({ user: null, warehouse: { id: 'wh-1' } })

    await runSeed(em)

    expect(ensureDemoWarehouseLocations).toHaveBeenCalledTimes(1)
    expect(setCustomFieldsIfAny).toHaveBeenCalledTimes(1)
    const [call] = setCustomFieldsIfAny.mock.calls as unknown as [[{ values: Record<string, unknown> }]]
    expect(Object.values(call[0].values)).toEqual(['wh-1'])
  })

  it('creates the warehouse when it is missing, then seeds its Locations', async () => {
    const { em, created } = fakeEm({ user: null, warehouse: null })

    await runSeed(em)

    expect(created.some((row) => row.code === 'DEMO-WH')).toBe(true)
    expect(ensureDemoWarehouseLocations).toHaveBeenCalledTimes(1)
  })

  it('does nothing at all when no demo password is configured', async () => {
    // Production: the credentials resolver refuses to invent a well-known password, and
    // that refusal must stop the whole hook rather than leaving demo rows behind.
    resolveSeedWarehouseman.mockReturnValueOnce(null as never)
    const { em, created } = fakeEm({ user: null, warehouse: null })

    await runSeed(em)

    expect(created).toHaveLength(0)
    expect(ensureDemoWarehouseLocations).not.toHaveBeenCalled()
    expect(setCustomFieldsIfAny).not.toHaveBeenCalled()
  })
})
