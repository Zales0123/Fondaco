# Confirming a goods receipt posts its counted pallets into stock

ADR-0005 recorded that a goods receipt records a delivery and does not move stock, and it kept the
seam open on purpose: "turning this into a stock-posting system later means adding a subscriber that
calls `wms.inventory.receive` per line". That later is now. A pallet that has to be put away must
first exist in the ledger, and nothing in the app has ever put it there. This decision supersedes
ADR-0005's record-only stance and takes the seam it left open, without touching `pz`: confirming a
Goods Receipt emits `pz.goods_receipt.confirmed` exactly as it does today, and a subscriber owned by
`pallets` posts each counted pallet line into a staging location of the document's warehouse.

It corrects one detail of the recipe ADR-0005 sketched. That recipe used the goods receipt id as
`referenceId`, and it cannot be used: the installed idempotency key joins reference type, reference
id, movement type, both locations, variant, lot, serial **and quantity**. Two pallets carrying the
same product and the same quantity into the same location under one document-level reference produce
an identical key, and the second posting is silently swallowed as a replay — stock quietly lost, with
no error anywhere. The reference is therefore the app's own placement row id, one uuid per pallet line
per operation, stable across every retry. That also satisfies the requirement that a pallet code is
never a reference key, which the installed schema enforces anyway by demanding a uuid.

The destination is resolved by location `type = 'staging'` within the document's warehouse, never by a
location code or name. A warehouse with no active staging location, or with several, refuses the
posting with an explicit reason rather than guessing; that gap is an operational configuration
question and we would rather see it than paper over it. Posting per pallet line rather than per
document line follows ADR-0009: the counted quantity lives on the pallet, and it is the pallet that
will be moved next.

The posting is executed through the `pallets` movement facade, which creates the placement before
calling `wms.inventory.receive` and uses that placement id as the movement reference. The installed
WMS does not carry a pallet id. Therefore a later generic WMS movement touching a tracked
variant/location cannot be safely attributed to a carrier; the reconciliation subscriber marks the
affected pallet lines `drifted` and blocks putaway until an operator resolves the discrepancy.

The alternative of putting the subscriber inside `pz` was rejected because it is precisely what
ADR-0005 designed against: the document module stays a record of what arrived. The alternative of a
third module purely for posting was rejected because the record of where a carrier's goods are is the
carrier's own business, and `pallets` already owns it.

## Consequences

- ADR-0005 is superseded on the record-only point. Its other consequence still holds: lines carry
  `catalogVariantId`, so posting needs no product-to-variant resolution.
- Quantities on a confirmed receipt now do reconcile against `wms` balances. The old note that they
  would not is no longer true.
- Every posting is recorded as a placement with its own outcome — `pending`, `confirmed`, `rejected`
  or `unknown` — and an unknown outcome is read back from the ledger before anything is written again
  for that line. There is no fire-and-forget posting.
- `wms` ships a default-off toggle `wms_integration_procurement_goods_receipt` reserved for a
  procurement-driven integration. This subscriber is the app's own and does not sit behind it; if that
  installed integration is ever enabled, the two must be reconciled before both post.
- A goods receipt whose pallets have reached the ledger can no longer be treated as a document with no
  consequences. Withdrawal is refused once its pallets have been posted or moved.
