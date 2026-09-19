/**
 * What the office says should arrive, as the floor reads it.
 *
 * The document's lines are an assertion by somebody who is not in the warehouse, so the panel
 * renders them and nothing else: no arithmetic against what has been counted, which is the
 * summary screen's job and the only place the two should ever be compared. Kept pure so the
 * list a warehouseman scans against can be tested without a browser or a database.
 */

/** One `pz_goods_receipt_lines` row as `/api/pz/goods-receipts` answers a single-record read. */
export type ReceivingExpectedLine = {
  id: string
  lineNumber: number
  catalogVariantId: string
  catalogSnapshot: { name: string; sku: string | null } | null
  quantity: string
  unit: string | null
  uomSnapshot: { code: string | null; productDefaultUnit: string | null } | null
}

export type ExpectedContentRow = {
  id: string
  /** `null` when nothing on the line names the product; the screen says so rather than guess. */
  name: string | null
  sku: string | null
  /** Storage precision trimmed off: `12.0000` is read off a phone as `12`. */
  quantity: string
  unit: string | null
}

/**
 * `null` lines and a document that could not be read are the same thing to this screen — an
 * answer it does not have. They are deliberately not an empty list: "nothing is expected" is
 * a fact about the delivery that would send somebody looking for goods nobody ordered.
 */
export type ExpectedContentsState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'rows'; rows: ExpectedContentRow[] }

function cleanText(value: string | null | undefined): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > 0 ? text : null
}

/**
 * The unit the line was written in, falling back to what the product's unit was when the line
 * was saved. Never the product's current default: the document means the unit it was written
 * with, and a later change to the catalog must not restate somebody else's quantity.
 */
function resolveUnit(line: ReceivingExpectedLine): string | null {
  return (
    cleanText(line.unit) ??
    cleanText(line.uomSnapshot?.code) ??
    cleanText(line.uomSnapshot?.productDefaultUnit)
  )
}

/**
 * `numeric(18,4)` arrives as `12.0000`. Trimmed as text rather than through a JS number: the
 * column carries more digits than a float holds exactly, and a quantity a warehouseman reads
 * off a screen must be the one the document stores.
 */
export function formatExpectedQuantity(raw: string | null | undefined): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return '0'
  if (!text.includes('.')) return text
  const separator = text.indexOf('.')
  const integer = text.slice(0, separator)
  const fraction = text.slice(separator + 1).replace(/0+$/, '')
  // `.5` and `-.5` are valid decimals nobody wants to read without their leading zero.
  const whole = integer === '' || integer === '-' || integer === '+' ? `${integer}0` : integer
  return fraction ? `${whole}.${fraction}` : whole
}

/**
 * Document order, one row per line. Lines are not merged per product: the same product on two
 * lines is something the office wrote on purpose, and folding it into one row would show the
 * floor a delivery that does not match the paperwork in their hand.
 */
export function buildExpectedContents(
  lines: readonly ReceivingExpectedLine[] | null | undefined,
): ExpectedContentRow[] {
  if (!Array.isArray(lines)) return []
  return [...lines]
    .sort((left, right) => left.lineNumber - right.lineNumber)
    .map((line) => ({
      id: line.id,
      name: cleanText(line.catalogSnapshot?.name),
      sku: cleanText(line.catalogSnapshot?.sku),
      quantity: formatExpectedQuantity(line.quantity),
      unit: resolveUnit(line),
    }))
}

export function resolveExpectedContents(input: {
  loading: boolean
  error: unknown
  document: { lines?: readonly ReceivingExpectedLine[] | null } | null | undefined
}): ExpectedContentsState {
  if (input.loading) return { kind: 'loading' }
  if (input.error || !input.document) return { kind: 'error' }
  // A list read reports `null` for lines it never loaded, so `null` is "not answered" and only
  // an array — empty or not — is the document speaking for itself.
  if (!Array.isArray(input.document.lines)) return { kind: 'error' }
  return { kind: 'rows', rows: buildExpectedContents(input.document.lines) }
}
