/** Pure agreements shared by the panel's receiving screens: where they link, what they ask
 *  the `pz` API for, and what a gloved hand is allowed to type into them. */

export const RECEIVING_LIST_HREF = '/warehouseman/receiving'

export function receivingReceiptHref(receiptId: string): string {
  return `${RECEIVING_LIST_HREF}/${encodeURIComponent(receiptId)}`
}

export function receivingPalletHref(receiptId: string, palletId: string): string {
  return `${receivingReceiptHref(receiptId)}/pallets/${encodeURIComponent(palletId)}`
}

export function receivingSummaryHref(receiptId: string): string {
  return `${receivingReceiptHref(receiptId)}/summary`
}

/**
 * `null` means every Warehouse the organization scope allows. The Assigned Warehouse is a
 * filter and never a gate (ADR-0002), so widening past it is an ordinary choice rather than
 * a privilege, and the panel expresses that by simply dropping the parameter.
 */
export type WarehouseFilter = string | null

export function buildReceivingListQuery(warehouse: WarehouseFilter): Record<string, string> {
  const query: Record<string, string> = { status: 'receiving', pageSize: '50' }
  if (warehouse) query.warehouseId = warehouse
  return query
}

/** A handheld scanner appends its own whitespace and a terminating newline. */
export function normalizeScannedCode(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/** Matches the `numeric(18,4)` column `pz_pallet_lines.quantity` stores. */
export const COUNT_QUANTITY_SCALE = 4
const COUNT_QUANTITY_INTEGER_DIGITS = 14

/**
 * Canonicalises what somebody typed into the quantity field, or answers `null` when it is
 * not a quantity. A decimal comma is accepted because a Polish keyboard produces one, and
 * zero is refused because a pallet line asserts that a product is on the pallet.
 *
 * The server validates this again and remains the authority; refusing here only saves the
 * floor a round trip in the middle of a count.
 */
export function parseCountQuantity(raw: string): string | null {
  const normalized = raw.trim().replace(',', '.')
  if (!normalized) return null

  const match = /^(\d*)(?:\.(\d*))?$/.exec(normalized)
  if (!match) return null
  const [, rawInteger = '', rawFraction = ''] = match
  if (!rawInteger && !rawFraction) return null
  if (rawFraction.length > COUNT_QUANTITY_SCALE) return null

  const integer = rawInteger.replace(/^0+/, '')
  if (integer.length > COUNT_QUANTITY_INTEGER_DIGITS) return null
  const fraction = rawFraction.padEnd(COUNT_QUANTITY_SCALE, '0')
  if (!integer && !fraction.replace(/0+$/, '')) return null

  return `${integer || '0'}.${fraction}`
}

/** Trailing zeros are storage precision, not something to read back to somebody counting. */
export function formatCountQuantity(raw: string): string {
  if (!/^\d+\.\d+$/.test(raw)) return raw
  return raw.replace(/\.?0+$/, '') || '0'
}

/**
 * Every `pz` refusal carries an already-localized `error`. Printing it is the only way the
 * panel can name the other document a scanned pallet belongs to, so the caller's own key is
 * a fallback rather than the first choice.
 */
export function resolveApiMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback
  const message = (payload as { error?: unknown }).error
  return typeof message === 'string' && message.trim() ? message : fallback
}

/**
 * `pz` answers with an empty name when a counted variant has neither a snapshot nor a live
 * catalog row. The floor still has to be told which line it is looking at, so empty is the
 * same answer as absent here.
 */
export function productLabel(name: string | null | undefined, fallback: string): string {
  return name && name.trim() ? name : fallback
}
