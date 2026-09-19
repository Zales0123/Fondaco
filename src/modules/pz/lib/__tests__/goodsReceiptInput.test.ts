import { describe, expect, it } from '@jest/globals'
import {
  isCalendarDay,
  normalizeQuantity,
  parseGoodsReceiptWriteInput,
} from '../goodsReceiptInput'

// The translator is injected, so the tests assert on which field was rejected rather than
// on copy that belongs to the locale files.
const translate = (key: string, _fallback?: string, params?: Record<string, string | number>) =>
  params ? `${key}:${Object.values(params).join(',')}` : key

const TODAY = '2026-09-19'
const PRODUCT = '33333333-3333-4333-8333-333333333333'
const WAREHOUSE = '22222222-2222-4222-8222-222222222222'

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    documentNumber: 'PZ/1/2026',
    documentDate: '2026-09-18',
    supplierName: 'Hurtownia Kowalski',
    warehouseId: WAREHOUSE,
    lines: [{ catalogProductId: PRODUCT, quantity: '2.5', unit: 'szt' }],
    ...overrides,
  }
}

function parse(payload: Record<string, unknown>) {
  return parseGoodsReceiptWriteInput(payload, translate, { today: TODAY })
}

describe('normalizeQuantity', () => {
  it('accepts fractional quantities and stores them at the column precision', () => {
    expect(normalizeQuantity('2.5')).toBe('2.5000')
    expect(normalizeQuantity('0.125')).toBe('0.1250')
  })

  it('accepts a decimal comma, because that is what a Polish keyboard produces', () => {
    expect(normalizeQuantity('1,25')).toBe('1.2500')
  })

  it('rejects zero, negatives and non-numbers', () => {
    expect(normalizeQuantity('0')).toBeNull()
    expect(normalizeQuantity(0)).toBeNull()
    expect(normalizeQuantity('-1')).toBeNull()
    expect(normalizeQuantity('')).toBeNull()
    expect(normalizeQuantity('abc')).toBeNull()
    expect(normalizeQuantity(null)).toBeNull()
  })

  it('rejects more precision than the column keeps rather than rounding it away silently', () => {
    expect(normalizeQuantity('1.00001')).toBeNull()
  })

  it('rejects a value wider than the column, instead of letting Postgres refuse it', () => {
    expect(normalizeQuantity('9'.repeat(15))).toBeNull()
    expect(normalizeQuantity(`0000${'9'.repeat(14)}`)).toBe(`${'9'.repeat(14)}.0000`)
  })

  it('carries a wide decimal through exactly, because a float would change what arrived', () => {
    expect(normalizeQuantity('12345678901234.5678')).toBe('12345678901234.5678')
    expect(normalizeQuantity('99999999999999.9999')).toBe('99999999999999.9999')
  })

  it('takes a fractional quantity only as a string, because a JSON number cannot carry one', () => {
    // 900719925474.0002 and 900719925474.0003 are the same IEEE-754 value, so neither is
    // a quantity a document can be trusted to have recorded.
    expect(900719925474.0002).toBe(900719925474.0003)
    expect(normalizeQuantity(900719925474.0002)).toBeNull()
    expect(normalizeQuantity(12345678901234.5678)).toBeNull()
    expect(normalizeQuantity(2.5)).toBeNull()
    expect(normalizeQuantity('2.5')).toBe('2.5000')
  })

  it('accepts a whole count as a number, where nothing can be lost', () => {
    expect(normalizeQuantity(7)).toBe('7.0000')
    expect(normalizeQuantity(Number.MAX_SAFE_INTEGER + 2)).toBeNull()
  })

  it('refuses exponent notation, which is never what a delivery note says', () => {
    expect(normalizeQuantity('1e5')).toBeNull()
    expect(normalizeQuantity('1E5')).toBeNull()
  })

  it('accepts a decimal quantity written with a comma', () => {
    expect(normalizeQuantity('0,125')).toBe('0.1250')
  })

  it('treats an all-zero value as no quantity at all', () => {
    expect(normalizeQuantity('0.0000')).toBeNull()
    expect(normalizeQuantity('000')).toBeNull()
  })

  it('accepts a bare fractional value', () => {
    expect(normalizeQuantity('.5')).toBe('0.5000')
  })
})

describe('isCalendarDay', () => {
  it('rejects a day that does not exist', () => {
    expect(isCalendarDay('2026-02-31')).toBe(false)
    expect(isCalendarDay('2026-02-28')).toBe(true)
  })
})

