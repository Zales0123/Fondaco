# Awizo, PZ and recoverable stock posting

**Date**: 2026-09-19
**Status**: Ready for implementation
Source issue: https://github.com/Zales0123/Fondaco/issues/40
Related delivery: #41–#49. Separate subsequent capability: #50.

## TLDR

Separate announced quantities (Awizo) from immutable counted receipts (PZ). Warehouseman counts and closes pallets without changing stock, then issues PZ to receive actual quantities once. Persist per-line outcomes and pallet provenance, reconcile uncertain results, and cancel through controlled recoverable reversals. Installed WMS remains the only stock ledger.

## Resolved assumptions (autonomous defaults)

| Decision | Resolution |
|---|---|
| Scope split | This spec covers #40–#49; putaway #50 is a separately shippable follow-on, not an extra phase hidden in receipt acceptance. |
| Approval | User explicitly requested implementing the issues after their consistency corrections. Preserve those published business decisions. |
| Migration | Add forward migrations; preserve existing migrations and data. Generate/review SQL; do not apply it without approval. No reset. |
| Unavailable cancellation proof | A demonstrably safe stock/provenance exclusion path is a release gate. If unsupported, cancellation remains unavailable and the task remains incomplete; do not substitute a balance-only precheck. |
| Test environment | Use the supported ephemeral test runner; never point validation at a user's live database. Any migration-application requirement remains an explicit approval boundary. |
| Execution | Start with short command executions and persisted recovery state, using supported DI/commands. No extra queue, scheduler or workflow engine is required by receipt posting alone. |

## Problem Statement

Current `GoodsReceipt` describes expected quantities while `PalletLine` holds actual counts. Confirm freezes paperwork but does not receive stock. The UI therefore calls an announcement a receipt. Current barcode scanning, printer integration and demo fixtures must survive the split.

## Overview and Success Measures

Primary outcome: expected 100, counted 97 yields exactly +97 stock at the selected location, with a readable PZ and pallet provenance. Repeat, restart and lost response do not add another 97. Known cancellation blockers produce zero writes; later cancellation failures expose the already committed reversals and recover safely.
Baseline: counting works; native stock changes are absent. Design reference: WM22 warehouse_operations separates intent, confirmed ledger outcome and recovery; adopt that distinction without copying its procurement, Android, process designer or QC modules. Odoo-style separation of source/receipt/movement is a conceptual reference, not an installed contract claim.

## Goals

- REQ-01: office and Panel distinguish Awizo from PZ while retaining existing counting.
- REQ-02: close captures a scoped active location; undelivered Awizo can be cancelled.
- REQ-03: issue freezes actual quantities, generates unique numbers and preserves per-pallet provenance.
- REQ-04: native receipt posting is scoped, permissioned, serialized and idempotently recoverable.
- REQ-05: cancellation has explicit eligibility, per-line execution and safe recovery.
- REQ-06: Panel/admin show one outcome with integration evidence and migration/upgrade documentation.

## Non-goals

Putaway implementation, inter-warehouse MM, purchasing/PO, QC, lot/serial capture, UOM conversion, GS1 additions, offline posting, workflow designer, new printers or integrations, financial accounting. #50 may consume this spec's provenance but changes no receipt reference identity.

## Proposed Solution

Retain the `pz` module. Rename the current document to Awizo, retaining source data and counts. A new immutable GoodsReceipt and its grouped lines record the counted stock assertion. Command handlers own persistence and post-commit events; the command bus invokes installed inventory operations with immutable references. Execution state records outcomes, never a competing inventory balance.

### Design Decisions and Alternatives

| Decision | Rationale | Rejected alternative |
|---|---|---|
| Two documents in `pz` | Expectations and counted fact have different authors/lifecycles | Reusing expected lines as actual stock |
| Receipt reference = PZ UUID | Grouping by variant/location makes receipt lines distinct | Silently changing parent contract to per-item receipt references |
| Per-item reversal identity | Each intentional adjustment needs a distinct immutable identity | Reusing a receipt/header key for unrelated corrections |
| Persist original pallet contributions | Grouped lines alone cannot identify one pallet | Inferring ownership from current SKU balance |
| Recoverable cancellation | Native handlers commit independently | Claiming multi-line ACID from sequential calls |

## Domain Vocabulary and Business Rules

