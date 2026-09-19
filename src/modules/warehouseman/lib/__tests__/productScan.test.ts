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
    expect(summarizeStock(rows)).toMatchObject({ onHand: 10, available: 9 })
  })

  it('counts a bucket whose available figure never came back', () => {
    expect(summarizeStock([{ quantity_on_hand: 5 }])).toMatchObject({ onHand: 5, available: 0 })
  })

  it('names the location holding the most of it and counts the ones holding any', () => {
    const rows: InventoryBalanceRow[] = [
      { quantity_on_hand: '25.0000', location_id: 'a', location_code: 'A-01-01' },
      { quantity_on_hand: '35.0000', location_id: 'b', location_code: 'A-01-02' },
      { quantity_on_hand: '15.0000', location_id: 'c', location_code: 'PICK-01' },
    ]
    expect(summarizeStock(rows)).toMatchObject({
      primaryLocation: { code: 'A-01-02', onHand: 35 },
      locationCount: 3,
    })
  })

  it('leaves a location holding none of it out of the count', () => {
    const rows: InventoryBalanceRow[] = [
      { quantity_on_hand: '12.0000', location_id: 'a', location_code: 'A-01-01' },
      { quantity_on_hand: '0.0000', location_id: 'b', location_code: 'STG-RECV' },
    ]
    expect(summarizeStock(rows)).toMatchObject({
      primaryLocation: { code: 'A-01-01', onHand: 12 },
      locationCount: 1,
    })
  })

  it('reads one location split across lots as the one shelf it is', () => {
    const rows: InventoryBalanceRow[] = [
      { quantity_on_hand: '6.0000', location_id: 'a', location_code: 'A-01-01', lot_id: 'lot-1' },
      { quantity_on_hand: '6.0000', location_id: 'a', location_code: 'A-01-01', lot_id: 'lot-2' },
      { quantity_on_hand: '9.0000', location_id: 'b', location_code: 'PICK-01' },
    ]
    expect(summarizeStock(rows)).toMatchObject({
      primaryLocation: { code: 'A-01-01', onHand: 12 },
      locationCount: 2,
    })
  })

  it('sends the warehouseman to the lower code when two hold the same amount', () => {
    const rows: InventoryBalanceRow[] = [
      { quantity_on_hand: '10.0000', location_id: 'b', location_code: 'B-02-01' },
      { quantity_on_hand: '10.0000', location_id: 'a', location_code: 'A-09-04' },
    ]
    expect(summarizeStock(rows).primaryLocation).toEqual({ code: 'A-09-04', onHand: 10 })
  })

  it('still reports the stock when the row names no location', () => {
    const rows: InventoryBalanceRow[] = [{ quantity_on_hand: '4.0000', quantity_available: 4 }]
    expect(summarizeStock(rows)).toMatchObject({
      onHand: 4,
      primaryLocation: { code: null, onHand: 4 },
      locationCount: 1,
    })
  })

  it('names no location for a product every shelf is out of', () => {
    const rows: InventoryBalanceRow[] = [
      { quantity_on_hand: '0.0000', location_id: 'a', location_code: 'A-01-01' },
    ]
    expect(summarizeStock(rows)).toMatchObject({ primaryLocation: null, locationCount: 0 })
  })
})

describe('formatStockQuantity', () => {
  it('keeps whole units whole and trims the numeric scale', () => {
    expect(formatStockQuantity(12)).toBe('12')
    expect(formatStockQuantity(2.5)).toBe('2.5')
  })
})
