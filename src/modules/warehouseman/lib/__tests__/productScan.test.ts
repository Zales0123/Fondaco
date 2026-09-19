import { describe, expect, it } from '@jest/globals'
import {
  formatStockQuantity,
  summarizeStock,
  toQuantity,
  type InventoryBalanceRow,
} from '../productScan'

describe('toQuantity', () => {
  it('reads the numeric column whether it arrives as a string or a number', () => {
    expect(toQuantity('12.0000')).toBe(12)
    expect(toQuantity(7)).toBe(7)
  })

  it('treats a missing or unreadable quantity as none', () => {
    expect(toQuantity(null)).toBe(0)
    expect(toQuantity(undefined)).toBe(0)
    expect(toQuantity('not a number')).toBe(0)
  })
})

describe('summarizeStock', () => {
  it('answers nothing for a product no warehouse holds', () => {
    expect(summarizeStock([])).toEqual({ totalOnHand: 0, totalAvailable: 0, byWarehouse: [] })
  })

  it('sums the buckets of one warehouse into one row', () => {
    const rows: InventoryBalanceRow[] = [
      { warehouse_id: 'wh-1', warehouse_name: 'Main', quantity_on_hand: '4.0000', quantity_available: 3 },
      { warehouse_id: 'wh-1', warehouse_name: 'Main', quantity_on_hand: '6.0000', quantity_available: 6 },
    ]
    expect(summarizeStock(rows)).toEqual({
      totalOnHand: 10,
      totalAvailable: 9,
      byWarehouse: [{ warehouseId: 'wh-1', warehouseLabel: 'Main', onHand: 10, available: 9 }],
    })
  })

  it('orders the warehouses by what they hold, most first', () => {
    const rows: InventoryBalanceRow[] = [
      { warehouse_id: 'wh-1', warehouse_name: 'Small', quantity_on_hand: 2, quantity_available: 2 },
      { warehouse_id: 'wh-2', warehouse_name: 'Big', quantity_on_hand: 40, quantity_available: 40 },
    ]
    expect(summarizeStock(rows).byWarehouse.map((entry) => entry.warehouseLabel)).toEqual(['Big', 'Small'])
  })

  it('names a warehouse by its code, then its id, when no name came back', () => {
    const rows: InventoryBalanceRow[] = [
      { warehouse_id: 'wh-1', warehouse_name: '  ', warehouse_code: 'DEMO-WH', quantity_on_hand: 1 },
      { warehouse_id: 'wh-2', quantity_on_hand: 1 },
    ]
    expect(summarizeStock(rows).byWarehouse.map((entry) => entry.warehouseLabel)).toEqual(['DEMO-WH', 'wh-2'])
  })

  it('counts a bucket with no warehouse into the total rather than dropping it', () => {
    const summary = summarizeStock([{ warehouse_id: null, quantity_on_hand: 5, quantity_available: 5 }])
    expect(summary.totalOnHand).toBe(5)
    expect(summary.byWarehouse).toEqual([])
  })
})

describe('formatStockQuantity', () => {
  it('keeps whole units whole and trims the numeric scale', () => {
    expect(formatStockQuantity(12)).toBe('12')
    expect(formatStockQuantity(2.5)).toBe('2.5')
  })
})
