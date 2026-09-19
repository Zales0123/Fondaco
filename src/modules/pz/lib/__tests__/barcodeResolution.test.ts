import { describe, expect, it } from '@jest/globals'
import {
  normalizeBarcode,
  resolveVariantByBarcode,
  toCountedVariant,
  type CountedVariant,
  type VariantBarcodeLookup,
} from '../barcodeResolution'

const VARIANT = '44444444-4444-4444-8444-444444444444'
const PRODUCT = '55555555-5555-4555-8555-555555555555'

function variant(overrides: Partial<CountedVariant> = {}): CountedVariant {
  return {
    catalogVariantId: VARIANT,
    catalogProductId: PRODUCT,
    name: 'Kabel USB-C 2m',
    sku: '4411',
    barcode: '5901234123457',
    quantityMultiplier: 1,
    ...overrides,
  }
}

function lookupReturning(...variants: CountedVariant[]): VariantBarcodeLookup {
  return async () => variants
}

describe('normalizeBarcode', () => {
  it('keeps a clean code unchanged', () => {
    expect(normalizeBarcode('5901234123457')).toBe('5901234123457')
  })

  it('drops the padding and the terminator a scanner appends', () => {
    expect(normalizeBarcode('  5901234123457\r\n')).toBe('5901234123457')
  })

  it('drops control characters a wrapped scan puts inside the code', () => {
    expect(normalizeBarcode('5901234\t123457')).toBe('5901234123457')
  })

  it('rejects an empty or whitespace-only code', () => {
    expect(normalizeBarcode('')).toBeNull()
    expect(normalizeBarcode('   \r\n')).toBeNull()
  })

  it('rejects anything that is not text', () => {
    expect(normalizeBarcode(undefined)).toBeNull()
    expect(normalizeBarcode(5901234123457)).toBeNull()
  })
})

describe('resolveVariantByBarcode', () => {
  it('refuses an empty barcode without reading the catalog', async () => {
    let called = false
    const resolution = await resolveVariantByBarcode('  ', async () => {
      called = true
      return []
    })
    expect(resolution).toEqual({ kind: 'barcode-required' })
    expect(called).toBe(false)
  })

  it('resolves an exact match and reports the normalized code', async () => {
    const seen: string[] = []
    const resolution = await resolveVariantByBarcode(' 5901234123457\r', async (barcode) => {
      seen.push(barcode)
      return [variant()]
    })
    expect(seen).toEqual(['5901234123457'])
    expect(resolution).toEqual({ kind: 'resolved', variant: variant() })
  })

  it('reports an unrecognised code as unknown, carrying the code the client scanned', async () => {
    const resolution = await resolveVariantByBarcode('0000000000000', lookupReturning())
    expect(resolution).toEqual({ kind: 'unknown', barcode: '0000000000000' })
  })

  it('reports a barcode shared by two variants as unknown, so the picker resolves it', async () => {
    const resolution = await resolveVariantByBarcode(
      '5901234123457',
      lookupReturning(variant(), variant({ catalogVariantId: PRODUCT })),
    )
    expect(resolution).toEqual({ kind: 'unknown', barcode: '5901234123457' })
  })
})

describe('toCountedVariant', () => {
  const row = { id: VARIANT, product_id: PRODUCT, name: null, sku: '4411', barcode: '5901234123457' }

  it('prefers the variant name', () => {
    expect(toCountedVariant({ ...row, name: 'Kabel USB-C 2m' }, 'Kabel USB-C', '5901234123457').name).toBe(
      'Kabel USB-C 2m',
    )
  })

  it('falls back to the product title when the variant is unnamed', () => {
    expect(toCountedVariant(row, 'Kabel USB-C', '5901234123457').name).toBe('Kabel USB-C')
  })

  it('falls back to the SKU rather than leaving a row nameless', () => {
    expect(toCountedVariant(row, '  ', '5901234123457').name).toBe('4411')
  })

  it('echoes the scanned code when the stored barcode is absent', () => {
    expect(toCountedVariant({ ...row, barcode: null }, null, '5901234123457').barcode).toBe('5901234123457')
  })

  // Issue #35: a bulk (carton) barcode carries a base-unit multiplier.
  it('reports a multiplier of 1 for an ordinary piece barcode match', () => {
    expect(toCountedVariant(row, null, '5901234123457').quantityMultiplier).toBe(1)
  })

  it('reports the bulk quantity when the scan matches the bulk barcode', () => {
    const bulkRow = { ...row, barcode: '5901234123457', 'cf:bulk_barcode': '9999999999999', 'cf:bulk_quantity': 24 }
    expect(toCountedVariant(bulkRow, null, '9999999999999').quantityMultiplier).toBe(24)
  })

  it('prefers the piece barcode when a code matches both fields on the same row', () => {
    const clashingRow = { ...row, barcode: '5901234123457', 'cf:bulk_barcode': '5901234123457', 'cf:bulk_quantity': 24 }
    expect(toCountedVariant(clashingRow, null, '5901234123457').quantityMultiplier).toBe(1)
  })

  it('falls back to a multiplier of 1 when the bulk quantity is missing or not a positive integer', () => {
    const noQuantity = { ...row, barcode: 'other', 'cf:bulk_barcode': '9999999999999', 'cf:bulk_quantity': null }
    expect(toCountedVariant(noQuantity, null, '9999999999999').quantityMultiplier).toBe(1)

    const zeroQuantity = { ...row, barcode: 'other', 'cf:bulk_barcode': '9999999999999', 'cf:bulk_quantity': 0 }
    expect(toCountedVariant(zeroQuantity, null, '9999999999999').quantityMultiplier).toBe(1)
  })
})
