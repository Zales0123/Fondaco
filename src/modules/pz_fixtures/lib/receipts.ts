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

/**
 * What a demo document exists to show.
 *
 * Confirming a counted delivery posts its stock, and `pz` refuses that confirmation when the
 * delivery contains a variant `wms` tracks by lot or serial number, because this module
 * captures neither (ADR-0011). Both outcomes are worth demonstrating and neither is worth
 * leaving to chance: before this the builder cycled the catalog blindly, so whether a demo
 * document could be confirmed depended on which products happened to be seeded.
 *
 * - `postable`   — only untracked products, on a Warehouse that has an eligible Destination,
 *                  so a reviewer can confirm it and watch the stock land.
 * - `lotBlocked` — carries a lot-tracked product, so the refusal is visible too.
 * - `mixed`      — promises nothing; fills out the series the way it always did.
 */
export type FixtureIntent = 'postable' | 'lotBlocked' | 'mixed'

export type FixtureReceipt = {
  documentNumber: string
  /** Calendar day, YYYY-MM-DD. Never in the future — the write validator refuses that. */
  documentDate: string
  supplierName: string
  warehouseId: string
  lines: FixtureLine[]
  intent: FixtureIntent
  /**
   * Whether the catalog and the warehouses on hand could actually deliver the intent. A
   * catalog with no untracked product cannot produce a postable document, and demo data that
   * is smaller than planned is not an error — so the document is still built and the
   * shortfall is reported rather than thrown, which is the bargain `dedupeLines` already
   * strikes for a catalog too small to fill two lines.
   */
  intentSatisfied: boolean
}

export type FixtureWarehouse = {
  id: string
  /**
   * Whether at least one of its Locations is an eligible Destination. Absent means "not known
   * to have one", which is the safe reading: a `postable` document placed on a Warehouse with
   * nowhere to post would be refused at confirmation for a reason the demo was not trying to
   * show.
   */
  hasEligibleDestination?: boolean
}

export type FixtureProduct = {
  id: string
  /** `wms` tracks this product's default variant by lot or serial number. */
  tracked?: boolean
  /**
   * The product has exactly one default variant, so `pz` can resolve a line for it at all.
   * Anything else makes `pz.goodsReceipts.create` refuse the whole document, which would
   * quietly cost us the very document a guarantee rests on.
   */
  receivable?: boolean
}

const SUPPLIERS = [
  'Nordwind Logistics',
  'Baltic Textiles Sp. z o.o.',
  'Adriatic Footwear SRL',
  'Hanseatic Supply GmbH',
  'Vistula Trading',
  'Carpathian Goods',
] as const

type PlanEntry = {
  /**
   * Quantities are fixed rather than random so two runs on two machines produce the same
   * documents — a fixture that differs per run is one nobody can describe in a bug report.
   * The fractional values are deliberate: quantity is `numeric(18,4)` and the receiving
   * screens have to render a decimal separator, which is worth seeing in demo data.
   */
  quantities: string[]
  intent: FixtureIntent
}

/**
 * The guaranteed documents come first, because `--release <n>` releases the first N created
 * and only a released document reaches the floor. Warehouses arrive ordered by name and are
 * assigned by rotation, so `--release 3` hands a reviewer a postable delivery on the first
 * warehouse, a lot-blocked one on the second, and a second postable one on the third — which
 * in a demo environment is the demo warehouseman's own warehouse, and therefore the one the
 * floor panel confirms against.
 */
