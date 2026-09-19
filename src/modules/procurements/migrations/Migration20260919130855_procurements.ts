import { Migration } from '@mikro-orm/migrations';

export class Migration20260919130855_procurements extends Migration {

  override name = 'Migration20260919130855';

  override up(): void | Promise<void> {
    this.addSql(`create table "procurements_purchase_order_commitments" ("id" uuid not null default gen_random_uuid(), "purchase_order_id" uuid not null, "purchase_order_line_id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "source_type" text not null default 'awizo', "source_document_id" uuid not null, "source_line_id" uuid not null, "source_snapshot" jsonb null, "quantity" numeric(18,4) not null default '0', "status" text not null default 'outstanding', "released_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create unique index "procurements_commitments_active_source_line_unique_idx" on "procurements_purchase_order_commitments" ("source_type", "source_line_id") where "status" = 'outstanding';`);
    this.addSql(`create index "procurements_commitments_scope_source_document_idx" on "procurements_purchase_order_commitments" ("tenant_id", "organization_id", "source_document_id");`);
    this.addSql(`create index "procurements_commitments_scope_order_idx" on "procurements_purchase_order_commitments" ("tenant_id", "organization_id", "purchase_order_id");`);
    this.addSql(`create index "procurements_commitments_line_status_idx" on "procurements_purchase_order_commitments" ("purchase_order_line_id", "status");`);

    this.addSql(`alter table "procurements_purchase_order_commitments" add constraint "procurements_purchase_order_commitments_purchase_382d7_foreign" foreign key ("purchase_order_id") references "procurements_purchase_orders" ("id");`);
    this.addSql(`alter table "procurements_purchase_order_commitments" add constraint "procurements_purchase_order_commitments_purchase_772a3_foreign" foreign key ("purchase_order_line_id") references "procurements_purchase_order_lines" ("id");`);
  }

}
