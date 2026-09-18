import { Collection } from '@mikro-orm/core'
import {
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy'

export type GoodsReceiptStatus = 'draft' | 'confirmed'

/** Warehouse name and code as they stood when the document was confirmed. */
export type GoodsReceiptWarehouseSnapshot = {
  name: string
  code: string
}

/** Product name and SKU as they stood when the line was saved. */
export type GoodsReceiptCatalogSnapshot = {
  name: string
  sku: string | null
}

/** Unit of measure as it stood when the line was saved. */
export type GoodsReceiptUomSnapshot = {
  code: string | null
  label: string | null
}

@Entity({ tableName: 'pz_goods_receipts' })
@Index({
  name: 'pz_goods_receipts_scope_document_date_idx',
  properties: ['tenantId', 'organizationId', 'documentDate'],
})
@Index({
  name: 'pz_goods_receipts_scope_status_idx',
  properties: ['tenantId', 'organizationId', 'status'],
})
@Index({
  name: 'pz_goods_receipts_scope_warehouse_idx',
  properties: ['tenantId', 'organizationId', 'warehouseId'],
})
/**
 * Document Numbers are typed by hand, so uniqueness is a data rule rather than a
 * generator invariant. The index is per `(tenant, organization)` so one Organization's
 * numbering series never collides with another's, is `lower(...)` so `PZ/1/2026` and
 * `pz/1/2026` are the same document, and is partial on `deleted_at is null` so deleting
 * a Draft frees its number for reuse (ADR-0006).
 */
@Index({
  name: 'pz_goods_receipts_document_number_unique_idx',
  expression:
    'create unique index "pz_goods_receipts_document_number_unique_idx" on "pz_goods_receipts" ("tenant_id", "organization_id", lower("document_number")) where deleted_at is null',
})
export class GoodsReceipt {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'document_number', type: 'text' })
  documentNumber!: string

  /** Day-granular on purpose: warehouse paperwork has no clock, and a timestamp here would only invite timezone drift. */
  @Property({ name: 'document_date', type: 'date' })
  documentDate!: Date

  /** A name, not a record — the app holds no supplier entity. Named so a `supplier_id` can join it later. */
  @Property({ name: 'supplier_name', type: 'text' })
  supplierName!: string

  /** `wms:warehouse` id. Scalar by contract: no cross-module ORM relation (ADR-0004). */
  @Property({ name: 'warehouse_id', type: 'uuid' })
  warehouseId!: string

  /** Taken at confirmation, so a confirmed document still names its Warehouse after that Warehouse is removed. */
  @Property({ name: 'warehouse_snapshot', type: 'jsonb', nullable: true })
  warehouseSnapshot?: GoodsReceiptWarehouseSnapshot | null

  @Property({ type: 'text', default: 'draft' })
  status: GoodsReceiptStatus = 'draft'

  @OneToMany(() => GoodsReceiptLine, (line) => line.goodsReceipt)
  lines = new Collection<GoodsReceiptLine>(this)

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'pz_goods_receipt_lines' })
@Index({
  name: 'pz_goods_receipt_lines_receipt_idx',
  properties: ['goodsReceipt', 'lineNumber'],
})
@Index({
  name: 'pz_goods_receipt_lines_scope_idx',
  properties: ['tenantId', 'organizationId', 'catalogVariantId'],
})
export class GoodsReceiptLine {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @ManyToOne(() => GoodsReceipt, { fieldName: 'goods_receipt_id' })
  goodsReceipt!: GoodsReceipt

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** Explicit, because the same product may legitimately appear on two lines. */
  @Property({ name: 'line_number', type: 'integer', default: 0 })
  lineNumber: number = 0

  /** `catalog:catalog_product_variant` id — required, matching how every `wms` entity keys products (ADR-0007). */
  @Property({ name: 'catalog_variant_id', type: 'uuid' })
  catalogVariantId!: string

  /** `catalog:catalog_product` id, stored alongside the variant so the document can be queried product-first. */
  @Property({ name: 'catalog_product_id', type: 'uuid' })
  catalogProductId!: string

  @Property({ name: 'catalog_snapshot', type: 'jsonb', nullable: true })
  catalogSnapshot?: GoodsReceiptCatalogSnapshot | null

  /** Same precision the installed `sales` module uses for line quantities. */
  @Property({ name: 'quantity', type: 'numeric', precision: 18, scale: 4, default: '0' })
  quantity: string = '0'

  /** Prefilled from the product's default unit and editable, so a product without configured conversions does not hard-fail. */
  @Property({ name: 'unit', type: 'text', nullable: true })
  unit?: string | null

  @Property({ name: 'uom_snapshot', type: 'jsonb', nullable: true })
  uomSnapshot?: GoodsReceiptUomSnapshot | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
