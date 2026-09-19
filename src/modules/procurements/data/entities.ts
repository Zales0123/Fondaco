import { Collection } from '@mikro-orm/core'
import {
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy'

/**
 * Stage 1 of `.ai/specs/2026-09-19-purchasing-inbound-ui-proposal.md` covers ordering only:
 * a Purchase Order is a draft while the buyer is writing it, `released` once it is the
 * organization's standing order, and `cancelled` when it will not be fulfilled.
 *
 * `released` deliberately does not mean "sent to the supplier", and there is no
 * `partially_received`/`received`/`closed` here: those depend on confirmed goods movements
 * that stage 2 (Awizo/PZ posting) introduces, and adding them now would put statuses on
 * screen that nothing can ever set.
 */
export type PurchaseOrderStatus = 'draft' | 'released' | 'cancelled'

/** A released or cancelled order is no longer a working document, so both refuse edits. */
export const FROZEN_PURCHASE_ORDER_STATUSES: readonly PurchaseOrderStatus[] = ['released', 'cancelled']

/**
 * Supplier name and code as they stood when the order was released.
 *
 * The supplier register is a separate module still to be built (issue #51). Until it exists
 * the order carries a typed name and `supplierId` stays null; once it does, the id points at
 * the record and this snapshot keeps a released order readable after a rename.
 */
export type PurchaseOrderSupplierSnapshot = {
  name: string
  code: string | null
}

/** Warehouse name and code as they stood when the order was released. */
export type PurchaseOrderWarehouseSnapshot = {
  name: string
  code: string
}

/** Product name and SKU as they stood when the line was saved. */
export type PurchaseOrderCatalogSnapshot = {
  name: string
  sku: string | null
}

/**
 * Unit of measure as it stood when the line was saved: the code the order means, plus the
 * product's default at that moment, so a later change to the product's default unit cannot
 * make a past line look like it was ordered in a different one.
 */
export type PurchaseOrderUomSnapshot = {
  code: string | null
  productDefaultUnit: string | null
}

@Entity({ tableName: 'procurements_purchase_orders' })
@Index({
  name: 'procurements_purchase_orders_scope_order_date_idx',
  properties: ['tenantId', 'organizationId', 'orderDate'],
})
@Index({
  name: 'procurements_purchase_orders_scope_status_idx',
  properties: ['tenantId', 'organizationId', 'status'],
})
@Index({
  name: 'procurements_purchase_orders_scope_warehouse_idx',
  properties: ['tenantId', 'organizationId', 'warehouseId'],
})
/**
 * Document Numbers are typed by hand, the same way the Goods Receipt series is, so
 * uniqueness is a data rule rather than a generator invariant. Per `(tenant, organization)`
 * so one Organization's numbering never collides with another's, `lower(...)` so `ZZ/1/2026`
 * and `zz/1/2026` are the same order, and partial on `deleted_at is null` so deleting a
 * draft frees its number for reuse.
 */
@Index({
  name: 'procurements_purchase_orders_document_number_unique_idx',
  expression:
    'create unique index "procurements_purchase_orders_document_number_unique_idx" on "procurements_purchase_orders" ("tenant_id", "organization_id", lower("document_number")) where deleted_at is null',
})
export class PurchaseOrder {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'document_number', type: 'text' })
  documentNumber!: string

  /** Day-granular: commercial paperwork has no clock, and a timestamp would only invite timezone drift. */
  @Property({ name: 'order_date', type: 'date' })
  orderDate!: Date

  /**
   * The delivery date the whole order is expected by. It prefills each line's own date and
   * is nullable, because an order placed against an open call-off has no single date yet.
   */
  @Property({ name: 'expected_date', type: 'date', nullable: true })
  expectedDate?: Date | null

  /**
   * The future supplier register's id (issue #51). Null until that module exists; the name
   * below is what the document says in the meantime. Scalar by contract — no cross-module
   * ORM relation.
   */
  @Property({ name: 'supplier_id', type: 'uuid', nullable: true })
  supplierId?: string | null

  @Property({ name: 'supplier_name', type: 'text' })
  supplierName!: string

  /** Taken at release, so a released order still names its supplier after a later rename. */
  @Property({ name: 'supplier_snapshot', type: 'jsonb', nullable: true })
  supplierSnapshot?: PurchaseOrderSupplierSnapshot | null

  /** `wms:warehouse` id. Scalar by contract: no cross-module ORM relation. */
  @Property({ name: 'warehouse_id', type: 'uuid' })
  warehouseId!: string

  /** Taken at release, so a released order still names its warehouse after that warehouse is removed. */
  @Property({ name: 'warehouse_snapshot', type: 'jsonb', nullable: true })
  warehouseSnapshot?: PurchaseOrderWarehouseSnapshot | null

  /**
   * ISO-4217 code the prices on this order are written in. One currency per document: a line
   * priced in another would make the order total meaningless.
   */
  @Property({ name: 'currency_code', type: 'text', default: 'PLN' })
  currencyCode: string = 'PLN'

  @Property({ type: 'text', default: 'draft' })
  status: PurchaseOrderStatus = 'draft'

  /** Free text for the buyer — terms, a call-off reference, anything the supplier should read. */
  @Property({ type: 'text', nullable: true })
  notes?: string | null

  @OneToMany(() => PurchaseOrderLine, (line) => line.purchaseOrder)
  lines = new Collection<PurchaseOrderLine>(this)

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'procurements_purchase_order_lines' })
@Index({
  name: 'procurements_purchase_order_lines_order_idx',
  properties: ['purchaseOrder', 'lineNumber'],
})
@Index({
  name: 'procurements_purchase_order_lines_scope_variant_idx',
  properties: ['tenantId', 'organizationId', 'catalogVariantId'],
})
/** The cross-order line view's default sort, and how a buyer looks for what is due next. */
@Index({
  name: 'procurements_purchase_order_lines_scope_expected_date_idx',
  properties: ['tenantId', 'organizationId', 'expectedDate'],
})
export class PurchaseOrderLine {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @ManyToOne(() => PurchaseOrder, { fieldName: 'purchase_order_id' })
  purchaseOrder!: PurchaseOrder

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /**
   * Explicit and stable, because the same product may legitimately appear on two lines at
   * different prices or dates, and a later delivery has to be able to say which one it
   * settles.
   */
  @Property({ name: 'line_number', type: 'integer', default: 0 })
  lineNumber: number = 0