Awizo: supplier announcement with hand-entered unique number. States draft/receiving/received/cancelled plus `legacy_confirmed` for migrated record-only confirmations. Received means every PZ position has a confirmed stock receipt, not just an issued header.
PZ: generated-number immutable receipt from counted Awizo; posting/posted/posting_failed, then cancelling/cancel_failed/cancel_unknown/cancelled for cancellation.
Pallet: carrier belonging to Awizo. Open/closed describes counting, not stock availability. Close requires current location; reopen reconfirms it. No editing once source is frozen for posting or recovery.
Contribution: immutable pallet ID, pallet-line ID, variant, quantity and posting location supporting a grouped PZ line. Historical location never becomes the mutable current location after later putaway.
Execution: pending/confirmed/rejected/unknown per line, immutable input and native movement reference. UNKNOWN is not failure proof and forbids blind resubmission.
Rules: group actual counts by variant/location; include surplus, omit never-counted products; no sum across incompatible units. One non-cancelled PZ per Awizo. No issue with no pallets or any open pallet. Freeze source during posting, failed/unknown execution and cancellation recovery. Unique sequence per tenant/org/year; generated numbers never reused.

## Users, Permissions, and Scope

Use ACL features, never role-name checks. Awizo uses `pz.awizo.view/manage`, floor counting retains `pz.receiving.count`. Receipt uses `pz.goodsReceipts.view/issue/cancel`. Panel access alone is insufficient. Native stock calls run through authorized server commands with explicit tenant/org and actor; no unrestricted system scope or client-supplied actor.
Existing manage/confirm grants never silently become stock-posting grants. Read/write/find filters fail closed for both scope IDs. Mutable records expose updatedAt; action clients send expected version and display 409 conflicts.

## Reuse and Ownership Map

| Owner | Responsibility | Seam |
|---|---|---|
| app `pz` | Awizo, receipt, contributions, number sequence, execution/reversal intent | Entities/commands/routes in existing module |
| app `warehouseman` | Floor UI and scanner/label callers | Existing receiving API client and PanelShell |
| installed `wms` 0.8.0 | Warehouses, locations, profiles, stock balances and movements | Scalar IDs, scoped reads and commandBus |
| installed catalog/auth | Variant snapshots, users and feature authorization | Existing option/read helpers and auth context |
| app `pz_fixtures`, `label_printing` | Preserve demo sources and scoped pallet-label reads after rename | Update affected source references, no new provider |

## Architecture and Data Flow

Awizo → counted pallet lines → frozen PZ/contributions → receipt position intents → native receive → scoped movement readback → posted PZ/received Awizo.
Persist intent before native effect. Each native handler owns its transaction; do not claim shared ACID with PZ. After commit but before result storage, recovery looks up full immutable movement identity and verifies type/quantity/variant/location/reference. Ambiguity blocks; no match permits retry only after prior execution is known finished. Serialize concurrent attempts and reject mutated inputs.
Cancellation: verify original unconsumed/unreserved source, claim affected stock/document, persist reversal items, call adjust with negative quantities and stable reversal UUIDs. Known blockers reject before writes. Runtime failures preserve confirmed reversals; resume missing items after readback. Complete cancellation alone returns Awizo to receiving. Other moves/consumption/putaway or unknown outcomes block first-version cancellation even if replacement stock sits in the old location.
Gate native mutation paths through supported UMES/command guard mechanisms where required to preserve claims. A client boolean is not authorization. Confirm installed guard availability before implementing the gate; unsupported safety is a blocker, not an invitation to mutate native tables.

## User Journeys

### Journey J-001 — Count and post
Office creates/releases Awizo; Warehouseman opens it, scans/counts, chooses each pallet location and closes pallets. Summary shows expected/count/difference by SKU/UOM. Issue action shows frozen quantities and locations. Pending is visible; success requires verified native effects. Office and Panel show the same PZ number and per-line outcome.

### Journey J-002 — Recover and cancel
Authorized user retries a failed issue using the original reference, or reconciles unknown results. For an eligible fully posted PZ, cancel requires a reason. During cancellation, show each confirmed/pending/unknown reversal. Only full reversal permits recount/reissue with a new number. No fake undo by navigating back.

## UI and Interaction Contracts

### UI architecture
References: existing `pz/components/GoodsReceiptsTable.tsx` (DataTable), `GoodsReceiptForm.tsx` (CrudForm), `GoodsReceiptDetail.tsx`; `warehouseman/components/ReceivingPallets.tsx`, `ReceivingCount.tsx`, `ReceivingSummaryScreen.tsx` (PanelShell/mobile scanner flow). Preserve merged barcode-camera and label-print actions. Installed UI imports and tokens remain canonical; use shared API helpers and guarded mutations, no raw admin forms/fetch. Read `.ai/guides/backend-ui.md` and routed quality-state references before changes.

