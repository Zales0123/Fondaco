/**
 * Expected against counted, per product, for one Goods Receipt.
 *
 * Kept pure and free of the database so the comparison the office reads before pressing
 * Confirm can be tested without one. Quantities stay decimal strings from end to end: a JSON
 * number cannot carry `numeric(18,4)` faithfully, and a delivery filed under a quantity
 * nobody wrote is exactly the failure this screen exists to catch.
 */

import type { GoodsReceiptStatus, StockPostingFailureReason, StockPostingStatus } from '../data/entities'
import { fromScaledQuantity, toScaledQuantity } from './quantity'
import type { ConfirmationBlocker } from './stockPosting'

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

/**
 * Expected and counted for the rows written in one unit. A document mixing cartons and
 * pieces has one entry per unit, because adding them would produce a number that is true of
 * nothing — and this total sits next to the button that posts the stock.
 */
export type ReceivingSummaryUnitTotal = {
  /** `null` groups the rows carrying no unit, which includes every surplus row. */
  unit: string | null
  expected: string
  counted: string
}

export type ReceivingSummary = {
  items: ReceivingSummaryRow[]
  /**
   * Kept because it is part of the published `receiving-summary` response and removing a
   * response field is a breaking change. It sums across units and is therefore not rendered
   * any more; read `totalsByUnit`.
   *
   * @deprecated Use `totalsByUnit`.
   */
  totals: { expected: string; counted: string }
  totalsByUnit: ReceivingSummaryUnitTotal[]
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
  row.expected = (row.expected ?? 0n) + toScaledQuantity(line.quantity)
  row.name ??= line.name
  row.sku ??= line.sku
  row.unit ??= line.unit
}

function addCounted(rows: Map<string, Accumulator>, line: ReceivingSummaryPalletLine): void {
  const row = accumulatorFor(rows, line.catalogVariantId)
  const quantity = toScaledQuantity(line.quantity)
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
    expected: row.expected === null ? null : fromScaledQuantity(row.expected),
    counted: fromScaledQuantity(row.counted),
    difference: fromScaledQuantity(difference),
    surplus: row.expected === null,
    pallets: Array.from(row.pallets.values())
      .sort((left, right) => (left.code === right.code ? 0 : left.code < right.code ? -1 : 1))
      .map((pallet) => ({ palletId: pallet.palletId, code: pallet.code, quantity: fromScaledQuantity(pallet.quantity) })),
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

/** Named units first, alphabetically, so the unitless group never displaces a real one. */
function buildUnitTotals(rows: readonly Accumulator[]): ReceivingSummaryUnitTotal[] {
  const totals = new Map<string, { unit: string | null; expected: bigint; counted: bigint }>()
  for (const row of rows) {
    const key = row.unit ?? ''
    const total = totals.get(key) ?? { unit: row.unit, expected: 0n, counted: 0n }
    total.expected += row.expected ?? 0n
    total.counted += row.counted
    totals.set(key, total)
  }
  return Array.from(totals.values())
    .sort((left, right) => compareNullableText(left.unit, right.unit))
    .map((total) => ({
      unit: total.unit,
      expected: fromScaledQuantity(total.expected),
      counted: fromScaledQuantity(total.counted),
    }))
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
    totals: { expected: fromScaledQuantity(expectedTotal), counted: fromScaledQuantity(countedTotal) },
    totalsByUnit: buildUnitTotals(ordered),
    palletCount: input.pallets.length,
    palletsOpen: input.pallets.filter((pallet) => pallet.status === 'open').length,
    palletsClosed: input.pallets.filter((pallet) => pallet.status === 'closed').length,
  }
}

/**
 * The summary as `/api/pz/goods-receipts/receiving-summary` answers it: the comparison plus
 * everything a completion depends on. One response rather than two, so a screen can never
 * offer a button for one state of the document while showing the counts of another.
 */
export type ReceivingSummaryResponse = ReceivingSummary & {
  status: GoodsReceiptStatus
  /** The version a completion sends in its optimistic-lock header. */
  updatedAt: string | null
  blockers: ConfirmationBlocker[]
  defaultDestinationId: string | null
  stockPosting: {
    status: StockPostingStatus
    postedAt: string | null
    reason: StockPostingFailureReason | null
    locationId: string | null
    enabled: boolean
  }
}
