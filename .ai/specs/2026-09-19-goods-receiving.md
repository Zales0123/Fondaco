# Goods Receiving — counting a delivery onto pallets

**Date**: 2026-09-19
**Status**: Ready for implementation

> Written from a design interview (`/grill-with-docs`). Vocabulary is `CONTEXT.md`; decisions are ADR-0008, ADR-0009, ADR-0010 alongside the existing ADR-0004 … ADR-0007.

## TLDR

A Warehouseman opens **Przyjęcie towaru** in the Panel, picks a Goods Receipt the office has
released to the floor, creates Pallets, counts goods onto them by barcode, and compares what was
counted against what the document expected. The Goods Receipt gains one status, `receiving`,
between `draft` and `confirmed`; counted quantities live on two new app-owned tables and never
touch `pz_goods_receipt_lines`. Reuses the installed catalog variant reads, the Panel shell,
the command bus, optimistic locking and the CRUD route factory; adds no events, no new module,
and no stock movement.

## Problem Statement

Today a Goods Receipt is typed in the admin backend from the supplier's paperwork and confirmed
in one sitting. Nobody records what physically arrived. The floor counts on paper or not at all, a
short or surplus delivery is discovered days later when stock does not add up, and the Panel's
**Przyjęcie towaru** button is a Stub Action. The affected user is the Warehouseman, who has a
handheld device, a barcode scanner, gloves, and no way to write down what is in front of them.

## Overview and Success Measures

- **Primary outcome:** every released Goods Receipt has a recorded counted quantity per product,
  and any difference from the expected quantity is visible before the document is confirmed.
- **Leading indicators:** Goods Receipts reaching `confirmed` via `receiving` rather than directly;
  Pallets closed per receipt; differences surfaced on the Receiving Summary.
- **Baseline:** zero — no counted quantity is recorded anywhere today.
- **Market / product reference:** standard WMS goods-in with handling units. Adopted: pallets as
  the counting unit, count-by-scan, expected-vs-actual reconciliation. Rejected for now: put-away,
  locations, lots/expiry, serials, and any stock posting — see Non-goals and ADR-0005.

## Goals

- **REQ-001** — The office can hand a Goods Receipt to the floor and, from that moment, its expected
  Lines cannot change while it is being counted against.
- **REQ-002** — A Warehouseman can see, in the Panel, only the Goods Receipts that are waiting to be
  counted for their Assigned Warehouse, and open one.
- **REQ-003** — A Warehouseman can create a Pallet for that Goods Receipt and select any of its
  Pallets from a list or by scanning the Pallet's barcode.
- **REQ-004** — A Warehouseman can count goods onto the selected Pallet by scanning a product
  barcode and entering a quantity, including products that the document did not expect.
- **REQ-005** — A Warehouseman can correct a count: change a quantity, remove a Pallet Line, and
  delete an empty Pallet.
- **REQ-006** — A Warehouseman can declare a Pallet counted, and reopen it if they were wrong.
- **REQ-007** — Anyone with access can compare, per product, the expected quantity against the
  quantity counted across all Pallets of a Goods Receipt, on both the Panel and the admin backend.
- **REQ-008** — A Goods Receipt can only be confirmed once it is in `receiving` and every one of its
  Pallets is closed; a difference never blocks confirmation.
- **REQ-009** — Two Warehousemen counting the same Pallet cannot silently overwrite each other.

## Non-goals

- Any stock effect. Nothing writes `wms_inventory_balances`, `wms_inventory_movements`,
  `wms_inventory_lots` or reservations (ADR-0005 stands).
- Put-away, warehouse Locations, Zones, lots, expiry dates, serial numbers, pallet weight or
  capacity.
- Pallets that outlive their Goods Receipt, are re-used across documents, or are moved.
- Correcting a `confirmed` Goods Receipt. ADR-0006's answer — a correcting document — stays unbuilt.
- Printing Pallet labels.
- Units of measure on counted quantities, and any conversion between a Line's unit and a counted one.
- New events, new notifications, scheduled work, search indexing of Pallets.

## Proposed Solution

The Goods Receipt gains a third status. The office presses **Przekaż do przyjęcia** on a `draft`,
which moves it to `receiving` and freezes it exactly as confirmation does. The Panel lists documents
in `receiving` for the Warehouseman's Assigned Warehouse. Inside one, the Warehouseman creates
Pallets — each with a generated, Organization-unique barcode — and counts onto the selected Pallet:
scan a product barcode, type a quantity, and the (Pallet, variant) total goes up. Closing every
Pallet unlocks **Confirm** for the office, which keeps its existing one-way, irreversible meaning.

The Receiving Summary reads both sides — expected from Lines, counted from Pallet Lines — and shows
the difference per variant, surplus included.

### Design Decisions and Alternatives

| Decision | Rationale | Alternative considered | Why rejected / deferred |
|---|---|---|---|
| Receiving is a status of the Goods Receipt (`draft → receiving → confirmed`) | Confirm keeps meaning "the floor counted this and it is final" (ADR-0008) | A separate `Receiving` record started against a `confirmed` document | Would make a confirmed receipt only evidence that paperwork arrived, weakening ADR-0006's promise |
| `receiving` freezes the whole document, identically to `confirmed` | One freeze rule, not two; no field-by-field mutability matrix | Freeze Lines only, leave header editable | Every future edit path would need its own answer |
| `receiving → draft` allowed while no Pallet exists | Not accounting-final yet, so a mis-release is cheap to undo | Always reversible | Unfreezing the expected side after something was physically counted makes the comparison meaningless |
| Counted quantities live on `pz_pallet_lines` (ADR-0009) | Expected and counted are assertions by different authors | `received_quantity` column on `pz_goods_receipt_lines` | One product legitimately lands on several Pallets; one Line cannot hold two per-Pallet numbers |
| One Pallet Line per (Pallet, variant), quantity accumulates | The floor corrects by editing one number | Append-only scan log | Correcting a miscount becomes find-the-wrong-row archaeology |
| Removal deletes the row; quantity 0 is invalid | A Pallet Line asserts "this product is on this pallet" | Allow quantity 0 | A zero row asserts presence and absence at once and pollutes the Summary |
| Pallet code is generated and unique per Organization (ADR-0010) | A physical label is scanned by someone who has not said which document they mean | Per-receipt sequence ("paleta 2") | Ambiguous the moment two receipts are being counted at once |
| Scanning a Pallet of another Goods Receipt is refused | Switching documents mid-count files goods against the wrong delivery | Follow the scan | Silent context switch, unrecoverable by the person holding the scanner |
| Counted quantities carry no unit | Smallest coherent slice; the floor cannot answer a unit question mid-count | Unit + `uom_snapshot` mirroring the Line | Doubles the surface; revisit when a real carton-vs-piece case appears |
| Confirm gates on all Pallets closed, zero Pallets allowed | "Nothing arrived" is a real outcome | Require ≥1 Pallet | Forces a fake empty Pallet to express an empty delivery |
| No new events | Nothing subscribes; `pz.goods_receipt.confirmed` stays the module's one external fact | An event per transition | Four dead payloads that then need backward compatibility |
| Panel UI in `warehouseman`, all data and API in `pz` | ADR-0001 (Panel owns its route namespace) + ADR-0004 (Goods Receipts own their module) | A third `receiving` module | A Pallet that cannot outlive its Goods Receipt is part of that document |

