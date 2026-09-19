# Actual counts live on pallets and never touch goods receipt lines

What the supplier declared and what the floor counted are two assertions by two different authors,
so they are stored separately: lines keep the expected quantities and are never written to during
receiving, while counted quantities live on `pz_pallet_lines`, one row per pallet per catalog
variant. The comparison the floor needs — expected against counted, per product — is a read over
both sides rather than a field on either.

A `received_quantity` column on the line was rejected because one product legitimately lands on
several pallets, and one line cannot hold two per-pallet numbers. A pallet line is a running total
and not an append-only scan log: a miscount is corrected by editing the one number, which is what
the floor actually asks for, and a wrongly counted product is removed by deleting the row rather
than setting it to zero — a zero row would assert presence and absence at once.

## Consequences

- A product counted that no line expected is recorded as surplus and shown as such; the floor can
  always write down what is physically in front of it.
- Pallet lines carry no unit of their own; quantities are in the variant's default unit and the
  comparison displays the line's unit. If the office writes a line in cartons and the floor counts
  pieces, the comparison is wrong — accepted for now, and the reason to revisit is a real case of it.
- Concurrent counting is expected on one pallet, so quantity writes are version-checked and a losing
  writer gets a 409 rather than silently overwriting a colleague's count.
