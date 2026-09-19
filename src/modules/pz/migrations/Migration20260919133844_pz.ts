import { Migration } from '@mikro-orm/migrations';

export class Migration20260919133844_pz extends Migration {

  override name = 'Migration20260919133844';

  override up(): void | Promise<void> {
    this.addSql(`create table "pz_pallet_damage_reports" ("id" uuid not null default gen_random_uuid(), "pallet_id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "catalog_variant_id" uuid not null, "catalog_product_id" uuid not null, "catalog_snapshot" jsonb null, "quantity" numeric(18,4) not null, "photo_attachment_id" uuid null, "note" text null, "status" text not null default 'open', "resolution_note" text null, "reported_by" uuid not null, "resolved_by" uuid null, "resolved_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "pz_pallet_damage_reports_pallet_status_idx" on "pz_pallet_damage_reports" ("pallet_id", "status");`);
    this.addSql(`create index "pz_pallet_damage_reports_scope_pallet_idx" on "pz_pallet_damage_reports" ("tenant_id", "organization_id", "pallet_id");`);

    this.addSql(`alter table "pz_pallet_damage_reports" add constraint "pz_pallet_damage_reports_pallet_id_foreign" foreign key ("pallet_id") references "pz_pallets" ("id");`);
  }

}