  /** `catalog:catalog_product_variant` id — required, matching how every `wms` entity keys products. */
  @Property({ name: 'catalog_variant_id', type: 'uuid' })
  catalogVariantId!: string

  /** `catalog:catalog_product` id, stored alongside the variant so the order can be queried product-first. */
  @Property({ name: 'catalog_product_id', type: 'uuid' })
  catalogProductId!: string

  @Property({ name: 'catalog_snapshot', type: 'jsonb', nullable: true })
  catalogSnapshot?: PurchaseOrderCatalogSnapshot | null

  /** Same precision the installed `sales` module uses for line quantities. */
  @Property({ name: 'quantity_ordered', type: 'numeric', precision: 18, scale: 4, default: '0' })
  quantityOrdered: string = '0'

  /** Prefilled from the product's default unit and editable, so a product without configured conversions does not hard-fail. */
  @Property({ name: 'unit', type: 'text', nullable: true })
  unit?: string | null

  @Property({ name: 'uom_snapshot', type: 'jsonb', nullable: true })
  uomSnapshot?: PurchaseOrderUomSnapshot | null

  /**
   * Net price for one unit, in the order's currency. Four decimals because purchase prices
   * routinely carry more precision than the two a total is rounded to.
   */
  @Property({ name: 'unit_price_net', type: 'numeric', precision: 18, scale: 4, default: '0' })
  unitPriceNet: string = '0'

  /** This line's own delivery date; prefilled from the header and editable per line. */
  @Property({ name: 'expected_date', type: 'date', nullable: true })
  expectedDate?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
