/**
 * Turning what the stock API answers into the figures a warehouseman asked for: how much
 * of it this warehouse holds, and where in the warehouse to walk.
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
  location_id?: string | null
  location_code?: string | null
  lot_id?: string | null
}

/** One place inside the warehouse, and how much of the scanned product sits there. */
export type StockLocation = {
  /** Null when the row named no location — the quantity is still real, the shelf is not known. */
  code: string | null
  onHand: number
}

/** What the scanned product's own warehouse holds of it, and where. */
export type StockSummary = {
  onHand: number
  available: number
  /** Where to walk first: the location holding the most of it, or null when none holds any. */
  primaryLocation: StockLocation | null
  /** How many locations hold more than none of it, the primary one included. */
  locationCount: number
}

export const EMPTY_STOCK_SUMMARY: StockSummary = {
  onHand: 0,
  available: 0,
  primaryLocation: null,
  locationCount: 0,
}

/** A `numeric` column arriving as `"12.0000"`, `12`, `null` or nonsense is all one number. */
export function toQuantity(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : 0
  return Number.isFinite(value) ? value : 0
}

function trimmedOrNull(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

/**
 * Buckets of one location — the same shelf split across lots or serials — are that one
 * shelf, so they are folded together before anything is counted or compared. A row with
 * no location id falls back to its code, and a row with neither is its own place: two
 * unnamed buckets are not evidence of one shelf.
 */
function foldIntoLocations(rows: InventoryBalanceRow[]): StockLocation[] {
  const byLocation = new Map<string, StockLocation>()
  rows.forEach((row, index) => {
    const code = trimmedOrNull(row.location_code)
    const key = trimmedOrNull(row.location_id) ?? code ?? `row:${index}`
    const held = byLocation.get(key)
    if (held) held.onHand += toQuantity(row.quantity_on_hand)
    else byLocation.set(key, { code, onHand: toQuantity(row.quantity_on_hand) })
  })
  return [...byLocation.values()]
}

/**
 * Which shelf the warehouseman is sent to: the one holding the most. Ties break on the
 * location code so the answer is the same on every scan of the same stock — and an
 * unnamed location loses every tie, because a code somebody can walk to beats one nobody
 * can. The count beside it is the other places holding any, which is what tells them the
 * shelf they are about to walk to is not all of it.
 */
function compareByWhereToWalk(a: StockLocation, b: StockLocation): number {
  if (a.onHand !== b.onHand) return b.onHand - a.onHand
  if (a.code === b.code) return 0
  if (a.code === null) return 1
  if (b.code === null) return -1
  return a.code < b.code ? -1 : 1
}

/**
 * Stock is stored per (location, lot, serial) bucket even inside one warehouse, so a
 * product on two shelves is two rows. The panel answers "how many are here", which is the
 * sum, and "where is it", which is the fullest location — a full bin-by-bin listing is a
 * screen nobody holding a scanner reads.
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

  // A location holding none of it is a shelf the product is not on; the warehouseman is
  // not walking there, so it is neither named nor counted.
  const stocked = foldIntoLocations(rows).filter((location) => location.onHand > 0)
  stocked.sort(compareByWhereToWalk)

  return { onHand, available, primaryLocation: stocked[0] ?? null, locationCount: stocked.length }
}

/** Trailing zeros off a `numeric(18,4)` are noise on a handheld; whole units stay whole. */
export function formatStockQuantity(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
}