## Domain Vocabulary and Business Rules

| Term / invariant | Precise meaning or rule | Source of truth | Failure behavior |
|---|---|---|---|
| Receiving | The floor act of counting what arrived against a Goods Receipt; a phase of that document | `pz_goods_receipts.status = 'receiving'` | — |
| Release | `draft → receiving`, office action, freezes the document | `pz.goodsReceipts.release` command | reject 409 if not `draft`; 409 on stale version |
| Withdraw | `receiving → draft`, office action, allowed only while the receipt has no Pallet | `pz.goodsReceipts.withdraw` command | reject 409 if any Pallet exists or status ≠ `receiving` |
| Frozen document | In `receiving` and in `confirmed`: no Line edit, no header edit, no delete | `pz.goodsReceipts.update`/`delete` guards | reject with `pz.goodsReceipts.errors.receivingImmutable` |
| Pallet | Counting carrier belonging to exactly one Goods Receipt; cannot outlive it | `pz_pallets` | — |
| Pallet code | Generated, unique per `(tenant, organization)`, case-insensitive; the scannable identity | `pz_pallets.code` | unique-violation retried on generation; scan miss → not found |
| Pallet note | Free text for the floor; decoration, never a lookup key | `pz_pallets.label` | — |
| Pallet state | `open → closed`, reopenable | `pz_pallets.status` | counting into a `closed` Pallet is rejected |
| Pallet Line | One product and its counted quantity on one Pallet; one row per (Pallet, variant) | `pz_pallet_lines` | — |
| Counted quantity | `> 0`, numeric(18,4); re-scanning the same variant adds to it | `pz_pallet_lines.quantity` | `<= 0` rejected as validation error |
| Surplus | A counted variant that no Line of the document expected | Receiving Summary (derived) | shown, never blocked |
| Expected quantity | Σ of `pz_goods_receipt_lines.quantity` per variant | Lines | — |
| Counted total | Σ of `pz_pallet_lines.quantity` per variant across every Pallet of the receipt | Pallet Lines | — |
| Difference | counted total − expected quantity; may be negative (short), positive (over) or a surplus row | derived, never stored | never blocks confirmation |
| Confirm | Unchanged one-way transition, now additionally requiring `receiving` + all Pallets closed | `pz.goodsReceipts.confirm` | reject with `pz.goodsReceipts.errors.confirmPalletsOpen` |
| Pallet deletion | Allowed only while `open` and with no Pallet Lines; hard delete, freeing its code | `pz.pallets.delete` | reject otherwise |

## Users, Permissions, and Scope

| Actor | Allowed outcomes | Scope rule | Required feature IDs |
|---|---|---|---|
| Office user (backend) | View receipts, release, withdraw, confirm, read the Summary | organization | `pz.goodsReceipts.view`, `pz.goodsReceipts.manage` (release/withdraw), `pz.goodsReceipts.confirm` |
| Warehouseman (Panel) | List `receiving` receipts, create/close/reopen/delete Pallets, count, read the Summary | organization, filtered (not gated) by Assigned Warehouse | `warehouseman.panel.access` (Panel entry) + `pz.goodsReceipts.view` + `pz.receiving.count` (see Q-001) |

`tenantId` and `organizationId` come from the request auth context and the resolved organization
scope, exactly as `confirm/route.ts` derives them today; a selection the scope rejects stops the
request rather than falling back. No system-scope operation exists here. The Assigned Warehouse is a
**filter** on the Panel's receipt list, never a permission — a Warehouseman may widen it to another
Warehouse in the same Organization.

## Reuse and Ownership Map

| Capability | Reuse / extend / app-own | Existing module or new module | Integration seam | Why |
|---|---|---|---|---|
| Goods Receipt, Lines, statuses | app-owned, extended | `pz` | direct | ADR-0004 |
| Pallet, Pallet Line | app-owned, new | `pz` | ORM relation within the module | Part of the document |
| Catalog variant identity, barcode, name, SKU | reuse, read-only | `catalog` | scalar ID + query-engine read + stored snapshot | ADR-0004, ADR-0007 |
| Product picker for the unknown-barcode fallback | reuse | `catalog` `/api/catalog/variants` | installed option source | Reference display rule |
| Warehouse name | reuse | `wms` | scalar ID + existing snapshot | ADR-0004 |
| Panel shell, session, Assigned Warehouse | reuse | `warehouseman` | `PanelShell`, `loadPanelContext` | ADR-0001, ADR-0002 |
| Auth, ACL, optimistic locking, command bus, CRUD routes | reuse | installed shared libs | `makeCrudRoute`, `CommandBus`, lock header | Platform-native |
| Stock | not used | `wms` | none | ADR-0005 |

## Architecture and Data Flow

