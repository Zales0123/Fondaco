import { describe, expect, it } from '@jest/globals'
import {
  buildFixtureReceipts,
  FIXTURE_DOCUMENT_PREFIX,
  type FixtureProduct,
  type FixtureReceipt,
  type FixtureWarehouse,
} from '../lib/receipts'

/** Every warehouse can be posted into, which is what a seeded demo environment looks like. */
const WAREHOUSES: FixtureWarehouse[] = [
  { id: 'wh-1', hasEligibleDestination: true },
  { id: 'wh-2', hasEligibleDestination: true },
  { id: 'wh-3', hasEligibleDestination: true },
]
const PRODUCTS: FixtureProduct[] = [{ id: 'p-1' }, { id: 'p-2' }]
/** The shape the real catalog has: untracked products and one `wms` tracks by lot. */
const MIXED_CATALOG: FixtureProduct[] = [
  { id: 'untracked-1' },
  { id: 'tracked-1', tracked: true },
  { id: 'untracked-2' },
]
const TODAY = new Date('2026-09-19T10:00:00.000Z')

const postable = (receipts: FixtureReceipt[]) => receipts.filter((receipt) => receipt.intent === 'postable')
const lotBlocked = (receipts: FixtureReceipt[]) => receipts.filter((receipt) => receipt.intent === 'lotBlocked')

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
    expect(buildFixtureReceipts(WAREHOUSES, MIXED_CATALOG, { today: TODAY }))
      .toEqual(buildFixtureReceipts(WAREHOUSES, MIXED_CATALOG, { today: TODAY }))
  })

  it('never repeats a product within one document', () => {
    for (const receipt of buildFixtureReceipts(WAREHOUSES, MIXED_CATALOG, { today: TODAY })) {
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

describe('buildFixtureReceipts — demonstrating both confirmation outcomes', () => {
  const receipts = buildFixtureReceipts(WAREHOUSES, MIXED_CATALOG, { today: TODAY })
  const trackedIds = new Set(MIXED_CATALOG.filter((product) => product.tracked).map((product) => product.id))

  it('produces at least one postable and one lot-blocked document', () => {
    expect(postable(receipts).length).toBeGreaterThan(0)
    expect(lotBlocked(receipts).length).toBeGreaterThan(0)
    for (const receipt of [...postable(receipts), ...lotBlocked(receipts)]) {
      expect(receipt.intentSatisfied).toBe(true)
    }
  })

  it('keeps every tracked product off a postable document', () => {
    for (const receipt of postable(receipts)) {
      expect(receipt.lines.length).toBeGreaterThan(0)
      for (const line of receipt.lines) expect(trackedIds.has(line.catalogProductId)).toBe(false)
    }
  })

  it('puts a tracked product on the lot-blocked document, so the refusal is visible', () => {
    for (const receipt of lotBlocked(receipts)) {
      expect(receipt.lines.some((line) => trackedIds.has(line.catalogProductId))).toBe(true)
    }
  })

  it('places both demonstrations in the first three documents, which `--release 3` reaches', () => {
    const guaranteed = receipts
      .map((receipt, index) => ({ index, intent: receipt.intent }))
      .filter((entry) => entry.intent !== 'mixed')
    expect(guaranteed.length).toBeGreaterThan(1)
    expect(guaranteed.every((entry) => entry.index < 3)).toBe(true)
  })

  it('reaches the last warehouse in the rotation, which is the demo warehouseman’s own', () => {
    expect(postable(receipts).map((receipt) => receipt.warehouseId)).toContain('wh-3')
  })
})

describe('buildFixtureReceipts — a postable document needs somewhere to post', () => {
  it('steps forward to a warehouse that has an eligible destination', () => {
    const receipts = buildFixtureReceipts(
      [
        { id: 'wh-1', hasEligibleDestination: false },
        { id: 'wh-2', hasEligibleDestination: true },
        { id: 'wh-3', hasEligibleDestination: false },
      ],
      MIXED_CATALOG,
      { today: TODAY },
    )
    for (const receipt of postable(receipts)) {
      expect(receipt.warehouseId).toBe('wh-2')
      expect(receipt.intentSatisfied).toBe(true)
    }
    // The rest of the series keeps the plain rotation: the fall-forward is not contagious.
    expect(receipts[1].warehouseId).toBe('wh-2')
    expect(receipts[3].warehouseId).toBe('wh-1')
  })

  it('still seeds the document when no warehouse can be posted into, and says so', () => {
    const receipts = buildFixtureReceipts([{ id: 'wh-1' }], MIXED_CATALOG, { today: TODAY })
    expect(receipts).toHaveLength(8)
    for (const receipt of postable(receipts)) expect(receipt.intentSatisfied).toBe(false)
    // The lot-blocked demonstration needs no destination at all, so it still holds.
    for (const receipt of lotBlocked(receipts)) expect(receipt.intentSatisfied).toBe(true)
  })
})

describe('buildFixtureReceipts — degrading on a catalog that cannot satisfy the plan', () => {
  it('reports rather than throws when nothing in the catalog is untracked', () => {
    const receipts = buildFixtureReceipts(WAREHOUSES, [{ id: 'tracked-1', tracked: true }], { today: TODAY })
    expect(receipts).toHaveLength(8)
    for (const receipt of postable(receipts)) {
      expect(receipt.intentSatisfied).toBe(false)
      expect(receipt.lines.length).toBeGreaterThan(0)
    }
  })

  it('reports rather than throws when nothing in the catalog is tracked', () => {
    const receipts = buildFixtureReceipts(WAREHOUSES, [{ id: 'untracked-1' }], { today: TODAY })
    for (const receipt of lotBlocked(receipts)) expect(receipt.intentSatisfied).toBe(false)
    for (const receipt of postable(receipts)) expect(receipt.intentSatisfied).toBe(true)
  })

  it('never builds a guaranteed document from a product pz could not resolve a line for', () => {
    const receipts = buildFixtureReceipts(
      WAREHOUSES,
      [
        { id: 'no-default-variant', receivable: false },
        { id: 'untracked-1' },
        { id: 'tracked-1', tracked: true },
      ],
      { today: TODAY },
    )
    for (const receipt of [...postable(receipts), ...lotBlocked(receipts)]) {
      expect(receipt.lines.some((line) => line.catalogProductId === 'no-default-variant')).toBe(false)
    }
  })

  it('treats an unreceivable tracked product as no tracked product at all', () => {
    const receipts = buildFixtureReceipts(
      WAREHOUSES,
      [{ id: 'untracked-1' }, { id: 'tracked-1', tracked: true, receivable: false }],
      { today: TODAY },
    )
    for (const receipt of lotBlocked(receipts)) expect(receipt.intentSatisfied).toBe(false)
  })
})
