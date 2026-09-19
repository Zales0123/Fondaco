import { Migration } from '@mikro-orm/migrations';

export class Migration20260919153825_pz extends Migration {

  override name = 'Migration20260919153825';

  override up(): void | Promise<void> {
    this.addSql(`alter table "pz_goods_receipts" add "confirmed_by" uuid null, add "confirmed_at" timestamptz null, add "stock_posting_status" text not null default 'not_applicable', add "stock_posted_at" timestamptz null, add "stock_posting_location_id" uuid null, add "stock_posting_error" text null;`);
    this.addSql(`create index "pz_goods_receipts_scope_posting_status_idx" on "pz_goods_receipts" ("tenant_id", "organization_id", "stock_posting_status");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "pz_goods_receipts_scope_posting_status_idx";`);
    this.addSql(`alter table "pz_goods_receipts" drop column "confirmed_by", drop column "confirmed_at", drop column "stock_posting_status", drop column "stock_posted_at", drop column "stock_posting_location_id", drop column "stock_posting_error";`);
  }

}