```text
office  -> POST /api/pz/goods-receipts/release   -> pz.goodsReceipts.release   -> GoodsReceipt.status = receiving
Panel   -> GET  /api/pz/goods-receipts?status=receiving&warehouseId=…          -> GoodsReceipt list
Panel   -> POST /api/pz/pallets                  -> pz.pallets.create          -> Pallet (generated code)
Panel   -> GET  /api/pz/pallets/by-code?code=…                                 -> Pallet (or refusal: other receipt)
Panel   -> GET  /api/pz/receiving/variant-by-barcode?barcode=…                 -> catalog variant (query engine)
Panel   -> POST /api/pz/pallet-lines             -> pz.palletLines.count       -> PalletLine.quantity += qty
Panel   -> POST /api/pz/pallets/close            -> pz.pallets.close           -> Pallet.status = closed
both    -> GET  /api/pz/goods-receipts/receiving-summary?id=…                  -> expected vs counted (derived)
office  -> POST /api/pz/goods-receipts/confirm   -> pz.goodsReceipts.confirm   -> pz.goods_receipt.confirmed
```

- **Module boundaries:** `pz` owns every entity, command, API route and the Summary computation;
  `warehouseman` owns only Panel pages and their components, calling the `pz` API. A Pallet and its
  Goods Receipt must stay transactionally consistent (confirm reads Pallet state), so they share a
  module.
- **Extension points:** none required — no installed code is modified. The admin Goods Receipt
  detail page is app-owned and extended in place.
- **Alternatives considered:** a separate `receiving` module (rejected — no distinct invariant), and
  modelling Receiving as its own aggregate (rejected in ADR-0008).
- **Compatibility:** `GET /api/pz/goods-receipts` gains `receiving` as a possible `status` value —
  an additive change to a documented enum; consumers filtering on `draft`/`confirmed` are unaffected.
  Read `.ai/guides/upstream/BACKWARD_COMPATIBILITY.md` before touching the route's schema.

## User Journeys

### Journey J-001 — Office releases a Goods Receipt to the floor

1. Office opens `/backend/wms/goods-receipts/{id}` on a `draft`.
2. Presses **Przekaż do przyjęcia**; a confirmation dialog states that the document can no longer be
   edited while it is being counted.
3. Status becomes `receiving`; the edit route now refuses, as it does for `confirmed`.
4. If the document changed meanwhile, the stale version is rejected with 409 and a reload prompt;
   without `pz.goodsReceipts.manage` the action is not rendered and the API answers 403.

### Journey J-002 — Warehouseman counts a delivery

1. Warehouseman signs into the Panel and taps **Przyjęcie towaru**.
2. Sees the `receiving` Goods Receipts of their Assigned Warehouse (document number, supplier, date,
   pallet count), with a control to widen to another Warehouse; empty state explains that the office
   has not released anything yet.
3. Opens one, sees its Pallets, taps **Utwórz paletę**; the new Pallet is created with a generated
   code and the app navigates straight into it.
4. Scans a product barcode, types a quantity, submits; the Pallet Line appears with a running total.
   Re-scanning the same product adds to it.
5. An unknown barcode opens a product search; picking a variant records the count normally.
6. Taps **Zakończ skanowanie**; the Pallet becomes `closed` and the app returns to the Pallet list.
7. Starts the next Pallet, or opens **Podsumowanie przyjęcia** to see what is still missing.
8. Failure paths: a `closed` Pallet refuses counts until reopened; a Pallet code from another
   document is refused by name; a concurrent quantity write answers 409 and the screen reloads the
   current total before retrying.

### Journey J-003 — Office confirms

1. Office opens the receipt, reads the Receiving Summary — expected, counted, difference, surplus.
2. Presses **Confirm**. If any Pallet is still `open`, the action is refused and names the open
   Pallets.
3. Confirmed: warehouse snapshot taken, `pz.goods_receipt.confirmed` emitted, document immutable.
   A difference does not block this step and is recorded as counted.

## UI and Interaction Contracts

Panel screens follow `PanelShell` — phone-first, single column, large targets, header naming the
Warehouse and the signed-in person. Backend screens follow `.ai/guides/backend-ui.md` with `Page`,
`PageBody`, `DataTable` and `CrudForm`, matching the existing `pz` backend pages. Every reference to
another record is a selection control over a scoped option source: the product fallback uses the
installed catalog variant picker (`/api/catalog/variants`), the Warehouse widener uses the same
Warehouse option source the Goods Receipt form already uses. Raw IDs never appear on screen.

| Surface / route | Purpose and primary actions | Data source / mutations | Closest installed reference | Canonical shell / components | Required states | Requirement IDs |
|---|---|---|---|---|---|---|
| `/warehouseman/receiving` | List `receiving` receipts for the Assigned Warehouse; widen Warehouse; open one | `GET /api/pz/goods-receipts?status=receiving` | `warehouseman` `PanelHome` | `PanelShell`, primitives | loading, empty, error, permission denied | REQ-002 |
| `/warehouseman/receiving/[receiptId]` | Pallet list; **Utwórz paletę**; scan a Pallet code; open the Summary; delete an empty Pallet | `GET/POST/DELETE /api/pz/pallets`, `GET /api/pz/pallets/by-code` | `PanelShell` screens | `PanelShell`, primitives | loading, empty, error, not-found, wrong-document, success | REQ-003, REQ-005 |
| `/warehouseman/receiving/[receiptId]/pallets/[palletId]` | Count: barcode + quantity; edit a quantity; remove a Pallet Line; **Zakończ skanowanie** / reopen | `GET/POST/PUT/DELETE /api/pz/pallet-lines`, `GET /api/pz/receiving/variant-by-barcode`, `POST /api/pz/pallets/close`, `/reopen` | `PanelShell` screens; `GoodsReceiptLinesEditor` for line-editing behavior | `PanelShell`, primitives, catalog variant picker | loading, empty, error, unknown-barcode fallback, conflict (409), closed-pallet, success | REQ-004, REQ-005, REQ-006, REQ-009 |
| `/warehouseman/receiving/[receiptId]/summary` | Expected vs counted per product, worst difference first, surplus flagged | `GET /api/pz/goods-receipts/receiving-summary` | `pz` `GoodsReceiptDetail` | `PanelShell`, primitives | loading, empty, error | REQ-007 |
| `/backend/wms/goods-receipts/[id]` | Adds: **Przekaż do przyjęcia**, **Cofnij do wersji roboczej**, Pallet list, Receiving Summary section; Confirm gains its refusal | `POST …/release`, `…/withdraw`, `GET …/receiving-summary`, `GET /api/pz/pallets` | itself (existing detail page) | `Page`, `PageBody`, `DataTable` | loading, empty, error, conflict, success, permission denied | REQ-001, REQ-007, REQ-008 |
| `/backend/wms/goods-receipts` | Status filter and badge gain `receiving` | `GET /api/pz/goods-receipts` | itself | `DataTable` | unchanged | REQ-001 |

