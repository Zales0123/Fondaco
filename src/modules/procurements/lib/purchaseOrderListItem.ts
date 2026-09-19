import type {
  PurchaseOrderCatalogSnapshot,
  PurchaseOrderStatus,
  PurchaseOrderSupplierSnapshot,
  PurchaseOrderUomSnapshot,
  PurchaseOrderWarehouseSnapshot,
} from '../data/entities'
import { lineNetValue } from './decimal'

export type PurchaseOrderLineItem = {
  id: string
  lineNumber: number
  catalogProductId: string
  catalogVariantId: string
  catalogSnapshot: PurchaseOrderCatalogSnapshot | null
  quantityOrdered: string
  unit: string | null
  uomSnapshot: PurchaseOrderUomSnapshot | null
  unitPriceNet: string
  /** quantity × price, rounded once on the server so every screen prints the same value. */
  netValue: string | null
  expectedDate: string | null
  /**
   * How much of this line warehouse announcements currently hold, and how much a new one
   * could still take. Both are `null` until the route has read the commitment ledger, so a
   * response that could not answer never shows a confident zero.
   */
  quantityAnnounced: string | null
  quantityFree: string | null
}

/** Raw projection the query engine returns for a Purchase Order list row. */
export type PurchaseOrderListRow = {
  id: string
  document_number: string
  order_date: Date | string | null
  expected_date: Date | string | null
  supplier_id: string | null
  supplier_name: string
  supplier_snapshot: PurchaseOrderSupplierSnapshot | null
  warehouse_id: string
  warehouse_snapshot: PurchaseOrderWarehouseSnapshot | null
  currency_code: string
  status: string
  notes: string | null
  updated_at: Date | string | null
}

export type PurchaseOrderListItem = {
  id: string
  documentNumber: string
  /** Day-granular `YYYY-MM-DD`; never a timestamp, so no timezone can shift the day. */
  orderDate: string | null
  expectedDate: string | null
  supplierId: string | null
  supplierName: string
  supplierSnapshot: PurchaseOrderSupplierSnapshot | null
  warehouseId: string
  warehouseSnapshot: PurchaseOrderWarehouseSnapshot | null
  currencyCode: string
  status: PurchaseOrderStatus
  notes: string | null
  lineCount: number
  /** Sum of the lines' rounded net values; `null` while the aggregate has not been resolved. */
  netTotal: string | null
  /**
   * Only a single-record read carries the lines; a grid page reports `null` rather than an
   * empty array, so "not loaded" and "has no lines" never look the same.
   */
  lines: PurchaseOrderLineItem[] | null
  updatedAt: string | null
}

export function toIsoDay(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10)
  }
  const text = String(value)
  // The `date` column already arrives as `YYYY-MM-DD` from the driver; anything else is
  // parsed rather than trusted, so a stray timestamp still yields a calendar day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

export function toIsoTimestamp(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export function toPurchaseOrderStatus(value: unknown): PurchaseOrderStatus {
  return value === 'released' || value === 'cancelled' ? value : 'draft'
}

function toSupplierSnapshot(value: unknown): PurchaseOrderSupplierSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PurchaseOrderSupplierSnapshot>
  if (typeof candidate.name !== 'string') return null
  return { name: candidate.name, code: typeof candidate.code === 'string' ? candidate.code : null }
}

function toWarehouseSnapshot(value: unknown): PurchaseOrderWarehouseSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PurchaseOrderWarehouseSnapshot>
  if (typeof candidate.name !== 'string' || typeof candidate.code !== 'string') return null
  return { name: candidate.name, code: candidate.code }
}

export type PurchaseOrderLineRow = {
  id: string
  purchase_order_id: string
  line_number: number
  catalog_product_id: string
  catalog_variant_id: string
  catalog_snapshot: PurchaseOrderCatalogSnapshot | null
  quantity_ordered: string | number
  unit: string | null
  uom_snapshot: PurchaseOrderUomSnapshot | null
  unit_price_net: string | number
  expected_date: Date | string | null
}

export function toPurchaseOrderLineItem(row: PurchaseOrderLineRow): PurchaseOrderLineItem {
  const quantityOrdered = String(row.quantity_ordered)
  const unitPriceNet = String(row.unit_price_net)
  return {
    id: String(row.id),
    lineNumber: Number(row.line_number),
    catalogProductId: String(row.catalog_product_id),
    catalogVariantId: String(row.catalog_variant_id),
    catalogSnapshot: row.catalog_snapshot ?? null,
    quantityOrdered,
    unit: row.unit ?? null,
    uomSnapshot: row.uom_snapshot ?? null,
    unitPriceNet,
    netValue: lineNetValue(quantityOrdered, unitPriceNet),
    expectedDate: toIsoDay(row.expected_date),
    quantityAnnounced: null,
    quantityFree: null,
  }
}

/**
 * The aggregate fields start unresolved and are filled by the route's `afterList` hook, so
 * the response shape is identical whether or not they could be read: `lineCount` at 0 with a
 * `null` total says "not counted yet" rather than claiming an empty order.
 */
export function toPurchaseOrderListItem(row: PurchaseOrderListRow): PurchaseOrderListItem {
  return {
    id: String(row.id),
    documentNumber: String(row.document_number),
    orderDate: toIsoDay(row.order_date),
    expectedDate: toIsoDay(row.expected_date),
    supplierId: row.supplier_id ? String(row.supplier_id) : null,
    supplierName: String(row.supplier_name),
    supplierSnapshot: toSupplierSnapshot(row.supplier_snapshot),
    warehouseId: String(row.warehouse_id),
    warehouseSnapshot: toWarehouseSnapshot(row.warehouse_snapshot),
    currencyCode: String(row.currency_code ?? 'PLN'),
    status: toPurchaseOrderStatus(row.status),
    notes: row.notes ?? null,
    lineCount: 0,
    netTotal: null,
    lines: null,
    updatedAt: toIsoTimestamp(row.updated_at),
  }
}

/**
 * One row of the cross-order line view: the line itself plus the few header facts a buyer
 * needs to recognise it. The header values are copied onto the row rather than nested, so
 * the table can sort and filter on them without unpacking an object per cell.
 */
export type PurchaseOrderLineListItem = PurchaseOrderLineItem & {
  purchaseOrderId: string
  documentNumber: string
  supplierName: string
  warehouseId: string
  status: PurchaseOrderStatus
  currencyCode: string
  orderDate: string | null
  updatedAt: string | null
}
