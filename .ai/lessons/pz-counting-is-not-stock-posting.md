---
title: "PZ counting and confirmation do not post WMS stock"
modules: ["pz", "warehouseman", "wms"]
areas: ["framework-context"]
topics: ["receiving", "stock-posting", "documentation-evidence", "transaction-mapping", "purchasing", "suppliers"]
---

# PZ counting and confirmation do not post WMS stock

**Context**: Read-only comparison of the Fondaco Panel with WM22 on 2026-09-19. The Panel README still calls receiving a stub, while its routes render receiving documents, pallets, counting and summary screens.

**Problem**: A receiving label or confirmed PZ can be mistaken for a stock movement. Installed WMS commands exist, but the Panel calls PZ APIs. WM22 describes proposed software, not a second running implementation.

**Rule**: Trace the current page to its API and command before describing its effect. PZ pallet counts store actual quantities separately from expected document lines; confirmation freezes the document without calling native receive (ADR-0005/0008/0009). A future posting proposal must use actual counts and explicitly design location, idempotency and correction rules. Do not treat the confirmation event's document lines as actual counts. Distinguish code inspection, documented intent and runtime verification.

**Applies to**: `src/modules/warehouseman/components/Receiving*.tsx`, `src/modules/warehouseman/lib/receivingApi.ts`, `src/modules/pz/commands/goodsReceipts.ts`, and comparisons with WMS specifications.

**Transaction mapping (2026-09-19)**: Installed core 0.8.0 validators enumerate receipt, putaway, pick, pack, ship, adjust, transfer, cycle_count and return_receive. Enum presence is not evidence of a dedicated posting command. In inventory-actions.ts, receive fixes type=receipt; move accepts a type but always subtracts/adds onHand between two locations of the same warehouse. reserve/allocate/release change reserved/allocated quantities, not physical onHand. cycleCount applies a delta (autoAdjust defaults true), so it is not the document-only counting screen. Model business operation → controlled command → verified effect explicitly; never use move(type=ship) as an outbound issue.

**Tracker follow-up**: #40 proposes the Awizo/PZ split; its children #44/#45/#46 own issue/post/retry. #49 is their integration acceptance and pallet-lineage follow-up, #50 adds putaway. Read parent sub-issues as well as the open-issue list before creating overlapping tasks; tracker specifications are future intent, not evidence of installed behavior.

**Consistency audit of #40–#50**: Header-level receipt referenceId in #40/#45 is compatible with their unique (variant, location) grouping; do not claim it necessarily duplicates movements. #49 proposed a different reference contract and must align with the parent. Native adjust forks its EM and commits per call, so #47 cannot obtain all-or-nothing multi-line reversal merely by sequencing calls or prechecking stock. Available quantity is not proof that stock belongs to a particular receipt/pallet. Keep audit findings distinct from approved architecture changes.

**Prepared reconciliation**: `.ai/reviews/wms-issues-reconciled/` holds reviewed issue replacements and a publication script with remote-change checks. Publication was denied by GitHub UpdateIssue permissions for msulich7-hub on #40; drafts are not evidence of changed tracker contracts.

**Purchasing proposal (2026-09-19)**: WM22 PO/ASN specs already exist separately. They require PR-derived PO lines and place SupplierProfile in procurements; a requested future standalone supplier module is a design difference to resolve. Existing PZ stores supplierName and pallet counts by variant; neither proves PO-line allocation. Preserve source-line identity when proposing multi-PO receiving.

**Scope decision (2026-09-19)**: For the purchasing/inbound proposal, the user selected two delivery stages and purchase orders without mandatory requisitions. Apply this only to this proposal; do not silently rewrite the WM22 baseline or infer approval to implement.
