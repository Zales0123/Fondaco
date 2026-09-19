# A pallet is a carrier that outlives the document it was counted on

Until now a Pallet was a counting device: it belonged to one Goods Receipt, hung off that document's
foreign key, and had no reason to exist once the document was confirmed. That was the right model for
counting a delivery and the wrong one for a warehouse. A pallet on the floor is moved, scanned, asked
what it holds and where it stands, and it keeps doing all of that long after the paperwork is closed.
The moment the app has to answer "where is pallet P" or "which pallets are waiting to be put away",
the document-bound model stops being a simplification and starts being wrong.

So the Pallet becomes a carrier in its own right, owned by its own module `pallets`, holding its own
identity, contents, and history. The link to the Goods Receipt survives as a scalar id plus a snapshot
of the document's number and date — a durable historical reference, not an ownership relation. Where a
pallet's goods physically are is not stored on it at all: it is computed from the confirmed placements
its goods have in the stock ledger, because a stored location drifts the moment the ledger moves and a
multi-product pallet caught halfway through a putaway has no single location to store.

The alternatives were weighed and lost. Keeping the Pallet in `pz` is what this decision reverses:
it is the document module, and the carrier must outlive the document. Moving it into the installed
`wms` fails for the same reason ADR-0004 kept Goods Receipts out of it — installed entities are not
app-editable and offer no extension point for one, while a pallet with an editable lifecycle is
exactly such a record. Letting a future `putaway` module own it inverts the dependency: a pallet is
created during receiving, long before any putaway exists, so `pz` would end up depending on `putaway`
merely to create one. A separate `pallets` module follows the precedent `barcode_scanner` and
`label_printing` already set — small shared modules whose data nobody else owns.

We also keep the word. "Pallet" is what the floor says, and *handling unit* and *LPN* stay on the
avoid list: the glossary's ban on those words was never the problem. The clause that had to go was
"it belongs to that document and cannot outlive it".

## Consequences

- `pz` holds no ORM relation to a Pallet. It reads pallets through the query engine by scalar id,
  exactly as it already reads `wms:warehouse`, and writes them only through `pallets` commands.
- `pz_pallets` and `pz_pallet_lines` are replaced by `pallets_pallets` and `pallets_pallet_lines`.
  The entity ids `pz:pallet` / `pz:pallet_line` and the `/api/pz/pallets*` routes are frozen surfaces,
  so they keep working through deprecated forwarders for one release.
- A pallet's current location is a computed read, never a column. Code that wants it asks the
  `pallets` module rather than joining to the ledger itself.
- ADR-0009 still holds — actual counts live on pallets and never touch goods receipt lines — but its
  premise is no longer "per document": counts live on a carrier that the document merely started.
- A pallet that is never put away simply stays where the ledger says it is. Nothing expires it, and
  this decision deliberately does not define when a pallet stops existing.
