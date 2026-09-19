/**
 * Decimal quantities as scaled integers.
 *
 * Every quantity in this module is a `numeric(18,4)` string from end to end: adding `0.1` to
 * `0.2` as floats turns a matching delivery into a difference of `0.0000000000000004`, and a
 * JSON number cannot carry the column faithfully. The comparison screen and the stock posting
 * both add quantities up, so the arithmetic lives here rather than twice.
 */

import { QUANTITY_SCALE } from './goodsReceiptInput'

const SCALE_FACTOR = 10n ** BigInt(QUANTITY_SCALE)
const DECIMAL = /^(-?)(\d*)(?:\.(\d*))?$/

export function toScaledQuantity(value: string): bigint {
  const match = DECIMAL.exec(value.trim())
  if (!match) return 0n
  const [, sign, integer = '', fraction = ''] = match
  const scaled =
    BigInt(integer || '0') * SCALE_FACTOR + BigInt(fraction.slice(0, QUANTITY_SCALE).padEnd(QUANTITY_SCALE, '0'))
  return sign === '-' ? -scaled : scaled
}

export function fromScaledQuantity(value: bigint): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(QUANTITY_SCALE + 1, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -QUANTITY_SCALE)}.${digits.slice(-QUANTITY_SCALE)}`
}

/**
 * The number `wms.inventory.receive` takes. Its schema is a positive JS number, so a stored
 * decimal string becomes one exactly once, here, and only at that boundary.
 */
export function quantityToNumber(value: string): number {
  return Number(fromScaledQuantity(toScaledQuantity(value)))
}