### UI architecture

| Role | Navigation groups in order | Dashboard / injected widgets | Login-to-primary-task flow |
|---|---|---|---|
| Warehouseman | Panel home → **Przyjęcie towaru** → receipt → pallet | none | login → **Przyjęcie towaru** → pick receipt → pick/create pallet → count (3 taps to the first scan) |
| Office user | WMS → Goods receipts → detail | none | login → Goods receipts → detail → **Przekaż do przyjęcia** (3 clicks) |

| Surface / widget | Empty state guidance and action | Responsive behavior | Keyboard / focus behavior |
|---|---|---|---|
| Panel receipt list | "Brak dokumentów do przyjęcia" + how a document gets here | single column, full-width rows | list is a sequence of links; visible focus ring |
| Panel pallet list | "Brak palet" + **Utwórz paletę** as the primary action | single column | primary action reachable first |
| Panel counting screen | "Brak zeskanowanych towarów" + hint to scan | single column, quantity field beside the code field at ≥480px | barcode field autofocused and refocused after every submit — a scanner ends with Enter, so the form submits on Enter and never loses focus |
| Summary | "Nic jeszcze nie policzono" | table collapses to stacked rows on narrow screens | headers announced; difference stated in text, never by color alone |

### `/warehouseman/receiving/[receiptId]/pallets/[palletId]` — Counting screen

```text
┌────────────────────────────────────────────────────────────┐
│ PZ/12/2026 · Paleta PAL-000042              [Zakończ skan.] │
│ Dostawca: Hurt-Pol · 3 pozycje                              │
├────────────────────────────────────────────────────────────┤
│ [ kod kreskowy ............................ ] [ ilość ] [+] │
│   nieznany kod → [ wyszukaj produkt ▾ ]                     │
├────────────────────────────────────────────────────────────┤
│ Kabel USB-C 2m        SKU 4411     12  [edytuj] [usuń]      │
│ Ładowarka 65W         SKU 9012      4  [edytuj] [usuń]      │
├────────────────────────────────────────────────────────────┤
│ [Podsumowanie przyjęcia]                    [Wróć do palet] │
└────────────────────────────────────────────────────────────┘
```

- **Behavior:** barcode submit resolves a variant and adds the quantity to the (Pallet, variant)
  total; unknown barcode reveals the catalog picker inline with the scanned code preserved;
  quantity must be `> 0`; editing sends the Pallet Line's `updatedAt` and surfaces a 409 by
  reloading the row and asking the Warehouseman to re-enter; removing a Pallet Line asks for
  confirmation; closing asks for confirmation and states that it can be reopened.
- **Responsive and accessibility:** touch targets ≥44px, focus stays in the barcode field, each
  added or changed row announced through a live region, confirmation dialogs focus-trapped.
- **Localization:** `warehouseman.receiving.*` for Panel copy, `pz.pallets.*` / `pz.palletLines.*`
  for API error messages; Polish and English both supplied.
- **Design-system and theming:** semantic tokens only, as in `PanelShell`; difference and surplus
  are labelled in words with a token-based badge, never color alone; verified in light and dark.

### `/warehouseman/receiving/[receiptId]/summary` — Receiving Summary

```text
┌────────────────────────────────────────────────────────────┐
│ Podsumowanie przyjęcia · PZ/12/2026                         │
│ Dostawca: Hurt-Pol · 3 palety (2 zamknięte)                 │
│ [ ] pokaż zgodne (4)                                        │
├────────────────────────────────────────────────────────────┤
│ Kabel USB-C 2m      SKU 4411   oczek. 20  policz. 12        │
│                                       [Brakuje 8]      [v]  │
│   └ PAL-000042: 8 · PAL-000043: 4                           │
│ Ładowarka 65W       SKU 9012   oczek. 10  policz. 12        │
│                                     [Nadwyżka 2]       [v]  │
│ Taśma pakowa        SKU 7781   oczek.  —  policz.  6        │
│                                  [Spoza dokumentu]     [v]  │
├────────────────────────────────────────────────────────────┤
│ Razem: oczekiwano 30 · policzono 24                         │
└────────────────────────────────────────────────────────────┘
```

- **Ordering and filtering:** shortages first, ordered by absolute difference descending, then
  surplus rows (counted but not expected), then over-counts. Rows with difference 0 are hidden
  behind a **pokaż zgodne** toggle that states how many are hidden, so the default view is a
  problem list.
- **Behavior:** every row expands to its per-Pallet breakdown (`PAL-000042: 8 · PAL-000043: 4`),
  which is how a product split across Pallets is checked without leaving the screen. The screen is
  read-only on both surfaces — corrections happen on the counting screen, so nothing here can be
  edited by accident while someone else counts.
- **Wording:** the difference is stated in words — `Brakuje {n}` / `Nadwyżka {n}` / `Spoza dokumentu`
  / `Zgodne` — with a token-based badge; color never carries the meaning alone.
- **Responsive and accessibility:** a table at ≥768px collapsing to stacked rows below it, expanders
  as real buttons with `aria-expanded`, totals in a footer region announced on load.
- **Admin placement:** a section on the existing `/backend/wms/goods-receipts/[id]` detail page
  below the Lines, not a separate tab — the office reads it immediately before pressing Confirm.

## Data Models

### `pz_pallets`

