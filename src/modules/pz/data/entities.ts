import { Collection, OptionalProps } from '@mikro-orm/core'
import {
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy'

/**
 * `receiving` sits between `draft` and `confirmed` (ADR-0008): the office has released the
 * document to the floor, so it is frozen exactly as a confirmed one is, but nothing is final
 * until the floor has counted and the office confirms.
 */
export type GoodsReceiptStatus = 'draft' | 'receiving' | 'confirmed'

/** A released document is frozen for the same reasons a confirmed one is, so both refuse edits. */
export const FROZEN_GOODS_RECEIPT_STATUSES: readonly GoodsReceiptStatus[] = ['receiving', 'confirmed']

/**
 * What became of the attempt to post this document's counted goods into `wms` stock.
 *
 * `not_applicable` is what a document confirmed while the posting toggle was off records —
 * it is not a failure and never becomes one. The rest is the lifecycle of one attempt:
 * `pending` from confirmation until the subscriber runs, then `posted` or `failed`.
 */
export type StockPostingStatus = 'not_applicable' | 'pending' | 'posted' | 'failed'

/**
 * Why a posting failed, as a stable code rather than an exception message: the office reads
 * this, so it is translated at render time, and a raw `wms` error could carry internals a
 * warehouse screen has no business showing.
 */
export type StockPostingFailureReason =
  | 'destination_unusable'
  | 'variant_tracking_required'
  | 'posting_rejected'

export type PalletStatus = 'open' | 'closed'

/** Product name and SKU as they stood when the variant was first counted onto the pallet. */
export type PalletLineCatalogSnapshot = {
  name: string
  sku: string | null
}

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

/**
 * Unit of measure as it stood when the line was saved: the code the document means, plus
 * the product's default at that moment, so a later change to the product's default unit
 * cannot make a past line look like it was entered against a different one.
 */
export type GoodsReceiptUomSnapshot = {
  code: string | null
  productDefaultUnit: string | null
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
/** The panel and the office both list the documents whose stock posting needs attention. */
@Index({
  name: 'pz_goods_receipts_scope_posting_status_idx',
  properties: ['tenantId', 'organizationId', 'stockPostingStatus'],
})
/**
 * Document Numbers are typed by hand, so uniqueness is a data rule rather than a
 * generator invariant. The index is per `(tenant, organization)` so one Organization's
 * numbering series never collides with another's, is `lower(...)` so `ZPZ/1/2026` and
 * `zpz/1/2026` are the same document, and is partial on `deleted_at is null` so deleting
 * a Draft frees its number for reuse (ADR-0006).
 */
@Index({
  name: 'pz_goods_receipts_document_number_unique_idx',
  expression:
    'create unique index "pz_goods_receipts_document_number_unique_idx" on "pz_goods_receipts" ("tenant_id", "organization_id", lower("document_number")) where deleted_at is null',
})
export class GoodsReceipt {
  /** Defaulted by the column, so creating a draft says nothing about a posting that cannot exist yet. */
  [OptionalProps]?: 'stockPostingStatus'

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

  /**
   * `auth:user` id of whoever confirmed, and when. Scalar by contract, and stored because the
   * stock movement `wms` records has to name a person: the posting runs after the request
   * that confirmed has ended, so there is no actor left to ask by then.
   */
  @Property({ name: 'confirmed_by', type: 'uuid', nullable: true })
  confirmedBy?: string | null

  @Property({ name: 'confirmed_at', type: Date, nullable: true })
  confirmedAt?: Date | null

  @Property({ name: 'stock_posting_status', type: 'text', default: 'not_applicable' })
  stockPostingStatus: StockPostingStatus = 'not_applicable'

  @Property({ name: 'stock_posted_at', type: Date, nullable: true })
  stockPostedAt?: Date | null

  /**
   * The `wms:warehouse_location` the counted goods are posted into, pinned at confirmation.
   * It is not re-read from the warehouse's configured Default Destination at posting time:
   * the location is part of the movement idempotency key, so a setting changed between the
   * first attempt and a retry would make the retry post a second movement instead of
   * replaying the first (ADR-0011).
   */
  @Property({ name: 'stock_posting_location_id', type: 'uuid', nullable: true })
  stockPostingLocationId?: string | null

  @Property({ name: 'stock_posting_error', type: 'text', nullable: true })
  stockPostingError?: StockPostingFailureReason | null

  @OneToMany(() => GoodsReceiptLine, (line) => line.goodsReceipt)
  lines = new Collection<GoodsReceiptLine>(this)

  /** In-module relation: a Pallet is part of this document and cannot outlive it (ADR-0009). */
  @OneToMany(() => Pallet, (pallet) => pallet.goodsReceipt)
  pallets = new Collection<Pallet>(this)

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

/**
 * A counting carrier belonging to exactly one Goods Receipt. Counted quantities live here and
 * on its lines, never on `pz_goods_receipt_lines` (ADR-0009): expected and counted are
 * assertions by different authors, and one product legitimately lands on several Pallets.
 *
 * Hard-deleted rather than soft-deleted, and only while `open` and empty, so deleting frees the
 * code. Deleting a Goods Receipt is only possible in `draft`, where no Pallet can exist, so no
 * cascade is needed.
 */
@Entity({ tableName: 'pz_pallets' })
@Index({
  name: 'pz_pallets_scope_receipt_idx',
  properties: ['tenantId', 'organizationId', 'goodsReceipt'],
})
@Index({
  name: 'pz_pallets_receipt_status_idx',
  properties: ['goodsReceipt', 'status'],
})
/**
 * The code is scanned by someone who has not said which document they mean, so it is unique
 * across the whole Organization rather than per receipt (ADR-0010), and `lower(...)` so a
 * scanner that upper-cases cannot mint a second pallet.
 */
@Index({
  name: 'pz_pallets_code_unique_idx',
  expression:
    'create unique index "pz_pallets_code_unique_idx" on "pz_pallets" ("tenant_id", "organization_id", lower("code"))',
})
export class Pallet {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @ManyToOne(() => GoodsReceipt, { fieldName: 'goods_receipt_id' })
  goodsReceipt!: GoodsReceipt

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** Generated at creation and immutable; never user-supplied. */
  @Property({ name: 'code', type: 'text' })
  code!: string

  /** A free note for the floor — decoration, never a lookup key. */
  @Property({ name: 'label', type: 'text', nullable: true })
  label?: string | null

  @Property({ type: 'text', default: 'open' })
  status: PalletStatus = 'open'

  @Property({ name: 'closed_at', type: Date, nullable: true })
  closedAt?: Date | null

  @OneToMany(() => PalletLine, (line) => line.pallet)
  lines = new Collection<PalletLine>(this)

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * One product and its counted quantity on one Pallet. One row per (Pallet, variant): the floor
 * corrects a miscount by editing one number, which an append-only scan log would turn into
 * find-the-wrong-row archaeology. Removal deletes the row — a quantity of zero would assert
 * presence and absence at once.
 */
@Entity({ tableName: 'pz_pallet_lines' })
@Index({
  name: 'pz_pallet_lines_scope_idx',
  properties: ['tenantId', 'organizationId', 'catalogVariantId'],
})
/** One row per (Pallet, variant) is the whole model: the database enforces it, and the count
 *  command turns the unique violation into an add rather than an error. */
@Index({
  name: 'pz_pallet_lines_pallet_variant_unique_idx',
  expression:
    'create unique index "pz_pallet_lines_pallet_variant_unique_idx" on "pz_pallet_lines" ("pallet_id", "catalog_variant_id")',
})
export class PalletLine {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @ManyToOne(() => Pallet, { fieldName: 'pallet_id' })
  pallet!: Pallet

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** `catalog:catalog_product_variant` id. Scalar by contract (ADR-0004, ADR-0007). */
  @Property({ name: 'catalog_variant_id', type: 'uuid' })
  catalogVariantId!: string

  /** Stored alongside the variant so counts can be read product-first. */
  @Property({ name: 'catalog_product_id', type: 'uuid' })
  catalogProductId!: string

  @Property({ name: 'catalog_snapshot', type: 'jsonb', nullable: true })
  catalogSnapshot?: PalletLineCatalogSnapshot | null

  /**
   * Always `> 0`. Counting adds to it, editing replaces it, and it carries no unit: the floor
   * cannot answer a unit question mid-count, so the quantity is in the variant's default unit.
   */
  @Property({ name: 'quantity', type: 'numeric', precision: 18, scale: 4, default: '0' })
  quantity: string = '0'

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
