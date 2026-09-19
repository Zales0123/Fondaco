# Goods receipts record a delivery; they do not move stock

> **Superseded by [ADR-0011](0011-confirming-a-goods-receipt-posts-counted-stock.md).** Confirmation
> now posts the counted quantities into `wms` stock through the seam described below. The reasoning
> here is kept because it is why that seam exists and what it costs to close it; where the two
> disagree — notably "per line", which ADR-0011 replaces with counted quantities summed per variant —
> ADR-0011 wins.

A warehouse receipt that leaves stock untouched is surprising enough to be worth writing down.
Confirming a goods receipt does not call `wms.inventory.receive` and does not change any
`wms` balance — the document is a record of what arrived, and nothing more. Stock posting brings
a lifecycle we are not ready to own: idempotent posting, a required destination location per line
(not just a warehouse), and correcting documents instead of edits once quantities have hit a ledger.

The seam is kept open rather than closed. Confirming emits `pz.goods_receipt.confirmed` carrying the
header and its lines, currently with no subscriber. Turning this into a stock-posting system later
means adding a subscriber that calls `wms.inventory.receive` per line with `referenceType: 'manual'`
and `referenceId` set to the goods receipt id — without touching this module. Upstream anticipates
this: `wms` ships a default-off toggle `wms_integration_procurement_goods_receipt` reserved for it.

## Consequences

- Lines carry `catalogVariantId` so that future posting needs no product-to-variant resolution step.
- Quantities on a confirmed receipt will not reconcile against `wms` balances. That is expected, not
  drift.
