import { describe, expect, it } from '@jest/globals'
import {
  aggregatePostableQuantities,
  isEligibleDestination,
  resolveConfirmationBlockers,
  type ConfirmationCheck,
  type DestinationCandidate,
} from '../stockPosting'

const WAREHOUSE = '11111111-1111-4111-8111-111111111111'
const OTHER_WAREHOUSE = '22222222-2222-4222-8222-222222222222'

function candidate(overrides: Partial<DestinationCandidate> = {}): DestinationCandidate {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    code: 'STG-RECV',
    type: 'staging',
    warehouseId: WAREHOUSE,
    isActive: true,
    hasChildren: false,
    ...overrides,
  }
}

function check(overrides: Partial<ConfirmationCheck> = {}): ConfirmationCheck {
  return {
    status: 'receiving',
    palletsOpen: 0,
    lineCount: 2,
    postingEnabled: true,
    eligibleDestinationCount: 1,
    selectedDestinationId: '33333333-3333-4333-8333-333333333333',
    selectedDestinationEligible: true,
    trackedProducts: [],
    ...overrides,
  }
}

describe('isEligibleDestination', () => {
  it('accepts the location types goods can physically be put into', () => {
    for (const type of ['bin', 'slot', 'staging', 'dock']) {
      expect(isEligibleDestination(candidate({ type }), WAREHOUSE)).toBe(true)
    }
  })

  it('refuses container types, because a balance held in an aisle cannot be picked from', () => {
    for (const type of ['zone', 'aisle', 'rack']) {
      expect(isEligibleDestination(candidate({ type }), WAREHOUSE)).toBe(false)
    }
  })

  it('refuses a location with children whatever its type: the goods are somewhere more specific', () => {
    expect(isEligibleDestination(candidate({ type: 'bin', hasChildren: true }), WAREHOUSE)).toBe(false)
  })

  it('refuses an inactive location and one belonging to another warehouse', () => {
    expect(isEligibleDestination(candidate({ isActive: false }), WAREHOUSE)).toBe(false)
    expect(isEligibleDestination(candidate({ warehouseId: OTHER_WAREHOUSE }), WAREHOUSE)).toBe(false)
  })
})

describe('resolveConfirmationBlockers', () => {
  it('reports nothing when the delivery is counted and has somewhere to go', () => {
    expect(resolveConfirmationBlockers(check())).toEqual([])
  })

  it('names the open pallets, because that is what somebody has to go and do', () => {
    expect(resolveConfirmationBlockers(check({ palletsOpen: 2 }))).toContainEqual({ kind: 'palletsOpen', count: 2 })
  })

  it('refuses a document that is not being received, and one without lines', () => {
    expect(resolveConfirmationBlockers(check({ status: 'draft' }))).toContainEqual({ kind: 'notReceiving' })
    expect(resolveConfirmationBlockers(check({ lineCount: 0 }))).toContainEqual({ kind: 'noLines' })
  })

  it('asks no destination question at all when nothing will be posted', () => {
    const blockers = resolveConfirmationBlockers(
      check({ postingEnabled: false, eligibleDestinationCount: 0, selectedDestinationId: null, selectedDestinationEligible: false }),
    )
    expect(blockers).toEqual([])
  })

  it('distinguishes a warehouse with nowhere to put goods from a choice nobody made', () => {
    expect(
      resolveConfirmationBlockers(
        check({ eligibleDestinationCount: 0, selectedDestinationId: null, selectedDestinationEligible: false }),
      ),
    ).toContainEqual({ kind: 'noEligibleDestination' })
    expect(
      resolveConfirmationBlockers(check({ selectedDestinationId: null, selectedDestinationEligible: false })),
    ).toContainEqual({ kind: 'destinationRequired' })
    expect(resolveConfirmationBlockers(check({ selectedDestinationEligible: false }))).toContainEqual({
      kind: 'destinationInvalid',
    })
  })

  it('refuses a delivery holding a lot- or serial-tracked product, naming every one of them', () => {
    expect(resolveConfirmationBlockers(check({ trackedProducts: ['Serum', 'Aurora'] }))).toContainEqual({
      kind: 'trackedVariants',
      products: ['Aurora', 'Serum'],
    })
  })
})

describe('aggregatePostableQuantities', () => {
  const VARIANT = '44444444-4444-4444-8444-444444444444'
  const OTHER = '55555555-5555-4555-8555-555555555555'

  it('sums one variant across pallets into a single posting', () => {
    // The wms movement idempotency key includes the quantity, so posting two pallets of
    // 5 separately would produce one key twice and stock 5 instead of 10.
    expect(
      aggregatePostableQuantities([
        { catalogVariantId: VARIANT, quantity: '5.0000' },
        { catalogVariantId: VARIANT, quantity: '5.0000' },
      ]),
    ).toEqual([{ catalogVariantId: VARIANT, quantity: '10.0000' }])
  })

  it('adds fractional quantities exactly rather than through floating point', () => {
    expect(
      aggregatePostableQuantities([
        { catalogVariantId: VARIANT, quantity: '0.1000' },
        { catalogVariantId: VARIANT, quantity: '0.2000' },
      ]),
    ).toEqual([{ catalogVariantId: VARIANT, quantity: '0.3000' }])
  })

  it('drops a variant that sums to nothing: wms refuses it and there is nothing to shelve', () => {
    expect(aggregatePostableQuantities([{ catalogVariantId: VARIANT, quantity: '0.0000' }])).toEqual([])
    expect(aggregatePostableQuantities([])).toEqual([])
  })

  it('orders by variant so a retry sends the same postings in the same order', () => {
    const postable = aggregatePostableQuantities([
      { catalogVariantId: OTHER, quantity: '1' },
      { catalogVariantId: VARIANT, quantity: '1' },
    ])
    expect(postable.map((entry) => entry.catalogVariantId)).toEqual([VARIANT, OTHER])
  })
})
