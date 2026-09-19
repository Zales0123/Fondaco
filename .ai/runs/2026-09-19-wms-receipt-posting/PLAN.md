# WMS receipt posting execution plan

Source spec: .ai/specs/2026-09-19-awizo-pz-stock-posting.md (design PR #52)
Source issues: #40–#49; subsequent putaway #50 remains separately scoped.
Engine: om-auto-create-pr-loop (steps: 27, --loop: no; automatic threshold >20)

## Tasks

Status is todo/done; first todo is the resume point. Exec placement is fixed. Code commit identifiers are backfilled at checkpoint to avoid impossible self-referential commit hashes; each step remains one code commit.

| Phase | Step | Title | Exec | Status | Commit |
|---|---|---|---|---|---|
| 1 | 1.1 | Rename announcement entities/commands and dependent call sites with unit regressions. | group:A | todo | — |
| 1 | 1.2 | Rename APIs/ACL/events and scoped source contracts. | group:A | todo | — |
| 1 | 1.3 | Rename office and floor UI; preserve scanner/label/fixture consumers. | group:A | todo | — |
| 1 | 1.4 | Generate and review additive migration/snapshot; no application. | group:A | todo | — |
| 1 | 1.5 | Run phase-1 discovery/type/targeted tests and inspect diff. | group:A | todo | — |
| 2 | 2.1 | Add scoped pallet location fields/validation/close semantics. | dispatch | todo | — |
| 2 | 2.2 | Add floor location picker and error/conflict states. | dispatch | todo | — |
| 2 | 2.3 | Add Awizo cancellation command/route/permissions. | dispatch | todo | — |
| 2 | 2.4 | Add cancellation action and tests of frozen states. | dispatch | todo | — |
| 2 | 2.5 | Generate/review phase-2 schema and verify roundtrips. | dispatch | todo | — |
| 3 | 3.1 | Add PZ header/line/provenance entities and validators. | dispatch | todo | — |
| 3 | 3.2 | Add locked yearly number sequence and actual-count grouping. | dispatch | todo | — |
| 3 | 3.3 | Add issue command/source freeze and new ACL boundaries. | dispatch | todo | — |
| 3 | 3.4 | Add native receipt adapter with immutable per-line execution state. | dispatch | todo | — |
| 3 | 3.5 | Add serialized retry/readback and unknown-outcome handling. | dispatch | todo | — |
| 3 | 3.6 | Add PZ list/detail and issue/retry/reconcile UI. | dispatch | todo | — |
| 3 | 3.7 | Add native-ledger integration tests including restart/concurrency. | dispatch | todo | — |
| 3 | 3.8 | Generate/review schema and pass phase-3 gates. | dispatch | todo | — |
| 4 | 4.1 | Resolve/prove supported native mutation-guard and stock-claim contract. | dispatch | todo | — |
| 4 | 4.2 | Add cancellation intent/items and immutable reference execution. | dispatch | todo | — |
| 4 | 4.3 | Add reversal readback/retry and eligibility enforcement. | dispatch | todo | — |
| 4 | 4.4 | Add cancellation UI and explicit partial/unknown states. | dispatch | todo | — |
| 4 | 4.5 | Add ledger/provenance/race/failure integration tests. | dispatch | todo | — |
| 5 | 5.1 | Run integrated floor/admin acceptance and preserve merged label/scanner flows. | inline | todo | — |
| 5 | 5.2 | Update CONTEXT, ADRs, upgrade notes and discovery. | inline | todo | — |
| 5 | 5.3 | Run full generate/typecheck/lint/ds/test/build and integration gates. | inline | todo | — |
| 5 | 5.4 | Complete independent code review and UI verification; publish evidence. | inline | todo | — |

## Goal

Implement actual-count PZ posting, recovery and cancellation on the existing floor receiving flow, with pallet provenance for later putaway.

## Scope and non-goals

Own changes in app pz/warehouseman and affected fixtures/labels. Preserve current upstream main scanner/printing behavior. No procurement, QC, new providers, offline posting or putaway code in this PR. Do not edit node_modules, generated registries or shipped migrations. No migration application or reset authorized.

## Routed context

module-data + umes + backend-ui + testing + spec-pr. Architecture ownership resolved by approved issue #40; framework-context only for named missing seams. Load om-module-scaffold, business-one-shot-blueprints exact closest business slice and required procedures; om-data-model-design including integrity/concurrency/migration; om-system-extension for installed WMS links/guards; om-backend-ui-design with quality states and frontend/design system; om-integration-tests for integration verification. Read all matching guides once. Use /workspace/.agents/skills if worktree has not installed its own skills yet; .ai overrides remain mandatory.

## Implementation Plan

### Step 1.1 — Rename announcement entities/commands and dependent call sites with unit regressions.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 1.2 — Rename APIs/ACL/events and scoped source contracts.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 1.3 — Rename office and floor UI; preserve scanner/label/fixture consumers.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 1.4 — Generate and review additive migration/snapshot; no application.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 1.5 — Run phase-1 discovery/type/targeted tests and inspect diff.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 2.1 — Add scoped pallet location fields/validation/close semantics.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 2.2 — Add floor location picker and error/conflict states.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 2.3 — Add Awizo cancellation command/route/permissions.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 2.4 — Add cancellation action and tests of frozen states.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 2.5 — Generate/review phase-2 schema and verify roundtrips.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 3.1 — Add PZ header/line/provenance entities and validators.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 3.2 — Add locked yearly number sequence and actual-count grouping.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 3.3 — Add issue command/source freeze and new ACL boundaries.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 3.4 — Add native receipt adapter with immutable per-line execution state.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 3.5 — Add serialized retry/readback and unknown-outcome handling.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 3.6 — Add PZ list/detail and issue/retry/reconcile UI.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 3.7 — Add native-ledger integration tests including restart/concurrency.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 3.8 — Generate/review schema and pass phase-3 gates.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 4.1 — Resolve/prove supported native mutation-guard and stock-claim contract.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 4.2 — Add cancellation intent/items and immutable reference execution.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 4.3 — Add reversal readback/retry and eligibility enforcement.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 4.4 — Add cancellation UI and explicit partial/unknown states.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 4.5 — Add ledger/provenance/race/failure integration tests.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 5.1 — Run integrated floor/admin acceptance and preserve merged label/scanner flows.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 5.2 — Update CONTEXT, ADRs, upgrade notes and discovery.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 5.3 — Run full generate/typecheck/lint/ds/test/build and integration gates.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

### Step 5.4 — Complete independent code review and UI verification; publish evidence.

Implement exactly this spec step and its applicable issue criteria. Preserve working unrelated flows; add or adapt meaningful tests. Do not expand into later phases. Run targeted checks before committing and push.

## Risks and validation

Native stock/provenance exclusion is a Phase 4 release gate. No pretending sequential native calls are atomic. Historical confirmations get a read-only legacy state only at PZ cutover. Phase 1 preserves temporary record-only confirm.

Run generation after discovery changes; generate/review scoped SQL without applying. Checkpoint each phase / five steps. Full final validation: yarn generate, yarn typecheck, yarn lint, yarn ds:check, yarn test, yarn build; supported ephemeral integration and UI evidence. Never report unavailable runtime tests as passed. Test environment requires explicit safe setup; no guessed credentials or live DB migrations.
