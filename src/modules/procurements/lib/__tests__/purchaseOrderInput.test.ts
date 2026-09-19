import { describe, expect, it } from '@jest/globals'
import {
  normalizePrice,
  normalizeQuantity,
  parsePurchaseOrderWriteInput,
  type TranslateFn,
} from '../purchaseOrderInput'

/** Returns the key, so an assertion names the rule that fired rather than its English text. */
const translate: TranslateFn = (key) => key

const PRODUCT_A = '11111111-1111-4111-8111-111111111111'
const PRODUCT_B = '22222222-2222-4222-8222-222222222222'
const WAREHOUSE = '33333333-3333-4333-8333-333333333333'

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    documentNumber: 'ZZ/1/2026',
    orderDate: '2026-09-19',
    supplierName: 'Hurtownia Kowalski',
    warehouseId: WAREHOUSE,
    currencyCode: 'PLN',
    lines: [{ catalogProductId: PRODUCT_A, quantityOrdered: '2,5', unitPriceNet: '12,3456', unit: 'szt.' }],
    ...overrides,
  }
}

describe('normalizeQuantity', () => {
  it('accepts a decimal comma and canonicalises to the storage scale', () => {
    expect(normalizeQuantity('2,5')).toBe('2.5000')
    expect(normalizeQuantity('0007')).toBe('7.0000')
  })

  it('refuses zero, negatives, exponents and over-precise values', () => {
    expect(normalizeQuantity('0')).toBeNull()
    expect(normalizeQuantity('-1')).toBeNull()
    expect(normalizeQuantity('1e3')).toBeNull()
    expect(normalizeQuantity('1.00001')).toBeNull()
  })

  it('takes a JSON number only when it is a safe whole count', () => {
    expect(normalizeQuantity(4)).toBe('4.0000')
    expect(normalizeQuantity(2.5)).toBeNull()
    expect(normalizeQuantity(Number.MAX_SAFE_INTEGER + 2)).toBeNull()
  })
})

describe('normalizePrice', () => {
  it('allows zero, because a free-of-charge line is still a line', () => {
    expect(normalizePrice('0')).toBe('0.0000')
    expect(normalizePrice(0)).toBe('0.0000')
  })

  it('refuses a negative price', () => {
    expect(normalizePrice('-0.01')).toBeNull()
  })
})

describe('parsePurchaseOrderWriteInput', () => {
  it('accepts a complete order and canonicalises its values', () => {
    const result = parsePurchaseOrderWriteInput(validBody(), translate)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.currencyCode).toBe('PLN')
    expect(result.value.lines).toEqual([
      {
        catalogProductId: PRODUCT_A,
        quantityOrdered: '2.5000',
        unit: 'szt.',
        unitPriceNet: '12.3456',
        expectedDate: null,
      },
    ])
  })

  it('upper-cases the currency so pln and PLN are one currency', () => {
    const result = parsePurchaseOrderWriteInput(validBody({ currencyCode: 'pln' }), translate)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.currencyCode).toBe('PLN')
  })

  it('lets a line without its own date follow the header', () => {
    const result = parsePurchaseOrderWriteInput(
      validBody({
        expectedDate: '2026-10-01',
        lines: [
          { catalogProductId: PRODUCT_A, quantityOrdered: '1', unitPriceNet: '1' },
          { catalogProductId: PRODUCT_B, quantityOrdered: '1', unitPriceNet: '1', expectedDate: '2026-11-02' },
        ],
      }),
      translate,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lines.map((line) => line.expectedDate)).toEqual(['2026-10-01', '2026-11-02'])
  })

  it('refuses a delivery expected before the order was placed', () => {
    const result = parsePurchaseOrderWriteInput(validBody({ expectedDate: '2026-09-18' }), translate)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields.expectedDate).toBe('procurements.purchaseOrders.errors.expectedDateBeforeOrderDate')
  })

  it('refuses a date that is not a real calendar day', () => {
    const result = parsePurchaseOrderWriteInput(validBody({ orderDate: '2026-02-31' }), translate)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields.orderDate).toBe('procurements.purchaseOrders.errors.orderDateInvalid')
  })

  it('does not truncate a padded date into a valid one', () => {
    const result = parsePurchaseOrderWriteInput(validBody({ orderDate: '2026-09-19junk' }), translate)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields.orderDate).toBe('procurements.purchaseOrders.errors.orderDateInvalid')
  })

  it('reports every failing header field at once, keyed by the form field id', () => {
    const result = parsePurchaseOrderWriteInput(
      { documentNumber: '', orderDate: '', supplierName: '', warehouseId: 'nope', currencyCode: 'PLNX', lines: [] },
      translate,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.fields).sort()).toEqual([
      'currencyCode',
      'documentNumber',
      'lines',
      'orderDate',
      'supplierName',
      'warehouseId',
    ])
  })

  it('names the position of the first bad line', () => {
    const result = parsePurchaseOrderWriteInput(
      validBody({
        lines: [
          { catalogProductId: PRODUCT_A, quantityOrdered: '1', unitPriceNet: '1' },
          { catalogProductId: PRODUCT_B, quantityOrdered: '0', unitPriceNet: '1' },
        ],
      }),
      translate,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields.lines).toBe('procurements.purchaseOrders.errors.lineQuantityInvalid')
  })

  it('refuses a negative price rather than storing a credit as a purchase', () => {
    const result = parsePurchaseOrderWriteInput(
      validBody({ lines: [{ catalogProductId: PRODUCT_A, quantityOrdered: '1', unitPriceNet: '-5' }] }),
      translate,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields.lines).toBe('procurements.purchaseOrders.errors.linePriceInvalid')
  })

  it('drops a blank note to null so clearing it is not stored as an empty string', () => {
    const result = parsePurchaseOrderWriteInput(validBody({ notes: '   ' }), translate)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.notes).toBeNull()
  })

  it('accepts an order dated in the future, which is how a call-off is written', () => {
    const result = parsePurchaseOrderWriteInput(
      validBody({ orderDate: '2099-01-01', expectedDate: '2099-02-01' }),
      translate,
    )
    expect(result.ok).toBe(true)
  })
})
