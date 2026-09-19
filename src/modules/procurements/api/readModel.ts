import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import type {
  PurchaseOrderCatalogSnapshot,
  PurchaseOrderSupplierSnapshot,
  PurchaseOrderUomSnapshot,
  PurchaseOrderWarehouseSnapshot,
} from '../data/entities'

/**
 * The columns the list routes read directly through Kysely, for aggregates and for the
 * literal free-text match the query engine's tokenizer cannot do. Only the columns those
 * reads actually project are declared; this is a read model, not a second schema definition.
 */
export type ProcurementsReadDatabase = {
  procurements_purchase_orders: {
    id: string
    tenant_id: string
    organization_id: string
    document_number: string
    order_date: Date | string | null
    supplier_name: string
    supplier_snapshot: PurchaseOrderSupplierSnapshot | null
    warehouse_id: string
    warehouse_snapshot: PurchaseOrderWarehouseSnapshot | null
    currency_code: string
    status: string
    deleted_at: Date | null
  }
  procurements_purchase_order_lines: {
    id: string
    purchase_order_id: string
    tenant_id: string
    organization_id: string
    line_number: number
    catalog_product_id: string
    catalog_variant_id: string
    catalog_snapshot: PurchaseOrderCatalogSnapshot | null
    quantity_ordered: string
    unit: string | null
    uom_snapshot: PurchaseOrderUomSnapshot | null
    unit_price_net: string
    expected_date: Date | string | null
  }
}

/**
 * Mirrors the scope the CRUD factory applied to the rows themselves: `null` is the only value
 * that means unrestricted within the tenant, and an empty array is deny-all — the factory
 * short-circuits that case to an empty page, so widening it back to the selected organization
 * here would read rows the caller was refused.
 */
export function resolveScopedOrganizationIds(ctx: CrudCtx): string[] | null {
  if (ctx.organizationIds === null) return null
  if (!Array.isArray(ctx.organizationIds)) return []
  return Array.from(
    new Set(
      ctx.organizationIds.filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  )
}
