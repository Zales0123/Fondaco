import { describe, expect, it } from '@jest/globals'
import {
  compareDecimal,
  isPositiveDecimal,
  lineNetValue,
  multiplyDecimal,
  orderNetValue,
  subtractDecimal,
  sumDecimals,
} from '../decimal'

describe('multiplyDecimal', () => {
  it('multiplies without floating-point drift', () => {
    // 0.1 * 3 is 0.30000000000000004 in IEEE-754; on a document it is 0.30.
    expect(multiplyDecimal('0.1', '3')).toBe('0.30')
    expect(multiplyDecimal('1.15', '3')).toBe('3.45')
  })

  it('rounds half away from zero at the requested scale', () => {
    expect(multiplyDecimal('1', '0.005')).toBe('0.01')
    expect(multiplyDecimal('1', '0.004')).toBe('0.00')
    expect(multiplyDecimal('-1', '0.005')).toBe('-0.01')
  })

  it('keeps precision a JavaScript number would lose', () => {
    expect(multiplyDecimal('1', '900719925474.0002', 4)).toBe('900719925474.0002')
    expect(multiplyDecimal('1', '900719925474.0003', 4)).toBe('900719925474.0003')
  })

  it('returns null for values that are not decimals', () => {
    expect(multiplyDecimal('', '2')).toBeNull()
    expect(multiplyDecimal('2', 'abc')).toBeNull()
    expect(multiplyDecimal('1e3', '2')).toBeNull()
  })
})

describe('sumDecimals', () => {
  it('adds at a fixed scale', () => {
    expect(sumDecimals(['0.10', '0.20', '0.30'])).toBe('0.60')
  })

  it('reports an unreadable entry rather than skipping it', () => {
    expect(sumDecimals(['1.00', 'oops'])).toBeNull()
  })

  it('is zero for an empty list', () => {
    expect(sumDecimals([])).toBe('0.00')
  })
})

describe('orderNetValue', () => {
  it('sums the values printed beside each line, not the raw products', () => {
    // Each line rounds to 0.01, so the order is 0.03 — a single rounding of the raw
    // products (3 × 0.005 = 0.015) would say 0.02 and disagree with what is on screen.
    const lines = [
      { quantityOrdered: '1.0000', unitPriceNet: '0.0050' },
      { quantityOrdered: '1.0000', unitPriceNet: '0.0050' },
      { quantityOrdered: '1.0000', unitPriceNet: '0.0050' },
    ]
    expect(lines.map((line) => lineNetValue(line.quantityOrdered, line.unitPriceNet))).toEqual([
      '0.01',
      '0.01',
      '0.01',
    ])
    expect(orderNetValue(lines)).toBe('0.03')
  })

  it('computes a realistic order total exactly', () => {
    expect(
      orderNetValue([
        { quantityOrdered: '12.5000', unitPriceNet: '3.3300' },
        { quantityOrdered: '2.0000', unitPriceNet: '19.9900' },
      ]),
    ).toBe('81.61')
  })

  it('refuses a total when one line cannot be read', () => {
    expect(
      orderNetValue([
        { quantityOrdered: '1.0000', unitPriceNet: '1.0000' },
        { quantityOrdered: 'NaN', unitPriceNet: '1.0000' },
      ]),
    ).toBeNull()
  })
})

describe('subtractDecimal', () => {
  it('subtracts at quantity scale without drift', () => {
    expect(subtractDecimal('100', '60')).toBe('40.0000')
    expect(subtractDecimal('0.3', '0.1')).toBe('0.2000')
  })

  it('returns a negative result rather than clamping it', () => {
    // The caller decides what "less than nothing" means; hiding it here would turn a ledger
    // inconsistency into a plausible-looking zero.
    expect(subtractDecimal('100', '140')).toBe('-40.0000')
  })

  it('is null when either side is not a number', () => {
    expect(subtractDecimal('abc', '1')).toBeNull()
    expect(subtractDecimal('1', '')).toBeNull()
  })
})

describe('compareDecimal', () => {
  it('orders values regardless of how many places they are written to', () => {
    expect(compareDecimal('40', '40.0000')).toBe(0)
    expect(compareDecimal('40.0001', '40')).toBe(1)
    expect(compareDecimal('39.9999', '40')).toBe(-1)
  })

  it('is null when either side is unreadable', () => {
    expect(compareDecimal('x', '1')).toBeNull()
  })
})

describe('isPositiveDecimal', () => {
  it('accepts only a readable quantity above zero', () => {
    expect(isPositiveDecimal('0.0001')).toBe(true)
    expect(isPositiveDecimal('0')).toBe(false)
    expect(isPositiveDecimal('-1')).toBe(false)
    expect(isPositiveDecimal('nope')).toBe(false)
  })
})
