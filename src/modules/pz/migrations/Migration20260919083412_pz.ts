import { Migration } from '@mikro-orm/migrations';

export class Migration20260919083412_pz extends Migration {

  override name = 'Migration20260919083412';

  override up(): void | Promise<void> {
    this.addSql(`create table "pz_pallets" ("id" uuid not null default gen_random_uuid(), "goods_receipt_id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "code" text not null, "label" text null, "status" text not null default 'open', "closed_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create unique index "pz_pallets_code_unique_idx" on "pz_pallets" ("tenant_id", "organization_id", lower("code"));`);
    this.addSql(`create index "pz_pallets_receipt_status_idx" on "pz_pallets" ("goods_receipt_id", "status");`);
    this.addSql(`create index "pz_pallets_scope_receipt_idx" on "pz_pallets" ("tenant_id", "organization_id", "goods_receipt_id");`);

    this.addSql(`create table "pz_pallet_lines" ("id" uuid not null default gen_random_uuid(), "pallet_id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "catalog_variant_id" uuid not null, "catalog_product_id" uuid not null, "catalog_snapshot" jsonb null, "quantity" numeric(18,4) not null default '0', "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create unique index "pz_pallet_lines_pallet_variant_unique_idx" on "pz_pallet_lines" ("pallet_id", "catalog_variant_id");`);
    this.addSql(`create index "pz_pallet_lines_scope_idx" on "pz_pallet_lines" ("tenant_id", "organization_id", "catalog_variant_id");`);

    this.addSql(`alter table "pz_pallets" add constraint "pz_pallets_goods_receipt_id_foreign" foreign key ("goods_receipt_id") references "pz_goods_receipts" ("id");`);

    this.addSql(`alter table "pz_pallet_lines" add constraint "pz_pallet_lines_pallet_id_foreign" foreign key ("pallet_id") references "pz_pallets" ("id");`);
  }

  override down(): void | Promise<void> {
    // The generator only emitted the foreign-key drop. Rollback is only safe while no document
    // has been released, and in that state both tables are empty, so dropping them is the whole
    // undo — leaving them behind would make a re-run of `up` fail on an existing table.
    this.addSql(`alter table "pz_pallet_lines" drop constraint if exists "pz_pallet_lines_pallet_id_foreign";`);
    this.addSql(`alter table "pz_pallets" drop constraint if exists "pz_pallets_goods_receipt_id_foreign";`);
    this.addSql(`drop table if exists "pz_pallet_lines" cascade;`);
    this.addSql(`drop table if exists "pz_pallets" cascade;`);
  }

}
