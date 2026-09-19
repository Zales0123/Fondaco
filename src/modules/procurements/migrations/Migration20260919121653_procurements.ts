import { Migration } from '@mikro-orm/migrations';

export class Migration20260919121653_procurements extends Migration {

  override name = 'Migration20260919121653';

  override up(): void | Promise<void> {
    this.addSql(`create table "procurements_purchase_orders" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "document_number" text not null, "order_date" date not null, "expected_date" date null, "supplier_id" uuid null, "supplier_name" text not null, "supplier_snapshot" jsonb null, "warehouse_id" uuid not null, "warehouse_snapshot" jsonb null, "currency_code" text not null default 'PLN', "status" text not null default 'draft', "notes" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "procurements_purchase_orders_document_number_unique_idx" on "procurements_purchase_orders" ("tenant_id", "organization_id", lower("document_number")) where deleted_at is null;`);
    this.addSql(`create index "procurements_purchase_orders_scope_warehouse_idx" on "procurements_purchase_orders" ("tenant_id", "organization_id", "warehouse_id");`);
    this.addSql(`create index "procurements_purchase_orders_scope_status_idx" on "procurements_purchase_orders" ("tenant_id", "organization_id", "status");`);
    this.addSql(`create index "procurements_purchase_orders_scope_order_date_idx" on "procurements_purchase_orders" ("tenant_id", "organization_id", "order_date");`);

    this.addSql(`create table "procurements_purchase_order_lines" ("id" uuid not null default gen_random_uuid(), "purchase_order_id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "line_number" int not null default 0, "catalog_variant_id" uuid not null, "catalog_product_id" uuid not null, "catalog_snapshot" jsonb null, "quantity_ordered" numeric(18,4) not null default '0', "unit" text null, "uom_snapshot" jsonb null, "unit_price_net" numeric(18,4) not null default '0', "expected_date" date null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "procurements_purchase_order_lines_scope_expected_date_idx" on "procurements_purchase_order_lines" ("tenant_id", "organization_id", "expected_date");`);
    this.addSql(`create index "procurements_purchase_order_lines_scope_variant_idx" on "procurements_purchase_order_lines" ("tenant_id", "organization_id", "catalog_variant_id");`);
    this.addSql(`create index "procurements_purchase_order_lines_order_idx" on "procurements_purchase_order_lines" ("purchase_order_id", "line_number");`);

    this.addSql(`alter table "procurements_purchase_order_lines" add constraint "procurements_purchase_order_lines_purchase_order_id_foreign" foreign key ("purchase_order_id") references "procurements_purchase_orders" ("id");`);
  }

}
