/**
 * Validation for the Purchase Order write path.
 *
 * It returns a result rather than throwing so the rules stay pure and unit-testable: the
 * translator is injected, and the command turns a failure into the field-level HTTP error
 * the form renders. Field keys are the form's field ids, so a rejected Document Number lands
 * on the Document Number input rather than in a banner.
 */

export type TranslateFn = (key: string, fallback?: string, params?: Record<string, string | number>) => string

export type PurchaseOrderLineInput = {
  catalogProductId: string
  /** Normalised decimal string at the storage precision; never a float. */
  quantityOrdered: string
  unit: string | null
  /** Normalised decimal string; `0` is allowed, a free-of-charge line is a real one. */
  unitPriceNet: string
  /** Calendar day, `YYYY-MM-DD`, or null to follow the header. */
  expectedDate: string | null
}

export type PurchaseOrderWriteInput = {
  documentNumber: string
  /** Calendar day, `YYYY-MM-DD`. */
  orderDate: string
  expectedDate: string | null
  supplierName: string
  warehouseId: string
  currencyCode: string
  notes: string | null
  lines: PurchaseOrderLineInput[]
}

export type PurchaseOrderInputResult =
  | { ok: true; value: PurchaseOrderWriteInput }
  | { ok: false; message: string; fields: Record<string, string> }

export const DOCUMENT_NUMBER_MAX_LENGTH = 100
export const SUPPLIER_NAME_MAX_LENGTH = 200
export const UNIT_MAX_LENGTH = 50
export const NOTES_MAX_LENGTH = 2000
/** Matches the `numeric(18,4)` columns the lines store, which mirror `sales` line quantities. */
export const DECIMAL_SCALE = 4
/** `numeric(18,4)` leaves 14 digits before the point; more is a database error, not a quantity. */
export const DECIMAL_INTEGER_DIGITS = 14

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/
/** ISO-4217: three letters, stored upper-case so `pln` and `PLN` are one currency. */
const CURRENCY_CODE = /^[A-Z]{3}$/

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
 * Accepts what a person types — a decimal comma included — and returns the canonical string
 * the column stores, or `null` when the value is not a decimal the document can carry.
 *
 * A **fractional** value is only accepted as a string. A JSON number cannot carry one
 * faithfully: `900719925474.0002` and `900719925474.0003` are the same IEEE-754 value, so
 * accepting either would file an order at a price nobody wrote. A JSON number is therefore
 * taken only when it is a safe whole value, which is exactly the case where nothing is lost.
 */
export function normalizeDecimal(value: unknown, options: { allowZero: boolean }): string | null {
  let raw: string
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null
    raw = String(value)
  } else if (typeof value === 'string') {
    raw = value.trim()
  } else {
    return null
  }
  if (!raw) return null

  const normalized = raw.replace(',', '.')
  // Exponent notation is refused too: it is never what a person typed on an order form.
  const match = /^(\d*)(?:\.(\d*))?$/.exec(normalized)
  if (!match) return null
  const [, rawInteger = '', rawFraction = ''] = match
  if (!rawInteger && !rawFraction) return null
  if (rawFraction.length > DECIMAL_SCALE) return null

  const integer = rawInteger.replace(/^0+/, '')
  // Refused here rather than in Postgres, where it would surface as an opaque write error.
  if (integer.length > DECIMAL_INTEGER_DIGITS) return null
  const fraction = rawFraction.padEnd(DECIMAL_SCALE, '0')
  const isZero = !integer && !fraction.replace(/0+$/, '')
  if (isZero && !options.allowZero) return null

  return `${integer || '0'}.${fraction}`
}

/** A quantity of zero is not a quantity: a line ordering nothing is a line that should not exist. */
export function normalizeQuantity(value: unknown): string | null {
  return normalizeDecimal(value, { allowZero: false })
}

/** A price of zero is legitimate — a free replacement is still a line on the order. */
export function normalizePrice(value: unknown): string | null {
  return normalizeDecimal(value, { allowZero: true })
}