### `/backend/wms/awizo`
DataTable with number/date/supplier/warehouse/status/count summaries; create/edit use CrudForm and draft-only rules. Detail: expected lines, pallets/count summary, release/cancel-undelivered/issue according to permission and state. API `/api/pz/awizo`. Existing navigation namespace remains under `/backend/wms`.

### `/backend/wms/goods-receipts`
Read-only receipt list/detail with generated number, Awizo link, actual grouped lines and contribution drilldown, location, posting/reversal outcome and movement references. Actions retry/reconcile/cancel are separately gated; no ordinary edit/delete UI.

### `/warehouseman/receiving/*`
List receiving Awizos, retain existing pallet selection/scanning/printing. Close dialog requires scoped active location. Summary: `Awizo | Pallets closed/total | Expected / Counted / Difference`, then `Issue PZ` and per-line result. Failed/unknown results expose retry/reconcile without declaring success. Header identifies operator and assigned warehouse, which is convenience only.

All routes: localized PL/EN, loading, empty with legal next action, error/retry, forbidden, conflict/refresh, pending and unknown; disabled actions explain cause. Retain keyboard Enter/Escape/focus, screen-reader status announcements and 44px floor targets, light/dark semantic tokens and narrow-width layout. Textual wireframes above are design evidence; no screenshot is claimed without a configured browser run.

## Data Models

All entities stay in `pz/data/entities.ts`, scoped tenant/org, UUID keys, timestamps and updatedAt where mutable. Cross-module warehouse/location/catalog/user references are scalar IDs/snapshots. Existing app-owned relations may remain intra-module.

| Entity | Fields/invariants |
|---|---|
| Awizo/AwizoLine | Renamed current expectation document/lines; retain scope, unique number, snapshots, quantities and soft-delete behavior |
| Pallet | Awizo relationship, code, status; nullable location for legacy/open rows, required by close/issue; never guess a legacy location |
| GoodsReceipt | awizoId, number/date, supplier/warehouse snapshots, state, source revision, immutable totals; at most one active per Awizo |
| GoodsReceiptLine | variant/location, quantity, UOM/catalog snapshot, unique grouped key, receipt outcome, movementId/error; immutable payload |
| ReceiptContribution | receiptLineId, palletId/palletLineId, variant/location, quantity; immutable historical attribution |
| ReceiptNumberSequence | tenant/org/year unique; transactional increment and persisted allocation |
| ReceiptCancellation/item | original receipt/line/movement, reason, actor, immutable payload/ref UUID, outcome/reversal movement ID, attempt metadata |
| Stock execution claim | Required serialized scope/provenance exclusion for native mutations; supported guard implementation must be demonstrated before cancellation release |

No new supplier entity. User-entered reasons and existing names follow app encryption/privacy conventions; no credentials or raw request transcripts in errors. Store quantities as decimal strings in app; range-check conversion at native numeric API boundary, use base UOM only.

## API, Command, and Error Contracts

Awizo CRUD moves to `/api/pz/awizo`, commands `pz.awizo.create/update/delete/release/withdraw/cancel`; preserve temporary record-only confirm during rename stage until issue replaces it. Pallet APIs retain paths but point to Awizo; close adds locationId. New PZ list/detail are read-only; `issue`, `retry`, `reconcile`, `cancel`/cancellation recovery are explicit commands/actions, not an editable status field. Exact action paths are additive under `/api/pz/goods-receipts/` and documented in OpenAPI alongside per-method metadata.
Factory CRUD: `makeCrudRoute`; action routes use existing command/mutation guard envelope. 400 invalid input, 401/403 auth/features, scoped missing 404, stale/invalid-state/concurrency 409, unsupported tracking/UOM/location 422. Responses include receipt id/state/updatedAt and per-line execution outcome, never imply stock success for a pending response. Scope and actor derive from session. Editable actions require expected updatedAt. Native receipt uses `referenceType=manual`, `referenceId=PZ.id`; unique grouped fields separate receipt identities. Reversal items use distinct immutable UUIDs. Match actual installed numeric/ref contracts; do not invent wms.reverse or stock APIs.

## Events, Jobs, Notifications, and Cross-Module Flows

Awizo emits created/updated/deleted/received/cancelled; PZ emits issued/posted/posting_failed/cancelled after corresponding durable state. Never emit full posted/cancelled from a partial outcome. Existing source payload changes require explicit migration/BC documentation. Do not double-emit installed WMS events or use events as the sole proof of native commit. Recovery commands read authoritative state. No new scheduler or provider; notifications are N/A for this scope.

## Security, Privacy, and Compliance