| Field | Type / nullability | Scope / index | Sensitive / encrypted | Lifecycle and validation |
|---|---|---|---|---|
| `id` | UUID, required | primary key | no | immutable |
| `tenant_id` / `organization_id` | UUID, required | `(tenant_id, organization_id, goods_receipt_id)` index | no | trusted context only |
| `goods_receipt_id` | UUID, required | FK to `pz_goods_receipts`, indexed with `created_at` | no | immutable; in-module ORM relation |
| `code` | text, required | unique on `(tenant_id, organization_id, lower(code))` | no | generated at creation, immutable, never user-supplied |
| `label` | text, nullable | — | no | free note, max 120 chars |
| `status` | text, required, default `open` | `(goods_receipt_id, status)` index | no | `open` ⇄ `closed` |
| `closed_at` | timestamp, nullable | — | no | set on close, cleared on reopen |
| `created_at` | timestamp, required | — | no | on create |
| `updated_at` | timestamp, required | optimistic-lock version | no | updated on every edit |

Hard-deleted, never soft-deleted, and only while `open` with no Pallet Lines — deleting frees the
code. Deleting a Goods Receipt is only possible in `draft`, where no Pallet can exist, so no cascade
is needed.

### `pz_pallet_lines`

| Field | Type / nullability | Scope / index | Sensitive / encrypted | Lifecycle and validation |
|---|---|---|---|---|
| `id` | UUID, required | primary key | no | immutable |
| `tenant_id` / `organization_id` | UUID, required | `(tenant_id, organization_id, catalog_variant_id)` index | no | trusted context only |
| `pallet_id` | UUID, required | FK to `pz_pallets`; unique on `(pallet_id, catalog_variant_id)` | no | immutable |
| `catalog_variant_id` | UUID, required | part of the unique key | no | scalar cross-module ID (ADR-0004, ADR-0007) |
| `catalog_product_id` | UUID, required | — | no | stored alongside so counts can be read product-first |
| `catalog_snapshot` | jsonb, nullable | — | no | `{ name, sku }` at the moment of the first count |
| `quantity` | numeric(18,4), required | — | no | `> 0`; counting adds, editing replaces, zero is invalid |
| `created_at` | timestamp, required | — | no | on create |
| `updated_at` | timestamp, required | optimistic-lock version | no | updated on every edit |

Hard delete. No unit column — quantities are in the variant's default unit (Non-goals).

### `pz_goods_receipts` (changed)

`status` accepts `receiving` in addition to `draft` and `confirmed`. No column is added; the
existing `(tenant_id, organization_id, status)` index covers the new value. The migration is a
data-compatible no-op for existing rows — no receipt is retro-fitted into `receiving`.

Migration is generated with `yarn db:generate`, its SQL and snapshot reviewed, and **not applied
without asking**.

## API, Command, and Error Contracts

| Method / command | Path / ID | Auth and feature gate | Input | Success response / event | Errors and concurrency | Requirement IDs |
|---|---|---|---|---|---|---|
| `POST` | `/api/pz/goods-receipts/release` | auth + `pz.goodsReceipts.manage` | `{ id }` + lock header | `200 { id, status: 'receiving', updatedAt }` | 400/403/404/409 (not draft, stale) | REQ-001 |
| `POST` | `/api/pz/goods-receipts/withdraw` | auth + `pz.goodsReceipts.manage` | `{ id }` + lock header | `200 { id, status: 'draft', updatedAt }` | 409 when not `receiving` or any Pallet exists | REQ-001 |
| `POST` | `/api/pz/goods-receipts/confirm` | unchanged: `pz.goodsReceipts.confirm` | unchanged | unchanged + `pz.goods_receipt.confirmed` | **new** 409 `confirmPalletsOpen`; `receiving` required instead of `draft` | REQ-008 |
| `GET` | `/api/pz/goods-receipts` | auth + `pz.goodsReceipts.view` | `status` accepts `receiving`; existing `warehouseId` filter | unchanged shape + `palletCount` | 400/403 | REQ-002 |
| `GET` | `/api/pz/pallets` | auth + `pz.goodsReceipts.view` | `{ goodsReceiptId }` | `{ items: [{ id, code, label, status, lineCount, updatedAt }], totalCount }` | 400/403/404 | REQ-003 |
| `POST` | `/api/pz/pallets` | auth + `pz.receiving.count` | `{ goodsReceiptId, label? }` | `201 { id, code, status: 'open', updatedAt }` | 409 when the receipt is not `receiving`; unique-violation retried internally | REQ-003 |
| `PUT` | `/api/pz/pallets` | auth + `pz.receiving.count` | `{ id, label }` + lock header | `200 { id, label, updatedAt }` | 409 stale / closed | REQ-003 |
| `DELETE` | `/api/pz/pallets` | auth + `pz.receiving.count` | `{ id }` + lock header | `200 { id }` | 409 when `closed` or it has Pallet Lines | REQ-005 |
| `GET` | `/api/pz/pallets/by-code` | auth + `pz.goodsReceipts.view` | `{ code, goodsReceiptId }` | `200 { id, code, goodsReceiptId, status }` | 404 unknown; **409 `palletOtherReceipt`** naming the other document | REQ-003 |
| `POST` | `/api/pz/pallets/close` | auth + `pz.receiving.count` | `{ id }` + lock header | `200 { id, status: 'closed', updatedAt }` | 409 already closed / stale | REQ-006 |
| `POST` | `/api/pz/pallets/reopen` | auth + `pz.receiving.count` | `{ id }` + lock header | `200 { id, status: 'open', updatedAt }` | 409 when the receipt is `confirmed` | REQ-006 |
| `GET` | `/api/pz/receiving/variant-by-barcode` | auth + `pz.goodsReceipts.view` | `{ barcode }` | `200 { catalogVariantId, catalogProductId, name, sku, barcode }` | `404 variantBarcodeUnknown` → client falls back to the catalog picker | REQ-004 |
| `GET` | `/api/pz/pallet-lines` | auth + `pz.goodsReceipts.view` | `{ palletId }` | `{ items: [{ id, catalogVariantId, name, sku, quantity, updatedAt }], totalCount }` | 400/403/404 | REQ-004 |
| `POST` | `/api/pz/pallet-lines` | auth + `pz.receiving.count` | `{ palletId, catalogVariantId, quantity }` | `200 { id, quantity, updatedAt }` — **adds** to an existing (Pallet, variant) row, creates it otherwise | 409 pallet closed / receipt not `receiving`; 400 quantity ≤ 0; unique-violation retried as an add | REQ-004, REQ-009 |
| `PUT` | `/api/pz/pallet-lines` | auth + `pz.receiving.count` | `{ id, quantity }` + lock header | `200 { id, quantity, updatedAt }` — **replaces** | 409 stale (concurrent count) / pallet closed | REQ-005, REQ-009 |
| `DELETE` | `/api/pz/pallet-lines` | auth + `pz.receiving.count` | `{ id }` + lock header | `200 { id }` | 409 pallet closed / stale | REQ-005 |
| `GET` | `/api/pz/goods-receipts/receiving-summary` | auth + `pz.goodsReceipts.view` | `{ id }` | `{ items: [{ catalogVariantId, name, sku, unit, expected, counted, difference, surplus }], totals, palletsOpen }` | 400/403/404 | REQ-007 |

