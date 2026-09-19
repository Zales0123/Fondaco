/**
 * These EANs are transcribed from packaging, so the only thing standing between
 * a typo and a variant nobody can scan is the check digit. The oracle is the
 * installed catalog module's own validator — the same function
 * `catalog.variants.create` runs on the way in.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'
import { isValidGtin, normalizeGtinValue } from '@open-mercato/core/modules/catalog/lib/gtin'
import { BEVERAGE_PRODUCTS, FIXTURE_MEDIA_ROOT } from '../lib/products'

describe('BEVERAGE_PRODUCTS', () => {
  it.each(BEVERAGE_PRODUCTS.map((fixture) => [fixture.handle, fixture] as const))(
    '%s carries a valid EAN-13',
    (_handle, fixture) => {
      expect(fixture.barcode).toMatch(/^[0-9]{13}$/)
      expect(isValidGtin('ean13', normalizeGtinValue('ean13', fixture.barcode))).toBe(true)
    },
  )

  it.each(BEVERAGE_PRODUCTS.map((fixture) => [fixture.handle, fixture] as const))(
    '%s ships its packaging photo',
    (_handle, fixture) => {
      expect(existsSync(path.join(FIXTURE_MEDIA_ROOT, fixture.image))).toBe(true)
    },
  )

  it('keeps handles, SKUs and barcodes unique', () => {
    const unique = (values: string[]) => new Set(values).size
    expect(unique(BEVERAGE_PRODUCTS.map((f) => f.handle))).toBe(BEVERAGE_PRODUCTS.length)
    expect(unique(BEVERAGE_PRODUCTS.map((f) => f.sku))).toBe(BEVERAGE_PRODUCTS.length)
    expect(unique(BEVERAGE_PRODUCTS.map((f) => f.barcode))).toBe(BEVERAGE_PRODUCTS.length)
  })

  it('uses handles the catalog handle validator accepts', () => {
    for (const fixture of BEVERAGE_PRODUCTS) {
      expect(fixture.handle).toMatch(/^[a-z0-9\-_]{1,150}$/)
      expect(fixture.sku).toMatch(/^[A-Za-z0-9\-_.]{1,191}$/)
    }
  })
})