Guard API and command paths, wildcard-aware ACL, complete tenant/org filters and immutable actor attribution. Direct native mutation paths must honor active claims; payload flags do not bypass guards. Do not grant broad receive/cancel access by reusing old document-edit permissions. Redact internal errors, preserve audit facts and historical IDs, do not log secrets. Expired request/lease does not prove native execution stopped.

## Integration Coverage

| Test | Setup/action | Observable oracle |
|---|---|---|
| TEST-01 | Two scopes; Awizo CRUD/release/count | No stock change; draft-only edits; foreign IDs refused |
| TEST-02 | Close pallet with missing/foreign/inactive/valid location | Refusal or saved location; version conflict without overwrite |
| TEST-03 | Expected100, counted97, surplus, two same-SKU pallets | PZ actual grouped quantities; distinct immutable contributions; one generated number |
| TEST-04 | Issue with open/no pallets, bad UOM/tracking/permission | Entire preflight refuses with zero movement |
| TEST-05 | Valid issue and concurrent duplicate | Real ledger +97 once; received only after all confirmed |
| TEST-06 | Failure before later call; crash after native commit | Partial/unknown shown; readback/retry adds only missing stock |
| TEST-07 | Known cancel blocker and other stock in original bin | Zero reversal; no consumption of another pallet's stock |
| TEST-08 | Eligible cancel, partial failure and lost response | One adjustment per item; complete cancellation alone permits reissue |
| TEST-09 | Real browser Panel/admin | Same outcomes; scan/labels retained; keyboard/narrow/light/dark/conflict states |
| TEST-10 | Generated migration inspection and existing fixture upgrade | No destructive reset; legacy rows preserved and unresolved locations explicit |

Failure injection is deterministic test-scoped execution control with the real WMS ledger, not a lot-tracked item that preflight must already reject. Tests must identify exact interruption boundaries and assert balances/movements, not only mocked call counts. Supported ephemeral test configuration only; no live DB migration as validation shortcut.

## Implementation Phases

