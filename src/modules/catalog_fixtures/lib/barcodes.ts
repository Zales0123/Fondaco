import { createHash } from 'node:crypto'
import { computeGs1CheckDigit } from '@open-mercato/core/modules/catalog/lib/gtin'

/**
 * Deterministic EAN-13 generation for demo catalog data.
 *
 * The prefix matters: GS1 reserves the `20`-`29` range for restricted
 * distribution — in-store and internal numbering that is guaranteed never to be
 * issued to a real product. Fixture barcodes therefore cannot collide with a
 * genuine GTIN, and scanning one in the wild resolves to nothing.
 *
 * Values are derived from the variant SKU rather than its id, because ids are
 * regenerated every time the catalog seed runs while SKUs are stable. Re-running
 * the fixtures reproduces the same barcode for the same SKU.
 */
export const FIXTURE_GTIN_PREFIX = '20'
export const FIXTURE_GTIN_TYPE = 'ean13' as const

const EAN13_BODY_LENGTH = 12

/**
 * @param seed  stable identity of the variant, normally its SKU
 * @param salt  bumped by the caller only to resolve a collision
 */
export function buildFixtureEan13(seed: string, salt = 0): string {
  const hash = createHash('sha1').update(`${seed}:${salt}`).digest()
  const digitCount = EAN13_BODY_LENGTH - FIXTURE_GTIN_PREFIX.length

  let digits = ''
  for (let index = 0; digits.length < digitCount; index += 1) {
    digits += (hash[index % hash.length] % 10).toString()
  }

  const body = `${FIXTURE_GTIN_PREFIX}${digits}`
  return `${body}${computeGs1CheckDigit(body)}`
}

/**
 * Resolves a barcode for `seed` that is not already present in `taken`.
 *
 * A hash collision across a demo dataset is vanishingly unlikely, but the
 * variant table has a unique index on (tenant, org, gtin_type, barcode), so an
 * unhandled one would abort the whole run rather than skip a single row.
 */
export function allocateFixtureEan13(seed: string, taken: ReadonlySet<string>): string {
  for (let salt = 0; salt < 1000; salt += 1) {
    const candidate = buildFixtureEan13(seed, salt)
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(`Unable to allocate a unique fixture barcode for "${seed}"`)
}
