import type {
  GoodsReceiptCatalogSnapshot,
  GoodsReceiptStatus,
  GoodsReceiptUomSnapshot,
  GoodsReceiptWarehouseSnapshot,
} from '../data/entities'

export type GoodsReceiptLineItem = {
  id: string
  lineNumber: number
  catalogProductId: string
  catalogVariantId: string
  catalogSnapshot: GoodsReceiptCatalogSnapshot | null
  quantity: string
  unit: string | null
  uomSnapshot: GoodsReceiptUomSnapshot | null
}

/** Raw projection the query engine returns for a Goods Receipt list row. */
export type GoodsReceiptListRow = {
  id: string
  document_number: string
  document_date: Date | string | null
  supplier_name: string
  warehouse_id: string
  warehouse_snapshot: GoodsReceiptWarehouseSnapshot | null
  status: string
  updated_at: Date | string | null
}

export type GoodsReceiptListItem = {
  id: string
  documentNumber: string
  /** Day-granular `YYYY-MM-DD`; never a timestamp, so no timezone can shift the day. */
  documentDate: string | null
  supplierName: string
  warehouseId: string
  warehouseSnapshot: GoodsReceiptWarehouseSnapshot | null
  status: GoodsReceiptStatus
  lineCount: number
  palletCount: number
  /**
   * Only a single-record read carries the lines; a grid page reports `null` rather than an
   * empty array, so "not loaded" and "has no lines" never look the same.
   */
  lines: GoodsReceiptLineItem[] | null
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

function toStatus(value: unknown): GoodsReceiptStatus {
  return value === 'confirmed' || value === 'receiving' ? value : 'draft'
}

function toWarehouseSnapshot(value: unknown): GoodsReceiptWarehouseSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<GoodsReceiptWarehouseSnapshot>
  if (typeof candidate.name !== 'string' || typeof candidate.code !== 'string') return null
  return { name: candidate.name, code: candidate.code }
}

export type GoodsReceiptLineRow = {
  id: string
  goods_receipt_id: string
  line_number: number
  catalog_product_id: string
  catalog_variant_id: string
  catalog_snapshot: GoodsReceiptCatalogSnapshot | null
  quantity: string | number
  unit: string | null
  uom_snapshot: GoodsReceiptUomSnapshot | null
}

export function toGoodsReceiptLineItem(row: GoodsReceiptLineRow): GoodsReceiptLineItem {
  return {
    id: String(row.id),
    lineNumber: Number(row.line_number),
    catalogProductId: String(row.catalog_product_id),
    catalogVariantId: String(row.catalog_variant_id),
    catalogSnapshot: row.catalog_snapshot ?? null,
    quantity: String(row.quantity),
    unit: row.unit ?? null,
    uomSnapshot: row.uom_snapshot ?? null,
  }
}

/**
 * Counts start at 0 and are filled by the route's `afterList` hook, so the response
 * shape is identical whether or not the aggregate could be resolved.
 */
export function toGoodsReceiptListItem(row: GoodsReceiptListRow): GoodsReceiptListItem {
  return {
    id: String(row.id),
    documentNumber: String(row.document_number),
    documentDate: toIsoDay(row.document_date),
    supplierName: String(row.supplier_name),
    warehouseId: String(row.warehouse_id),
    warehouseSnapshot: toWarehouseSnapshot(row.warehouse_snapshot),
    status: toStatus(row.status),
    lineCount: 0,
    palletCount: 0,
    lines: null,
    updatedAt: toIsoTimestamp(row.updated_at),
  }
}
