/**
 * Decimal arithmetic for order values, done on integers rather than floats.
 *
 * A purchase order's line value is a quantity times a unit price, and both are stored as
 * `numeric(18,4)`. Multiplying them as JavaScript numbers would make `0.1 * 3` print
 * `0.30000000000000004` on a document someone reconciles against a supplier invoice, so
 * everything here is `BigInt` on scaled integers and the inputs and outputs stay strings.
 */

/** Money on a purchase order is rounded to two places, the way an invoice states it. */
export const MONEY_SCALE = 2

/** Quantities keep all four places the `numeric(18,4)` columns store, so none is rounded away. */
export const QUANTITY_SCALE = 4

type Scaled = { units: bigint; scale: number }

/** Parses a canonical decimal string (`-12.3400`) into scaled integer units. */
function parseDecimal(value: string): Scaled | null {
  const text = value.trim()
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text)
  if (!match) return null
  const [, sign, integer, fraction = ''] = match
  const units = BigInt(`${integer}${fraction}`)
  return { units: sign === '-' ? -units : units, scale: fraction.length }
}

function rescale(value: Scaled, scale: number): bigint {
  if (value.scale === scale) return value.units
  if (value.scale < scale) return value.units * 10n ** BigInt(scale - value.scale)
  return divideRoundHalfUp(value.units, 10n ** BigInt(value.scale - scale))
}

/** Half-up on the magnitude, so -0.005 rounds to -0.01 rather than towards zero. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n
  const magnitude = negative ? -numerator : numerator
  const quotient = magnitude / denominator
  const remainder = magnitude % denominator
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient
  return negative ? -rounded : rounded
}

function format(units: bigint, scale: number): string {
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0')
  const integer = digits.slice(0, digits.length - scale)
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : ''
  return `${negative ? '-' : ''}${integer}${fraction}`
}

/**
 * Multiplies two decimal strings and rounds the product to `scale` places, half-up.
 * Returns `null` when either side is not a decimal number, so a caller renders a dash
 * rather than `NaN`.
 */
export function multiplyDecimal(left: string, right: string, scale: number = MONEY_SCALE): string | null {
  const a = parseDecimal(left)
  const b = parseDecimal(right)
  if (!a || !b) return null
  const product: Scaled = { units: a.units * b.units, scale: a.scale + b.scale }
  return format(rescale(product, scale), scale)
}

/** Adds decimal strings at a fixed scale; an unparseable entry makes the whole sum `null`. */
export function sumDecimals(values: readonly string[], scale: number = MONEY_SCALE): string | null {
  let total = 0n
  for (const value of values) {
    const parsed = parseDecimal(value)
    if (!parsed) return null
    total += rescale(parsed, scale)
  }
  return format(total, scale)
}

/**
 * `left - right` at a fixed scale. Returns `null` when either side is unreadable, so a
 * caller shows a dash instead of a quantity nobody can vouch for.
 */
export function subtractDecimal(left: string, right: string, scale: number = QUANTITY_SCALE): string | null {
  const a = parseDecimal(left)
  const b = parseDecimal(right)
  if (!a || !b) return null
  return format(rescale(a, scale) - rescale(b, scale), scale)
}

/**
 * Orders two decimal strings: negative when `left < right`, 0 when equal, positive when
 * greater. `null` when either side is unreadable — the caller must decide what an
 * unanswerable comparison means rather than get a silent `false`.
 */
export function compareDecimal(left: string, right: string, scale: number = QUANTITY_SCALE): number | null {
  const a = parseDecimal(left)
  const b = parseDecimal(right)
  if (!a || !b) return null
  const difference = rescale(a, scale) - rescale(b, scale)
  if (difference === 0n) return 0
  return difference < 0n ? -1 : 1
}

/** True only for a readable, strictly positive quantity; an unparseable string is not positive. */
export function isPositiveDecimal(value: string, scale: number = QUANTITY_SCALE): boolean {
  const comparison = compareDecimal(value, '0', scale)
  return comparison !== null && comparison > 0
}

/**
 * The net value of one line: quantity × unit price, rounded to money scale. Rounding here
 * rather than on the sum is what makes the order total equal the sum of the values printed
 * next to each line.
 */
export function lineNetValue(quantity: string, unitPriceNet: string): string | null {
  return multiplyDecimal(quantity, unitPriceNet, MONEY_SCALE)
}

/** The order's net value: the sum of its lines' rounded values, or `null` if any line is unreadable. */
export function orderNetValue(
  lines: readonly { quantityOrdered: string; unitPriceNet: string }[],
): string | null {
  const values: string[] = []
  for (const line of lines) {
    const value = lineNetValue(line.quantityOrdered, line.unitPriceNet)
    if (value === null) return null
    values.push(value)
  }
  return sumDecimals(values, MONEY_SCALE)
}
