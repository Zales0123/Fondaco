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
  warehouse_id?: string | null
  warehouse_name?: string | null
  warehouse_code?: string | null
  quantity_on_hand?: string | number | null
  quantity_available?: string | number | null
}

/** What one warehouse holds of the scanned product. */
export type WarehouseStock = {
  warehouseId: string
  /** Already display-ready: the warehouse name, its code, or the id when neither came back. */
  warehouseLabel: string
  onHand: number
  available: number
}

export type StockSummary = {
  totalOnHand: number
  totalAvailable: number
  /** One entry per warehouse holding the product, most stock first. */
  byWarehouse: WarehouseStock[]
}

export const EMPTY_STOCK_SUMMARY: StockSummary = { totalOnHand: 0, totalAvailable: 0, byWarehouse: [] }

/** A `numeric` column arriving as `"12.0000"`, `12`, `null` or nonsense is all one number. */
export function toQuantity(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : 0
  return Number.isFinite(value) ? value : 0
}

function warehouseLabelOf(row: InventoryBalanceRow, warehouseId: string): string {
  return row.warehouse_name?.trim() || row.warehouse_code?.trim() || warehouseId
}

/**
 * Stock is stored per (warehouse, location, lot, serial) bucket, so one product in one
 * warehouse is routinely several rows. The panel answers "how many are there", which is
 * the sum — the buckets are a storage detail nobody holding a scanner is asking about.
 *
 * A row with no warehouse still counts towards the total. Dropping it would understate the
 * stock, and understating it is the one way this screen must never be wrong.
 */
export function summarizeStock(rows: InventoryBalanceRow[]): StockSummary {
  const byWarehouse = new Map<string, WarehouseStock>()
  let totalOnHand = 0
  let totalAvailable = 0

  for (const row of rows) {
    const onHand = toQuantity(row.quantity_on_hand)
    const available = toQuantity(row.quantity_available)
    totalOnHand += onHand
    totalAvailable += available

    const warehouseId = row.warehouse_id?.trim()
    if (!warehouseId) continue
    const existing = byWarehouse.get(warehouseId)
    if (existing) {
      existing.onHand += onHand
      existing.available += available
    } else {
      byWarehouse.set(warehouseId, {
        warehouseId,
        warehouseLabel: warehouseLabelOf(row, warehouseId),
        onHand,
        available,
      })
    }
  }

  return {
    totalOnHand,
    totalAvailable,
    // Most stock first: on a phone, the warehouse that matters should not need a scroll.
    byWarehouse: [...byWarehouse.values()].sort((a, b) => b.onHand - a.onHand),
  }
}

/** Trailing zeros off a `numeric(18,4)` are noise on a handheld; whole units stay whole. */
export function formatStockQuantity(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
}
