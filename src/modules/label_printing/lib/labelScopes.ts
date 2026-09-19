/**
 * What a label can be printed for.
 *
 * A scope resolves a record into "a value plus the symbology that encodes it".
 * Keeping that behind one interface is what stops the printer from ever
 * learning about products: adding order or warehouse-bin labels later is a new
 * registration here, not a change to the route, the widget or the driver.
 */
import type { EntityManager } from '@mikro-orm/postgresql'
import type { BarcodeSymbology } from './barcodeImage'

export type LabelScopeId = 'catalog.product'

export type LabelSubject = {
  symbology: BarcodeSymbology
  value: string
  /** Identifies the record in logs; never printed. */
  describe: string
}

export class LabelNotAvailableError extends Error {
  readonly code = 'label-not-available' as const
  /** Translation key for the message shown to the operator. */
  readonly messageKey: string
  constructor(messageKey: string, message: string) {
    super(message)
    this.name = 'LabelNotAvailableError'
    this.messageKey = messageKey
  }
}

export type LabelScopeContext = {
  em: EntityManager
  tenantId: string
  organizationId: string
}

export type LabelScopeResolver = (id: string, ctx: LabelScopeContext) => Promise<LabelSubject>

/**
 * GTIN types the catalog stores, mapped to the symbology that renders them.
 *
 * `asin` and `mpn` are deliberately absent: they are catalog identifiers, not
 * barcode standards, so they fall through to Code128 like a bare SKU would.
 * `isbn` is omitted for now — ISBN-13 is structurally EAN-13, but ISBN-10 is
 * not, and silently printing the wrong one is worse than refusing.
 */
const GTIN_SYMBOLOGY: Record<string, BarcodeSymbology | undefined> = {
  ean13: 'ean13',
  ean8: 'ean8',
  upc: 'upca',
}

type VariantRow = {
  id: string
  sku: string | null
  barcode: string | null
  gtin_type: string | null
  is_default: boolean
}

/**
 * Cross-module read as scalar SQL by id only — the pattern AGENTS.md requires
 * and that `wms_fixtures` and the installed wms module both use for catalog.
 */
async function loadProductVariants(
  productId: string,
  ctx: LabelScopeContext,
): Promise<VariantRow[]> {
  return (await ctx.em.getConnection().execute(
    `select id, sku, barcode, gtin_type, is_default
       from catalog_product_variants
      where product_id = ? and tenant_id = ? and organization_id = ?
        and deleted_at is null and is_active = true
      order by is_default desc, sku asc nulls last, id asc`,
    [productId, ctx.tenantId, ctx.organizationId],
  )) as VariantRow[]
}

/**
 * A product is not itself barcoded — `barcode` and `gtinType` live on the
 * variant — so printing from the product grid has to pick one. The default
 * variant wins; a single variant is unambiguous; anything else is refused
 * rather than guessed, because printing the wrong variant's barcode produces a
 * label that scans as the wrong product.
 */
const resolveCatalogProduct: LabelScopeResolver = async (productId, ctx) => {
  const variants = await loadProductVariants(productId, ctx)

  if (!variants.length) {
    throw new LabelNotAvailableError(
      'label_printing.print.error.noVariant',
      `Product ${productId} has no active variant to print a label for`,
    )
  }

  const variant = variants.find((row) => row.is_default) ?? (variants.length === 1 ? variants[0] : null)
  if (!variant) {
    throw new LabelNotAvailableError(
      'label_printing.print.error.ambiguousVariant',
      `Product ${productId} has ${variants.length} variants and no default; cannot choose one`,
    )
  }

  const barcode = variant.barcode?.trim()
  if (!barcode) {
    throw new LabelNotAvailableError(
      'label_printing.print.error.noBarcode',
      `Variant ${variant.sku ?? variant.id} has no barcode`,
    )
  }

  const symbology = variant.gtin_type ? GTIN_SYMBOLOGY[variant.gtin_type] : undefined
  if (!symbology) {
    throw new LabelNotAvailableError(
      'label_printing.print.error.unsupportedGtin',
      `Variant ${variant.sku ?? variant.id} has gtin type `
      + `"${variant.gtin_type ?? 'none'}", which is not a printable barcode standard`,
    )
  }

  return {
    symbology,
    value: barcode,
    describe: `variant ${variant.sku ?? variant.id}`,
  }
}

const RESOLVERS: Record<LabelScopeId, LabelScopeResolver> = {
  'catalog.product': resolveCatalogProduct,
}

export const LABEL_SCOPE_IDS = Object.keys(RESOLVERS) as LabelScopeId[]

export function isLabelScopeId(value: string): value is LabelScopeId {
  return Object.prototype.hasOwnProperty.call(RESOLVERS, value)
}

export function resolveLabelSubject(
  scope: LabelScopeId,
  id: string,
  ctx: LabelScopeContext,
): Promise<LabelSubject> {
  return RESOLVERS[scope](id, ctx)
}