describe('parseGoodsReceiptWriteInput', () => {
  it('accepts a complete goods receipt', () => {
    const result = parse(validPayload())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      documentNumber: 'PZ/1/2026',
      documentDate: '2026-09-18',
      supplierName: 'Hurtownia Kowalski',
      warehouseId: WAREHOUSE,
      lines: [
        {
          catalogProductId: PRODUCT,
          quantity: '2.5000',
          unit: 'szt',
          // A delivery that names no purchase order is an ordinary document, not an
          // incomplete one: samples and warranty replacements arrive without an order.
          purchaseOrderId: null,
          purchaseOrderLineId: null,
        },
      ],
    })
  })

  it('trims the document number and the supplier, so a stray keystroke is not a new record', () => {
    const result = parse(validPayload({ documentNumber: '  PZ/2/2026  ', supplierName: '  Kowalski  ' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.documentNumber).toBe('PZ/2/2026')
    expect(result.value.supplierName).toBe('Kowalski')
  })

  it('accepts today and any past day', () => {
    expect(parse(validPayload({ documentDate: TODAY })).ok).toBe(true)
    expect(parse(validPayload({ documentDate: '2019-01-01' })).ok).toBe(true)
  })

  it('rejects a document date that only starts like one', () => {
    const result = parse(validPayload({ documentDate: '2026-09-18junk' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.fields)).toEqual(['documentDate'])
  })

  it('rejects a unit longer than the column instead of truncating what the user typed', () => {
    const result = parse(validPayload({ lines: [{ catalogProductId: PRODUCT, quantity: '1', unit: 'x'.repeat(51) }] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields.lines).toBeTruthy()
  })

  it('rejects a future document date', () => {
    const result = parse(validPayload({ documentDate: '2026-09-20' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.fields)).toEqual(['documentDate'])
  })

  it('rejects an empty document number, supplier and warehouse', () => {
    const result = parse(validPayload({ documentNumber: '   ', supplierName: '  ', warehouseId: '' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.fields).sort()).toEqual(['documentNumber', 'supplierName', 'warehouseId'])
  })

  it('rejects a goods receipt with no lines', () => {
    const result = parse(validPayload({ lines: [] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields.lines).toBeTruthy()
  })

  it('rejects a line whose quantity is zero', () => {
    const result = parse(validPayload({ lines: [{ catalogProductId: PRODUCT, quantity: '0' }] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields.lines).toContain('1')
  })

  it('allows the same product on two lines, because a split delivery is one delivery', () => {
    const result = parse(
      validPayload({
        lines: [
          { catalogProductId: PRODUCT, quantity: '1' },
          { catalogProductId: PRODUCT, quantity: '3' },
        ],
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lines).toHaveLength(2)
  })

  it('treats a blank unit as absent so the product default can fill it in', () => {
    const result = parse(validPayload({ lines: [{ catalogProductId: PRODUCT, quantity: '1', unit: '   ' }] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lines[0].unit).toBeNull()
  })
})

describe('parseGoodsReceiptWriteInput purchase order reference', () => {
  const ORDER = '44444444-4444-4444-8444-444444444444'
  const ORDER_LINE = '55555555-5555-4555-8555-555555555555'

  function withReference(reference: Record<string, unknown>) {
    return validPayload({
      lines: [{ catalogProductId: PRODUCT, quantity: '2.5', unit: 'szt', ...reference }],
    })
  }

  it('keeps both halves of a complete reference', () => {
    const result = parse(withReference({ purchaseOrderId: ORDER, purchaseOrderLineId: ORDER_LINE }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lines[0]).toMatchObject({
      purchaseOrderId: ORDER,
      purchaseOrderLineId: ORDER_LINE,
    })
  })

  it('accepts a line with no reference at all', () => {
    expect(parse(withReference({})).ok).toBe(true)
    expect(parse(withReference({ purchaseOrderId: '', purchaseOrderLineId: '' })).ok).toBe(true)
  })

  it('refuses an order without the position it settles', () => {
    // A reference naming only the order could not say which of its lines was delivered,
    // and the same product legitimately sits on two lines at different prices.
    const result = parse(withReference({ purchaseOrderId: ORDER }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields.lines).toContain('linePurchaseOrderInvalid')
  })

  it('refuses a position without its order', () => {
    const result = parse(withReference({ purchaseOrderLineId: ORDER_LINE }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields.lines).toContain('linePurchaseOrderInvalid')
  })

  it('refuses a reference that is not a pair of identifiers', () => {
    const result = parse(withReference({ purchaseOrderId: 'ZZ/1/2026', purchaseOrderLineId: '1' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fields.lines).toContain('linePurchaseOrderInvalid')
  })
})
