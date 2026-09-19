# pz_fixtures — demo goods receipts, and an environment worth confirming them in

Demo data for the `pz` receiving flow. It exists because `pz` deliberately ships no
`seedExamples`: a demo delivery is indistinguishable from a real one in a document series
users reconcile against paper. Rather than override that decision, these fixtures never enter
the real series — every document is numbered `ZPZ-DEMO-*`, so `ZPZ-2026-0001` stays free for
the office to type — and nothing here runs on `mercato init`.

Documents are written through `pz.goodsReceipts.create` and `pz.goodsReceipts.release`, never
by an `em.insert` loop, so they carry the catalog resolution, the snapshots, the scope checks
and the audit and undo trail a hand-entered document carries.

## Commands

```bash
yarn mercato pz_fixtures seed [--tenant <id>] [--org <id>] [--release <n>] [--no-posting]
yarn mercato pz_fixtures enable-posting [--tenant <id>] [--org <id>]
yarn mercato pz_fixtures status [--tenant <id>] [--org <id>]
```

Scope is auto-detected when exactly one tenant and one organization are active; pass
`--tenant` / `--org` otherwise. Every read and write stays inside that scope.

- **`seed`** plans eight documents, skips any whose number is already present, and releases
  the first `<n>` it created to the floor. It also performs the posting setup below, unless
  `--no-posting` is given.
- **`enable-posting`** performs only the posting setup, idempotently and without touching a
  single document — for an environment seeded before this existed.
- **`status`** reports the demo documents by status, the toggle, and each warehouse's Default
  Destination.

## What the seed leaves behind

**The stock posting toggle.** Confirming a counted delivery posts its quantities into `wms`
only when `wms_integration_procurement_goods_receipt` is on, and `wms` ships it off by default
(ADR-0005) — rightly, since an installation that never asked for the bridge must not have
stock moved under it. A demo environment that seeds eight deliveries and then silently refuses
to post any of them demonstrates the wrong thing, so the seed turns it on **for the seeded
tenant only**, as an override rather than a change to the global default, and says so in its
summary. Turning on an integration is a decision, not obviously demo data, so `--no-posting`
opts out. The global definition is created on demand if this database has never had one.

**A Default Destination per warehouse.** Confirmation needs a Location to post into, and a
warehouse with no preselection asks whoever confirms to pick one. Every active warehouse that
has at least one eligible Location and no Default Destination gets the lowest-coded eligible
Location preselected — the same ordering the picker uses, so the preselected value is the one
at the top of the list. A warehouse with nowhere eligible is skipped and reported, not failed
on, and **a value somebody set on purpose is never overwritten** (the rule the demo
warehouseman's Assigned Warehouse already follows). What is written is only a preselection:
the confirmation re-validates it against the eligible Locations exactly as it validates a
hand-picked one, so a value that later goes stale prefills nothing instead of quietly posting
stock somewhere else (ADR-0011).

## What the documents demonstrate

`pz` refuses to confirm a delivery containing a variant `wms` tracks by lot or serial number,
because it captures neither. Both outcomes are worth showing, and neither is left to chance:
the tracked variants are read from `wms` the same way the confirmation reads them, and the
plan is shaped around the answer.

| Document | Intent | Warehouse |
|---|---|---|
| `ZPZ-DEMO-0001` | untracked products only — confirming it posts stock | 1st by name |
| `ZPZ-DEMO-0002` | carries a lot-tracked product — confirming it is refused | 2nd by name |
| `ZPZ-DEMO-0003` | untracked products only — confirming it posts stock | 3rd by name |
| `ZPZ-DEMO-0004`…`0008` | ordinary deliveries | rotating |

The two demonstrations are the first documents on purpose: `--release <n>` releases the first
N created, so `--release 3` puts both in front of the floor. Warehouses are assigned by
rotation over the active ones ordered by name, which in a demo environment makes the third
document land on the demo warehouseman's own warehouse — the one the floor panel confirms
against. A document that promises to be postable steps forward to the next warehouse that has
an eligible Location, so it is never blocked for a reason the demo was not trying to show.

When the catalog cannot satisfy the plan — no untracked product, no tracked one, a product
with no single default variant — the document is still seeded and the shortfall is reported.
Demo data is allowed to be smaller than planned; a failed seed is not an improvement on it.

## Typical use

```bash
yarn mercato pz_fixtures seed --release 3
yarn mercato pz_fixtures status
```

Roles that predate `pz` still need `yarn mercato auth sync-role-acls` before anyone holds
`pz.receiving.confirm`; that is an ACL concern and stays out of the fixtures.
