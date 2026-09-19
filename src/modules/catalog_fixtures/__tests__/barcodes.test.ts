/**
 * The oracle here is the installed catalog module's own validator: a fixture
 * barcode is correct exactly when `isValidGtin` accepts it, because that is the
 * same function `catalog.variants.update` runs on the way in.
 */
import { describe, expect, it } from '@jest/globals'
import { isValidGtin, normalizeGtinValue } from '@open-mercato/core/modules/catalog/lib/gtin'
import {
  allocateFixtureEan13,
  buildFixtureEan13,
  FIXTURE_GTIN_PREFIX,
  FIXTURE_GTIN_TYPE,
} from '../lib/barcodes'

const SEEDS = [
  'ATLAS-RUN-NAVY-8',
  'ATLAS-RUN-GLACIER-10',
  'AURORA-CELESTIAL-L',
  'AURORA-ROSE-M',
  'a',
  '',
  'sku with spaces and ünicode',
]

describe('buildFixtureEan13', () => {
  it.each(SEEDS)('produces a GTIN the catalog validator accepts for %p', (seed) => {
    const value = buildFixtureEan13(seed)
    expect(value).toHaveLength(13)
    expect(value).toMatch(/^[0-9]{13}$/)
    expect(isValidGtin(FIXTURE_GTIN_TYPE, normalizeGtinValue(FIXTURE_GTIN_TYPE, value))).toBe(true)
  })

  it('stays inside the GS1 restricted-distribution range', () => {
    // 20-29 is reserved for internal numbering, so demo data can never collide
    // with a real product's GTIN.
    for (const seed of SEEDS) {
      expect(buildFixtureEan13(seed).startsWith(FIXTURE_GTIN_PREFIX)).toBe(true)
    }
  })

  it('is deterministic for the same seed', () => {
    expect(buildFixtureEan13('ATLAS-RUN-NAVY-8')).toBe(buildFixtureEan13('ATLAS-RUN-NAVY-8'))
  })

  it('differs between seeds', () => {
    const values = new Set(SEEDS.map((seed) => buildFixtureEan13(seed)))
    expect(values.size).toBe(SEEDS.length)
  })

  it('produces a different, still-valid value for each salt', () => {
    const a = buildFixtureEan13('same-sku', 0)
    const b = buildFixtureEan13('same-sku', 1)
    expect(a).not.toBe(b)
    expect(isValidGtin(FIXTURE_GTIN_TYPE, b)).toBe(true)
  })
})

describe('allocateFixtureEan13', () => {
  it('returns the unsalted value when it is free', () => {
    expect(allocateFixtureEan13('ATLAS-RUN-NAVY-8', new Set())).toBe(
      buildFixtureEan13('ATLAS-RUN-NAVY-8'),
    )
  })

  it('skips a value already taken and still returns a valid GTIN', () => {
    const taken = new Set([buildFixtureEan13('ATLAS-RUN-NAVY-8')])
    const allocated = allocateFixtureEan13('ATLAS-RUN-NAVY-8', taken)
    expect(taken.has(allocated)).toBe(false)
    expect(isValidGtin(FIXTURE_GTIN_TYPE, allocated)).toBe(true)
  })
})
