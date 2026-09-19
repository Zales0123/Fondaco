# Receiving is a status of the goods receipt, not a separate document

Counting a delivery on the warehouse floor happens against a goods receipt that must not change
while it is being counted, so the document gains a third status between the two it had:
`draft → receiving → confirmed`. The office moves a draft into `receiving` with its own action
("Przekaż do przyjęcia"), which freezes the document exactly as confirmation does — no edit to
lines or header, no delete. It can be moved back to `draft`, office-only, while no pallet exists
yet; once anything has been physically counted against it, the expected side is fixed until
confirmation.

Receiving was modelled this way rather than as its own record hanging off a confirmed receipt
because Confirm should keep meaning "the floor counted this and it is final". A receipt confirmed
before anyone counted would assert only that the paperwork arrived, which is a weaker promise than
the one ADR-0006 was written to protect.

## Consequences

- `receiving` is a partly-immutable state, the shape ADR-0006 otherwise avoids. It is deliberately
  the only one: the freeze rule is identical to the confirmed one, so there is one rule, not two.
- Confirmation now also requires that the receipt is in `receiving` and that every pallet is closed.
  Zero pallets is allowed and means nothing arrived; a difference between expected and counted
  quantities never blocks confirmation, because a short delivery is a fact rather than an error.
- The warehouseman panel lists receipts in `receiving`, never drafts, so a half-typed document is
  never offered to the floor.
