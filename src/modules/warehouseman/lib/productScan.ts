/**
 * Turning what the stock API answers into the one number a warehouseman asked for.
 *
 * Everything here is pure: the balances arrive as buckets and leave as a summary, so the
 * arithmetic that decides what the floor reads off the screen can be exercised without a
 * database or a camera.
 */

/**
 * One inventory balance row as `/api/wms/inventory/balances` returns it. Quantities come
 * off a `numeric` column, so they arrive as strings as often as numbers, and every field
 * is optional because the installed list schema declares them so.
 */
export type InventoryBalanceRow = {
  quantity_on_hand?: string | number | null
  quantity_available?: string | number | null
}

/** What the scanned product's own warehouse holds of it. */
export type StockSummary = {
  onHand: number
  available: number
}

export const EMPTY_STOCK_SUMMARY: StockSummary = { onHand: 0, available: 0 }

/** A `numeric` column arriving as `"12.0000"`, `12`, `null` or nonsense is all one number. */
export function toQuantity(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : 0
  return Number.isFinite(value) ? value : 0
}

/**
 * Stock is stored per (location, lot, serial) bucket even inside one warehouse, so a
 * product on two shelves is two rows. The panel answers "how many are here", which is the
 * sum — the buckets are a storage detail nobody holding a scanner is asking about.
 *
 * The caller has already narrowed the read to one warehouse, so every row handed here
 * belongs to it and nothing needs filtering out again.
 */
export function summarizeStock(rows: InventoryBalanceRow[]): StockSummary {
  let onHand = 0
  let available = 0
  for (const row of rows) {
    onHand += toQuantity(row.quantity_on_hand)
    available += toQuantity(row.quantity_available)
  }
  return { onHand, available }
}

/** Trailing zeros off a `numeric(18,4)` are noise on a handheld; whole units stay whole. */
export function formatStockQuantity(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
}
