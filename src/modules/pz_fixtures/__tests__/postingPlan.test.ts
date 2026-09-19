import { describe, expect, it } from '@jest/globals'
import {
  pickDefaultDestination,
  planDefaultDestinations,
  type WarehouseDefaultState,
} from '../lib/postingPlan'

const BIN_A = { id: 'loc-a', code: 'A-01-01' }
const BIN_B = { id: 'loc-b', code: 'B-01-01' }
const STAGING = { id: 'loc-s', code: 'STG-RECV' }

describe('pickDefaultDestination', () => {
  it('picks the lowest code, whatever order the caller read them in', () => {
    expect(pickDefaultDestination([STAGING, BIN_B, BIN_A])).toEqual(BIN_A)
    expect(pickDefaultDestination([BIN_A, BIN_B, STAGING])).toEqual(BIN_A)
  })

  it('has nothing to pick from an empty list', () => {
    expect(pickDefaultDestination([])).toBeNull()
  })
})

describe('planDefaultDestinations', () => {
  it('preselects the lowest-coded eligible location when nothing is set', () => {
    const states: WarehouseDefaultState[] = [
      { warehouseId: 'wh-1', warehouseName: 'Central', eligible: [BIN_B, BIN_A], currentDefaultId: null },
    ]
    expect(planDefaultDestinations(states)).toEqual([
      {
        warehouseId: 'wh-1',
        warehouseName: 'Central',
        eligibleCount: 2,
        currentDefaultId: null,
        currentDefaultEligible: false,
        action: 'set',
        destination: BIN_A,
      },
    ])
  })

  it('never overwrites a destination somebody set on purpose', () => {
    const states: WarehouseDefaultState[] = [
      { warehouseId: 'wh-1', warehouseName: 'Central', eligible: [BIN_A, BIN_B], currentDefaultId: BIN_B.id },
    ]
    const [plan] = planDefaultDestinations(states)
    expect(plan.action).toBe('keep')
    expect(plan.destination).toEqual(BIN_B)
    expect(plan.currentDefaultEligible).toBe(true)
  })

  it('leaves a stale value alone and reports that it is not eligible', () => {
    const states: WarehouseDefaultState[] = [
      { warehouseId: 'wh-1', warehouseName: 'Central', eligible: [BIN_A], currentDefaultId: 'loc-gone' },
    ]
    const [plan] = planDefaultDestinations(states)
    expect(plan.action).toBe('keep')
    expect(plan.currentDefaultEligible).toBe(false)
    expect(plan.destination).toBeNull()
  })

  it('skips a warehouse with nowhere to post rather than failing on it', () => {
    const states: WarehouseDefaultState[] = [
      { warehouseId: 'wh-1', warehouseName: 'Central', eligible: [BIN_A], currentDefaultId: null },
      { warehouseId: 'wh-2', warehouseName: 'Demo', eligible: [], currentDefaultId: null },
    ]
    const plans = planDefaultDestinations(states)
    expect(plans.map((plan) => plan.action)).toEqual(['set', 'skip'])
    expect(plans[1].destination).toBeNull()
    expect(plans[1].eligibleCount).toBe(0)
  })

  it('is idempotent: re-planning after the write changes nothing', () => {
    const before: WarehouseDefaultState[] = [
      { warehouseId: 'wh-1', warehouseName: 'Central', eligible: [BIN_A, BIN_B], currentDefaultId: null },
    ]
    const [first] = planDefaultDestinations(before)
    const after: WarehouseDefaultState[] = [{ ...before[0], currentDefaultId: first.destination!.id }]
    const [second] = planDefaultDestinations(after)
    expect(second.action).toBe('keep')
    expect(second.destination).toEqual(first.destination)
  })

  it('reports one plan per warehouse, in the order they were read', () => {
    const states: WarehouseDefaultState[] = [
      { warehouseId: 'wh-1', warehouseName: 'Central', eligible: [BIN_A], currentDefaultId: null },
      { warehouseId: 'wh-2', warehouseName: 'Returns', eligible: [STAGING], currentDefaultId: null },
      { warehouseId: 'wh-3', warehouseName: 'Demo', eligible: [], currentDefaultId: null },
    ]
    expect(planDefaultDestinations(states).map((plan) => plan.warehouseId)).toEqual(['wh-1', 'wh-2', 'wh-3'])
  })
})