`/api/pz/pallets` and `/api/pz/pallet-lines` use `makeCrudRoute` as the Goods Receipt list does;
every transition (`release`, `withdraw`, `close`, `reopen`) and `pallet-lines` write is a hand-written
guarded command route in the shape of the existing `confirm/route.ts`, which is the prior art for
dispatching a domain command with mutation guards, scope derivation and post-commit callbacks. Every
route declares per-method `metadata` and OpenAPI schemas through `api/openapi.ts`. Commands:
`pz.goodsReceipts.release`, `pz.goodsReceipts.withdraw`, `pz.pallets.create|update|delete|close|reopen`,
`pz.palletLines.count|update|delete`. Counting is idempotent only per request, not per barcode: two
identical scans legitimately mean two items.

## Events, Jobs, Notifications, and Cross-Module Flows

| Trigger | Producer | Consumer | Side effect | Retry / idempotency / audit behavior |
|---|---|---|---|---|
| `pz.goods_receipt.confirmed` | `pz` (unchanged) | none today | none | unchanged |

No new events, jobs, notifications, cache invalidation or scheduled work (Non-goals, ADR-0008 rationale).
Receiving performs no cross-module write; `catalog` and `wms` are read-only sources.

## Security, Privacy, and Compliance

- **Authorization:** every route gates on feature IDs, never role names. Panel entry keeps
  `warehouseman.panel.access`; the `pz` API gates on `pz.*` features so `pz` never depends on a
  `warehouseman` feature ID (Q-001).
- **Tenant isolation:** every read and write filters on the trusted `tenantId` plus the resolved
  organization scope, including the Pallet code lookup — an unscoped `by-code` lookup would be a
  cross-tenant enumeration oracle. Missing scope fails closed.
- **Sensitive data:** none. No encryption map, no PII beyond what the Goods Receipt already holds.
- **Abuse and failure modes:** Pallet code enumeration (mitigated by scoping `by-code` and returning
  404 for anything outside scope); concurrent counting (optimistic locking, 409); replayed scans
  (accepted by design — a repeated scan is a repeated item); destructive actions (delete restricted
  to empty open Pallets, confirmed via dialog); a Goods Receipt frozen mid-count (Withdraw blocked
  once a Pallet exists).

## Integration Coverage

Tests are self-contained, create their own tenant/org/user/records, and exercise real API and UI
paths. Prior art: `src/modules/pz/__integration__/TC-PZ-001…006` (API-level, Playwright request
context, `adoptSession`) and `src/modules/warehouseman/__integration__/TC-WHM-001` (browser).

| Test ID | Level | Setup / fixture | Actions | Assertions | Requirement IDs |
|---|---|---|---|---|---|
| TEST-001 | integration | draft receipt with 2 lines | release, then attempt update/delete/line edit | `receiving` persisted; every mutation refused; confirm refused only on open pallets | REQ-001 |
| TEST-002 | integration | receipt in `receiving`, then with one pallet | withdraw twice | first succeeds back to `draft`; second refused with 409 once a pallet exists | REQ-001 |
| TEST-003 | integration | receipt in `receiving` | create two pallets | codes unique per organization, both `open`, both listed under the receipt | REQ-003 |
| TEST-004 | integration | two receipts, one pallet each | `by-code` for the foreign pallet | 409 `palletOtherReceipt`, naming the other document; no data from it leaked | REQ-003 |
| TEST-005 | integration | pallet + catalog variant with barcode | count the same barcode twice, then PUT a corrected quantity, then DELETE | one row per variant, quantity accumulated then replaced then gone | REQ-004, REQ-005 |
| TEST-006 | integration | pallet, variant not on any line | count it | recorded; summary flags it as surplus | REQ-004, REQ-007 |
| TEST-007 | integration | pallet with one line | two PUTs with the same `updatedAt` | second answers 409; stored quantity is the first writer's | REQ-009 |
| TEST-008 | integration | receipt with one open pallet | confirm, close the pallet, confirm again | first refused `confirmPalletsOpen`; second confirms and emits `pz.goods_receipt.confirmed`; `wms` balances/movements/lots unchanged either side | REQ-006, REQ-008 |
| TEST-009 | security | second tenant + a user holding only `warehouseman.panel.access` | read and write pallets of the other tenant's receipt | fail closed, 403/404, no leak | REQ-002 |
| TEST-010 | UI (browser) | warehouseman with assigned warehouse, one `receiving` receipt | Panel: open receiving list, create pallet, count an unknown barcode via the picker, close, read the summary | each screen's loading/empty/error/conflict states render; only the assigned warehouse's receipts listed; keyboard-only path from barcode field to submit works | REQ-002, REQ-004, REQ-006, REQ-007 |
| TEST-011 | unit | — | barcode normalization + variant resolution helper | trims, rejects empty, resolves exact match, reports unknown | REQ-004 |
| TEST-012 | unit | — | summary computation over expected lines + pallet lines | sums per variant across pallets, negative/positive/zero differences, surplus rows, ordering worst-first | REQ-007 |

**Seams.** Two, both existing: the module's HTTP API (all API and security tests) and the Panel in a
browser (TEST-010). The only new seams are two pure functions — barcode/variant resolution and the
summary computation — extracted so TEST-011/012 do not need a database.

## Implementation Phases

### Phase 1 — The `receiving` status

