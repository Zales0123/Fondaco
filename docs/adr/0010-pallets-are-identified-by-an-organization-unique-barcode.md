# Pallets are identified by an organization-unique generated barcode

A pallet belongs to exactly one goods receipt and cannot outlive it, but its label is physical and
gets scanned by someone standing in front of it who has not told the system which document they
mean. Its identifier is therefore generated per organization, not per receipt, so a scan resolves
to exactly one pallet — the scoping `pz_goods_receipts` already uses for document numbers. A
per-receipt sequence ("pallet 2") would be ambiguous the moment two receipts are open at once.

Scanning a pallet that belongs to another goods receipt is refused with that reason, never silently
followed: switching documents under someone mid-count is how goods end up recorded against the wrong
delivery.

## Consequences

- Pallets are selected from the list of the current receipt's pallets or by scanning a barcode; both
  reach the same screen.
- A human-readable note can be attached to a pallet for the floor's own benefit; it is decoration and
  is never used to look a pallet up.
