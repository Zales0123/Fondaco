import { Migration } from '@mikro-orm/migrations';

export class Migration20260918232359_pz extends Migration {

  override name = 'Migration20260918232359';

  override up(): void | Promise<void> {
    this.addSql(`create table "pz_goods_receipts" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "document_number" text not null, "document_date" date not null, "supplier_name" text not null, "warehouse_id" uuid not null, "warehouse_snapshot" jsonb null, "status" text not null default 'draft', "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "pz_goods_receipts_document_number_unique_idx" on "pz_goods_receipts" ("tenant_id", "organization_id", lower("document_number")) where deleted_at is null;`);
    this.addSql(`create index "pz_goods_receipts_scope_warehouse_idx" on "pz_goods_receipts" ("tenant_id", "organization_id", "warehouse_id");`);
    this.addSql(`create index "pz_goods_receipts_scope_status_idx" on "pz_goods_receipts" ("tenant_id", "organization_id", "status");`);
    this.addSql(`create index "pz_goods_receipts_scope_document_date_idx" on "pz_goods_receipts" ("tenant_id", "organization_id", "document_date");`);

    this.addSql(`create table "pz_goods_receipt_lines" ("id" uuid not null default gen_random_uuid(), "goods_receipt_id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "line_number" int not null default 0, "catalog_variant_id" uuid not null, "catalog_product_id" uuid not null, "catalog_snapshot" jsonb null, "quantity" numeric(18,4) not null default '0', "unit" text null, "uom_snapshot" jsonb null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "pz_goods_receipt_lines_scope_idx" on "pz_goods_receipt_lines" ("tenant_id", "organization_id", "catalog_variant_id");`);
    this.addSql(`create index "pz_goods_receipt_lines_receipt_idx" on "pz_goods_receipt_lines" ("goods_receipt_id", "line_number");`);

    this.addSql(`alter table "pz_goods_receipt_lines" add constraint "pz_goods_receipt_lines_goods_receipt_id_foreign" foreign key ("goods_receipt_id") references "pz_goods_receipts" ("id");`);
  }

}
