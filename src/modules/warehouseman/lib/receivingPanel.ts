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

/**
 * The deliveries this floor finished whose goods never reached stock. Only the office can fix
 * one, so the panel lists them to say "this is not done" rather than to offer an action
 * (ADR-0011).
 */
export function buildFailedPostingsQuery(warehouse: WarehouseFilter): Record<string, string> {
  const query: Record<string, string> = { status: 'confirmed', stockPostingStatus: 'failed', pageSize: '20' }
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

/**
 * Blank means one unit: a scan is the gesture that says "one more of these". The quantity
 * field is therefore a multiplier rather than a required entry — left alone a scan adds one,
 * filled with 12 a scan adds twelve — and only something that was actually typed can still
 * be refused, which is why anything non-blank goes back through `parseCountQuantity`.
 */
export function resolveCountQuantity(raw: string): string | null {
  if (!raw.trim()) return `1.${'0'.repeat(COUNT_QUANTITY_SCALE)}`
  return parseCountQuantity(raw)
}

/** Trailing zeros are storage precision, not something to read back to somebody counting. */
export function formatCountQuantity(raw: string): string {
  if (!/^\d+\.\d+$/.test(raw)) return raw
  return raw.replace(/\.?0+$/, '') || '0'
}

/** The smallest a confirmed scan can be: the scan itself asserts the product is there. */
export const MIN_SCAN_QUANTITY = 1

/**
 * Moves the pending scan's quantity by one of the step buttons.
 *
 * Clamping at one rather than zero is the whole reason this is a function. Coming back down
 * from an overshoot with −10 is ordinary — the floor taps `+10` twice, sees 21, and corrects —
 * and landing on 0 or −7 would put a count on screen that the server is bound to refuse,
 * discovered only after the button is pressed. A gloved thumb overshooting is expected input,
 * not a mistake to punish.
 */
export function adjustScanQuantity(current: number, delta: number): number {
  return Math.max(MIN_SCAN_QUANTITY, current + delta)
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

/** A refusal the `pz` and `label_printing` APIs throw: an Error carrying the HTTP status. */
function readFailureStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

/** The server text is already localized, so it beats every key the panel owns. */
function readFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return ''
  return error.message.trim()
}

/**
 * The name `AbortSignal.timeout()` rejects with once the request outlives its bound.
 *
 * Matched on the name alone rather than `instanceof Error`: the rejection is a
 * `DOMException` built by the platform, so it can come from another realm — a
 * worker, an iframe, a test sandbox — where `instanceof` is false against a
 * structurally identical error.
 */
function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'TimeoutError'
  )
}

export type PalletLabelNoticeKind = 'success' | 'warning'

/** What the floor is told about a label, never about the pallet it belongs to. */
export type PalletLabelNotice = { kind: PalletLabelNoticeKind; message: string }

/**
 * Classifies a label print. Printing is a post-commit effect — the pallet is committed
 * before the printer is ever asked — so a printer that is off, busy, faulty or has nothing
 * to print can only ever produce a warning about the sticker. There is deliberately no
 * failure kind here: "creating the pallet failed" is not an outcome this can express.
 *
 * `failure` frames the reason the printer gave, so the screen that just created a pallet
 * can say the pallet is there and the sticker is not, while a reprint only reports the
 * printer. `error` is `null` for a print that went through.
 */
export function describePalletPrintOutcome(
  error: unknown,
  messages: {
    success: string
    failure: (reason: string) => string
    unknownReason: string
    timedOutReason: string
  },
): PalletLabelNotice {
  if (error == null) return { kind: 'success', message: messages.success }
  // Every other refusal carries the server's own localized text. A timeout does
  // not: nothing answered, so the only message available is the browser's
  // untranslated one, and the floor must never be shown that.
  if (isTimeoutError(error)) {
    return { kind: 'warning', message: messages.failure(messages.timedOutReason) }
  }
  return { kind: 'warning', message: messages.failure(readFailureMessage(error) || messages.unknownReason) }
}

/**
 * What the floor is told when opening a pallet by its code fails. Typed and scanned codes
 * share it: a camera must never be refused on different terms than a keyboard.
 *
 * A code nobody has is named as such; every other refusal prints the server's own text,
 * which is what names the other document a pallet belongs to.
 */
export function describePalletLookupFailure(
  error: unknown,
  messages: { notFound: string; failed: string },
): string {
  if (readFailureStatus(error) === 404) return messages.notFound
  return readFailureMessage(error) || messages.failed
}
