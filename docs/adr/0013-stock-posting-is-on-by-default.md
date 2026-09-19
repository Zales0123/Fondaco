# Stock posting is on by default in Fondaco

Extends [ADR-0011](0011-confirming-a-goods-receipt-posts-counted-stock.md), which built the posting
and left it behind the upstream toggle exactly as upstream ships it.

`wms` ships `wms_integration_procurement_goods_receipt` default-off, and for `wms` that is right: an
installation that happens to have a procurement module should not discover one morning that its
balances moved. Fondaco is not that installation. Fondaco is a warehouse receiving app — a delivery
arrives, the floor counts it, the count goes onto stock. An installation where confirming a counted
delivery leaves stock untouched is not a cautious Fondaco, it is a broken one. So `pz`'s setup turns
the toggle on for the tenant it initialises, and a fresh install adjusts inventory with nobody
hunting for a switch.

What is written is a **per-tenant override**, not a new default on the toggle. The toggle's default
is one global row shared by every tenant of the installation and it belongs to `wms`; rewriting it
would be this app deciding for installations that are not it. The override is the seam upstream put
there for exactly this, and `pz` writes it through `feature_toggles.overrides.changeState` — the same
command the toggle admin screen uses — rather than inserting the row, because the command is what
clears the resolution cache the toggle is read back from.

**An override that already exists is never touched.** This is the whole of what "idempotent" means
here, and a rewrite-every-run would have been the wrong reading of it: an operator who turned posting
off for their tenant would find it back on after the next deploy that runs `mercato init`, and would
have no way to make the decision stick. So setup only speaks for a tenant that has never expressed a
preference. Repeated runs converge; they do not fight.

The seeding of the toggle row itself goes through `wms`'s own `seedWmsIntegrationToggles`, which is
idempotent and skips what exists. `pz` declares no `requires` on `wms`, so the order the two
`seedDefaults` hooks run in is not guaranteed, and assuming `wms` went first would be a coin toss
that fails silently — on the wrong side, leaving posting off.

## Consequences

- **ADR-0011's first consequence now bites on day one.** A delivery holding a lot- or serial-tracked
  variant cannot be confirmed at all while posting is on, and posting is now on out of the box. Two
  fixture SKUs are lot-tracked, so a developer who runs `mercato init` and confirms the wrong
  delivery meets the refusal immediately rather than in production. That is the point of the refusal,
  but it is also the strongest argument for capturing a lot per pallet line being the next slice.
- An operator can still turn posting off per tenant, in the toggle admin screen or with
  `yarn mercato feature_toggles override-set-value --identifier wms_integration_procurement_goods_receipt --tenantId <uuid> --value false`.
  That choice survives every later `mercato init`. Deleting the override, rather than setting it to
  false, hands the tenant back to the upstream default — which is off — and the next `init` will set
  it to true again.
- Tenants created before this ADR are unaffected until `mercato init` runs for them. Setup runs per
  tenant, so an existing installation is not retro-flipped by deploying this; it is flipped by
  initialising.
- `pz`'s setup now resolves the command bus and reads two `feature_toggles` tables, which is more
  than a declarative ACL block. The alternative — a CLI command a human remembers to run — is a
  default that is only on when somebody remembers, which is not a default.
