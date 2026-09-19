/**
 * Expected against counted, per product, for one Goods Receipt.
 *
 * Kept pure and free of the database so the comparison the office reads before pressing
 * Confirm can be tested without one. Quantities stay decimal strings from end to end: a JSON
 * number cannot carry `numeric(18,4)` faithfully, and a delivery filed under a quantity
 * nobody wrote is exactly the failure this screen exists to catch.
 */

import { QUANTITY_SCALE } from './goodsReceiptInput'

export type ReceivingSummaryPalletBreakdown = {
  palletId: string
  code: string
  quantity: string
}

export type ReceivingSummaryRow = {
  catalogVariantId: string
  name: string | null
  sku: string | null
  /** The unit the document's line was written in, so a carton-vs-piece mismatch is visible. */
  unit: string | null
  /** null when no line of the document expected this variant — a surplus row. */
  expected: string | null
  counted: string
  /** counted - (expected ?? 0). Negative = short, positive = over. */
  difference: string
  surplus: boolean
  pallets: ReceivingSummaryPalletBreakdown[]
}

export type ReceivingSummary = {
  items: ReceivingSummaryRow[]
  totals: { expected: string; counted: string }
  palletCount: number
  palletsOpen: number
  palletsClosed: number
}

export type ReceivingSummaryExpectedLine = {
  catalogVariantId: string
  quantity: string
  unit: string | null
  name: string | null
  sku: string | null
}

export type ReceivingSummaryPalletLine = {
  palletId: string
  palletCode: string
  catalogVariantId: string
  quantity: string
  name: string | null
  sku: string | null
}

export type ReceivingSummaryPallet = {
  id: string
  code: string
  status: 'open' | 'closed'
}

export type ReceivingSummaryInput = {
  expectedLines: ReceivingSummaryExpectedLine[]
  palletLines: ReceivingSummaryPalletLine[]
  pallets: ReceivingSummaryPallet[]
}

const SCALE_FACTOR = 10n ** BigInt(QUANTITY_SCALE)
const DECIMAL = /^(-?)(\d*)(?:\.(\d*))?$/

/**
 * Scaled integers rather than floats: adding `0.1` to `0.2` must not turn a matching
 * delivery into a difference of `0.0000000000000004`.
 */
function toScaled(value: string): bigint {
  const match = DECIMAL.exec(value.trim())
  if (!match) return 0n
  const [, sign, integer = '', fraction = ''] = match
  const scaled =
    BigInt(integer || '0') * SCALE_FACTOR + BigInt(fraction.slice(0, QUANTITY_SCALE).padEnd(QUANTITY_SCALE, '0'))
  return sign === '-' ? -scaled : scaled
}

function fromScaled(value: bigint): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(QUANTITY_SCALE + 1, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -QUANTITY_SCALE)}.${digits.slice(-QUANTITY_SCALE)}`
}

type Accumulator = {
  catalogVariantId: string
  name: string | null
  sku: string | null
  unit: string | null
  expected: bigint | null
  counted: bigint
  pallets: Map<string, { palletId: string; code: string; quantity: bigint }>
}

function accumulatorFor(rows: Map<string, Accumulator>, catalogVariantId: string): Accumulator {
  const existing = rows.get(catalogVariantId)
  if (existing) return existing
  const created: Accumulator = {
    catalogVariantId,
    name: null,
    sku: null,
    unit: null,
    expected: null,
    counted: 0n,
    pallets: new Map(),
  }
  rows.set(catalogVariantId, created)
  return created
}

function addExpected(rows: Map<string, Accumulator>, line: ReceivingSummaryExpectedLine): void {
  const row = accumulatorFor(rows, line.catalogVariantId)
  row.expected = (row.expected ?? 0n) + toScaled(line.quantity)
  row.name ??= line.name
  row.sku ??= line.sku
  row.unit ??= line.unit
}

function addCounted(rows: Map<string, Accumulator>, line: ReceivingSummaryPalletLine): void {
  const row = accumulatorFor(rows, line.catalogVariantId)
  const quantity = toScaled(line.quantity)
  row.counted += quantity
  row.name ??= line.name
  row.sku ??= line.sku
  const pallet = row.pallets.get(line.palletId)
  if (pallet) pallet.quantity += quantity
  else row.pallets.set(line.palletId, { palletId: line.palletId, code: line.palletCode, quantity })
}

/**
 * Worst first: a shortage is the only outcome somebody has to act on before the document is
 * confirmed, a surplus is the next surprise, and an over-count is the mildest. Matching rows
 * come last because the view hides them by default.
 */
function severityRank(expected: bigint | null, difference: bigint): number {
  if (difference < 0n) return 0
  if (expected === null) return 1
  if (difference > 0n) return 2
  return 3
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value
}

function compareNullableText(left: string | null, right: string | null): number {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left < right ? -1 : 1
}

function toRow(row: Accumulator): ReceivingSummaryRow {
  const difference = row.counted - (row.expected ?? 0n)
  return {
    catalogVariantId: row.catalogVariantId,
    name: row.name,
    sku: row.sku,
    unit: row.unit,
    expected: row.expected === null ? null : fromScaled(row.expected),
    counted: fromScaled(row.counted),
    difference: fromScaled(difference),
    surplus: row.expected === null,
    pallets: Array.from(row.pallets.values())
      .sort((left, right) => (left.code === right.code ? 0 : left.code < right.code ? -1 : 1))
      .map((pallet) => ({ palletId: pallet.palletId, code: pallet.code, quantity: fromScaled(pallet.quantity) })),
  }
}

function compareRows(left: Accumulator, right: Accumulator): number {
  const leftDifference = left.counted - (left.expected ?? 0n)
  const rightDifference = right.counted - (right.expected ?? 0n)
  const byRank = severityRank(left.expected, leftDifference) - severityRank(right.expected, rightDifference)
  if (byRank !== 0) return byRank
  const leftMagnitude = absolute(leftDifference)
  const rightMagnitude = absolute(rightDifference)
  if (leftMagnitude !== rightMagnitude) return leftMagnitude > rightMagnitude ? -1 : 1
  const byName = compareNullableText(left.name, right.name)
  if (byName !== 0) return byName
  const bySku = compareNullableText(left.sku, right.sku)
  if (bySku !== 0) return bySku
  return left.catalogVariantId < right.catalogVariantId ? -1 : 1
}

export function buildReceivingSummary(input: ReceivingSummaryInput): ReceivingSummary {
  const rows = new Map<string, Accumulator>()
  for (const line of input.expectedLines) addExpected(rows, line)
  for (const line of input.palletLines) addCounted(rows, line)

  const ordered = Array.from(rows.values()).sort(compareRows)
  let expectedTotal = 0n
  let countedTotal = 0n
  for (const row of ordered) {
    expectedTotal += row.expected ?? 0n
    countedTotal += row.counted
  }

  return {
    items: ordered.map(toRow),
    totals: { expected: fromScaled(expectedTotal), counted: fromScaled(countedTotal) },
    palletCount: input.pallets.length,
    palletsOpen: input.pallets.filter((pallet) => pallet.status === 'open').length,
    palletsClosed: input.pallets.filter((pallet) => pallet.status === 'closed').length,
  }
}
