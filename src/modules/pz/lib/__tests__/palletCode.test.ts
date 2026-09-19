import { describe, expect, it } from '@jest/globals'
import {
  formatPalletCode,
  nextPalletCode,
  normalizePalletCode,
  parsePalletCode,
} from '../palletCode'

describe('formatPalletCode', () => {
  it('pads the sequence to six digits', () => {
    expect(formatPalletCode(1)).toBe('PAL-000001')
    expect(formatPalletCode(42)).toBe('PAL-000042')
    expect(formatPalletCode(999999)).toBe('PAL-999999')
  })

  it('keeps counting past the padding rather than wrapping', () => {
    expect(formatPalletCode(1000000)).toBe('PAL-1000000')
  })

  it('refuses a sequence that is not a positive integer', () => {
    expect(() => formatPalletCode(0)).toThrow()
    expect(() => formatPalletCode(-1)).toThrow()
    expect(() => formatPalletCode(1.5)).toThrow()
  })
})

describe('parsePalletCode', () => {
  it('reads the sequence back out of a generated code', () => {
    expect(parsePalletCode('PAL-000042')).toBe(42)
    expect(parsePalletCode('PAL-1000000')).toBe(1000000)
  })

  it('accepts the casing and padding a scanner may send', () => {
    expect(parsePalletCode('  pal-000042  ')).toBe(42)
  })

  it('returns null for anything this generator did not mint', () => {
    expect(parsePalletCode('')).toBeNull()
    expect(parsePalletCode('PAL-')).toBeNull()
    expect(parsePalletCode('PAL-000000')).toBeNull()
    expect(parsePalletCode('PALLET-1')).toBeNull()
    expect(parsePalletCode('paleta 2')).toBeNull()
  })
})

describe('nextPalletCode', () => {
  it('starts an organization at the first code', () => {
    expect(nextPalletCode(null)).toBe('PAL-000001')
    expect(nextPalletCode(undefined)).toBe('PAL-000001')
  })

  it('continues from the highest code the organization holds', () => {
    expect(nextPalletCode('PAL-000041')).toBe('PAL-000042')
    expect(nextPalletCode('PAL-999999')).toBe('PAL-1000000')
  })

  it('ignores a code it could not have generated instead of skipping a range', () => {
    expect(nextPalletCode('paleta 2')).toBe('PAL-000001')
  })
})

describe('normalizePalletCode', () => {
  it('trims what the scanner sent', () => {
    expect(normalizePalletCode(' PAL-000042\n')).toBe('PAL-000042')
  })

  it('reports an empty or non-textual scan as nothing to look up', () => {
    expect(normalizePalletCode('   ')).toBeNull()
    expect(normalizePalletCode(undefined)).toBeNull()
    expect(normalizePalletCode(42)).toBeNull()
  })
})