- **Depends on:** none
- **Outcome:** the office can release a draft to the floor and take it back, and a released document
  is frozen.
- **Why this order / value delivered:** every later phase needs a document the floor may count
  against; freezing is the invariant the rest depends on.
- **Deliverables:** `GoodsReceiptStatus` gains `receiving`; `release`/`withdraw` commands and routes;
  update/delete guards extended; confirm requires `receiving`; backend detail actions and the index
  status filter/badge; i18n; OpenAPI.
- **Independent slices / estimated commits:** commands + routes; backend UI; i18n + OpenAPI (~3).
- **Requirements closed:** REQ-001
- **Tests:** TEST-001, TEST-002
- **Validation:** `yarn generate`, `yarn typecheck`, `yarn test`, focused `TC-PZ-00x`
- **Exit gate:** a draft can be released, refuses edits, comes back while empty, and confirm still
  works from `receiving`; light/dark and narrow widths checked on the detail page.

### Phase 2 — Pallets

- **Depends on:** Phase 1 exit gate
- **Outcome:** a Warehouseman sees the released receipts of their warehouse, opens one and creates
  pallets.
- **Deliverables:** `pz_pallets` entity + migration (generated, reviewed, not applied without
  asking); code generation; create/update/delete/list/by-code commands and routes; `pz.receiving.count`
  ACL feature and the Warehouseman role grant; Panel `/warehouseman/receiving` and
  `/warehouseman/receiving/[receiptId]` replacing the Stub Action; backend pallet list.
- **Independent slices / estimated commits:** entity + migration; commands + routes; Panel screens (~4).
- **Requirements closed:** REQ-002, REQ-003
- **Tests:** TEST-003, TEST-004, TEST-009
- **Validation:** `yarn generate`, `yarn typecheck`, `yarn lint`, `yarn ds:check`, focused integration
- **Exit gate:** from a phone-width browser, log in, open a released receipt, create a pallet, scan
  its code to reopen it, and be refused when scanning another document's pallet.

### Phase 3 — Counting

- **Depends on:** Phase 2 exit gate
- **Outcome:** goods are counted onto a pallet by barcode, with corrections.
- **Deliverables:** `pz_pallet_lines` entity + migration; `variant-by-barcode` resolution;
  count/update/delete commands and routes with optimistic locking; the counting screen including the
  unknown-barcode fallback to the installed catalog picker; i18n; OpenAPI.
- **Independent slices / estimated commits:** entity + migration; resolution helper + routes; counting
  screen (~4).
- **Requirements closed:** REQ-004, REQ-005, REQ-009
- **Tests:** TEST-005, TEST-006, TEST-007, TEST-011
- **Exit gate:** a scan with a quantity produces one accumulating row, a corrected quantity sticks, a
  concurrent write gives a recoverable 409, and an unknown barcode still lets the count happen.

### Phase 4 — Closing and the confirm gate

- **Depends on:** Phase 3 exit gate
- **Outcome:** the floor declares a pallet counted; the office cannot confirm over an open one.
- **Deliverables:** close/reopen commands and routes; confirm guard + `confirmPalletsOpen` error;
  Panel close/reopen with confirmation dialogs; backend refusal messaging.
- **Requirements closed:** REQ-006, REQ-008
- **Tests:** TEST-008
- **Exit gate:** confirm is refused while a pallet is open, succeeds once all are closed, moves no
  stock, and a closed pallet can be reopened before confirmation.

### Phase 5 — Receiving Summary

- **Depends on:** Phase 4 exit gate
- **Outcome:** expected vs counted, per product, on both surfaces.
- **Deliverables:** pure summary computation + `receiving-summary` route; Panel summary screen;
  backend detail summary section; i18n. Presentation is fully specified above — ordering, the
  `pokaż zgodne` toggle, per-Pallet expanders, wording and placement — so this phase needs no
  further design input.
- **Requirements closed:** REQ-007
- **Tests:** TEST-010, TEST-012
- **Validation:** full broad gate + `yarn test:integration:ephemeral`
- **Exit gate:** a split-across-pallets product shows one combined counted total; short, over and
  surplus rows are each legible in words in light and dark at phone width.

## Requirement Traceability

| Requirement | Journey / surface | Data/API/event contracts | Phase | Tests | Acceptance criterion |
|---|---|---|---|---|---|
| REQ-001 | J-001, `/backend/wms/goods-receipts/[id]` | `pz_goods_receipts.status`, `release`, `withdraw` | Phase 1 | TEST-001, TEST-002 | AC-001 |
| REQ-002 | J-002, `/warehouseman/receiving` | `GET /api/pz/goods-receipts?status=receiving` | Phase 2 | TEST-009, TEST-010 | AC-002 |
| REQ-003 | J-002, `/warehouseman/receiving/[receiptId]` | `pz_pallets`, `/api/pz/pallets`, `/by-code` | Phase 2 | TEST-003, TEST-004 | AC-003 |
| REQ-004 | J-002, counting screen | `pz_pallet_lines`, `/api/pz/pallet-lines`, `variant-by-barcode` | Phase 3 | TEST-005, TEST-006, TEST-011 | AC-004 |
| REQ-005 | J-002, counting screen | `PUT`/`DELETE /api/pz/pallet-lines`, `DELETE /api/pz/pallets` | Phase 3 | TEST-005 | AC-005 |
| REQ-006 | J-002 step 6, J-003 | `/api/pz/pallets/close`, `/reopen` | Phase 4 | TEST-008, TEST-010 | AC-006 |
| REQ-007 | J-003, both summary surfaces | `receiving-summary` | Phase 5 | TEST-010, TEST-012 | AC-007 |
| REQ-008 | J-003 | `confirm` + `confirmPalletsOpen` | Phase 4 | TEST-008 | AC-008 |
| REQ-009 | J-002 step 8 | lock header on pallet-line writes | Phase 3 | TEST-007 | AC-009 |

## Rollout, Migration, and Rollback