const DOCUMENT_PLAN: PlanEntry[] = [
  { quantities: ['24', '12.5'], intent: 'postable' },
  { quantities: ['40'], intent: 'lotBlocked' },
  { quantities: ['7.5', '3'], intent: 'postable' },
  { quantities: ['120'], intent: 'mixed' },
  { quantities: ['18', '22.25'], intent: 'mixed' },
  { quantities: ['6'], intent: 'mixed' },
  { quantities: ['64', '15'], intent: 'mixed' },
  { quantities: ['9.75'], intent: 'mixed' },
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

function isReceivable(product: FixtureProduct): boolean {
  return product.receivable !== false
}

/**
 * The Warehouse a document lands on. The rotation is what spreads the series across every
 * Warehouse; a `postable` document steps forward from its rotation slot to the next Warehouse
 * that has somewhere to post, and stays put when none does — the document is still worth
 * seeding, it just cannot keep its promise, which the summary then says out loud.
 */
function pickWarehouse(
  warehouses: FixtureWarehouse[],
  index: number,
  requireEligible: boolean,
): FixtureWarehouse {
  const base = index % warehouses.length
  if (!requireEligible) return warehouses[base]
  for (let step = 0; step < warehouses.length; step += 1) {
    const candidate = warehouses[(base + step) % warehouses.length]
    if (candidate.hasEligibleDestination) return candidate
  }
  return warehouses[base]
}

/**
 * Cycling both indexes keeps a two-line document off the same product twice, which the write
 * would reject as a duplicate line. This is the untargeted pick the whole series used before
 * the plan existed, and it is still what a `mixed` document gets.
 */
function cycleProducts(products: FixtureProduct[], index: number, lineCount: number): FixtureProduct[] {
  return Array.from({ length: lineCount }, (_, lineIndex) => products[(index + lineIndex) % products.length])
}

function buildLines(products: FixtureProduct[], quantities: string[]): FixtureLine[] {
  return dedupeLines(
    quantities.map((quantity, lineIndex) => ({
      catalogProductId: products[lineIndex % products.length].id,
      quantity,
    })),
  )
}

type ProductPools = {
  all: FixtureProduct[]
  receivable: FixtureProduct[]
  untracked: FixtureProduct[]
  tracked: FixtureProduct[]
}

export function buildFixtureReceipts(
  warehouses: FixtureWarehouse[],
  products: FixtureProduct[],
  options: { today?: Date } = {},
): FixtureReceipt[] {
  if (warehouses.length === 0 || products.length === 0) return []
  const reference = options.today ?? new Date()
  const total = DOCUMENT_PLAN.length
  const receivable = products.filter(isReceivable)
  const pools: ProductPools = {
    all: products,
    receivable,
    untracked: receivable.filter((product) => !product.tracked),
    tracked: receivable.filter((product) => product.tracked === true),
  }

  return DOCUMENT_PLAN.map((entry, index) => {
    const warehouse = pickWarehouse(warehouses, index, entry.intent === 'postable')
    const { lines, satisfied } = planLines(entry, index, pools)
    return {
      documentNumber: `${FIXTURE_DOCUMENT_PREFIX}${pad(index + 1)}`,
      documentDate: documentDate(reference, index, total),
      supplierName: SUPPLIERS[index % SUPPLIERS.length],
      warehouseId: warehouse.id,
      lines,
      intent: entry.intent,
      intentSatisfied:
        satisfied && (entry.intent !== 'postable' || warehouse.hasEligibleDestination === true),
    }
  })
}

function planLines(
  entry: PlanEntry,
  index: number,
  pools: ProductPools,
): { lines: FixtureLine[]; satisfied: boolean } {
  const lineCount = entry.quantities.length
  const fallback = () => ({
    lines: buildLines(cycleProducts(pools.all, index, lineCount), entry.quantities),
    satisfied: false,
  })

  if (entry.intent === 'postable') {
    // Nothing receivable in the catalog is untracked, so there is no shaping left to do.
    if (pools.untracked.length === 0) return fallback()
    return {
      lines: buildLines(cycleProducts(pools.untracked, index, lineCount), entry.quantities),
      satisfied: true,
    }
  }

  if (entry.intent === 'lotBlocked') {
    if (pools.tracked.length === 0) return fallback()
    // The tracked product leads and the rest of the document is ordinary: one tracked line is
    // all it takes for the confirmation to be refused, and a document that is nothing but the
    // blocker shows less than a normal delivery with a blocker in it. The rest comes from the
    // receivable products only — a line `pz` cannot resolve would cost the whole document, and
    // with it the demonstration.
    const rest = cycleProducts(pools.receivable, index, Math.max(0, lineCount - 1))
    const lines = buildLines([pools.tracked[index % pools.tracked.length], ...rest], entry.quantities)
    const trackedIds = new Set(pools.tracked.map((product) => product.id))
    return { lines, satisfied: lines.some((line) => trackedIds.has(line.catalogProductId)) }
  }

  return {
    lines: buildLines(cycleProducts(pools.all, index, lineCount), entry.quantities),
    satisfied: true,
  }
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
