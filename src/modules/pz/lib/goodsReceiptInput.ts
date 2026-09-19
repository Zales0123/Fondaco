/**
 * Validation for the Goods Receipt write path.
 *
 * It returns a result rather than throwing so the rules stay pure and unit-testable:
 * "today" and the translator are injected, and the command turns a failure into the
 * field-level HTTP error the form renders. Field keys are the form's field ids, so a
 * rejected Document Number lands on the Document Number input rather than in a banner.
 */

export type TranslateFn = (key: string, fallback?: string, params?: Record<string, string | number>) => string

export type GoodsReceiptLineInput = {
  catalogProductId: string
  /** Normalised decimal string at the storage precision; never a float. */
  quantity: string
  unit: string | null
}

export type GoodsReceiptWriteInput = {
  documentNumber: string
  /** Calendar day, `YYYY-MM-DD`. */
  documentDate: string
  supplierName: string
  warehouseId: string
  lines: GoodsReceiptLineInput[]
}

export type GoodsReceiptInputResult =
  | { ok: true; value: GoodsReceiptWriteInput }
  | { ok: false; message: string; fields: Record<string, string> }

export const DOCUMENT_NUMBER_MAX_LENGTH = 100
export const SUPPLIER_NAME_MAX_LENGTH = 200
export const UNIT_MAX_LENGTH = 50
/** Matches the `numeric(18,4)` column the lines store, which mirrors `sales` line quantities. */
export const QUANTITY_SCALE = 4
/** `numeric(18,4)` leaves 14 digits before the point; more is a database error, not a quantity. */
export const QUANTITY_INTEGER_DIGITS = 14

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** `YYYY-MM-DD` is only a real day if it survives a round trip — `2026-02-31` does not. */
export function isCalendarDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * Accepts what a person types — a decimal comma included — and returns the canonical
 * string the column stores, or `null` when the value is not a quantity a document can
 * carry. Zero and negatives are not quantities here: a line that says nothing arrived is
 * a line that should not exist.
 */
export function normalizeQuantity(value: unknown): string | null {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  const normalized = raw.replace(',', '.')
  if (!/^\d*\.?\d+$/.test(normalized)) return null
  const [integer = '', fraction = ''] = normalized.split('.')
  if (fraction.length > QUANTITY_SCALE) return null
  // Refused here rather than in Postgres, where it would surface as an opaque write error.
  if (integer.replace(/^0+/, '').length > QUANTITY_INTEGER_DIGITS) return null
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed.toFixed(QUANTITY_SCALE)
}

export function parseGoodsReceiptWriteInput(
  raw: unknown,
  translate: TranslateFn,
  options: { today: string },
): GoodsReceiptInputResult {
  const source = asRecord(raw)
  const fields: Record<string, string> = {}

  const documentNumber = asTrimmedString(source.documentNumber)
  if (!documentNumber) {
    fields.documentNumber = translate('pz.goodsReceipts.errors.documentNumberRequired', 'Document Number is required.')
  } else if (documentNumber.length > DOCUMENT_NUMBER_MAX_LENGTH) {
    fields.documentNumber = translate('pz.goodsReceipts.errors.documentNumberTooLong', 'Document Number is too long.')
  }

  // The whole trimmed value has to be a calendar day: truncating to ten characters would
  // accept `2026-09-18junk` and a timestamp alike.
  const documentDate = asTrimmedString(source.documentDate)
  if (!documentDate) {
    fields.documentDate = translate('pz.goodsReceipts.errors.documentDateRequired', 'Document Date is required.')
  } else if (!isCalendarDay(documentDate)) {
    fields.documentDate = translate('pz.goodsReceipts.errors.documentDateInvalid', 'Document Date is not a valid date.')
  } else if (documentDate > options.today) {
    // Backdating is normal — catching up on a backlog is the usual case — so only a day
    // that has not happened yet is refused.
    fields.documentDate = translate('pz.goodsReceipts.errors.documentDateFuture', 'Document Date cannot be in the future.')
  }

  const supplierName = asTrimmedString(source.supplierName)
  if (!supplierName) {
    fields.supplierName = translate('pz.goodsReceipts.errors.supplierRequired', 'Supplier is required.')
  } else if (supplierName.length > SUPPLIER_NAME_MAX_LENGTH) {
    fields.supplierName = translate('pz.goodsReceipts.errors.supplierTooLong', 'Supplier is too long.')
  }

  const warehouseId = asTrimmedString(source.warehouseId)
  if (!warehouseId) {
    fields.warehouseId = translate('pz.goodsReceipts.errors.warehouseRequired', 'Warehouse is required.')
  } else if (!UUID.test(warehouseId)) {
    fields.warehouseId = translate('pz.goodsReceipts.errors.warehouseInvalid', 'Select a warehouse from the list.')
  }

  const rawLines = Array.isArray(source.lines) ? source.lines : []
  const lines: GoodsReceiptLineInput[] = []
  if (rawLines.length === 0) {
    fields.lines = translate('pz.goodsReceipts.errors.linesRequired', 'Add at least one line.')
  }
  for (const [index, rawLine] of rawLines.entries()) {
    const position = index + 1
    const line = asRecord(rawLine)
    const catalogProductId = asTrimmedString(line.catalogProductId)
    if (!UUID.test(catalogProductId)) {
      fields.lines ??= translate('pz.goodsReceipts.errors.lineProductRequired', 'Position {position}: choose a product.', {
        position,
      })
      continue
    }
    const quantity = normalizeQuantity(line.quantity)
    if (quantity === null) {
      fields.lines ??= translate(
        'pz.goodsReceipts.errors.lineQuantityInvalid',
        'Position {position}: quantity must be greater than zero.',
        { position },
      )
      continue
    }
    const unit = asTrimmedString(line.unit)
    if (unit.length > UNIT_MAX_LENGTH) {
      // Silently truncating would store something the user never wrote on a document they
      // are meant to be able to trust.
      fields.lines ??= translate(
        'pz.goodsReceipts.errors.lineUnitTooLong',
        'Position {position}: the unit is too long.',
        { position },
      )
      continue
    }
    lines.push({ catalogProductId, quantity, unit: unit || null })
  }

  if (Object.keys(fields).length > 0) {
    return {
      ok: false,
      message: translate('pz.goodsReceipts.errors.validationFailed', 'The goods receipt could not be saved.'),
      fields,
    }
  }

  return { ok: true, value: { documentNumber, documentDate, supplierName, warehouseId, lines } }
}

/** The day the server considers "today", as the calendar day the document date is compared against. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}