Phase 1 (#41): rename all source call sites, APIs/UI/ACL/events/fixtures, append migration, preserve record-only confirm until the issue action replaces it. Tests TEST-01/09/10; value: correct terminology and preserved counting. Exit: generation/typecheck and focused regressions green.
Phase 2 (#42/#43): scoped location capture and undelivered Awizo cancellation. Tests TEST-01/02/09; value: stock-ready counted source. Exit: scoped close/reopen/cancel UI/API roundtrips verified.
Phase 3 (#44–#46): receipt model/provenance/numbering, native posting and uncertainty recovery. Tests TEST-03–06/09; value: stock changes once from actual count. Exit: real native movement readback and concurrent/restart cases pass.
Phase 4 (#47): prove native stock exclusion/provenance, then recoverable reversal and UI. Tests TEST-07/08; value: controlled correction. Exit: cancellation never consumes another pallet or reports partial reversal as complete.
Phase 5 (#49/#48): integrate all existing actions, full gates and final docs. Tests TEST-01–10; no deferred core behavior allowed. Value: reviewable verified receipt flow. Putaway remains subsequent #50.

## Implementation Plan

1.1 Rename announcement entities/commands and dependent call sites with unit regressions.
1.2 Rename APIs/ACL/events and scoped source contracts.
1.3 Rename office and floor UI; preserve scanner/label/fixture consumers.
1.4 Generate and review additive migration/snapshot; no application.
1.5 Run phase-1 discovery/type/targeted tests and inspect diff.
2.1 Add scoped pallet location fields/validation/close semantics.
2.2 Add floor location picker and error/conflict states.
2.3 Add Awizo cancellation command/route/permissions.
2.4 Add cancellation action and tests of frozen states.
2.5 Generate/review phase-2 schema and verify roundtrips.
3.1 Add PZ header/line/provenance entities and validators.
3.2 Add locked yearly number sequence and actual-count grouping.
3.3 Add issue command/source freeze and new ACL boundaries.
3.4 Add native receipt adapter with immutable per-line execution state.
3.5 Add serialized retry/readback and unknown-outcome handling.
3.6 Add PZ list/detail and issue/retry/reconcile UI.
3.7 Add native-ledger integration tests including restart/concurrency.
3.8 Generate/review schema and pass phase-3 gates.
4.1 Resolve/prove supported native mutation-guard and stock-claim contract.
4.2 Add cancellation intent/items and immutable reference execution.
4.3 Add reversal readback/retry and eligibility enforcement.
4.4 Add cancellation UI and explicit partial/unknown states.
4.5 Add ledger/provenance/race/failure integration tests.
5.1 Run integrated floor/admin acceptance and preserve merged label/scanner flows.
5.2 Update CONTEXT, ADRs, upgrade notes and discovery.
5.3 Run full generate/typecheck/lint/ds/test/build and integration gates.
5.4 Complete independent code review and UI verification; publish evidence.

## Requirement Traceability

| Requirement | Journey/surface | Data/command | Phase | Tests / acceptance |
|---|---|---|---|---|
| REQ-01 | J-001, Awizo office/Panel | Awizo CRUD | 1 | TEST-01/09, AC-01 |
| REQ-02 | J-001, pallet close | Pallet location, Awizo cancel | 2 | TEST-01/02, AC-02 |
| REQ-03 | J-001, issue | Receipt/sequence/contribution | 3 | TEST-03/04, AC-03 |
| REQ-04 | J-001/002, retry | Native receive/readback | 3 | TEST-05/06, AC-04 |
| REQ-05 | J-002, cancel | Claim/reversal/item | 4 | TEST-07/08, AC-05 |
| REQ-06 | All routes | Existing UI/discovery/docs | 1–5 | TEST-09/10 and full gate, AC-06 |

## Rollout, Migration, and Rollback

Never edit shipped migrations. Rename existing announcement tables through forward SQL; add new PZ tables and preserve relations/counts. Legacy closed pallets with no location remain readable and cannot be newly posted without explicit valid location resolution. Do not manufacture stock from historical confirmed paperwork. At the PZ introduction migration (#44), map pre-existing `confirmed` announcement rows to `legacy_confirmed`, retaining their header, lines, pallets and original confirmation timestamps. This terminal read-only state is displayed as “Historically confirmed — stock not posted”; it cannot release, withdraw, count, issue PZ or cancel. It is not `received` and has no fabricated movement. Phase 1 keeps the existing record-only `confirmed` lifecycle until that explicit mapping ships; after the cutover no new legacy confirmations are created. Do not auto-post historical records. Schema probe requires `yarn db:generate`, scoped SQL/snapshot review and separate approval to apply. Upgrade notes list breaking app-owned rename/API/event/ACL changes and deliberate re-grants; installed framework contracts remain untouched.
Rollback disables new issue/cancel actions and preserves records and native movements. In-flight operations require reconciliation, not deletion or a database rollback that loses their proof.

## Risks and Tradeoffs

| Risk | Mitigation / release condition |
|---|---|
| Native independent commits | Persist intent and immutable result identity; prove crash readback |
| Native direct writes evade claims | Prove supported guard/serialization across relevant commands before cancellation release |
| Grouping loses pallet identity | Immutable contributions owned by #44 and tested before putaway |
| Stale version/repeated scan/issue | Expected version, serialized source freeze, deterministic identity |
| Migration legacy records | Forward-only migration and explicit no-stock historical state |
| Tracker wording implies ready function | Completion only after real gates; spec is intent, not runtime evidence |

## Acceptance Criteria

- [ ] AC-01: Awizo names and existing count/scan/label flows work with no stock effect.
- [ ] AC-02: scoped close location and cancellation of undelivered Awizo behave correctly.
- [ ] AC-03: generated immutable PZ equals actual counts and preserves each pallet contribution.
- [ ] AC-04: expected100/count97 yields +97 once despite retry/restart/concurrency; received waits for full confirmation.
- [ ] AC-05: known blockers give zero reversals; partial/unknown cancellation is explicit and resumes safely; no misattribution of stock.
- [ ] AC-06: full gate, scoped API/browser cases, reviewed forward migrations and updated terminology/upgrade docs; no unapproved migration application.

## Final Compliance Report

| Check | Design status | Evidence |
|---|---|---|
| Routed context and ownership | pass | Existing pz/warehouseman call sites, installed WMS 0.8 facts, contracts/extensions/backend UI guides |
| Internal consistency | pass | Corrected issue #40/#44–#50, receipt identity and cancellation policy |
| Complete vertical phases | pass | Ordered plan and test oracles above; unsupported safety blocks release |
| Native reuse | pass | No duplicated ledger/providers/workflow engine; scalar cross-module references |
| UI states and references | pass | Existing DataTable/CrudForm/PanelShell surfaces and TEST-09 |
| Dependencies and traceability | pass | Requirement table; #50 separately scoped |

Verdict: Ready for implementation. This is design readiness; tests and runtime safety gates are not claimed passed.

## Open Questions

No unresolved business-policy question blocks starting Phase 1. Technical release gates (native claim enforcement, deterministic failure fixture, migration review) must be resolved by their owning phase before that phase is complete. They do not authorize weaker guarantees.

## Changelog

| Date | Change |
|---|---|
| 2026-09-19 | Materialized reconciled issues into executable phases; explicitly separated #50 and preserved forward-only migration boundary |
