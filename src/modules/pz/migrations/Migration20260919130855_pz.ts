import { Migration } from '@mikro-orm/migrations';

export class Migration20260919130855_pz extends Migration {

  override name = 'Migration20260919130855';

  override up(): void | Promise<void> {
    this.addSql(`alter table "pz_goods_receipt_lines" add "purchase_order_id" uuid null, add "purchase_order_line_id" uuid null, add "purchase_order_snapshot" jsonb null;`);
    this.addSql(`create index "pz_goods_receipt_lines_purchase_order_line_idx" on "pz_goods_receipt_lines" ("tenant_id", "organization_id", "purchase_order_line_id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "pz_goods_receipt_lines_purchase_order_line_idx";`);
    this.addSql(`alter table "pz_goods_receipt_lines" drop column "purchase_order_id", drop column "purchase_order_line_id", drop column "purchase_order_snapshot";`);
  }

}
