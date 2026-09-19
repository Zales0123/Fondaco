/**
 * The demo document series.
 *
 * `pz` deliberately ships no `seedExamples`, on the grounds that a demo delivery is
 * indistinguishable from a real one in a series users reconcile against paper. These
 * fixtures keep that property by never entering the real series at all: every document
 * number carries this prefix, so a demo receipt is recognisable at a glance and in a
 * `like` query, and `ZPZ-2026-0001` stays free for the office to type.
 */
export const FIXTURE_DOCUMENT_PREFIX = 'ZPZ-DEMO-'

export type FixtureLine = {
  catalogProductId: string
  /** A decimal string: a JSON number cannot carry a fractional quantity faithfully. */
  quantity: string
}

export type FixtureReceipt = {
  documentNumber: string
  /** Calendar day, YYYY-MM-DD. Never in the future — the write validator refuses that. */
  documentDate: string
  supplierName: string
  warehouseId: string
  lines: FixtureLine[]
}

type WarehouseLike = { id: string }
type ProductLike = { id: string }

const SUPPLIERS = [
  'Nordwind Logistics',
  'Baltic Textiles Sp. z o.o.',
  'Adriatic Footwear SRL',
  'Hanseatic Supply GmbH',
  'Vistula Trading',
  'Carpathian Goods',
] as const

/**
 * Quantities are fixed rather than random so two runs on two machines produce the same
 * documents — a fixture that differs per run is one nobody can describe in a bug report.
 * The fractional values are deliberate: quantity is `numeric(18,4)` and the receiving
 * screens have to render a decimal separator, which is worth seeing in demo data.
 */
const QUANTITY_PLAN: string[][] = [
  ['24', '12.5'],
  ['40'],
  ['7.5', '3'],
  ['120'],
  ['18', '22.25'],
  ['6'],
  ['64', '15'],
  ['9.75'],
]

function pad(value: number): string {
  return String(value).padStart(4, '0')
}

function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Walks backwards from the reference day so no document is dated in the future, and so a
 * freshly seeded environment shows a plausible recent run of deliveries rather than eight
 * documents stamped with the same day.
 */
function documentDate(reference: Date, index: number, total: number): string {
  const day = new Date(reference.getTime())
  day.setUTCDate(day.getUTCDate() - (total - 1 - index))
  return toIsoDay(day)
}

export function buildFixtureReceipts(
  warehouses: WarehouseLike[],
  products: ProductLike[],
  options: { today?: Date } = {},
): FixtureReceipt[] {
  if (warehouses.length === 0 || products.length === 0) return []
  const reference = options.today ?? new Date()
  const total = QUANTITY_PLAN.length

  return QUANTITY_PLAN.map((quantities, index) => ({
    documentNumber: `${FIXTURE_DOCUMENT_PREFIX}${pad(index + 1)}`,
    documentDate: documentDate(reference, index, total),
    supplierName: SUPPLIERS[index % SUPPLIERS.length],
    warehouseId: warehouses[index % warehouses.length].id,
    lines: quantities.map((quantity, lineIndex) => ({
      // Cycling both indexes keeps a two-line document off the same product twice, which
      // the write would reject as a duplicate line.
      catalogProductId: products[(index + lineIndex) % products.length].id,
      quantity,
    })),
  })).map((receipt) => ({
    ...receipt,
    lines: dedupeLines(receipt.lines),
  }))
}

/**
 * With a single stockable product in the catalog, cycling cannot avoid a collision, so the
 * duplicate is dropped rather than sent — a refused write would fail the whole seed over
 * demo data that is allowed to be smaller than planned.
 */
function dedupeLines(lines: FixtureLine[]): FixtureLine[] {
  const seen = new Set<string>()
  return lines.filter((line) => {
    if (seen.has(line.catalogProductId)) return false
    seen.add(line.catalogProductId)
    return true
  })
}
