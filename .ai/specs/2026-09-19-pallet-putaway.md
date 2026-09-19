# Pallet Putaway and the Pallet as a Persistent Carrier

**Date**: 2026-09-19
**Status**: Draft
**Issue**: [#50](https://github.com/Zales0123/Fondaco/issues/50)
**Research**: `.ai/research/2026-09-19-pallet-putaway-50.md` (primary-source evidence behind every claim below)

> Every section of `SPEC-000-template.md` is preserved. Status becomes `Ready for implementation`
> only after the Final Compliance Report passes and the user approves.

## TLDR

A Pallet stops being a counting device that dies with its Goods Receipt and becomes a persistent
carrier with its own identity, contents, history and a location computed from the stock ledger. Two
new app modules carry it: `pallets` owns the carrier and the record of every confirmed placement of
its goods, and `putaway` owns the floor operation that moves a received pallet from a staging
location to its storage location through the installed `wms.inventory.move` command with movement
type `putaway`. The installed WMS has no `palletId`, so every movement of pallet goods crosses a
controlled `pallets` command boundary; an unrecognised direct WMS movement is treated as location
drift and blocks further putaway instead of being attributed to a pallet by guesswork. Because
confirming a Goods Receipt does not put anything into the ledger today, this spec also lands the
smallest inbound posting slice that makes a pallet exist in `wms` at all. The installed WMS stays the
only quantity ledger; this app owns the carrier, the work, and the controlled execution of the moves.

## Problem Statement

The app can count a delivery onto pallets and freeze the document, and there it stops. The goods
never reach the stock ledger, nothing can move them to a storage place, and the pallet's real life on
the floor — it is moved, it is scanned, it is asked "what is on you and where are you" — has no
representation at all.

Three things block the operation, each verified against the tree rather than the tracker:

1. **The glossary contradicts the requirement.** `CONTEXT.md:84-87` defines a Pallet as "A carrier
   the goods of one Goods Receipt are counted onto… It belongs to that document and cannot outlive
   it", and forbids *handling unit* and *LPN*. The entity comment says the same
   (`src/modules/pz/data/entities.ts:180-188`, `:111`). A carrier that is put away after its document
   is confirmed and keeps its history is exactly the thing that definition says does not exist.
2. **The owner is wrong.** `Pallet`/`PalletLine` live in `pz` with a real in-module ORM ManyToOne to
   `GoodsReceipt` (`src/modules/pz/data/entities.ts:212-213`). A carrier that outlives the document
   cannot hang off the document's foreign key.
3. **Nothing posts stock, so a putaway has nothing to move.** `pz.goodsReceipts.confirm` deliberately
   moves no stock — "`wms.inventory.receive` is not called (ADR-0005)"
   (`src/modules/pz/commands/goodsReceipts.ts:1502-1506`). `grep -rn "wms.inventory.receive" src`
   outside comments hits only `src/modules/wms_fixtures/lib/seed.ts:288`. None of #44–#47's machinery
   exists: the status enum is `draft | receiving | confirmed`
   (`src/modules/pz/data/entities.ts:16`), there are no `issue`/`retry`/`cancel`/`reconcile` commands
   (`.mercato/generated/command-loaders.generated.ts:1502-1596`), no provenance record, no frozen
   payloads, no per-line outcomes. Those issues are closed on the tracker and their spec PR #52 was
   closed unmerged. #50's sentence "we do not repeat the execution mechanics #45 and #46 establish"
   has nothing to point at, so this spec establishes them.

Evidence it matters: the fixture warehouse already models the destination shape — `STG-RECV` with
`type: 'staging'` (`src/modules/wms_fixtures/lib/data.ts:149`), receipts into it (`:272-274`) and
`type: 'putaway'` moves out of it into `A-01-02`/`B-01-01`/`B-01-02` (`:283-285`). The demo data
describes an operation the application cannot perform.

## Overview and Success Measures

| Measure | Today | After this spec |
|---|---|---|
| Counted pallet reaches the stock ledger | never | every confirmed Goods Receipt posts its pallet lines into a staging location |
| "Where is pallet P?" | unanswerable | last known location from confirmed placements, with integrity status per pallet line |
| Pallets awaiting putaway | no such concept | a scoped work list keyed on destination-location `type = 'staging'` |
| Moving a pallet to storage | impossible | scan → scan → scan → confirm, one `wms.inventory.move` per pallet line |
| Warehouse total on hand after a putaway | n/a | unchanged; only the per-location split moves |
| A pallet's life after its document closes | ends | identity, contents and history survive |

## Goals

- **REQ-001** — `Pallet` and `PalletLine` are owned by a new app module `pallets`, with no ORM
  relation to `GoodsReceipt`; the carrier survives its source document.
- **REQ-002** — `pz` keeps every receiving behavior it has today over the relocated carrier, reading
  it by scalar id through the query engine and writing it only through `pallets` commands.
- **REQ-003** — Confirming a Goods Receipt posts each counted pallet line into a staging location of
  the document's warehouse, once, idempotently, with a per-line stable reference.
- **REQ-004** — A pallet's current location and contents are computed from confirmed placements, per
  pallet line. A line is actionable only while its derived integrity is `trusted`; a pallet awaits
  putaway when a trusted line's current location has `type = 'staging'`.
- **REQ-005** — A Warehouseman sees a work list of pallets awaiting putaway, filtered to their
  Assigned Warehouse, never a list of all pallets.
- **REQ-006** — The floor flow is scan pallet → scan source → scan destination → summary → confirm.
  Scanning alone changes no stock.
- **REQ-007** — Confirmation issues one `wms.inventory.move` with `type: 'putaway'` per pallet line;
  the warehouse total for the product does not change, only its per-location split.
- **REQ-008** — A partial result is displayed truthfully per line, with the real locations of each;
  resuming retries only the unresolved lines under their original identity.
- **REQ-009** — Two Warehousemen confirming the same pallet produce at most one move per line; the
  loser sees the current result or a conflict, never a duplicate move.
- **REQ-010** — An unknown outcome is read back from the ledger before any further write for that
  line.
- **REQ-011** — Putaway is refused for an open or unposted pallet, a wrong source, a destination equal
  to the source, a foreign warehouse or scope, an inactive destination, missing permission, or
  insufficient available stock — with no movement written.
- **REQ-012** — From a pallet code a user reaches its source document, its operations, its movements,
  and who performed them when.
- **REQ-013** — A Goods Receipt whose pallets have been put away, or have an unresolved outcome,
  cannot be withdrawn or retro-actively unwound.
- **REQ-014** — No generic WMS movement may be used to move tracked pallet goods. The `pallets`
  movement facade is the only supported write path; reconciliation detects an unrecognised WMS
  movement, marks affected pallet lines `drifted`, removes them from putaway work, and requires a
  controlled reconciliation before work can resume.

## Non-goals

Explicitly out of scope, not omissions: destination capacity limits (the installed WMS does not
enforce them either — §5.8 of the research); user-selected partial putaway; repacking a pallet;
inter-warehouse transfers; labels; QC; offline posting; a task manager with assignments; a workflow
designer; place optimisation; lot and serial handling beyond the limits #40 already set; a second
quantity ledger of any kind; and a `pz` cancellation command (#47), which does not exist and is not
built here — REQ-013 only protects what does exist.

## Proposed Solution

Two new app modules and one subscriber, over the installed WMS:

- **`pallets`** owns the carrier: `Pallet`, `PalletLine`, and `PalletPlacement` — the append-only
  record of every attempt to place the carrier's goods in the ledger, and therefore the source for
  the last known location of each line. It exposes plan / execute / reconcile commands and the only
  supported movement facade that wraps the installed inventory commands. The facade always creates a
  placement before calling WMS and passes that placement id as `referenceId`; no pallet-aware caller
  calls `wms.inventory.receive` or `wms.inventory.move` directly. Reconciliation compares observed WMS
  movements with known placement references and marks affected lines `drifted` when a direct movement
  is found. The module also owns a subscriber on `pz.goods_receipt.confirmed` that posts the counted
  lines into a staging location.
- **`putaway`** owns the floor operation: which pallets are work, the operation a Warehouseman starts
  and confirms, the destination, the actor, the permission, and the orchestration of the moves. It
  references pallets by id and never touches their tables.
- **`pz`** loses the `Pallet` ORM relation and keeps every behavior, reading the carrier through the
  query engine exactly as it already reads `wms:warehouse` (`src/modules/pz/commands/goodsReceipts.ts:168`).
- **`warehouseman`** gains the panel screens, as it already hosts every panel screen over `pz`'s API.

### Design Decisions and Alternatives

| Decision | Alternative rejected | Why |
|---|---|---|
| A new `pallets` module owns the carrier | Keep in `pz`; move into `wms`; let `putaway` own it | `pz` is the document the carrier must outlive; installed `wms` entities are not app-editable and have no extension points for entities (ADR-0004); `putaway` would invert the dependency, since a pallet exists long before any putaway. Settled on #50. |
| A separate `putaway` module owns the operation | `pallets` owns carrier and operation | User decision. The carrier registry stays answerable to "what and where"; floor work, permissions and orchestration live apart, leaving room for picking and replenishment later. |
| `PalletPlacement` is one append-only table serving both `receive` and `putaway` | A separate execution table per operation | Two operations land in this spec; one seam with two callers is a real seam. One table also makes the last known location a single ordered read instead of a union. |
| `PalletPlacement.id` is the `referenceId` passed to `wms` | `referenceId` = goods-receipt id (ADR-0005's suggested recipe), or the pallet code | `inventoryMoveSchema` requires a uuid `referenceId`, so a pallet code is impossible (`validators.ts:277-293`). Worse, `buildMovementIdempotencyKey` joins reference + type + locations + variant + **quantity** (`lib/inventoryIdempotency.ts:12-37`): two pallets holding the same variant and quantity in the same location under one document-level reference would produce an identical key, and the second posting would be silently swallowed as a replay. A per-placement uuid is the only reference that cannot collide. |
| Current location is computed from confirmed placements | Store `currentLocationId` on the pallet | #50's decision, and the honest one: a stored column drifts from the ledger, and a multi-product pallet split across a partial putaway has no single location to store. Integrity is tracked separately so drift is visible instead of hidden. |
| Every pallet movement crosses a `pallets` command boundary | Let callers invoke `wms.inventory.move` directly | WMS movements carry no `palletId`, so a direct movement cannot be assigned safely to one carrier. The facade supplies the placement reference; reconciliation fails closed when an unrecognised movement touches a tracked variant/location. |
| Awaiting putaway = the line's current location has `type = 'staging'` | A boolean flag, a status, or a hardcoded `STG-RECV` | #50 forbids inferring from `posted` or from a location name. `type` is a first-class filter on the installed contract (`wms/api/locations/route.ts:30, :74`). |
| Posting is a subscriber owned by `pallets` | A subscriber inside `pz`; a third module | ADR-0005 designed the seam this way — "adding a subscriber… without touching this module". `pallets` is the optional consumer that needs the goods in the ledger, and it is the module that owns placements. |
| Panel screens live in `warehouseman` | Screens inside `putaway` | Matches the existing layout exactly: every panel screen lives in `warehouseman` and calls another module's API (`src/modules/warehouseman/lib/receivingApi.ts`). Avoids a new cross-module component-import direction. |
| The staging destination is resolved by `type`, and ambiguity is refused loudly | Hardcode `STG-RECV`; add a receiving location to the document | Hardcoding is forbidden by #50. A per-document receiving location is a `pz` schema change this slice does not need; refusing an ambiguous warehouse is testable and makes the gap explicit rather than silent. |

## Domain Vocabulary and Business Rules

| Term / invariant | Precise meaning or rule | Source of truth | Failure behavior |
|---|---|---|---|
| Pallet | A carrier goods are counted onto, identified by its own barcode, with its own contents, location and history. It is created on a Goods Receipt and outlives it. | `pallets:pallet` | — |
| Pallet Line | One product and its counted quantity on one Pallet; one row per product per pallet. | `pallets:pallet_line` | unique `(pallet_id, catalog_variant_id)` |
| Placement | A statement that a pallet line's goods were put into, or moved to, a location in the ledger. Carries its own outcome; only a `confirmed` placement is a fact. | `pallets:pallet_placement` | outcome `pending`/`unknown` is never read as a location |
| Current Location | The `toLocationId` of a pallet line's latest `confirmed` placement, ordered by `performedAt` and placement id as a deterministic tie-break. This is actionable only while integrity is `trusted`. A pallet with lines in different locations has no single current location. | computed | no confirmed placement or `drifted` integrity → no actionable location and no work |
| Location Integrity | `trusted` means all observed movements touching the tracked variant/location are recognised by a placement reference; `drifted` means an unrecognised movement was observed. | `pallet_line.location_integrity` plus reconciliation evidence | `drifted` blocks putaway and requires reconciliation; never silently reassigns stock |
| Awaiting Putaway | A pallet line whose current location has `type = 'staging'`, whose integrity is `trusted`, on a pallet that is `closed` and has no unresolved placement. | computed | ambiguity or drift is resolved by excluding, never by guessing |
| Putaway | The operation that moves a received pallet's goods from a staging location to a storage location within one warehouse. | `putaway:putaway_operation` | — |
| Putaway Work | The list of pallets awaiting putaway in a warehouse. Work, not an inventory of pallets. | computed | — |
| Close | Unchanged: the reversible act by which a Warehouseman declares a Pallet counted. | `pallets.pallets.close` | reopen refused once the source document is confirmed |
| Frozen payload | The quantity, source and destination of every line of a putaway operation, captured at start and never re-derived on retry. | `pallets:pallet_placement` | a changed pallet invalidates the operation rather than silently re-freezing |
| Reference identity | `PalletPlacement.id`, passed as `referenceId` with `referenceType: 'manual'`, stable across every attempt for that line. | `pallets:pallet_placement` | never the pallet code, never the document id |
| Outcome | `pending` → an attempt may be in flight; `confirmed` → a movement id is known; `rejected` → the ledger refused, with a reason; `unknown` → the result was not observed and must be read back before any further write. | `pallets:pallet_placement` | `unknown` blocks further writes for that line |

## Users, Permissions, and Scope

| Actor | Allowed outcomes | Scope rule | Required feature IDs |
|---|---|---|---|
| Warehouseman (panel) | see putaway work, start an operation, scan, confirm, retry, see history | own organization; work list filtered to the Assigned Warehouse (a filter, never a gate — ADR-0002) | `warehouseman.panel.access`, `pallets.view`, `putaway.execute` |
| Office user (backend) | read pallets, their contents, placements and operations | own organization | `pallets.view` (dependsOn `wms.view`) |
| System (subscriber) | post confirmed receipts into staging | the tenant/org carried on the emitted event | none — runs under the event's scope, never system scope |

Trusted `tenantId`/`organizationId` are derived exactly as `pz` derives them today —
`ensureGoodsReceiptScope(ctx, translate)` (`src/modules/pz/commands/goodsReceipts.ts:121`), which the
pallet commands already reuse (`commands/pallets.ts:27`). The `pallets` module ships its own
equivalent so it does not gate on a `pz` export. Payload scope is never trusted; a missing scope is a
refusal, never "unrestricted". No operation in this spec uses system scope (`organizationId: null`).

`putaway.execute` declares `dependsOn: ['wms.view', 'wms.adjust_inventory']`. The installed move API
is gated on `wms.adjust_inventory` (`wms/api/inventory/move/route.ts:6-7`); calling the command
in-process from an app route must not become a way to hand a Warehouseman that capability through the
back door.

## Reuse and Ownership Map

| Capability | Reuse / extend / app-own | Existing module or new module | Integration seam | Why |
|---|---|---|---|---|
| Quantity ledger, balances, movements | reuse | installed `wms` | called only through the `pallets` movement facade | the only quantity ledger; #50 forbids a second one and the facade preserves pallet lineage |
| Locations and their `type` | reuse | installed `wms` | `GET /api/wms/locations?type=staging` | first-class filter, already supported |
| Warehouse | reuse | installed `wms` | scalar `warehouseId` + snapshot | ADR-0004 |
| Product identity | reuse | installed `catalog` | scalar `catalogVariantId` + snapshot | ADR-0007 |
| Carrier identity, contents, placements | app-own | **new `pallets`** | own entities; read by others via query engine and commands | #50 decision |
| Putaway work and operations | app-own | **new `putaway`** | pallet id + placement commands | user decision |
| Goods Receipt document | reuse | `pz` | emits `pz.goods_receipt.confirmed`; reads pallets by id | ADR-0004/0005 |
| Panel shell, scan field, states | reuse | `warehouseman` | `PanelShell`, `PanelUI.ScanField`, `ReceivingStates` | already the panel's vocabulary |
| Barcode camera fallback | reuse | `barcode_scanner` | `BarcodeScannerDialog` | already used by receiving |
| Optimistic locking | reuse | shared | `assertOptimisticLock`, required version header | the `pz` pattern (`commands/pallets.ts:95-107`) |
| Label printing | reuse | `label_printing` | scope id `pz.pallet` | see the compatibility note in Rollout |

## Architecture and Data Flow

```text
office confirms PZ
  pz.goodsReceipts.confirm -> event pz.goods_receipt.confirmed (persistent, post-commit)
        -> [pallets] subscriber
             -> resolve staging location (wms locations, type=staging, warehouse of the document)
             -> pallets.placements.plan      (kind=receive, one row per pallet line, frozen)
             -> pallets.placements.execute   (pallets movement facade -> wms.inventory.receive,
                                              referenceId = placement.id)
                                             -> confirmed | rejected | unknown

floor puts a pallet away
  warehouseman panel -> PUT /api/putaway/operations        (putaway.operations.start)
                            -> reads computed placement from pallets
                            -> freezes lines
                     -> POST /api/putaway/operations/confirm (putaway.operations.confirm)
                            -> pallets.placements.plan    (kind=putaway, from -> to)
                            -> pallets.placements.execute (pallets movement facade ->
                                                            wms.inventory.move, type=putaway)
                            -> per-line outcome -> operation status
                     -> POST /api/putaway/operations/retry  (unresolved lines only)

reads
  GET /api/pallets/by-code        -> carrier + contents + computed location + history
  GET /api/putaway/work           -> trusted pallets awaiting putaway in a warehouse
```

- **Module boundaries:** `pallets` owns one invariant — the carrier and the controlled, last-known
  location of each line. `putaway` owns another — the floor operation and who may perform it. They are
  separate modules because a carrier exists without any operation and outlives every one of them; they
  are not merged because nothing requires them to be transactionally consistent: a placement is
  committed by the ledger, and the operation reflects placements rather than owning them.
- **Extension points:** the installed `wms` is used only through its published commands and read APIs;
  nothing installed is modified. The app-level contract is stricter: generic WMS movement routes are
  not a supported path for tracked pallet goods, and the `pallets` facade is the only writer for those
  goods. The panel entry point is a new tile in `PanelHome`'s `ACTIONS` data
  (`src/modules/warehouseman/components/PanelHome.tsx:13-18`), not a new shell.
- **Alternatives considered:** doing the whole thing as a `wms` extension (rejected: installed WMS
  entities are not app-editable and carry no pallet concept — `InventoryMovement` has no pallet field,
  research §5.5); storing a pallet's location on the pallet (rejected above).
- **Compatibility:** `/api/pz/pallets*` and the entity ids `pz:pallet` / `pz:pallet_line` are frozen
  surfaces under `.ai/guides/contracts.md:92`. See Rollout for the bridge.

## User Journeys

### Journey J-001 — A confirmed delivery becomes stock a pallet carries
The office confirms a released Goods Receipt. Every closed pallet's lines are posted into the
warehouse's staging location, one movement per pallet line. The pallet now answers "what is on me" and "where was this line last confirmed"; it appears as putaway
work only while its location integrity is trusted. Covers REQ-003, REQ-004.

### Journey J-002 — A Warehouseman puts a pallet away
From the panel home, "Do odłożenia". The list shows trusted pallets whose lines are waiting in a
staging location in their Assigned Warehouse. Scan the pallet code: its code, source document,
contents with quantities and units, last known source location and integrity appear. A drifted line
is shown as requiring reconciliation and cannot enter confirmation. Scan the source location and it
is checked against the recorded one. Scan the destination and it is checked for the same warehouse
and scope, active, and different from the source. A summary reads "Paleta P: PRZYJĘCIA → A-01" with
products and quantities.
"Potwierdź odłożenie" issues the moves. Each line shows its own result, and the pallet is reported
put away only when every required line is confirmed. Covers REQ-005 … REQ-009, REQ-011.

### Journey J-003 — A multi-product pallet fails halfway
Line 1 is confirmed, line 2 is refused for insufficient available stock. The screen shows the pallet
as partially put away, naming the real location of each line — never one invented location for the
whole pallet, never overall success. Resuming retries only line 2, under its original reference.
Covers REQ-008, REQ-010.

### Journey J-004 — The document closes, the pallet lives on
The Goods Receipt is confirmed and later archived. Scanning the pallet still returns its identity,
contents, last known location, integrity state and full history, including the document it came from. Covers REQ-001,
REQ-012.

## UI and Interaction Contracts

All surfaces are Warehouseman **panel** screens, not `/backend` pages: they live in
`src/modules/warehouseman/frontend/warehouseman/putaway/**` and reuse the panel primitives. The
closest installed reference for every one of them is the receiving flow in the same module
(`components/ReceivingPallets.tsx`, `components/ReceivingCount.tsx`), which this spec follows rather
than reinvents. No `/backend` page is added in this spec; pallets remain readable through their API.
Because these are panel screens, `DataTable`/`CrudForm` do not apply — the panel's own glove-sized
primitives (`PANEL_ACTION`, `PanelCard`, `ScanField`, `StatTile`, `ReceivingStates`) are the canonical
components here, exactly as ADR-0001 and the existing receiving screens establish. That is the
recorded exception, and it is the same one the panel already runs under.

| Surface / route | Purpose and primary actions | Data source / mutations | Closest installed reference | Canonical shell / components | Required states | Requirement IDs |
|---|---|---|---|---|---|---|
| `/warehouseman` (tile) | enter putaway work, badged with the count waiting | `GET /api/putaway/work?warehouseId` | `PanelHome.tsx:13-28` receiving tile | `PanelHome`, `PanelAction` | loading, unbadged-on-failure | REQ-005 |
| `/warehouseman/putaway` | list pallets awaiting putaway; open one; scan a code to jump to it | `GET /api/putaway/work` | `ReceivingDocuments.tsx` | `PanelShell`, `PanelCard`, `ScanField`, `ReceivingStates` | loading, empty, error, permission denied | REQ-005, REQ-006 |
| `/warehouseman/putaway/[palletId]` | show carrier, contents, source; scan source; scan destination; summary; confirm | `GET /api/pallets/{id}`, `PUT /api/putaway/operations`, `POST …/confirm` | `ReceivingPallets.tsx` scan-to-open, `ScanQuantityStep.tsx` confirm step | `PanelShell`, `ScanField`, `PanelCard`, `StatTile`, `PanelFooter` | loading, empty, error, conflict, partial, success, permission denied | REQ-006, REQ-007, REQ-011 |
| `/warehouseman/putaway/[palletId]` (result) | per-line outcome; retry unresolved lines; back to work | `POST /api/putaway/operations/retry` | `ReceivingStates.ScreenWarning` | `ScreenWarning`, `StatTile`, `PanelLinkButton` | partial, unknown, error, success | REQ-008, REQ-010 |
| `/warehouseman/putaway/[palletId]/history` | pallet → document → operations → movements → actor and time | `GET /api/pallets/{id}/history` | `ReceivingSummaryScreen.tsx` | `PanelShell`, `PanelCard` | loading, empty, error | REQ-012 |

### UI architecture

| Role | Navigation groups in order | Dashboard / injected widgets | Login-to-primary-task flow |
|---|---|---|---|
| Warehouseman | Panel home → Do odłożenia → pallet → confirm | the existing WMS-menu injection widget reaches the panel (ADR-0012); a fifth `PanelAction` tile is added | login → panel home → "Do odłożenia" → pallet = 3 taps |

| Surface / widget | Empty state guidance and action | Responsive behavior | Keyboard / focus behavior |
|---|---|---|---|
| Work list | localized "nothing is waiting in this warehouse", with a link back to the panel home | single column, sticky footer on handheld, static from `md:` | scan field holds focus on entry; list items are links with visible focus |
| Scan steps | each step names what to scan next | one control per row, `h-20` targets | HID scanner types and submits on Enter via `ScanField`'s own `<form>`; focus returns to the field after every submit, including a failed one |
| Result | names the pallet's real per-line locations | stacked `StatTile`s | the retry button takes focus when unresolved lines remain; results announced in a live region |

### `/warehouseman/putaway/[palletId]` — Put a pallet away

```text
┌────────────────────────────────────────────────────────────┐
│ ← Do odłożenia            Paleta P-000123                  │
│ PZ 2026/09/17 · PRZYJĘCIA (STG-RECV)                       │
├────────────────────────────────────────────────────────────┤
│ Zawartość                                                  │
│  Śruba M8 ×97 szt        Podkładka ×40 szt                 │
│                                                            │
│ 1. Zeskanuj lokalizację źródłową   [__________] [Skanuj]   │
│ 2. Zeskanuj lokalizację docelową   [__________] [Skanuj]   │
│                                                            │
│ Podsumowanie:  Paleta P-000123: PRZYJĘCIA → A-01           │
├────────────────────────────────────────────────────────────┤
│                                   [ Potwierdź odłożenie ]  │
└────────────────────────────────────────────────────────────┘
```

- **Behavior:** a typed code and a camera read meet in one lookup, as `openPalletByCode` already does
  (`ReceivingPallets.tsx:111-145`), guarded by a `useRef` re-entrancy flag because the camera fires on
  every decoded frame (`:60-62`). Scans never mutate: the destination is held in component state until
  "Potwierdź odłożenie". A source scan that disagrees with the recorded location refuses and explains;
  it never silently re-targets the context to another pallet or document. Confirmation sends the
  operation's version; a 409 re-reads and shows what changed, following
  `ReceivingCount.tsx:369-377`. Back and cancel abandon the form, never a committed move.
- **Responsive and accessibility:** `PANEL_ACTION` glove targets, labelled scan fields via
  `React.useId()`, status announced through `role="status"`, focus returned to the active scan field,
  single-column layout at narrow width.
- **Localization:** new keys under `warehouseman.putaway.*` in `src/modules/warehouseman/i18n/{en,pl}.json`
  and domain refusals under `putaway.*` / `pallets.*` in the new modules' own bundles, EN and PL in
  sync, checked by `yarn i18n:check-hardcoded`.
- **Design-system and theming:** semantic tokens only; status colors come from a module-scope map as
  in `PALLET_STATUS_VARIANTS` (`ReceivingPallets.tsx:37-40`), never inline. Verified in light and dark
  and at narrow width.

## Data Models

### `pallets:pallet` — table `pallets_pallets`

| Field | Type / nullability | Scope / index | Sensitive / encrypted | Lifecycle and validation |
|---|---|---|---|---|
| `id` | UUID, required | primary key | no | immutable |
| `tenant_id` / `organization_id` | UUID, required | composite scope indexes | no | trusted context only |
| `code` | text, required | unique `(tenant_id, organization_id, lower(code))` | no | generated, immutable (ADR-0010) |
| `label` | text, nullable | — | no | ≤120 chars, editable while `open` |
| `status` | `open` \| `closed` | index `(status)` | no | `open → closed` via close, reversible while the source document allows it |
| `warehouse_id` | UUID, required | index `(tenant, org, warehouse_id)` | no | scalar; snapshot of the source document's warehouse |
| `source_document_type` | text, required | — | no | `pz.goods_receipt` today; open for later sources |
| `source_document_id` | UUID, required | index `(source_document_type, source_document_id)` | no | scalar, **no FK** — this is the relation that is deliberately cut |
| `source_document_snapshot` | jsonb, required | — | no | `{ documentNumber, documentDate }`, historical, never rewritten |
| `closed_at` | timestamp, nullable | — | no | moves with `status` |
| `created_at` / `updated_at` | timestamp, required | `updated_at` is the optimistic-lock version | no | updated on every edit |

Hard-deleted only while `open` and empty, as today (`src/modules/pz/data/entities.ts:180-188`).

### `pallets:pallet_line` — table `pallets_pallet_lines`

Based on `pz_pallet_lines` (`src/modules/pz/data/entities.ts:251-298`): in-module ManyToOne
`pallet_id`, scope columns, `catalog_variant_id`, `catalog_product_id`, `catalog_snapshot` jsonb,
`quantity` numeric(18,4) as a string and always `> 0`, timestamps, unique
`(pallet_id, catalog_variant_id)`, plus `location_integrity` (`trusted` | `drifted`) and
`integrity_checked_at`. The integrity fields are derived by reconciliation, never accepted from a
client, and do not replace the placement history.

### `pallets:pallet_placement` — table `pallets_pallet_placements`

| Field | Type / nullability | Scope / index | Sensitive / encrypted | Lifecycle and validation |
|---|---|---|---|---|
| `id` | UUID, required | primary key | no | **this value is the `referenceId` sent to `wms`**; immutable across retries |
| `tenant_id` / `organization_id` | UUID, required | composite scope index | no | trusted context only |
| `pallet_id` | UUID, required | in-module FK, index `(pallet_id, outcome)` | no | immutable |
| `pallet_line_id` | UUID, required | in-module FK | no | immutable |
| `catalog_variant_id` | UUID, required | index | no | frozen at plan time |
| `quantity` | numeric(18,4) string, required | — | no | frozen at plan time; `> 0` |
| `warehouse_id` | UUID, required | — | no | frozen |
| `from_location_id` | UUID, nullable | — | no | null for `receive`; required for `putaway` |
| `to_location_id` | UUID, required | index `(to_location_id)` | no | frozen |
| `kind` | `receive` \| `putaway` | index | no | immutable |
| `outcome` | `pending` \| `confirmed` \| `rejected` \| `unknown` | index `(outcome)` | no | `pending → confirmed \| rejected \| unknown`; `unknown → confirmed \| rejected` after read-back; a `confirmed` row is final |
| `movement_id` | UUID, nullable | unique where not null | no | set only with `confirmed`; the unique index makes double-recording impossible |
| `performed_at` | timestamp, nullable | index `(pallet_line_id, performed_at desc, id desc)` | no | copied from the ledger movement, not from the app clock; placement id breaks timestamp ties |
| `requested_by` | UUID, required | — | no | the acting user; for the subscriber, the confirming user carried on the event |
| `source_operation_id` | UUID, nullable | index | no | scalar id of the `putaway` operation that requested it; null for `receive` |
| `attempt_count` | int, required | — | no | incremented per attempt |
| `last_error_code` / `last_error_message` | text, nullable | — | no | the ledger's refusal, localized at the edge, never a stack trace |
| `created_at` / `updated_at` | timestamp, required | optimistic-lock version | no | — |

Rows are never deleted and their frozen fields are never rewritten; only `outcome`, `movement_id`,
`performed_at`, `attempt_count` and the error fields resolve. Current location of a pallet line is the
`to_location_id` of its latest `confirmed` row by `performed_at, id`, and is actionable only while
the line's `location_integrity` is `trusted`.

### `putaway:putaway_operation` — table `putaway_putaway_operations`

| Field | Type / nullability | Scope / index | Sensitive / encrypted | Lifecycle and validation |
|---|---|---|---|---|
| `id` | UUID, required | primary key | no | immutable |
| `tenant_id` / `organization_id` | UUID, required | composite scope index | no | trusted context only |
| `pallet_id` | UUID, required | **partial unique** `(pallet_id) where status in ('draft','executing','needs_review')` | no | scalar; the partial unique index is the concurrency guard for REQ-009 |
| `warehouse_id` | UUID, required | — | no | frozen |
| `from_location_id` | UUID, required | — | no | the recorded source at start |
| `to_location_id` | UUID, nullable | — | no | set when the destination is scanned, before confirmation |
| `status` | `draft` \| `executing` \| `completed` \| `partially_completed` \| `needs_review` \| `abandoned` | index | no | `draft → executing → completed \| partially_completed \| needs_review`; `draft → abandoned` |
| `performed_by` | UUID, required | — | no | the Warehouseman |
| `started_at` / `completed_at` | timestamp | — | no | — |
| `created_at` / `updated_at` | timestamp, required | optimistic-lock version | no | every mutation requires the version header |

The operation's lines are the `pallets:pallet_placement` rows carrying its `source_operation_id`; the
`putaway` module never writes them directly, only through `pallets` commands.

### Entity ids and migrations

New ids `pallets:pallet`, `pallets:pallet_line`, `pallets:pallet_placement`,
`putaway:putaway_operation`. Migrations are generated per module with `yarn db:generate`, every
statement reviewed, `.snapshot-open-mercato.json` updated, and **applied only after explicit
approval** (`.ai/guides/contracts.md:14-21`). `pz`'s migration drops `pz_pallets` / `pz_pallet_lines`
in the same release that creates the `pallets` tables; per the gate decision, no data is copied
because no environment holds pallets worth keeping — fixtures are re-seeded.

## API, Command, and Error Contracts

| Method / command | Path / ID | Auth and feature gate | Input | Success response / event | Errors and concurrency | Requirement IDs |
|---|---|---|---|---|---|---|
| `GET` | `/api/pallets` | auth + `pallets.view` | `sourceDocumentId` or `warehouseId`, paging | `{ items, totalCount }` with `lineCount` and computed location | 400 missing parent filter, 403 | REQ-001, REQ-002 |
| `GET` | `/api/pallets/by-code` | auth + `pallets.view` | `code`, optional `sourceDocumentId` | carrier + contents + computed location | 404 unknown code, 409 belongs to another document | REQ-006, REQ-012 |
| `GET` | `/api/pallets/{id}/history` | auth + `pallets.view` | — | placements with movement ids, actors, times | 403, 404 | REQ-012 |
| `POST`/`PUT`/`DELETE` | `/api/pallets` | auth + `pallets.count` | as `/api/pz/pallets` today | 201/200 + CRUD side effects | 400 missing version, 409 optimistic lock | REQ-002 |
| `POST` | `/api/pallets/close`, `/reopen` | auth + `pallets.count` | `{ id, version }` | updated carrier | 409 conflict, 422 document confirmed | REQ-002 |
| command | `pallets.placements.plan` | internal; callers gate | `{ palletId, kind, toLocationId, fromLocationId?, requestedBy }` | frozen `pending` rows | 409 when an unresolved placement exists for a line | REQ-003, REQ-007, REQ-010 |
| command | `pallets.placements.execute` | internal | `{ placementIds }` | per-row outcome | never advances a row past `unknown` without a read-back | REQ-007, REQ-008, REQ-010 |
| command | `pallets.placements.reconcile` | internal | `{ placementIds }` | resolved outcomes | reads WMS movements by placement reference; never writes again while outcome is `unknown` | REQ-010 |
| command | `pallets.integrity.reconcile` | internal; triggered by WMS movement event or operator | `{ warehouseId, palletIds?, since? }` | trusted/drifted state per affected line | scans movements touching tracked variant/location; an unrecognised reference marks lines `drifted` and blocks work | REQ-014 |
| command | `pallets.inventory.receive` / `pallets.inventory.move` | internal; only pallet movement writer | frozen placement payload | WMS movement with `referenceId = placement.id` | rejects caller payloads without a placement; scope, location and variant are rechecked | REQ-003, REQ-007, REQ-014 |
| `GET` | `/api/putaway/work` | auth + `putaway.execute` | `warehouseId` | pallets awaiting putaway with contents and source location | 403 | REQ-005 |
| `PUT` | `/api/putaway/operations` | auth + `putaway.execute` | `{ palletId }` | operation with frozen lines | 409 an operation is already open for this pallet; 422 pallet not awaiting putaway | REQ-006, REQ-009, REQ-011 |
| `POST` | `/api/putaway/operations/confirm` | auth + `putaway.execute` | `{ id, version, fromLocationId, toLocationId }` | per-line outcomes + operation status | 400 missing version, 409 version conflict, 422 `invalid_location` / same source and destination / inactive / foreign warehouse, 409 `insufficient_stock` | REQ-007, REQ-009, REQ-011 |
| `POST` | `/api/putaway/operations/retry` | auth + `putaway.execute` | `{ id, version }` | outcomes for unresolved lines only | refuses while any line is `unknown` and unread | REQ-008, REQ-010 |
| `POST` | `/api/putaway/operations/abandon` | auth + `putaway.execute` | `{ id, version }` | operation `abandoned` | 422 once any line is `confirmed` — there is no undo | REQ-011 |

Every route uses `makeCrudRoute` where it is CRUD (`/api/pallets`, `/api/pallets/close|reopen`
mirroring `src/modules/pz/api/pallets/route.ts`) and a custom guarded command route for the putaway
actions, each with per-method `metadata` and a separate `openApi` export. Every mutation requires an
explicit optimistic-lock version and answers a missing one with 400, keeping the deliberately stricter
rule `pz` already applies (`src/modules/pz/commands/pallets.ts:95-107`).

The installed calls this spec makes:

The facade is the only pallet-aware writer. It calls the installed commands with frozen placement data,
then records the returned movement id. A caller cannot supply a WMS payload without a placement.

- `wms.inventory.receive` — `{ warehouseId, locationId, catalogVariantId, quantity, referenceType: 'manual', referenceId: placement.id, performedBy, reason }`. `type` is hard-coded `'receipt'` upstream (`inventory-actions.ts:1459`).
- `wms.inventory.move` — the same plus `fromLocationId`, `toLocationId` and **`type: 'putaway'` passed explicitly**, because the command defaults to `'transfer'` (`inventory-actions.ts:1604`). `quantity` is a positive number, not a decimal string (`validators.ts:277-293`), so the app's `numeric(18,4)` strings are converted at the edge and the conversion is covered by a test.

## Events, Jobs, Notifications, and Cross-Module Flows

| Trigger | Producer | Consumer | Side effect | Retry / idempotency / audit behavior |
|---|---|---|---|---|
| `pz.goods_receipt.confirmed` | `pz` (unchanged) | **new** `pallets` subscriber | plan + execute `receive` placements for every closed pallet of the document | post-commit; per-placement reference identity; a failure leaves `pending`/`unknown` rows for reconciliation, never a partial silent success |
| `pallets.placement.confirmed` | `pallets` | none yet | — | persistent; the seam a future reporting or notification consumer attaches to |
| `pallets.placement.unresolved` | `pallets` | none yet | — | emitted when a placement lands `unknown`; the observability hook for operations |
| `putaway.operation.completed` | `putaway` | none yet | — | persistent, carries pallet id and destination |
| `wms.inventory.moved` | installed `wms` | **new** `pallets` reconciliation subscriber | invoke `pallets.integrity.reconcile`; compare `referenceId` with known placements and mark affected lines `drifted` when a tracked variant/location has an unrecognised movement | never guesses ownership; putaway work is blocked until controlled reconciliation |

There is no scheduled job in this slice. Reconciliation of `unknown` placements is user-triggered
(retry) and idempotent; a scheduled sweeper is deliberately deferred, and the `pallets.placement.unresolved`
event is what a later sweeper would hang off.

## Security, Privacy, and Compliance

- **Authorization:** feature gates only — `pallets.view`, `pallets.count`, `putaway.execute` — never
  role-name checks. `putaway.execute` depends on `wms.view` and `wms.adjust_inventory` so an app route
  cannot grant more ledger power than the installed API would.
- **Tenant isolation:** every query filters on the trusted `tenantId`/`organizationId` derived from the
  authenticated context; a missing scope is a refusal. The installed commands re-assert scope on every
  loaded row (`inventory-actions.ts:350-351, :365-366`), and the app does the same on its own rows. A
  pallet code is unique per organization, so a lookup for a code in another organization is a 404, not
  a cross-tenant read.
- **Sensitive data:** none. No PII, no credentials, no free text about people; `label` is an operator
  note about a pallet, and error messages carry the ledger's refusal, never a stack trace.
- **Movement boundary:** all receive and putaway writes for tracked pallet goods go through the
  `pallets` facade and carry a placement reference. Generic WMS movement APIs remain available for
  untracked stock, but are outside the pallet contract. Because WMS has no pallet id, reconciliation
  treats an unrecognised movement for a tracked variant/location as drift and blocks the affected
  lines rather than assigning it to a carrier.
- **Abuse and failure modes:** replay is bounded by the installed idempotency key plus the app's own
  unique `movement_id`; enumeration is bounded because listing requires a parent filter (the rule
  `src/modules/pz/api/pallets/route.ts:21-34` already states); concurrency is bounded by the partial
  unique index on open operations plus required optimistic-lock versions; the destructive path
  (abandon) is refused once anything is confirmed, because there is no undo — a wrong move is corrected
  by another controlled move.
- **Known caveat, carried deliberately:** the installed idempotency index is scoped by
  `organization_id` only, not `tenant_id` (`wms/data/entities.ts:381-385`). The app's own references
  are uuids, so a collision is not reachable in practice; it is recorded here rather than assumed away.

## Integration Coverage

Tests are self-contained and exercise real API paths. `yarn test:integration:ephemeral` is the runner;
UI states are exercised through the panel routes.

| Test ID | Level | Setup / fixture | Actions | Assertions | Requirement IDs |
|---|---|---|---|---|---|
| TEST-001 | integration | released PZ, one closed pallet, 97 pcs | confirm the document | one `receive` movement into the `staging` location, placement `confirmed` with a movement id, balance +97 | REQ-003 |
| TEST-002 | integration | as TEST-001 | emit the confirm event twice | exactly one movement; the second run is an idempotent replay | REQ-003, REQ-010 |
| TEST-003 | integration | warehouse with zero, then two active staging locations | confirm | refusal `staging_location_ambiguous`, no movement, placements left unplanned | REQ-003, REQ-011 |
| TEST-004 | integration | posted pallet in staging | `GET /api/putaway/work` | the pallet is listed with contents and source; a pallet already in a `rack` location is not | REQ-004, REQ-005 |
| TEST-005 | integration | posted pallet, 97 pcs | start, scan source, scan `A-01`, confirm | source −97, `A-01` +97, warehouse total unchanged, one movement of `type: 'putaway'` | REQ-006, REQ-007 |
| TEST-006 | integration | two-product pallet | confirm | one movement per pallet line; operation `completed` only after both are confirmed | REQ-007, REQ-008 |
| TEST-007 | integration | two pallets, same variant, same quantity, same location | put both away to the same destination | two distinct movements; no false dedupe; the second pallet's quantity is not swallowed | REQ-007 |
| TEST-008 | security | second tenant / missing `putaway.execute` / foreign warehouse | attempt every putaway route | fail closed, no movement, no data leak | REQ-011 |
| TEST-009 | integration | open pallet; unposted pallet; destination = source; inactive destination; insufficient available stock | attempt confirmation for each | each refused with its own code and no movement written | REQ-011 |
| TEST-010 | integration | one pallet, two concurrent confirmations | run both | at most one movement per line; the loser gets the current result or a 409 | REQ-009 |
| TEST-011 | integration | a move committed, then the process restarted before the outcome was recorded | reconcile | the placement resolves to `confirmed` from the ledger read-back; no second movement | REQ-010 |
| TEST-012 | integration | two-product pallet where line 2 has insufficient stock | confirm, then retry after stock is corrected | partial state reported per line with real locations; retry moves only line 2; line 1 is not moved twice | REQ-008 |
| TEST-013 | integration | pallet put away, then the source document withdrawn | attempt withdraw | refused; the pallet's history is intact | REQ-013 |
| TEST-014 | integration | pallet whose document is confirmed and archived | read the pallet by code | identity, contents, location and history still resolve | REQ-001, REQ-012 |
| TEST-015 | UI | posted pallet, Warehouseman session | walk the panel flow | loading, empty, error, conflict and partial states render; HID Enter submits; focus returns to the scan field; PL and EN; narrow width; light and dark | REQ-005, REQ-006, REQ-008 |
| TEST-016 | integration | existing receiving flow | run the current `pz` receiving integration suite against the relocated carrier | TC-PZ-001…006 still pass unchanged in behavior | REQ-002 |
| TEST-017 | integration/security | trusted pallet in staging plus a direct generic WMS movement for its variant/location | reconcile movements, then request putaway work | the line is marked `drifted`, excluded from work, and cannot be moved until a controlled reconciliation clears it; no guessed pallet assignment is made | REQ-004, REQ-014 |

## Implementation Phases

### Phase 1 — `pallets` owns the carrier

- **Depends on:** none
- **Outcome:** receiving works exactly as today, with the carrier owned by `pallets` and no ORM
  relation to `GoodsReceipt`.
- **Why this order / value delivered:** every later phase reads the carrier; doing it first means no
  phase has to migrate it twice. Value: the model decision is landed and documented.
- **Deliverables:** new module `pallets` (`index.ts`, `acl.ts`, `setup.ts`, `events.ts`,
  `data/entities.ts`, `data/validators.ts`, `commands/pallets.ts`, `commands/palletLines.ts`,
  `api/pallets/**`, `api/pallet-lines/**`, `migrations/`, `i18n/{en,pl}.json`), registered in
  `src/modules.ts` before `pz`; `pz` rewired to read pallets through the query engine and to refuse
  confirmation while a pallet is open without an ORM relation; `warehouseman/lib/receivingApi.ts`
  repointed; `label_printing` scope and `pz_fixtures` repointed. The `CONTEXT.md` rewrite and
  **ADR-0013** ship with this specification rather than with the code.
- **Independent slices / estimated commits:** (a) module + entities + migration, (b) commands + API,
  (c) `pz` rewiring, (d) panel/client repointing + fixtures.
- **Requirements closed:** REQ-001, REQ-002
- **Tests:** TEST-016, TEST-014 (identity half)
- **Validation:** `yarn generate`, `yarn typecheck`, focused `yarn test`, `yarn db:generate` reviewed
  but **not applied without approval**
- **Exit gate:** the receiving flow passes end to end on the panel with the carrier in its new module;
  `grep` shows no ORM relation between `GoodsReceipt` and `Pallet`; generated registries list
  `pallets:pallet`.

### Phase 2 — Placements and inbound posting

- **Depends on:** Phase 1 exit gate
- **Outcome:** confirming a Goods Receipt puts its counted pallet lines into the warehouse's staging
  location, once, and the pallet can say where it is.
- **Why this order / value delivered:** without this, no pallet exists in the ledger and putaway has
  nothing to move. Value on its own: stock finally reflects what the floor counted.
- **Deliverables:** `pallets:pallet_placement` + migration; `pallets.placements.{plan,execute,reconcile}`;
  `pallets.inventory.{receive,move}` as the only pallet movement facade; `pallets.integrity.reconcile`;
  the `pz.goods_receipt.confirmed` subscriber owned by `pallets`; reconciliation of `wms.inventory.moved`; staging-location resolution
  by `type` with an explicit ambiguity refusal; `pallets.placement.{confirmed,unresolved}` events;
  `GET /api/pallets/{id}/history`. **ADR-0014**, which records that a confirmed Goods Receipt now
  posts stock and corrects ADR-0005's `referenceId` recipe, ships with this specification.
- **Independent slices / estimated commits:** (a) entity + migration, (b) plan/execute/reconcile,
  (c) subscriber + staging resolution, (d) history API.
- **Requirements closed:** REQ-003, REQ-004 (computation half), REQ-010 (mechanism), REQ-012
- **Tests:** TEST-001, TEST-002, TEST-003, TEST-011, TEST-017
- **Validation:** `yarn generate`, `yarn typecheck`, `yarn test`, `yarn test:integration:ephemeral`
  for the posting paths
- **Exit gate:** confirming the fixture PZ produces balances in `STG-RECV` and `confirmed` placements
  with movement ids; replaying the event produces no second movement; an ambiguous warehouse refuses
  with no partial posting; an unrecognised WMS movement marks affected lines `drifted` and removes
  them from putaway work.

### Phase 3 — Putaway work and execution (API)

- **Depends on:** Phase 2 exit gate
- **Outcome:** a pallet awaiting putaway can be moved to a storage location through the API, safely,
  concurrently and repeatably.
- **Why this order / value delivered:** the operation is provable before any screen exists. Value: the
  capability is complete and testable end to end.
- **Deliverables:** new module `putaway` (`index.ts`, `acl.ts` with `putaway.execute`, `setup.ts`,
  `events.ts`, `data/entities.ts`, `commands/operations.ts`, `api/work/**`, `api/operations/**`,
  `migrations/`, `i18n/{en,pl}.json`), registered in `src/modules.ts` after `pallets`;
  `GET /api/putaway/work`; start / confirm / retry / abandon; the partial unique index guarding one
  open operation per pallet; the withdraw guard for REQ-013 in `pz`.
- **Independent slices / estimated commits:** (a) module + entity + migration, (b) work list read,
  (c) start/confirm, (d) retry/reconcile/abandon, (e) the `pz` withdraw guard.
- **Requirements closed:** REQ-004 (qualification half), REQ-005 (API), REQ-007, REQ-008, REQ-009,
  REQ-010, REQ-011, REQ-013
- **Tests:** TEST-004 … TEST-013
- **Validation:** `yarn generate`, `yarn typecheck`, `yarn lint`, `yarn test`,
  `yarn test:integration:ephemeral`
- **Exit gate:** TEST-005 shows source −97 / `A-01` +97 / warehouse total unchanged / one `putaway`
  movement; TEST-007 shows two identical pallets moving independently; TEST-010 shows at most one
  movement per line under concurrency.

### Phase 4 — The floor screens

- **Depends on:** Phase 3 exit gate
- **Outcome:** a Warehouseman performs the whole operation from the panel.
- **Why this order / value delivered:** the screens sit on a proven API. Value: the feature reaches its
  actual user.
- **Deliverables:** the putaway tile in `PanelHome`; `/warehouseman/putaway` work list;
  `/warehouseman/putaway/[palletId]` scan flow, summary, confirmation and per-line result with retry;
  `/warehouseman/putaway/[palletId]/history`; `warehouseman.putaway.*` keys in EN and PL;
  panel-access route metadata on every new route.
- **Independent slices / estimated commits:** (a) work list + tile, (b) scan flow, (c) result and
  retry, (d) history, (e) i18n and a11y pass.
- **Requirements closed:** REQ-005 (UI), REQ-006, REQ-012 (UI)
- **Tests:** TEST-015
- **Validation:** `yarn generate`, `yarn typecheck`, `yarn lint`, `yarn ds:check`,
  `yarn i18n:check-hardcoded`, `yarn test`, `yarn build`
- **Exit gate:** the flow is walked on a real browser at narrow width in light and dark, with the HID
  Enter path, keyboard-only operation, and the loading, empty, error, conflict and partial states
  demonstrated; EN and PL key counts stay in sync.

## Requirement Traceability

| Requirement | Journey / surface | Data/API/event contracts | Phase | Tests | Acceptance criterion |
|---|---|---|---|---|---|
| REQ-001 | J-004 | `pallets:pallet`, `pallets:pallet_line` | Phase 1 | TEST-014, TEST-016 | AC-001 |
| REQ-002 | J-001 | `/api/pallets*`, query-engine reads in `pz` | Phase 1 | TEST-016 | AC-002 |
| REQ-003 | J-001 | `pz.goods_receipt.confirmed` → `pallets` subscriber, `wms.inventory.receive` | Phase 2 | TEST-001, TEST-002, TEST-003 | AC-003 |
| REQ-004 | J-002 | `pallets:pallet_placement`, computed location | Phase 2–3 | TEST-004 | AC-004 |
| REQ-005 | J-002, `/warehouseman/putaway` | `GET /api/putaway/work` | Phase 3–4 | TEST-004, TEST-015 | AC-004 |
| REQ-006 | J-002, `/warehouseman/putaway/[palletId]` | `PUT /api/putaway/operations` | Phase 3–4 | TEST-005, TEST-015 | AC-005 |
| REQ-007 | J-002 | `wms.inventory.move` `type: 'putaway'` | Phase 3 | TEST-005, TEST-006, TEST-007 | AC-006 |
| REQ-008 | J-003 | retry over unresolved placements | Phase 3–4 | TEST-012 | AC-007 |
| REQ-009 | J-002 | partial unique index + optimistic lock | Phase 3 | TEST-010 | AC-008 |
| REQ-010 | J-003 | `pallets.placements.reconcile` | Phase 2–3 | TEST-011 | AC-008 |
| REQ-011 | J-002 | refusal codes on confirm | Phase 3 | TEST-008, TEST-009 | AC-009 |
| REQ-012 | J-004 | `GET /api/pallets/{id}/history` | Phase 2, 4 | TEST-014, TEST-015 | AC-010 |
| REQ-013 | J-004 | `pz` withdraw guard | Phase 3 | TEST-013 | AC-009 |
| REQ-014 | J-001, J-002 | `pallets` movement facade, `pallets.integrity.reconcile`, `wms.inventory.moved` subscriber, `location_integrity` | Phase 2–3 | TEST-017 | AC-011 |

## Rollout, Migration, and Rollback

- **Migration boundary:** every migration is generated with `yarn db:generate`, reviewed statement by
  statement, and **applied only with explicit approval**. Validation never runs a migration.
- **Data migration:** none, by the gate decision — no environment holds pallet data worth preserving.
  Phase 1 creates the `pallets` tables and drops `pz_pallets`/`pz_pallet_lines`; `pz_fixtures` and
  `wms_fixtures` re-seed.
- **Compatibility bridge:** `/api/pz/pallets`, `/api/pz/pallets/by-code`, `/api/pz/pallets/close`,
  `/api/pz/pallets/reopen`, `/api/pz/pallet-lines` and the entity ids `pz:pallet` / `pz:pallet_line`
  are frozen surfaces (`.ai/guides/contracts.md:92`). Phase 1 keeps the `pz` routes as thin deprecated
  forwarders to the `pallets` routes for one release, marked deprecated in their OpenAPI, while every
  in-repo caller is repointed. `.ai/guides/upstream/BACKWARD_COMPATIBILITY.md` is read before the
  change lands. `label_printing`'s `LabelScopeId` keeps `'pz.pallet'` as its published scope id and
  resolves it against the new table — the printed label is unchanged and the scope id is itself a
  frozen surface.
- **Backward-compatibility protocol:** `.ai/guides/upstream/BACKWARD_COMPATIBILITY.md` binds modules
  that third-party developers import. API route URLs are STABLE (retire by marking `deprecated: true`
  in `openApi` and keeping the route through a bridge release), which is exactly what the forwarders
  above do; database schema is ADDITIVE-ONLY for published modules, and dropping `pz_pallets` is a
  deliberate, recorded exception — these tables belong to this application, have no external consumer,
  and are dropped in the same release that creates their replacement, under explicit approval. That
  exception is named here rather than taken quietly.
- **Rollout order:** Phase 1 → 2 → 3 → 4, each behind its own PR and exit gate. The staging-location
  resolution is the only environment-dependent step; a warehouse without exactly one active staging
  location refuses posting loudly rather than guessing.
- **Observability:** `pallets.placement.unresolved` marks every placement that needs a human;
  audit entries follow the existing `resourceKind` pattern (`pallets.pallet`, `pallets.placement`,
  `putaway.operation`).
- **Rollback:** Phases 1–3 are reversible by reverting the code and the generated registries; committed
  ledger movements are not reversed by a rollback and must be corrected by a controlled counter-move,
  which is exactly why abandon is refused after the first confirmation.

## Risks and Tradeoffs

| Risk / tradeoff | Impact | Mitigation / detection | Residual risk |
|---|---|---|---|
| The installed idempotency key includes quantity, so a document-level reference would silently swallow a second identical posting | lost stock, invisible | per-placement uuid references; TEST-007 proves two identical pallets move independently | none known |
| A move commits but the app never records the outcome | double movement on retry | `unknown` outcome plus mandatory read-back by `referenceId` before any further write; TEST-011 | a read-back that itself fails leaves the line `unknown` and visible, not silently retried |
| A generic WMS movement changes stock without a pallet reference | false pallet location and unsafe putaway | only the `pallets` facade may move tracked goods; `wms.inventory.moved` reconciliation marks affected lines `drifted` and blocks work; TEST-017 | a shared SKU/location can produce a conservative false positive, which requires operator reconciliation rather than an unsafe guess |
| `quantityAvailable` subtracts reserved and allocated, so reserved stock blocks a putaway (`inventory-actions.ts:1643-1645`) | a legitimate putaway is refused | the refusal is surfaced verbatim to the floor; TEST-009 | accepted: the ledger's rule wins |
| A warehouse with zero or several active staging locations | posting cannot choose | explicit `staging_location_ambiguous` refusal, no partial posting; TEST-003 | operational configuration, deliberately not automated |
| Two new modules plus a subscriber widen the module graph | more seams to keep honest | no cross-module ORM anywhere; reads by id through the query engine; writes through commands | accepted |
| Dropping `pz_pallets` is destructive if an environment turns out to hold real data | data loss | the gate decision is recorded here; the migration is applied only after explicit approval, and the operator confirms the environment first | accepted under the recorded assumption |
| Capacity is unenforced, so a destination can be overfilled | physical mismatch | out of scope by decision, and the installed WMS does not enforce it either | accepted, explicitly |
| The tracker and the code disagree about #44–#47 | a reader assumes machinery exists | the Problem Statement records the verified code state with paths | accepted |

## Acceptance Criteria

- [ ] **AC-001** — A Pallet created on a Goods Receipt still resolves by code, with contents and
      history, after that document is confirmed and archived.
- [ ] **AC-002** — Every receiving behavior available today works unchanged with the carrier owned by
      `pallets`, and no ORM relation ties a Pallet to a Goods Receipt.
- [ ] **AC-003** — Confirming a Goods Receipt with a closed pallet of 97 pcs produces exactly one
      `receive` movement into the warehouse's staging location; confirming twice produces one.
- [ ] **AC-004** — A pallet whose goods sit in a `staging` location appears in that warehouse's putaway
      work; one in a `rack` location does not.
- [ ] **AC-005** — Scanning the pallet, the source and the destination changes no stock; only
      "Potwierdź odłożenie" does.
- [ ] **AC-006** — Confirming moves source −97 and `A-01` +97 with a `putaway` movement, and the
      warehouse total for the product is unchanged.
- [ ] **AC-007** — When one line of a multi-product pallet fails, the screen names each line's real
      location, reports the pallet as partially put away, and a resume moves only the failed line.
- [ ] **AC-008** — Two Warehousemen confirming the same pallet at once produce at most one movement per
      line, and an interrupted execution never produces a second movement after reconciliation.
- [ ] **AC-009** — Every refusal in REQ-011 and REQ-013 leaves the ledger untouched and explains itself
      in the operator's language.
- [ ] **AC-010** — From a pallet code a user reaches its source document, its operations, its movements
      and their actors and times.
- [ ] **AC-011** — A direct generic WMS movement touching a tracked pallet variant/location never gets
      attributed to a pallet. Reconciliation marks the affected line `drifted`, excludes it from
      putaway work, and putaway remains blocked until a controlled reconciliation records the actual
      placement or otherwise resolves the discrepancy.
- [ ] Every listed surface matches its recorded reference and uses the canonical panel shell and
      components, shared API helpers, semantic tokens, and complete loading, empty, error, conflict,
      keyboard, accessibility, responsive, light-mode and dark-mode states.
- [ ] Every affected API and UI path has self-contained integration coverage and the configured
      validation gate passes.

## Final Compliance Report

| Check | Status | Evidence / resolution |
|---|---|---|
| Applicable `AGENTS.md` files and routed guides/skills reviewed | pass | root `AGENTS.md`, `.ai/guides/spec-delivery.md`, `.ai/guides/contracts.md`, `om-spec-writing`, research file §6–§7 |
| Data models, APIs, events, UI, and tests are internally consistent | pass | Requirement Traceability maps all 14 requirements to phases, tests and acceptance criteria |
| Every workflow completes end to end without a catch-all integration phase | pass | each phase closes its own requirements and carries its own exit gate; Phase 4 adds no deferred backend behavior |
| Platform-native reuse and extension points were chosen before custom code | pass | Reuse and Ownership Map; the installed WMS is the only ledger and is used through published commands |
| UI contracts identify references, canonical components, and theme/state coverage | pass | UI table records the panel reference for each surface and the recorded panel-primitive exception |
| Every phase has dependencies, bounded slices, tests, value, and an observable exit gate | pass | Implementation Phases |
| Migrations are reviewed and never applied to validate | pass | Rollout; `yarn db:generate` is a probe and application needs approval |

Verdict: **Blocked — pending user approval of this document and of the destructive `pz_pallets` drop
in Phase 1.** Status becomes `Ready for implementation` on that approval.

## Open Questions

| ID | Question | Owner | Blocking? | Resolution / decision date |
|---|---|---|---|---|
| Q-001 | Spec split: one document or two? | user | yes | **One spec, two phases** — extended to four during design (2026-09-19) |
| Q-002 | Who owns the putaway operation? | user | yes | **A separate `putaway` module** (2026-09-19) |
| Q-003 | Canonical English term for *odłożenie* | user | yes | **Putaway** (2026-09-19) |
| Q-004 | Does "Pallet" stay canonical? | user | yes | **Yes**; only the definition changes (2026-09-19) |
| Q-005 | How real is the data migration? | user | yes | **Fixtures only**, no data copy (2026-09-19) |
| Q-006 | Dependency on stock posting (#54 / #45) | user | yes | **Absorbed**: this spec lands the minimal posting slice as Phase 2 (2026-09-19) |
| Q-007 | Do the placement rows for a putaway belong to `pallets` or to `putaway`? | user | no | Proposed: `pallets` owns them, `putaway` owns the operation that requests them. Reversible; raise it in review if the boundary should sit elsewhere. |
| Q-008 | `docs/adr/` has two files numbered 0012 | user | no | New ADRs take 0013 and 0014; the collision is left for a separate housekeeping change |
| Q-009 | How can a pallet location remain safe when WMS movements have no `palletId`? | user | yes | **Controlled movement facade plus fail-closed drift detection** — all pallet movements use a placement reference; an unrecognised WMS movement marks affected lines `drifted` and blocks putaway until reconciliation (2026-09-19) |

## Changelog

| Date | Change |
|---|---|
| 2026-09-19 | Initial skeleton and Open Questions gate |
| 2026-09-19 | Gate answered; full draft written against `.ai/research/2026-09-19-pallet-putaway-50.md` |
| 2026-09-19 | Added controlled pallet movement facade, WMS movement reconciliation, per-line integrity state, drift blocking and TEST-017/AC-011; resolved Q-009 |
