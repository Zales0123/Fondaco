# Goods receipts live in their own app module, not as a `wms` extension

The installed `wms` module already receives inventory, so extending it looked like the obvious
home. It is not one: `wms.inventory.receive` is a single-line ledger movement with no document
above it, `wms` exposes no host extension points for entities, and all of its entities are
non-editable. A goods receipt is a header-plus-lines editable record, which is a domain capability
of this application rather than an additive change to an installed one — the case `.ai/guides/architecture.md`
sends to `src/modules/<id>/`. So goods receipts live in an app module `pz`, referencing `wms` and
`catalog` by scalar id only, never by cross-module ORM relation.

The module keeps the id `pz` while its entities use English names (`pz:goods_receipt`). If WZ, PW or
RW documents are ever added here, that id becomes a misnomer and the module should be renamed
`warehouse_documents`.

## Consequences

- The page joins the existing WMS sidebar group by declaring `pageGroup: 'WMS'` and
  `pageGroupKey: 'wms.nav.group'` in its `page.meta.ts` — no UMES override, grouping is by key.
- Permissions are the module's own (`pz.goodsReceipts.view` / `.manage` / `.confirm`), not borrowed
  from `wms.receive_inventory`, which would imply a stock effect this module does not have.