Two additive tables and no column change: `yarn db:generate` produces the migration, its SQL and the
`pz` snapshot are reviewed, and it is applied only with explicit approval — never to validate. No
data backfill: existing receipts stay `draft` or `confirmed`, and no confirmed document is touched.
`pz.receiving.count` is added to `pz/acl.ts` and granted to the Warehouseman role in
`warehouseman/setup.ts` alongside `pz.goodsReceipts.view`. No feature flag: the Panel screen replaces
a Stub Action, so the feature is invisible until its phase lands. Rollback is per phase — dropping
the two tables and the `receiving` status is safe while no document has been released; once a
document has been released, rolling back requires withdrawing it to `draft` first.

## Risks and Tradeoffs

| Risk / tradeoff | Impact | Mitigation / detection | Residual risk |
|---|---|---|---|
| `receiving` is a partly-immutable state, the shape ADR-0006 avoided | Future edit paths may disagree about what is frozen | The freeze rule is literally the confirmed one; TEST-001 asserts every mutation refuses | A new mutation route could forget the guard; caught by reusing the shared guard |
| No unit on counted quantities | Office lines in cartons vs floor counting pieces makes a difference wrong | Summary displays the Line's unit next to both numbers so the mismatch is visible to a human | Silent miscomparison if nobody reads the unit — accepted, revisit on a real case |
| Concurrent counting on one pallet | Lost counts | Optimistic locking on every quantity write, 409 surfaced with a reload; TEST-007 | A user who ignores the conflict and re-types a stale number |
| Pallet code generation under concurrency | Two pallets racing for the same code | Unique index + retry on unique violation, as the document number path already does | Retry storm under absurd concurrency; bounded retries |
| Withdraw blocked once a pallet exists | Office cannot fix a wrong release after counting starts | Deleting the empty pallets restores the way back; refusal message says so | A receipt counted against the wrong document needs deletion of pallet lines first |
| Cross-tenant pallet code lookup | Enumeration oracle | `by-code` scoped to trusted tenant + organization; TEST-009 | — |
| Floor counts but nobody confirms | Documents stall in `receiving` | The backend index filter shows the `receiving` bucket | No reminder or scheduled nudge (Non-goals) |

## Acceptance Criteria

- [ ] **AC-001** — An office user with `pz.goodsReceipts.manage` releases a draft; every edit and
      delete on it is then refused, and it can be withdrawn only while it has no Pallet.
- [ ] **AC-002** — A Warehouseman signing into the Panel sees only `receiving` receipts of their
      Assigned Warehouse, and none from another tenant or organization.
- [ ] **AC-003** — Pallets created in one Organization have unique codes; scanning a code belonging to
      another Goods Receipt is refused by name and never switches document.
- [ ] **AC-004** — Scanning one barcode twice on one Pallet leaves one Pallet Line whose quantity is
      the sum; an unknown barcode still results in a recorded count via the catalog picker.
- [ ] **AC-005** — A quantity can be corrected and a Pallet Line removed; an empty open Pallet can be
      deleted and its code becomes free.
- [ ] **AC-006** — A Pallet can be closed and reopened while the receipt is not confirmed.
- [ ] **AC-007** — For a product counted across two Pallets, the Summary shows one combined counted
      total against the expected quantity, and a product on no Line appears as surplus.
- [ ] **AC-008** — Confirm is refused while any Pallet is open, succeeds when all are closed
      (including with zero Pallets), and moves no stock.
- [ ] **AC-009** — Two concurrent quantity writes: the second receives 409 and no count is lost.
- [ ] Every listed backend surface matches its recorded Open Mercato reference and uses the canonical
      shell/components, shared API helpers, semantic tokens, and complete loading, empty, error,
      conflict, keyboard, accessibility, responsive, light-mode, and dark-mode states.
- [ ] Every affected API and UI path has self-contained integration coverage and the configured
      validation gate passes.

## Final Compliance Report

| Check | Status | Evidence / resolution |
|---|---|---|
| Applicable `AGENTS.md` files and routed guides/skills reviewed | pass | root `AGENTS.md`, `.ai/specs/README.md`, `SPEC-000-template.md`, `.ai/guides/modules/wms|catalog` entity facts, ADR-0001…0010 |
| Data models, APIs, events, UI, and tests are internally consistent | pass | Requirement Traceability covers REQ-001…009 |
| Every workflow completes end to end without a catch-all integration phase | pass | J-001…J-003; each phase ends in a usable slice |
| Platform-native reuse and extension points were chosen before custom code | pass | Reuse and Ownership Map; `makeCrudRoute`, `CommandBus`, `PanelShell`, catalog picker |
| UI contracts identify references, canonical components, and theme/state coverage | pass | UI and Interaction Contracts table + UI architecture |
| Every phase has dependencies, bounded slices, tests, value, and an observable exit gate | pass | Phases 1–5 |
| Permission model resolved | pass | Q-001 resolved: `warehouseman.panel.access` for Panel entry, `pz.goodsReceipts.view` + `pz.receiving.count` for the API |

Verdict: `Ready for implementation`.

## Open Questions

| ID | Question | Owner | Blocking? | Resolution / decision date |
|---|---|---|---|---|
| Q-001 | Which features the Warehouseman role holds, given that `pz` must not gate on a `warehouseman` feature ID. | user | yes | **Resolved 2026-09-19**: Panel entry keeps `warehouseman.panel.access`; the Warehouseman role additionally holds `pz.goodsReceipts.view` and a new `pz.receiving.count`, seeded in `warehouseman/setup.ts`. `pz` gates only on `pz.*` features. |
| Q-002 | Pallet code format and generation: proposal `PAL-` + a per-Organization zero-padded sequence derived in-transaction, with unique-violation retry, mirroring the document-number path. Alternative: a random code, no sequence, no contention. | user | no | pending — `PAL-000001` assumed |
| Q-003 | Pallets and Pallet Lines are hard-deleted, unlike the soft-deleted Goods Receipt, so a deleted Pallet frees its code and leaves no trace. | user | no | pending — hard delete assumed |

## Changelog

| Date | Change |
|---|---|
| 2026-09-19 | Initial draft from the `/grill-with-docs` design interview. |
| 2026-09-19 | Q-001 resolved (`pz.receiving.count`); status set to `Ready for implementation`. |
| 2026-09-19 | Receiving Summary presentation specified in full (ordering, toggle, expanders, wording, placement); every phase is agent-ready. |
