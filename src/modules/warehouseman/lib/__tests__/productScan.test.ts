import { describe, expect, it } from '@jest/globals'
import {
  EMPTY_STOCK_SUMMARY,
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
  it('answers nothing for a product this warehouse does not hold', () => {
    expect(summarizeStock([])).toEqual(EMPTY_STOCK_SUMMARY)
  })

  it('sums the buckets of the warehouse into one figure', () => {
    const rows: InventoryBalanceRow[] = [
      { quantity_on_hand: '4.0000', quantity_available: 3 },
      { quantity_on_hand: '6.0000', quantity_available: 6 },
    ]
    expect(summarizeStock(rows)).toEqual({ onHand: 10, available: 9 })
  })

  it('counts a bucket whose available figure never came back', () => {
    expect(summarizeStock([{ quantity_on_hand: 5 }])).toEqual({ onHand: 5, available: 0 })
  })
})

describe('formatStockQuantity', () => {
  it('keeps whole units whole and trims the numeric scale', () => {
    expect(formatStockQuantity(12)).toBe('12')
    expect(formatStockQuantity(2.5)).toBe('2.5')
  })
})