export function parsePurchaseOrderWriteInput(
  raw: unknown,
  translate: TranslateFn,
): PurchaseOrderInputResult {
  const source = asRecord(raw)
  const fields: Record<string, string> = {}

  const documentNumber = asTrimmedString(source.documentNumber)
  if (!documentNumber) {
    fields.documentNumber = translate(
      'procurements.purchaseOrders.errors.documentNumberRequired',
      'Document Number is required.',
    )
  } else if (documentNumber.length > DOCUMENT_NUMBER_MAX_LENGTH) {
    fields.documentNumber = translate(
      'procurements.purchaseOrders.errors.documentNumberTooLong',
      'Document Number is too long.',
    )
  }

  // The whole trimmed value has to be a calendar day: truncating to ten characters would
  // accept `2026-09-18junk` and a timestamp alike. An order may be written for a future
  // delivery, and backdating a placed order is normal, so neither end of the range is capped.
  const orderDate = asTrimmedString(source.orderDate)
  if (!orderDate) {
    fields.orderDate = translate('procurements.purchaseOrders.errors.orderDateRequired', 'Order Date is required.')
  } else if (!isCalendarDay(orderDate)) {
    fields.orderDate = translate('procurements.purchaseOrders.errors.orderDateInvalid', 'Order Date is not a valid date.')
  }

  const expectedDateRaw = asTrimmedString(source.expectedDate)
  let expectedDate: string | null = null
  if (expectedDateRaw) {
    if (!isCalendarDay(expectedDateRaw)) {
      fields.expectedDate = translate(
        'procurements.purchaseOrders.errors.expectedDateInvalid',
        'Expected Date is not a valid date.',
      )
    } else if (orderDate && isCalendarDay(orderDate) && expectedDateRaw < orderDate) {
      // A delivery cannot be expected before the order was placed; string comparison is
      // exact for `YYYY-MM-DD`.
      fields.expectedDate = translate(
        'procurements.purchaseOrders.errors.expectedDateBeforeOrderDate',
        'Expected Date cannot be earlier than the Order Date.',
      )
    } else {
      expectedDate = expectedDateRaw
    }
  }

  const supplierName = asTrimmedString(source.supplierName)
  if (!supplierName) {
    fields.supplierName = translate('procurements.purchaseOrders.errors.supplierRequired', 'Supplier is required.')
  } else if (supplierName.length > SUPPLIER_NAME_MAX_LENGTH) {
    fields.supplierName = translate('procurements.purchaseOrders.errors.supplierTooLong', 'Supplier is too long.')
  }

  const warehouseId = asTrimmedString(source.warehouseId)
  if (!warehouseId) {
    fields.warehouseId = translate('procurements.purchaseOrders.errors.warehouseRequired', 'Warehouse is required.')
  } else if (!UUID.test(warehouseId)) {
    fields.warehouseId = translate('procurements.purchaseOrders.errors.warehouseInvalid', 'Select a warehouse from the list.')
  }

  const currencyCode = asTrimmedString(source.currencyCode).toUpperCase()
  if (!currencyCode) {
    fields.currencyCode = translate('procurements.purchaseOrders.errors.currencyRequired', 'Currency is required.')
  } else if (!CURRENCY_CODE.test(currencyCode)) {
    fields.currencyCode = translate(
      'procurements.purchaseOrders.errors.currencyInvalid',
      'Currency must be a three-letter code, for example PLN.',
    )
  }

  const notesRaw = asTrimmedString(source.notes)
  if (notesRaw.length > NOTES_MAX_LENGTH) {
    fields.notes = translate('procurements.purchaseOrders.errors.notesTooLong', 'The note is too long.')
  }

  const rawLines = Array.isArray(source.lines) ? source.lines : []
  const lines: PurchaseOrderLineInput[] = []
  if (rawLines.length === 0) {
    fields.lines = translate('procurements.purchaseOrders.errors.linesRequired', 'Add at least one line.')
  }
  for (const [index, rawLine] of rawLines.entries()) {
    const position = index + 1
    const line = asRecord(rawLine)
    const catalogProductId = asTrimmedString(line.catalogProductId)
    if (!UUID.test(catalogProductId)) {
      fields.lines ??= translate(
        'procurements.purchaseOrders.errors.lineProductRequired',
        'Position {position}: choose a product.',
        { position },
      )
      continue
    }
    const quantityOrdered = normalizeQuantity(line.quantityOrdered)
    if (quantityOrdered === null) {
      fields.lines ??= translate(
        'procurements.purchaseOrders.errors.lineQuantityInvalid',
        'Position {position}: quantity must be greater than zero.',
        { position },
      )
      continue
    }
    const unitPriceNet = normalizePrice(line.unitPriceNet)
    if (unitPriceNet === null) {
      fields.lines ??= translate(
        'procurements.purchaseOrders.errors.linePriceInvalid',
        'Position {position}: the net unit price must be zero or more.',
        { position },
      )
      continue
    }
    const unit = asTrimmedString(line.unit)
    if (unit.length > UNIT_MAX_LENGTH) {
      // Silently truncating would store something the user never wrote on a document they
      // are meant to be able to trust.
      fields.lines ??= translate(
        'procurements.purchaseOrders.errors.lineUnitTooLong',
        'Position {position}: the unit is too long.',
        { position },
      )
      continue
    }
    const lineExpectedRaw = asTrimmedString(line.expectedDate)
    let lineExpected: string | null = null
    if (lineExpectedRaw) {
      if (!isCalendarDay(lineExpectedRaw)) {
        fields.lines ??= translate(
          'procurements.purchaseOrders.errors.lineExpectedDateInvalid',
          'Position {position}: the expected date is not a valid date.',
          { position },
        )
        continue
      }
      if (orderDate && isCalendarDay(orderDate) && lineExpectedRaw < orderDate) {
        fields.lines ??= translate(
          'procurements.purchaseOrders.errors.lineExpectedDateBeforeOrderDate',
          'Position {position}: the expected date cannot be earlier than the Order Date.',
          { position },
        )
        continue
      }
      lineExpected = lineExpectedRaw
    }
    lines.push({
      catalogProductId,
      quantityOrdered,
      unit: unit || null,
      unitPriceNet,
      // A line without its own date follows the header, which is what a buyer means by
      // leaving it blank.
      expectedDate: lineExpected ?? expectedDate,
    })
  }

  if (Object.keys(fields).length > 0) {
    return {
      ok: false,
      message: translate('procurements.purchaseOrders.errors.validationFailed', 'The purchase order could not be saved.'),
      fields,
    }
  }

  return {
    ok: true,
    value: {
      documentNumber,
      orderDate,
      expectedDate,
      supplierName,
      warehouseId,
      currencyCode,
      notes: notesRaw || null,
      lines,
    },
  }
}
