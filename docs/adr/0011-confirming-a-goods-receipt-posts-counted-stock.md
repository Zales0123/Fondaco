# Confirming a goods receipt posts the counted stock

Supersedes [ADR-0005](0005-goods-receipts-are-record-only.md), whose reasoning for leaving the seam
open still stands and is the argument this decision answers.

Confirming a goods receipt now puts its counted goods into `wms` stock, through exactly the route
ADR-0005 reserved: a subscriber on `pz.goods_receipt.confirmed` calling `wms.inventory.receive` with
`referenceType: 'manual'` and the receipt id as `referenceId`, gated by the upstream default-off
toggle `wms_integration_procurement_goods_receipt`. `pz` gains no dependency on `wms` beyond the
scalar ids and query-engine reads it already had. With the toggle off, confirmation records a
delivery and nothing else, exactly as before.

What is posted is what the floor counted, not what the document expected: the pallet lines, surplus
included, **summed per catalog variant**. ADR-0005's own sentence said "per line" and it was wrong —
expected quantities would shelve goods nobody counted. Summing is not a convenience either. The `wms`
movement idempotency key covers the reference, warehouse, location, variant *and quantity*, so two
pallets each carrying five of one product would produce the same key twice and the second would be
silently swallowed as a replay. One posting per variant makes each key unique, and makes a retry send
exactly the key it sent before — which is what makes retrying safe.

`wms.inventory.receive` will not accept a warehouse alone, so a confirmation names a **Destination**:
one Warehouse Location per document, chosen by whoever confirms and preselected from the Warehouse's
**Default Destination** (a custom field on `wms:warehouse`, following ADR-0002). Eligible means
active, belonging to that warehouse, of type `bin`, `slot`, `staging` or `dock`, and childless — `wms`
allows posting into a zone or an aisle, and a balance held there is one nobody can pick from. The
chosen Location is **pinned onto the document** at confirmation rather than re-read at posting time,
because it is part of that idempotency key: a setting changed between the first attempt and a retry
would make the retry write a second movement instead of replaying the first.

Every precondition is checked before the one-way transition and inside the shared confirm command, so
the office's confirm and the floor's are refused by the same rules. The floor gets its own feature,
`pz.receiving.confirm`, and its own thin route: "the count is done" and "the paperwork is final" are
different people's jobs, and granting the second would hand over every office confirm surface with it.
Both routes dispatch one command, and user-facing text says Confirm on both — the separate identifier
is about who may do it, not about a second act.

The posting attempt has its own state on the document (`pending`, `posted`, `failed`, or
`not_applicable` when the toggle was off) with a stable failure reason code. That is a record of our
process, not a second copy of the stock `wms` owns: it exists because "failed" is precisely the state
nobody can see by reading balances, and it is what the office's retry action works from.

## Consequences

- A delivery holding a lot- or serial-tracked variant cannot be confirmed at all while posting is on.
  `wms` refuses to receive one without a lot or serial number and this module captures neither, so the
  document is refused before it becomes irreversible rather than half-posted afterwards. Two fixture
  SKUs are lot-tracked, so this is met on day one in development. Capturing a lot per pallet line is
  the real answer and the next slice; per-pallet Destinations are the slice after that.
- The posting command holds the document's row lock across the `wms` writes. Keeping a transaction
  open across other work is normally the wrong shape; it is deliberate here because it is what makes
  two concurrent retries impossible, and a crashed process releases the lock rather than stranding a
  document mid-posting. The `wms` commands write their own tables in their own transactions.
- Confirmation returns before the goods are on stock. `confirmed` means the count is final and the
  posting has started; only `stockPostingStatus: posted` means stock moved.
- A failed posting may be re-pointed at another Location only while nothing of it has posted, checked
  against the movements `wms` holds for the document. Once anything has landed, the pin is permanent
  and a wrong destination is a stock correction rather than a retry.
- `receiving-summary` grew per-unit totals. The flat `totals` field sums across units, which is wrong
  next to a button that posts stock, but removing a published response field is breaking — so it stays,
  deprecated and unrendered.
