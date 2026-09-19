import { describe, expect, it } from '@jest/globals'
import { buildFixtureReceipts, FIXTURE_DOCUMENT_PREFIX } from '../lib/receipts'

const WAREHOUSES = [{ id: 'wh-1' }, { id: 'wh-2' }, { id: 'wh-3' }]
const PRODUCTS = [{ id: 'p-1' }, { id: 'p-2' }]
const TODAY = new Date('2026-09-19T10:00:00.000Z')

describe('buildFixtureReceipts', () => {
  it('keeps every document out of the real series', () => {
    for (const receipt of buildFixtureReceipts(WAREHOUSES, PRODUCTS, { today: TODAY })) {
      expect(receipt.documentNumber.startsWith(FIXTURE_DOCUMENT_PREFIX)).toBe(true)
    }
  })

  it('numbers documents uniquely', () => {
    const numbers = buildFixtureReceipts(WAREHOUSES, PRODUCTS, { today: TODAY }).map((r) => r.documentNumber)
    expect(new Set(numbers).size).toBe(numbers.length)
  })

  it('never dates a document in the future', () => {
    const latest = TODAY.toISOString().slice(0, 10)
    for (const receipt of buildFixtureReceipts(WAREHOUSES, PRODUCTS, { today: TODAY })) {
      expect(receipt.documentDate <= latest).toBe(true)
    }
  })

  it('is deterministic, so two runs describe the same documents', () => {
    expect(buildFixtureReceipts(WAREHOUSES, PRODUCTS, { today: TODAY }))
      .toEqual(buildFixtureReceipts(WAREHOUSES, PRODUCTS, { today: TODAY }))
  })

  it('never repeats a product within one document', () => {
    for (const receipt of buildFixtureReceipts(WAREHOUSES, PRODUCTS, { today: TODAY })) {
      const ids = receipt.lines.map((line) => line.catalogProductId)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('still produces single-line documents when the catalog has one stockable product', () => {
    const receipts = buildFixtureReceipts(WAREHOUSES, [{ id: 'only' }], { today: TODAY })
    expect(receipts.length).toBeGreaterThan(0)
    for (const receipt of receipts) {
      expect(receipt.lines).toHaveLength(1)
      expect(receipt.lines[0].catalogProductId).toBe('only')
    }
  })

  it('spreads documents across every available warehouse', () => {
    const used = new Set(buildFixtureReceipts(WAREHOUSES, PRODUCTS, { today: TODAY }).map((r) => r.warehouseId))
    expect(used).toEqual(new Set(['wh-1', 'wh-2', 'wh-3']))
  })

  it('includes fractional quantities, which the numeric column and the UI must handle', () => {
    const quantities = buildFixtureReceipts(WAREHOUSES, PRODUCTS, { today: TODAY })
      .flatMap((receipt) => receipt.lines.map((line) => line.quantity))
    expect(quantities.some((quantity) => quantity.includes('.'))).toBe(true)
  })

  it('returns nothing when there is no warehouse or no product to point at', () => {
    expect(buildFixtureReceipts([], PRODUCTS, { today: TODAY })).toEqual([])
    expect(buildFixtureReceipts(WAREHOUSES, [], { today: TODAY })).toEqual([])
  })
})
