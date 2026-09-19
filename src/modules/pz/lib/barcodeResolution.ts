/**
 * Resolving a scanned barcode to a catalog variant.
 *
 * The normalisation and the decision it feeds are pure, and the catalog read is injected as
 * a single function, so the rules can be exercised without a database. `catalog` is read
 * through the query engine under the caller's scope and reached by scalar id only — this
 * module holds no ORM relation into it (ADR-0004, ADR-0007).
 */
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { E } from '@/.mercato/generated/entities.ids.generated'

export type VariantBarcodeScope = { tenantId: string; organizationId: string }

export type CountedVariant = {
  catalogVariantId: string
  catalogProductId: string
  name: string
  sku: string | null
  barcode: string
}

export type VariantBarcodeResolution =
  | { kind: 'resolved'; variant: CountedVariant }
  | { kind: 'barcode-required' }
  | { kind: 'unknown'; barcode: string }

/** Every candidate for one normalised barcode; more than one is as unusable as none. */
export type VariantBarcodeLookup = (barcode: string) => Promise<CountedVariant[]>

/**
 * A scanner ends its transmission with a carriage return and may pad the code, and the same
 * field is typed into by hand with gloves on. Control characters are stripped wherever they
 * land rather than only at the end, because a wrapped scan puts them in the middle.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g

export function normalizeBarcode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const normalized = raw.replace(CONTROL_CHARACTERS, '').trim()
  return normalized.length > 0 ? normalized : null
}

/**
 * Exactly one variant counts as resolved. Two variants sharing a barcode is a catalog
 * problem the floor cannot adjudicate mid-count, so it is reported as unknown and the
 * Warehouseman picks the product by hand — the same recovery an unrecognised code gets.
 */
export async function resolveVariantByBarcode(
  raw: unknown,
  lookup: VariantBarcodeLookup,
): Promise<VariantBarcodeResolution> {
  const barcode = normalizeBarcode(raw)
  if (!barcode) return { kind: 'barcode-required' }
  const candidates = await lookup(barcode)
  if (candidates.length !== 1) return { kind: 'unknown', barcode }
  return { kind: 'resolved', variant: candidates[0] }
}

type VariantRow = {
  id: string
  product_id: string
  name: string | null
  sku: string | null
  barcode: string | null
}

type ProductRow = { id: string; title: string | null }

/**
 * Two candidates are read even though one is expected: a barcode shared by two variants has
 * to be detectable, and truncating the page to one would present it as an ordinary match.
 */
async function findVariantsByBarcode(
  queryEngine: QueryEngine,
  scope: VariantBarcodeScope,
  barcode: string,
): Promise<VariantRow[]> {
  const result = await queryEngine.query<VariantRow>(E.catalog.catalog_product_variant, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['id', 'product_id', 'name', 'sku', 'barcode'],
    filters: { barcode: { $eq: barcode } },
    page: { page: 1, pageSize: 2 },
  })
  return result.items
}

async function findProductTitles(
  queryEngine: QueryEngine,
  scope: VariantBarcodeScope,
  productIds: string[],
): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map()
  const result = await queryEngine.query<ProductRow>(E.catalog.catalog_product, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['id', 'title'],
    filters: { id: { $in: productIds } },
    page: { page: 1, pageSize: productIds.length },
  })
  return new Map(result.items.map((product) => [String(product.id), product.title ?? '']))
}

/**
 * A variant may carry no name of its own, in which case the product's title is what the
 * floor recognises on the shelf; the SKU is the last resort so a row is never nameless.
 */
export function toCountedVariant(row: VariantRow, productTitle: string | null, barcode: string): CountedVariant {
  const name = row.name?.trim() || productTitle?.trim() || row.sku?.trim() || ''
  return {
    catalogVariantId: String(row.id),
    catalogProductId: String(row.product_id),
    name,
    sku: row.sku ?? null,
    barcode: row.barcode ?? barcode,
  }
}

export function createVariantBarcodeLookup(
  queryEngine: QueryEngine,
  scope: VariantBarcodeScope,
): VariantBarcodeLookup {
  return async (barcode: string) => {
    const variants = await findVariantsByBarcode(queryEngine, scope, barcode)
    if (variants.length === 0) return []
    const titles = await findProductTitles(
      queryEngine,
      scope,
      Array.from(new Set(variants.map((variant) => String(variant.product_id)))),
    )
    return variants.map((variant) => toCountedVariant(variant, titles.get(String(variant.product_id)) ?? null, barcode))
  }
}
