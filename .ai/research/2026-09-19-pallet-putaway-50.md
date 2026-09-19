# Research — Pallet Putaway (issue #50) primary-source notes

**Date**: 2026-09-19
**Worktree**: `/Users/mpzalewski/Sites/CommerceWeavers/OM-hackathon/fondaco.feat-pallet-putaway`
**Branch**: `feat/pallet-putaway`, identical to `origin/main` (`/usr/bin/git log --oneline origin/main..HEAD` is empty); only untracked files are `.agents/` and `.ai/specs/2026-09-19-pallet-putaway.md`.
**Installed platform**: `@open-mercato/core` **0.8.0** (`package.json:76`; verified via `node_modules/@open-mercato/core/package.json` `version`).

> **Location convention**: the repo has **no** existing convention for research notes — there is no `.ai/research/`, no `docs/research/`, and neither `.ai/specs/README.md` nor `docs/agents/*.md` nor `.ai/agentic.config.json` mentions research notes. `.ai/specs/` is for specs (`.ai/specs/README.md:5-10`) and `docs/adr/` for decisions. This file is therefore written to `.ai/research/2026-09-19-pallet-putaway-50.md`, a new directory.

> **Note**: a spec skeleton for this work already exists (untracked) at `.ai/specs/2026-09-19-pallet-putaway.md`, status `Draft — skeleton, Open Questions gate not yet passed` (`.ai/specs/2026-09-19-pallet-putaway.md:4`). This research file is the evidence base behind it, not a replacement.

---

## 1. The `pz` module today

### 1.1 Files

All under `src/modules/pz/`: `index.ts`, `acl.ts`, `setup.ts`, `events.ts`, `data/entities.ts`, `data/validators.ts`, `commands/{goodsReceipts,pallets,palletLines}.ts`, `api/…`, `backend/wms/goods-receipts/…`, `components/…`, `lib/…`, `i18n/{en,pl}.json`, `migrations/{Migration20260918232359_pz.ts, Migration20260919083412_pz.ts, .snapshot-open-mercato.json}`, `__integration__/TC-PZ-00{1..6}*.spec.ts`.

There is **no** `di.ts`, **no** `ce.ts`, **no** `search.ts`, **no** `subscribers/`, **no** `widgets/`, **no** `README.md` in `pz`.

Module metadata: `name: 'pz'`, `title: 'Goods Receipt Orders'`, version `0.1.0` (`src/modules/pz/index.ts:3-10`).

### 1.2 Entities (`src/modules/pz/data/entities.ts`)

| Entity | Table | Key fields |
|---|---|---|
| `GoodsReceipt` | `pz_goods_receipts` (`:51`) | `id` uuid (`:77-78`), `tenantId`/`organizationId` (`:80-84`), `documentNumber` (`:86-87`), `documentDate` date (`:90-91`), `supplierName` (`:94-95`), `warehouseId` uuid **scalar, no ORM relation, ADR-0004** (`:97-99`), `warehouseSnapshot` jsonb (`:102-103`), `status` default `'draft'` (`:105-106`), `lines` (`:108-109`), `pallets` (`:112-113`), `createdAt`/`updatedAt`/`deletedAt` (`:115-122`) |
| `GoodsReceiptLine` | `pz_goods_receipt_lines` (`:125`) | `goodsReceipt` ManyToOne `goods_receipt_id` (`:138-139`), `tenantId`/`organizationId` (`:141-145`), `lineNumber` (`:148-149`), `catalogVariantId` uuid (`:152-153`), `catalogProductId` uuid (`:156-157`), `catalogSnapshot` jsonb (`:159-160`), `quantity` numeric(18,4) as string (`:163-164`), `unit` (`:167-168`), `uomSnapshot` (`:170-171`) |
| `Pallet` | `pz_pallets` (`:189`) | `id` uuid (`:209-210`), `goodsReceipt` ManyToOne `goods_receipt_id` (`:212-213`), `tenantId`/`organizationId` (`:215-219`), `code` text, generated + immutable (`:222-223`), `label` optional note (`:226-227`), `status` default `'open'` (`:229-230`), `closedAt` (`:232-233`), `lines` (`:235-236`), `createdAt`/`updatedAt` (`:238-242`). **No soft delete, no `deletedAt`.** |
| `PalletLine` | `pz_pallet_lines` (`:251`) | `pallet` ManyToOne `pallet_id` (`:267-268`), `tenantId`/`organizationId` (`:270-274`), `catalogVariantId` (`:277-278`), `catalogProductId` (`:281-282`), `catalogSnapshot` jsonb (`:284-285`), `quantity` numeric(18,4) string, always `> 0` (`:291-292`), `createdAt`/`updatedAt` (`:294-298`) |

Types:
- `GoodsReceiptStatus = 'draft' | 'receiving' | 'confirmed'` (`src/modules/pz/data/entities.ts:16`); `FROZEN_GOODS_RECEIPT_STATUSES = ['receiving','confirmed']` (`:19`).
- `PalletStatus = 'open' | 'closed'` (`:21`).
- `PalletLineCatalogSnapshot = { name: string; sku: string | null }` (`:24-27`).

Indexes on `Pallet`: `pz_pallets_scope_receipt_idx` (tenant, org, goodsReceipt) `:190-193`; `pz_pallets_receipt_status_idx` (goodsReceipt, status) `:194-197`; **`pz_pallets_code_unique_idx` = unique on `(tenant_id, organization_id, lower(code))`** `:203-207` (ADR-0010).
On `PalletLine`: `pz_pallet_lines_scope_idx` (tenant, org, catalogVariantId) `:252-255`; **`pz_pallet_lines_pallet_variant_unique_idx` = unique `(pallet_id, catalog_variant_id)`** `:258-262`.

Entity comment states the current contract explicitly: *"A counting carrier belonging to exactly one Goods Receipt… Hard-deleted rather than soft-deleted, and only while `open` and empty"* (`src/modules/pz/data/entities.ts:180-188`), and on `GoodsReceipt.pallets`: *"In-module relation: a Pallet is part of this document and cannot outlive it (ADR-0009)"* (`:111`).

### 1.3 Migrations

- `src/modules/pz/migrations/Migration20260918232359_pz.ts` — creates `pz_goods_receipts` + `pz_goods_receipt_lines` (`:8-12` for the header table and indexes).
- `src/modules/pz/migrations/Migration20260919083412_pz.ts` — creates `pz_pallets` (`:9`), `pz_pallets_code_unique_idx` (`:10`), `pz_pallets_receipt_status_idx` (`:11`), `pz_pallets_scope_receipt_idx` (`:12`), `pz_pallet_lines` (`:14`) + its two indexes (`:15-16`), and both FKs (`:18`, `:20`). `down()` drops both tables (`:23-31`).
- Snapshot: `src/modules/pz/migrations/.snapshot-open-mercato.json`.

### 1.4 Commands

Registered via file-based discovery; generated loader entries at `.mercato/generated/command-loaders.generated.ts:1502-1596` (ids `pz.goodsReceipts.{confirm,create,delete,release,update}`, `pz.palletLines.{count,delete,update}` `:1544-1556`, `pz.pallets.{close,create,delete,reopen,update}` `:1567-1591`).

**Pallet commands — `src/modules/pz/commands/pallets.ts`**
- `PALLET_ENTITY_ID = E.pz.pallet` (`:31`); `PALLET_CODE_UNIQUE_INDEX = 'pz_pallets_code_unique_idx'` (`:32`); `PALLET_CODE_ATTEMPTS = 5` (`:35`); `MAX_LABEL_LENGTH = 120` (`:37`).
- `SerializedPallet` shape (`:39-50`): `{ id, goodsReceiptId, tenantId, organizationId, code, label, status, closedAt, createdAt, updatedAt }`.
- `pz.pallets.create` (`:311-340`): requires `goodsReceiptId` (`:121-128`), optional `label`; locks the receipt with `LockMode.PESSIMISTIC_WRITE` and refuses unless `status === 'receiving'` (`lockReceivingReceipt`, `:136-164`); code derived by `deriveNextCode` (`:173-186`) over `pz_pallets` via Kysely ordering by `length(code) desc, code desc`, then `nextPalletCode` (`src/modules/pz/lib/palletCode.ts:35-38`); unique-violation retried up to 5×, otherwise `409` (`:324-334`). Write goes through `runCrudCommandWrite` with `action: 'created'` (`:276-306`).
- `pz.pallets.update` (`:342-392`): only `label` is editable — *"The code is the physical label somebody has already stuck on the pallet, so nothing here may change it."* (`:369-371`). Requires open status (`assertOpen`, `:239-243`).
- `pz.pallets.delete` (`:394-445`): requires open + no lines (`assertNoLines`, `:452-471`), hard delete (`tx.remove(pallet)`, `:422`).
- `pz.pallets.close` (`:552-563`) and `pz.pallets.reopen` (`:565-582`) share `transitionPallet` (`:477-520`): status + `closedAt` move together (`:506-510`); reopen additionally runs `assertReceiptReopenable` refusing when the receipt is `confirmed` (`:527-550`).
- **All pallet writes require an explicit optimistic-lock version header**; `requireExpectedVersion` (`:95-107`) rejects a missing one with 400, deliberately *not* the additive installed default. `lockPalletForWrite` (`:211-237`) pessimistically locks and calls `assertOptimisticLock({ resourceKind: PALLET_ENTITY_ID, resourceId, expected, current: pallet.updatedAt })`.
- Audit: `buildPalletLog` uses `resourceKind: 'pz.pallet'` (`:255-265`).
- `isUndoable: false` on every pallet command (`:313, :344, :396, :554, :567`).

**Pallet-line commands — `src/modules/pz/commands/palletLines.ts`**
- `PALLET_LINE_ENTITY_ID = E.pz.pallet_line` (`:29`); `PALLET_LINE_UNIQUE_INDEX = 'pz_pallet_lines_pallet_variant_unique_idx'` (`:30`).
- `pz.palletLines.count` (`:346-374`): **adds** to the `(pallet, variant)` row, creating it on first scan (`runCountAttempt`, `:287-336`); `lockPalletForCount` (`:159-180`) pessimistically locks the pallet, requires `pallet.goodsReceipt.status === 'receiving'` and pallet open; a unique violation is retried once as an add (`:355-360`). Exact decimal addition via `addQuantities`/`toScaledInteger` (`:142-151`).
- The counted variant and its snapshot are resolved **from the catalog through `queryEngine`, never from the client** (`resolveCountedVariant`, `:226-254`) against `E.catalog.catalog_product_variant` and `E.catalog.catalog_product`.
- `pz.palletLines.update` (`:380-429`) replaces the quantity; `pz.palletLines.delete` (`:435-481`) hard-deletes. Both require a version (`:100-112`) and translate a 409 into a floor-readable message (`assertPalletLineVersion`, `:119-139`).
- Audit `resourceKind: 'pz.pallet_line'` (`:367, :424, :475`).

**Goods-receipt commands — `src/modules/pz/commands/goodsReceipts.ts`** (1634 lines)
- `GOODS_RECEIPT_ENTITY_ID = E.pz.goods_receipt` (`:54`); `ensureGoodsReceiptScope(ctx, translate)` is the shared trusted-scope derivation reused by the pallet commands (`:121`, imported at `commands/pallets.ts:27` and `commands/palletLines.ts:27`).
- `pz.goodsReceipts.create` `:579`, `.update` `:1024`, `.delete` `:1212`, `.release` `:1356`, `.withdraw` `:1411`, `.confirm` `:1514`.
- `release` (`:1355-1408`): `draft → receiving` only (`:1378-1380`).
- `withdraw` (`:1410-1460`): `receiving → draft`, **refused when any pallet exists** (`:1437-1446`).
- `confirm` (`:1513-1607`): requires `receiving` (`:1538-1542`), **refuses while any pallet is `open`, naming their codes** (`:1544-1558`), refuses zero lines (`:1562-1572`), takes `warehouseSnapshot` (`:1573-1578`), sets `status = 'confirmed'`, then emits (`:1592`).

### 1.5 Events

`src/modules/pz/events.ts:12-22` declares exactly four, via `createModuleEvents({ moduleId: 'pz', events })` (`:24`):
`pz.goods_receipt.created`, `pz.goods_receipt.updated`, `pz.goods_receipt.deleted`, `pz.goods_receipt.confirmed` (lifecycle).

**There is no pallet event of any kind** — no `pz.pallet.created`, `.closed`, `.reopened`. Pallet writes only produce CRUD side effects via `runCrudCommandWrite` and audit log entries.

`emitConfirmed` (`goodsReceipts.ts:1621-1632`) emits **persistent** with `tenantId`/`organizationId`, after commit, and swallows failures to an error log.

### 1.6 API routes

| Route | Methods & features | Notes |
|---|---|---|
| `src/modules/pz/api/pallets/route.ts` | GET `pz.goodsReceipts.view`; POST/PUT/DELETE `pz.receiving.count` (`:127-130`) | `makeCrudRoute`; list requires `goodsReceiptId` (`:26-34`) — *"an optional parent would turn this into a listing of every pallet in the Organization"* (`:21-25`); `lineCount` decorated per page by one grouped Kysely query (`decorateLineCounts`, `:98-124`), with tenant/org fail-closed (`:101-105`); command ids wired at `:167,:182,:195` |
| `src/modules/pz/api/pallets/close/route.ts` | POST `pz.receiving.count` (`:30`) | |
| `src/modules/pz/api/pallets/reopen/route.ts` | POST `pz.receiving.count` (`:30`) | |
| `src/modules/pz/api/pallets/by-code/route.ts` | GET `pz.goodsReceipts.view` (`:17`) | 404 unknown code, 409 when the code belongs to another document (consumed at `src/modules/warehouseman/lib/receivingApi.ts:137-143`) |
| `src/modules/pz/api/pallet-lines/route.ts` | GET `pz.goodsReceipts.view`; POST/PUT/DELETE `pz.receiving.count` (`:104-107`) | commands at `:161,:167,:173` |
| `src/modules/pz/api/goods-receipts/route.ts`, `…/confirm`, `…/release`, `…/withdraw`, `…/receiving-summary` | — | |
| `src/modules/pz/api/receiving/variant-by-barcode/route.ts` | — | barcode → variant resolution |

### 1.7 ACL and setup

`src/modules/pz/acl.ts:12-44` — `pz.goodsReceipts.view` (dependsOn `wms.view`), `pz.goodsReceipts.manage` (dependsOn view + `catalog.products.view`), **`pz.receiving.count`** (`:33`, dependsOn view — *"Owned by `pz` so that `pz` never gates on a `warehouseman` feature id"* `:28-32`), `pz.goodsReceipts.confirm`.
`src/modules/pz/setup.ts:3-21` — `GOODS_RECEIPT_FEATURES` granted to `superadmin` and `admin`; **no `seedExamples`** by deliberate decision (`:10-15`).

### 1.8 Validators

`src/modules/pz/data/validators.ts` — `goodsReceiptStatusSchema` (`:3`), `palletStatusSchema = z.enum(['open','closed'])` (`:5`), `goodsReceiptListSchema` (`:19-34`), `goodsReceiptLineBodySchema` (`:38-50`), `goodsReceiptWriteBodySchema` (`:57-63`). **There is no pallet write schema here** — pallet input parsing lives inline in `commands/pallets.ts` (`requirePalletId` `:79-88`, `readLabel` `:109-119`, `requireGoodsReceiptId` `:121-128`).

### 1.9 What links a pallet to the receipt and to catalog variants

- Pallet → receipt: a real **in-module ORM ManyToOne** (`data/entities.ts:212-213`, FK `pz_pallets_goods_receipt_id_foreign`, `Migration20260919083412_pz.ts:18`). This is the relation that must become a scalar `palletId` on the `pz` side under the #50 decision.
- PalletLine → catalog: **scalar ids plus snapshot** — `catalogVariantId` + `catalogProductId` + `catalogSnapshot` (`data/entities.ts:276-285`), never an ORM relation (ADR-0004/0007).
- Receipt → warehouse: scalar `warehouseId` + `warehouseSnapshot` (`data/entities.ts:97-103`).

### 1.10 Pallet provenance (issue #44)

**It is not in the code.** `grep -rni "provenance" src docs .ai/specs` returns only unrelated hits in `src/modules/example/references/surface-inventory.json`. There is no `pz` entity, column or command carrying per-PZ-line pallet contributions.

Issue #44 ("Issue a PZ from the counted pallets") is **CLOSED** and its "Pallet provenance acceptance" section (*"Preserve immutable contribution records per PZ line: pallet ID, pallet-line ID, counted quantity and posting location"*) describes a model that does **not** exist on this branch: today's `GoodsReceipt` is the hand-entered *document*, not a generated PZ, its number is user-supplied (`data/entities.ts:64-75`), and there is no `posting`/`posted` status (`:16`). See §3 for what this means.

---

## 2. Blast radius — everything outside `pz` that touches Pallet/PalletLine

**No file outside `src/modules/pz/` imports the `Pallet`/`PalletLine` ORM entities or the `pz` commands.** Verified with `grep -rn "from '@/modules/pz\|pz/data/entities\|pz/commands" src --include='*.ts' --include='*.tsx'` excluding `src/modules/pz/` — the single hit is a **component** import, not ORM:

- `src/modules/warehouseman/components/ReceivingSummaryScreen.tsx:4` — `import { ReceivingSummaryView, useReceivingSummary } from '@/modules/pz/components/ReceivingSummary'`.

Everything else is coupled by **HTTP path, response shape, translation key and label scope**:

### 2.1 `src/modules/warehouseman/` — the largest surface

`src/modules/warehouseman/lib/receivingApi.ts` is the single client seam. It re-declares the shapes locally (`PalletStatus` `:17`, `Pallet` `:19-26`, `PalletLine` `:28-36`, `PalletWriteResult` `:39-44`, `PalletLineWriteResult` `:46-50`, `PalletCodeMatch` `:52-57`) and calls, by URL:

| Function | URL | Line |
|---|---|---|
| `fetchPallets` | `GET /api/pz/pallets?goodsReceiptId=…&pageSize=100` | `:125-127` |
| `createPallet` | `POST /api/pz/pallets` | `:129-131` |
| `deletePallet` | `DELETE /api/pz/pallets` | `:133-135` |
| `findPalletByCode` | `GET /api/pz/pallets/by-code?code=&goodsReceiptId=` | `:138-143` |
| `printPalletLabel` | `POST /api/label_printing/print-label` with `scope: 'pz.pallet'` | `:146`, `:176-187` |
| `closePallet` | `POST /api/pz/pallets/close` | `:189-191` |
| `reopenPallet` | `POST /api/pz/pallets/reopen` | `:193-195` |
| `fetchPalletLines` | `GET /api/pz/pallet-lines?palletId=…&pageSize=100` | `:197-199` |
| `countPalletLine` | `POST /api/pz/pallet-lines` | `:202-208` |
| `updatePalletLine` | `PUT /api/pz/pallet-lines` | `:211-217` |
| `deletePalletLine` | `DELETE /api/pz/pallet-lines` | `:219-221` |

Consumers: `components/ReceivingPallets.tsx` (`:16-26`), `components/ReceivingCount.tsx` (`:28-44`), `components/ReceivingDocuments.tsx`, `components/ReceivingSummaryScreen.tsx`, `components/ScanQuantityStep.tsx`, `components/PanelUI.tsx`, plus routes `frontend/warehouseman/receiving/[receiptId]/pallets/[palletId]/page.tsx`, `…/[receiptId]/page.tsx`, `…/[receiptId]/summary/page.tsx`. Panel URL helpers: `lib/receivingPanel.ts:4-16`. Tests: `lib/__tests__/receivingPanel.test.ts`, `lib/__tests__/palletLabelNotice.test.ts`, `lib/__tests__/printPalletLabel.test.ts`.

Translation keys owned by `pz` but consumed by the panel: `pz.pallets.errors.*`, `pz.pallets.status.*` (`ReceivingPallets.tsx:102,108,135,151,265`), `pz.receiving.summary.unknownProduct` (`ReceivingCount.tsx:92`). Also `src/modules/warehouseman/setup.ts` mentions pallets.

### 2.2 `src/modules/label_printing/`

- `src/modules/label_printing/lib/labelScopes.ts:12` — `export type LabelScopeId = 'catalog.product' | 'pz.pallet'`. The pallet resolver reads the pallet row to get the code that is printed; `src/modules/label_printing/api/print-label/route.ts` is the entry point; `src/modules/label_printing/i18n/{en,pl}.json` carry its strings; `__tests__/labelScopes.test.ts` covers it.

### 2.3 `src/modules/barcode_scanner/`

Mentions pallets only in copy/tests (`components/BarcodeScannerDialog.tsx`, `lib/scanFeedback.ts`, `lib/scanStream.ts`, `__tests__/*`). No structural coupling.

### 2.4 `src/modules/pz_fixtures/lib/seed.ts`

Seeds demo pallets; will need re-pointing if tables move.

### 2.5 Generated registries (regenerate, never hand-edit)

`.mercato/generated/entities.ids.generated.ts:186-190` declares `pz: { goods_receipt, goods_receipt_line, pallet: "pz:pallet", pallet_line: "pz:pallet_line" }`. Also generated: `.mercato/generated/entities/pallet/index.ts`, `.mercato/generated/entities/pallet_line/index.ts`, `.mercato/generated/command-loaders.generated.ts:1544-1596`, `.mercato/generated/modules.generated.ts:572-592`, `.mercato/generated/api-route-shard.016.pz.generated.ts`, `.mercato/generated/entity-fields-registry.ts`, `.mercato/generated/openapi.generated.json`.

**Contract consequence**: `.ai/guides/contracts.md:92` lists *"API routes, public imports/signatures, DB schema, event/entity/ACL/DI/widget/notification/AI IDs, CLI commands/flags, and generated bootstrap exports"* as compatibility surfaces requiring a deprecation bridge. Moving `pz:pallet` → `pallets:pallet` and `/api/pz/pallets` → `/api/pallets/...` are both breaking changes under that rule and must read `.ai/guides/upstream/BACKWARD_COMPATIBILITY.md`.

---

## 3. Issue #47's cancellation logic and #45/#46's execution & recovery — **none of it is in code on this branch**

This is the most load-bearing finding for a plan.

**Tracker state** (`gh issue view`, repo `Zales0123/Fondaco`): #44, #45, #46, #47 are all **CLOSED**; #54 is **OPEN**.

**Code state** — verified absent:
- `GoodsReceiptStatus` is `'draft' | 'receiving' | 'confirmed'` only (`src/modules/pz/data/entities.ts:16`). There is **no** `posting`, `posted`, `posting_failed`, `cancelling`, `cancelled`, `cancel_failed`, `cancel_unknown`.
- Commands are `create/update/delete/release/withdraw/confirm` only (`.mercato/generated/command-loaders.generated.ts:1502-1596`). There is **no** `pz.goodsReceipts.issue`, `.retry`, `.cancel`, `.reconcile`.
- Events are the four in `src/modules/pz/events.ts:12-22`. There is **no** `pz.goods_receipt.issued`, `.posted`, `.posting_failed`, `.cancelled`.
- ACL has no `pz.goodsReceipts.issue` and no `pz.goodsReceipts.cancel` (`src/modules/pz/acl.ts:12-44`).
- There is no frozen-payload table, no per-line outcome (`pending/confirmed/rejected/unknown`), no claim/lock entity, no reversal-item entity, no stored movement id, no provenance record anywhere in `src/`.
- `docs/adr/0005-goods-receipts-are-record-only.md:4-7` still stands unsuperseded: *"Confirming a goods receipt does not call `wms.inventory.receive` and does not change any `wms` balance."*
- The lesson record `.ai/lessons/pz-counting-is-not-stock-posting.md:14` states the rule directly: *"PZ pallet counts store actual quantities separately from expected document lines; confirmation freezes the document without calling native receive (ADR-0005/0008/0009)."* Its line `:20` notes *"tracker specifications are future intent, not evidence of installed behavior."*

**Conclusion**: there is nothing from #45/#46/#47 in this repo to extend. The only mechanisms this app has actually built and can be extended are:

1. **Command-level optimistic locking with a *required* version** — `readOptimisticLockExpected` + `assertOptimisticLock` from `@open-mercato/shared/lib/crud/optimistic-lock-command`, wrapped so a missing header is a 400 (`src/modules/pz/commands/pallets.ts:95-107`, `commands/palletLines.ts:100-112`), and a 409 body preserved but re-worded (`commands/palletLines.ts:119-139`). Client side: `buildOptimisticLockHeader` + `withScopedApiRequestHeaders` (`src/modules/warehouseman/lib/receivingApi.ts:2-3, 96-106`).
2. **Pessimistic row locks inside the write transaction** — `LockMode.PESSIMISTIC_WRITE` on the receipt (`commands/pallets.ts:151`), on the pallet (`:226`, `commands/palletLines.ts:169`) and on the pallet line (`commands/palletLines.ts:203`).
3. **Unique-index-as-authority retry** — pallet code collision re-derives up to 5× (`commands/pallets.ts:324-334`); pallet-line unique violation retries once as an add (`commands/palletLines.ts:355-360`).
4. **Post-commit side effects** — `runCrudCommandWrite({ phases, sideEffect })` throughout; `emitConfirmed` after the commit with `persistent: true` (`commands/goodsReceipts.ts:1621-1632`).
5. **Installed WMS idempotency** — see §5; this is the only "don't post twice" mechanism actually available today.

The reference-identity concepts named in the issues (`frozen payload`, `referenceId` stable across retries, `unknown` outcome, readback, claims) exist **only as prose in the tracker**, and the only concrete platform affordance behind them is `buildMovementIdempotencyKey` + the partial unique index on `wms_inventory_movements.idempotency_key` (§5.4).

---

## 4. Issue #54's subscriber `pz.goods_receipt.confirmed` → `wms.inventory.receive`

**Not implemented on this branch.**

- `find src -name "*subscriber*"` returns only `src/modules/example/subscribers/`, `src/modules/example_customers_sync/subscribers/`, `src/modules/example_customers_sync/lib/inbound-subscriber.ts`, `src/modules/example_customers_sync/lib/outbound-subscriber.ts`. `pz` has no `subscribers/` directory.
- `grep -rn "goods_receipt.confirmed" src` hits only the declaration (`src/modules/pz/events.ts:17`), the emit (`src/modules/pz/commands/goodsReceipts.ts:1624`), and doc/OpenAPI prose (`src/modules/pz/api/goods-receipts/confirm/route.ts:172`, `commands/goodsReceipts.ts:1504-1505`).
- `grep -rn "wms.inventory.receive" src` outside docs hits only `src/modules/wms_fixtures/lib/seed.ts:288`.
- `grep -rn "wms_integration_procurement_goods_receipt" src` → **no hits in app code**.

**Where received stock lands today**: nowhere via `pz`. The only place the app puts stock into a staging location is the demo fixture: `src/modules/wms_fixtures/lib/data.ts:149` defines `{ warehouseCode: 'WH-MAIN', code: 'STG-RECV', type: 'staging', parentCode: 'RECV', capacityUnits: 400 }` (and `STG-SHIP` at `:165`), and `:272-274` seed receipts into `STG-RECV`, while `:283-285` seed **`type: 'putaway'` moves from `STG-RECV` to `A-01-02`/`B-01-01`/`B-01-02`** — executed at `src/modules/wms_fixtures/lib/seed.ts:288-304` (receive) and `:317-334` (move).

**The toggle #54 names is real and default-off**: `node_modules/@open-mercato/core/src/modules/wms/lib/wmsIntegrationToggles.ts:23-30` — `identifier: 'wms_integration_procurement_goods_receipt'`, `defaultValue: false`, described as *"Reserved toggle for future procurement-driven receiving integration."* Resolution helper: `resolveWmsIntegrationToggleEnabled(...)` (`:60-81`), which self-seeds the toggle on `MISSING_TOGGLE` (`:72-77`).

**#54's open question, answered by the code**: `/api/wms/locations` accepts `type` as a first-class filter — `z.enum(['zone','aisle','rack','bin','slot','dock','staging'])` at `node_modules/@open-mercato/core/src/modules/wms/api/locations/route.ts:30` and `filters.type = { $eq: query.type }` at `:74`. So selecting a staging location **by type** rather than by the `STG-RECV` code is supported by the installed contract, which is exactly what #50 requires.

---

## 5. The installed WMS contract (`@open-mercato/core` 0.8.0)

### 5.1 Movement type and reference type enums

`node_modules/@open-mercato/core/src/modules/wms/data/validators.ts:18-28`:
```
inventoryMovementTypeSchema = z.enum([
  'receipt', 'putaway', 'pick', 'pack', 'ship', 'adjust', 'transfer', 'cycle_count', 'return_receive',
])
```
**`'putaway'` exists** (`:20`). Mirrored as the TS type at `node_modules/@open-mercato/core/src/modules/wms/data/entities.ts:17-26`.

`inventoryMovementReferenceTypeSchema = z.enum(['po','so','transfer','manual','qc','rma'])` (`validators.ts:29`; type at `entities.ts:27`). **There is no `pallet`, `putaway` or receipt reference type** — `'manual'` is the only fit, matching the #50 decision.

### 5.2 `wms.inventory.move` input schema

`node_modules/@open-mercato/core/src/modules/wms/data/validators.ts:277-293`:

| Field | Rule |
|---|---|
| `organizationId`, `tenantId` | `z.string().uuid()`, required (from `scopedSchema`, `:8-11`) |
| `warehouseId` | uuid, required |
| `fromLocationId` | uuid, **required** |
| `toLocationId` | uuid, **required** |
| `catalogVariantId` | uuid, required |
| `lotId` | uuid, optional |
| `serialNumber` | string ≤120, optional |
| `quantity` | `z.coerce.number().finite().gt(0)` — **positive, and a number not a decimal string** (`:4-5`) |
| `type` | `inventoryMovementTypeSchema.optional()` |
| `reason` | string, **required**, trimmed, 1–500 |
| `reasonCode` | string ≤80, optional |
| `referenceType` | `inventoryMovementReferenceTypeSchema.default('manual')` |
| `referenceId` | **uuid, required** — hence "a pallet code is never a reference key" is enforced by the schema |
| `performedBy` | **uuid, required** |
| `performedAt` | `z.coerce.date()`, optional |
| `metadata` | `z.record(z.string(), z.unknown())`, optional (`:31`) |

Exported type: `InventoryMoveInput` (`:343`).

### 5.3 `wms.inventory.move` execution

`node_modules/@open-mercato/core/src/modules/wms/commands/inventory-actions.ts:1557-1710`, `registerCommand` at `:1868`. Handler returns `{ movementId: string }` (`:1557`, `:1694`). `isUndoable: false` (`:1560`).

Order of operations inside one transaction (`runInTransaction`, `:1566`):
1. `ensureTenantScope(ctx, input.tenantId)` / `ensureOrganizationScope(ctx, input.organizationId)` **before** the transaction (`:1563-1564`).
2. `requireWarehouse` (`:1568`) — 404 `Warehouse not found.` and re-asserts both scopes from the loaded row (`:340-353`).
3. `requireLocation` for both from and to (`:1569-1570`) — 404 `Warehouse location not found.`, scope re-asserted (`:355-368`).
4. **Both locations must belong to `input.warehouseId`, else `422 { error: 'invalid_location' }`** (`:1571-1575`). Cross-warehouse moves are impossible through this command.
5. `upsertBalanceBucket` for source and target (`:1576-1593`), creating a zero row if absent (`:702-731`).
6. `performedAt = input.performedAt ?? new Date()` (`:1594`); `receivedAt` inherited from the source bucket's earliest movement via `resolveReceivedAtForBalance` (`:1595`, `:733-760`) — FIFO age travels with the goods.
7. `type: input.type ?? 'transfer'` (`:1604`) — **`putaway` must be passed explicitly.**
8. Idempotency key built and looked up **before any quantity change** (`:1614-1626`); on a hit the existing movement is returned and **no balance is touched** (`:1627-1642`).
9. `if (getAvailableQuantity(sourceBalance) < input.quantity - 0.000001) throw new CrudHttpError(409, { error: 'insufficient_stock' })` (`:1643-1645`). `quantityAvailable` = onHand − reserved − allocated (`data/entities.ts:286-294`), so reserved stock blocks a putaway.
10. Source `quantityOnHand -=`, target `+=` (`:1646-1655`), then `persistMovementWithIdempotency` (`:1656`).
11. After commit and only when not a replay: CRUD side effects (`:1674-1677`), `wms.inventory.moved` event (`:1678-1686`), low-stock check (`:1687-1692`).
12. Audit: `buildMutationLog({ actionKey: 'wms.audit.inventory.move', resourceKind: WMS_INVENTORY_MOVEMENT_RESOURCE, … })` (`:1696-1709`).

`wms.inventory.receive` (`:1420-1555`) is the same shape but **hard-codes `type: 'receipt'`** (`:1459`) and takes a single `locationId` (`validators.ts:217-232`, `InventoryReceiveInput` `:338`). Its schema requires `referenceType` (no default) and `referenceId` uuid, `performedBy` uuid, optional `receivedAt`/`performedAt`.

Other command ids in the same file: `wms.inventory.reserve` `:901`, `.release` `:1095`, `.allocate` `:1189`, `.adjust` `:1289`, `.receive` `:1421`, `.move` `:1558`, `.cycleCount` `:1713`.

### 5.4 Deduplication by referenceType/referenceId

`node_modules/@open-mercato/core/src/modules/wms/lib/inventoryIdempotency.ts:12-37`:
```
buildMovementIdempotencyKey = [
  'movement', referenceType, referenceId, type, warehouseId,
  locationFromId, locationToId, catalogVariantId, lotId, serialNumber, String(quantity),
].join('|')
```
**The key includes the quantity and both locations**, so it dedupes an *identical replay*, not "this reference has already been posted". Two different quantities under one `referenceId` are two movements. This is exactly why #50 assigns `referenceId` = the UUID of one execution **line** and keeps it stable across retries.

Lookup: `findExistingMovementByIdempotencyKey` filters `{ organizationId, idempotencyKey, deletedAt: null }` (`inventory-actions.ts:236-252`). Uniqueness is enforced by a partial index — `wms_inventory_movements_idempotency_unique_idx` on `("organization_id","idempotency_key") where idempotency_key is not null and deleted_at is null` (`data/entities.ts:381-385`). `persistMovementWithIdempotency` (`:831-864`) re-reads after a `23505` unique violation and returns the racing row as `idempotentReplay: true` (`:852-863`; `isUniqueConstraintError` `:228-234`).

**Caveat for a plan**: the key is scoped by `organizationId` only, not `tenantId`.

### 5.5 `InventoryBalance` and `InventoryMovement`

`InventoryBalance` — table `wms_inventory_balances` (`data/entities.ts:245-295`): `warehouse` FK (`:262-263`), `location` FK (`:265-266`), `catalogVariantId` uuid (`:268-269`), `lot` FK nullable (`:271-272`), `serialNumber` (`:274-275`), `quantityOnHand` / `quantityReserved` / `quantityAllocated` numeric(16,4) strings (`:277-284`), and a **generated stored column** `quantityAvailable = onHand − reserved − allocated` (`:286-294`). Bucket granularity is `(warehouse, location, variant, lot, serial)`.

`InventoryMovement` — table `wms_inventory_movements` (`:368-436`): `warehouse` (`:389-390`), `locationFrom` nullable (`:392-393`), `locationTo` nullable (`:395-396`), `catalogVariantId` (`:398-399`), `lot` (`:401-402`), `serialNumber` (`:404-405`), `quantity` numeric(16,4) (`:407-408`), `type` (`:410-411`), `referenceType` (`:413-414`), `referenceId` uuid (`:416-417`), `performedBy` uuid (`:419-420`), `performedAt` (`:422-423`), `receivedAt` (`:425-426`), `reason` (`:428-429`), `reasonCode` (`:431-432`), `idempotencyKey` (`:434-435`). Base class `WmsScopedEntity` adds `id`, `organizationId`, `tenantId`, `metadata` jsonb, `createdAt`, `updatedAt`, `deletedAt` (`:30-51`).
Indexes include `wms_inventory_movements_reference_idx` on `(organizationId, referenceType, referenceId)` (`:375`) and `wms_inventory_movements_warehouse_performed_at_idx` on `(organization_id, warehouse_id, performed_at desc)` (`:376-380`).

**Important for "current location is computed"**: `InventoryMovement` carries **no pallet reference of any kind**. The only fields that could carry one are `referenceId` (a uuid, already spoken for by the execution line), `reason`/`reasonCode` (text) and `metadata` (jsonb). Nothing in `wms` indexes `metadata`.

### 5.6 `WarehouseLocation` and its `type` enum

`data/entities.ts:126-164`, table `wms_warehouse_locations`. `type!: WarehouseLocationType` (`:144-145`) where
`WarehouseLocationType = 'zone' | 'aisle' | 'rack' | 'bin' | 'slot' | 'dock' | 'staging'` (`:12`, mirrored in `validators.ts:13`).
Also: `warehouse` FK (`:138-139`), `code` (`:141-142`), `parent`/`children` self-relation (`:147-151`), `isActive` default true (`:153-154`), `capacityUnits` numeric(16,4) nullable (`:156-157`), `capacityWeight` (`:159-160`), `constraints` jsonb (`:162-163`). Unique index `wms_warehouse_locations_warehouse_code_unique_idx` on `(warehouse_id, code) where deleted_at is null` (`:130-134`).

### 5.7 Warehouse / scope checks

- `ensureTenantScope` / `ensureOrganizationScope` (imported `inventory-actions.ts:77-78`) are called on the raw input **and** re-called against every loaded row (`:350-351, :365-366, :380-381, :400-401, :491-492, :514-515`).
- Both locations must sit in the passed warehouse → `422 invalid_location` (`:1573-1575`; receive's single-location variant at `:1434-1436`).
- API gating: `POST /api/wms/inventory/move` requires `wms.adjust_inventory` (`node_modules/@open-mercato/core/src/modules/wms/api/inventory/move/route.ts:6-7`, `commandId: 'wms.inventory.move'` at `:15`). ACL feature list: `node_modules/@open-mercato/core/src/modules/wms/acl.ts:2-11` — `wms.view`, `wms.manage_warehouses`, `wms.manage_zones`, `wms.manage_locations`, `wms.manage_inventory`, `wms.manage_reservations`, **`wms.adjust_inventory` ("Adjust and move inventory")**, `wms.receive_inventory`, `wms.cycle_count`, `wms.import`.
- `GET /api/wms/inventory/movements` and `GET /api/wms/locations` require only `wms.view` (`api/inventory/movements/route.ts:16-18`; `api/locations/route.ts:14`).

### 5.8 Capacity — **not enforced**

`capacityUnits` / `capacityWeight` exist on the entity (`data/entities.ts:156-160`) and in the location create/update schema (`validators.ts:82-83`). `grep -rn "capacity" node_modules/@open-mercato/core/src/modules/wms/commands/` returns hits **only** in `commands/configuration.ts` (`:243-244, :474-475, :1342-1343, :1356-1357, :1382-1383, :1452-1453`) — i.e. location CRUD. **No inventory mutation command reads capacity.** The #50 decision to put capacity out of scope matches the installed behavior exactly; nothing is being weakened.

### 5.9 Useful read APIs for "computed current location"

- `GET /api/wms/inventory/movements` (`api/inventory/movements/route.ts`) — `wms.view`; filters `warehouseId`, `catalogVariantId`, `lotId`, `referenceType`, `referenceId`, `type`, and `locationId` matching **either** `location_from_id` or `location_to_id` (`:66-82`); returned fields include `location_from_id`, `location_to_id`, `type`, `reference_type`, `reference_id`, `performed_at`, `received_at` (`:34-55`); sortable by `performedAt` (`:61`); `afterList` attaches warehouse/location/variant labels (`:102-110`). Query schema `inventoryMovementListQuerySchema` (`validators.ts:192-203`) caps `pageSize` at 100.
- `GET /api/wms/inventory/balances` — already used by the panel; returns `location_id` and `location_code` per bucket (consumed at `src/modules/warehouseman/lib/productScan.ts:15-21`, fetched at `src/modules/warehouseman/lib/productScanApi.ts:38-55`).
- `GET /api/wms/locations?type=staging` — supported (`api/locations/route.ts:30, :74`).

---

## 6. How a new app module is registered

### 6.1 The registry

`src/modules.ts` — `export type ModuleEntry = { id: string; from?: '@open-mercato/core' | '@app' | string }` (`:6`) and `export const enabledModules: ModuleEntry[]` (`:8`). App modules use `from: '@app'`: `label_printing` (`:28`), `catalog_fixtures` (`:31`), `barcode_scanner` (`:32`), `pz_fixtures` (`:36`), `wms_fixtures` (`:41`), then pushed after the enterprise block: `procurements` (`:68`), `pz` (`:69`), `warehouseman` (`:70`).

**Order matters** — the file says so at `:38-41` (*"Keep last: setup hooks run in this list's order"*). A new `pallets` module must come **before** `pz` if `pz`'s setup depends on it, and after `wms`/`catalog`.

### 6.2 Discovery files the generator picks up (evidence from the generated registry)

`.mercato/generated/modules.generated.ts:572-592` shows exactly which `pz` files are wired:
`index.ts` (`:572`), `acl.ts` (`:573`), `events.ts` (`:574`), `setup.ts` (`:575`), every `backend/**/page.meta.ts` (`:576-579`), every `api/**/route.ts` (`:580-590`), `i18n/en.json` + `i18n/pl.json` (`:591-592`).
Commands are discovered separately into `.mercato/generated/command-loaders.generated.ts` (`:1502-1596`), keyed `"<module>:commands:<file>"`.
Entities are compiled into `.mercato/generated/entities.generated.mjs` (`:34` = `// src/modules/pz/data/entities.ts`) and ids into `.mercato/generated/entities.ids.generated.ts:186-190`, plus a per-entity field dir `.mercato/generated/entities/<entity>/index.ts`.

### 6.3 Structural templates

**Smallest complete module — `barcode_scanner`** (`src/modules/barcode_scanner/`): `index.ts` (metadata only, `:3-10`), `backend/catalog/scan/{page.meta.ts,page.tsx}`, `components/BarcodeScannerDialog.tsx`, `lib/*.ts`, `__tests__/*.ts`, `i18n/{de,en,es,ko,pl}.json`, `README.md`. No entities, no commands, no ACL.

**Module with DI + ACL + injected widget — `label_printing`**: `index.ts` (`:3-10`), `acl.ts` (`:1-9`, single feature `label_printing.print`), `di.ts` (`register(container)` with `asFunction(...).singleton()`, `:35-41`, token exported as a const at `:10`), `api/print-label/route.ts`, `widgets/injection-table.ts` (`export const injectionTable: ModuleInjectionTable` keyed by a frozen host id, `:12-17`) + `widgets/injection/<id>/widget.ts`, `lib/*.ts`, `testing/fakeSerialTransport.ts`, `i18n/{en,pl}.json`, `__tests__/*`.

**Module with entities + commands + migrations + CRUD API — `pz` itself** is the template a `pallets` module should copy: `index.ts`, `acl.ts`, `setup.ts`, `events.ts`, `data/entities.ts`, `data/validators.ts`, `commands/*.ts`, `api/<resource>/route.ts` with `makeCrudRoute` + per-method `metadata` + `openApi`, `migrations/`, `i18n/{en,pl}.json`, `lib/`, `__tests__/`, `__integration__/`.

**Module with a widget injecting into the framework sidebar — `warehouseman`**: `widgets/injection-table.ts` + `widgets/injection/panel-link-menu/widget.ts`, and `ce.ts` declaring custom fields on an installed entity (`src/modules/warehouseman/ce.ts:11-19`).

**Module with a `requires` declaration — `pz_fixtures`**: `metadata.requires = ['pz','catalog','wms']` (`src/modules/pz_fixtures/index.ts:14`), plus `cli.ts` for a CLI-only seeder.

### 6.4 The written contract (`.ai/guides/contracts.md`)

Directly relevant lines for a `pallets` module:
- `:7` entities together in `src/modules/<id>/data/entities.ts`, decorators from `@mikro-orm/decorators/legacy`.
- `:8` tenant/org columns + composite index; **scope derived from authenticated context, never request payloads**.
- `:9` new user-editable rows carry `updated_at`, returned as `updatedAt`.
- `:10` UUID PKs, **explicit scalar FK IDs**, module-prefixed plural table names, **no cross-module ORM relations**.
- `:14-21` migration workflow: entity change → `yarn generate` → `yarn db:generate` as a *probe* → review every statement and update `.snapshot-open-mercato.json` → never edit a shipped migration → **ask before `yarn db:migrate`**.
- `:25-36` CRUD route contract (`makeCrudRoute`, per-method `metadata`, `list` with colon-form `entityId`, `actions.{create,update,delete}` naming command ids, `indexer`, separate `openApi` export).
- `:42-47` commands own domain mutations; command-level optimistic locking for action endpoints; `withAtomicFlush(..., { transaction: true })`; **"Make retries and idempotency explicit. Do not advance external cursors, one-time keys, or recovery state until the durable unit of work commits."**
- `:56-60` optimistic-lock UI contract.
- `:64-68` ACL/setup.
- `:72-78` cross-module mechanism table — *Durable historical reference → Scalar ID plus snapshot*; *Side effect after another module changes → Typed event + subscriber owned by the optional consumer*.
- `:90-92` frozen surfaces.

---

## 7. Repo conventions for this work

### 7.1 `CONTEXT.md` — the Pallet entry to be rewritten

`CONTEXT.md:84-87`, verbatim:
```
**Pallet**:
A carrier the goods of one Goods Receipt are counted onto, identified by its own barcode.
It belongs to that document and cannot outlive it.
_Avoid_: Palette, unit, handling unit, container, LPN
```
Neighbours that will need re-reading against the change: **Pallet Line** (`:89-92`), **Close** (`:94-96`), **Surplus** (`:98-100`), **Receiving** (`:74-77`), **Release** (`:79-82`), **Confirm** (`:61-65`). The file's own framing: *"This glossary covers the vocabulary the app itself owns; terms defined by installed Open Mercato modules (User, Role, Tenant, Organization, Warehouse) keep their upstream meaning and are not redefined here."* (`CONTEXT.md:3-5`).

`docs/agents/domain.md:43` requires output to use glossary vocabulary, and `:49-51` requires an ADR contradiction to be surfaced explicitly (*"Contradicts ADR-0007 …, but worth reopening because…"*).

### 7.2 `docs/adr/` numbering and format

Files are `NNNN-kebab-title.md`. **The current numbering has a collision: two ADRs are numbered 0012** —
`docs/adr/0012-a-scan-names-a-product-a-confirmation-step-names-the-amount.md` and `docs/adr/0012-the-wms-menu-reaches-the-panel-in-a-new-tab.md`.
So the highest used number is 0012 (twice) and **the next free number is 0013**.

Full list: 0001 warehouseman-panel-is-its-own-route-namespace · 0002 assigned-warehouse-is-a-custom-field-on-the-user · 0003 panel-access-is-enforced-by-installed-route-metadata · 0004 goods-receipts-live-in-their-own-app-module · 0005 goods-receipts-are-record-only · 0006 confirmed-goods-receipts-are-immutable · 0007 goods-receipt-lines-reference-catalog-variants · 0008 receiving-is-a-status-of-the-goods-receipt · 0009 actual-counts-live-on-pallets-never-on-lines · 0010 pallets-are-identified-by-an-organization-unique-barcode · 0011 a-repeated-scan-counts-again-only-after-the-code-leaves-the-frame · 0012 ×2.

**Format** (no front matter, no Status/Context/Decision headings): an `# ` H1 written as a full sentence stating the decision, then 2–4 prose paragraphs giving the reasoning *and* the rejected alternatives, then a `## Consequences` section of bullets. Examples: `docs/adr/0009-actual-counts-live-on-pallets-never-on-lines.md:1-23` (title `:1`, body `:3-13`, `## Consequences` `:15`, bullets `:17-23`); `docs/adr/0012-the-wms-menu-reaches-the-panel-in-a-new-tab.md:1-36` (rejected options stated inline at `:23-25`).

ADRs that this work will contradict or supersede: **ADR-0009** (`:1` *"Actual counts live on pallets and never touch goods receipt lines"* — its premise is per-document counting), the `Pallet` glossary entry, and — once anything posts stock — **ADR-0005** (`docs/adr/0005-goods-receipts-are-record-only.md:4-7`), whose `:9-13` already writes the intended #54 recipe verbatim: *"adding a subscriber that calls `wms.inventory.receive` per line with `referenceType: 'manual'` and `referenceId` set to the goods receipt id — without touching this module. Upstream anticipates this: `wms` ships a default-off toggle `wms_integration_procurement_goods_receipt` reserved for it."*

### 7.3 `.ai/specs/` conventions

`.ai/specs/README.md`: naming `{YYYY-MM-DD}-{slug}.md` (`:19-20`); what belongs (new domain features, data-model decisions, API contracts, integration design) `:7-10`; workflow `:24-27` — route through `om-spec-writing` + `.ai/guides/spec-delivery.md`, create the skeleton from `SPEC-000-template.md`, keep `Draft` while blocking questions remain, set `Ready for implementation` only after the compliance report, traceability pass **and user approval**, then implement via `om-implement-spec` / `om-auto-implement-spec` one dependency-ordered phase at a time.

`SPEC-000-template.md` header: `# {Title}` `:1`, `**Date**: {YYYY-MM-DD}` `:3`, `**Status**: Draft` `:4`, an instruction blockquote `:6` (*"Keep every section below; write `N/A — {reason}` when a section does not apply"*). Sections in order: TLDR `:8`, Problem Statement `:12`, Overview and Success Measures `:16`, Goals with `REQ-00N` ids `:23-26`, Non-goals `:28`, Proposed Solution `:32` + Design Decisions and Alternatives table `:36-40`, Domain Vocabulary and Business Rules `:42-48`, Users/Permissions/Scope `:50-56`, Reuse and Ownership Map `:58-64`, Architecture and Data Flow `:66-76`, User Journeys `:78-80`, and further sections beyond line 80.

Existing specs: `2026-08-06-reference-module-activation.md`, `2026-09-19-goods-receiving.md` (65 KB — the closest structural precedent, incl. an API-change table at `:475` and a test matrix at `:539`), `2026-09-19-purchasing-inbound-ui-proposal.md`, and the untracked `2026-09-19-pallet-putaway.md`.

### 7.4 `docs/agents/*`

- `docs/agents/issue-tracker.md` — GitHub via `gh`; read `gh issue view <n> --comments` (`:8`, `:34`); `#42` may be a PR or an issue (`:26`); never auto-write without the conventions at `:7-12`.
- `docs/agents/triage-labels.md:5-11` — the five canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- `docs/agents/domain.md` — read `CONTEXT.md` + `docs/adr/` before exploring (`:7-9`), use glossary vocabulary (`:43`), flag ADR conflicts explicitly (`:49-51`).

### 7.5 Lessons

`.ai/lessons.md` is a catalog (`:3`) with an add/update protocol (`:24-31`), including *"Run `node scripts/check-lessons.mjs` before committing"* (`:31`). The directly relevant record is `.ai/lessons/pz-counting-is-not-stock-posting.md`; its front matter is `modules: ["pz","warehouseman","wms"]`, `areas: ["framework-context"]` (`:3-4`). Its transaction-mapping paragraph (`:18`) is the primary-source-checked summary of exactly what §5 re-verifies here.

---

## 8. The warehouseman panel UI

### 8.1 Shell and layout vocabulary

`src/modules/warehouseman/components/PanelShell.tsx` — chrome for every panel screen: `PANEL_LOGIN_PATH = '/warehouseman/login'` (`:11`), props `{ userLabel, warehouseName, titleKey, backHref, backLabelKey }` (`:13-21`), composes `PanelSurface`/`PanelTopBar`/`PanelBody` (`:60-88`), and renders a sign-out failure as an `Alert status="error"` rather than navigating away (`:46-51`, `:81-85`).

`src/modules/warehouseman/components/PanelUI.tsx` — the panel's design tokens and primitives, all shadcn underneath (`:10-14`):
- `PANEL_ACTION = 'h-20 w-full text-xl font-semibold md:w-auto md:px-8'` (`:17`) — *"Every tappable control on the panel is at least this tall."* (`:16`)
- `PANEL_PRIMARY` (`:19`); `PanelSurface` (`:21-30`, stamps `data-om-panel="warehouseman"`); `PanelTopBar` (`:40-59`, sticky, back `IconButton asChild` with `aria-label`); `PanelBody` (`:61-67`); `PanelFooter` (`:73-79`, sticky-bottom on handheld, static on `md:`); `PanelCard` (`:81-83`); `SectionLabel` (`:85-92`); `ProgressStrip` (`:245-252`); `StatTile` with `tone: 'neutral' | 'error' | 'success'` (`:254-276`).
- **`ScanField` (`:94-175`) is the HID-scanner pattern**: *"A handheld scanner types the code and ends with Enter, so the field is a form of its own and the button beside it is for the times the scanner is on its charger."* (`:110-113`). It is a real `<form onSubmit>` with `preventDefault` (`:129-135`), `React.useId()`-linked label (`:127`, `:136-144`), `autoComplete="off"` (`:151`), `h-20` mono input (`:154-155`), and when `onCamera` is supplied the adjacent button becomes the camera and an explicit submit button is added below (`:157-172`) — *"typing stays the path that works without a secure context"* (`:104-105`).
- `QtyStepper` (`:177-242`): ±1 buttons sized `size-20`, `inputMode="decimal"`, stepping floors a typed decimal (`:200-204`).

### 8.2 `PanelHome.tsx`

`src/modules/warehouseman/components/PanelHome.tsx` — a `<nav aria-label>` of four tiles (`:31-32`), `ACTIONS` declared as data (`:13-18`): receiving (primary), `/warehouseman/scan`, `/warehouseman/transfer`, `/warehouseman/stocktake`. The receiving tile carries a badge fed by one `useQuery` (`:24-28`), with the stated degradation *"A failure leaves the tile unbadged, not broken."* (`:22-23`); the count has an `sr-only` suffix (`:49`). Tiles are `h-44`, `size-11` icons, `focus-visible:shadow-focus` (`:36-42`).
**A putaway entry point would be a fifth `PanelAction` here.**

### 8.3 `ReceivingPallets.tsx` — the scan-to-open pattern

`src/modules/warehouseman/components/ReceivingPallets.tsx` (328 lines):
- Status → badge variant map at module scope: `PALLET_STATUS_VARIANTS: Record<PalletStatus, StatusBadgeVariant> = { open: 'info', closed: 'success' }` (`:37-40`) — status colors are never hard-coded inline.
- `useQuery` for document and pallets (`:64-71`); `useMutation` for create (`:73-103`) and delete (`:105-109`), invalidating `['warehouseman.receiving.pallets', receiptId]`.
- **One lookup shared by keyboard and camera**: `openPalletByCode` (`:116-145`) — *"A typed code and a code read off a printed label meet here, so the camera can never open a pallet the keyboard would have refused"* (`:111-115`).
- **Re-entrancy guard is a ref, not state**: `lookupInFlight = React.useRef(false)` (`:62`) — *"The camera fires `onDetected` on every frame it decodes, so the guard has to be read synchronously"* (`:60-61`). Same pattern in `ReceivingCount.tsx:113` (`countInFlight`) and `:116` (`scannerOpenRef`).
- Print is an explicitly **post-commit** effect that can only warn, never fail the pallet (`:76-86`), and the outcome is stashed to travel with the navigation (`stashPalletLabelNotice`, `:90-98`).
- States: loading `ScreenMessage` (`:183`), error `ScreenError` + a back link (`:185-194`), empty `ScreenEmpty` (`:234-238`), inline `scanError`/`actionError` (`:229-230`).
- Destructive action goes through `useConfirmDialog` (`:53`, `:172-181`).
- Camera fallback: `BarcodeScannerDialog` from `@/modules/barcode_scanner` (`:13`, `:307-318`) with `busy`, `statusMessage`, `errorMessage` and localized title/description/manual-entry labels.

### 8.4 `ReceivingCount.tsx` — the count screen

`src/modules/warehouseman/components/ReceivingCount.tsx` (740 lines). Header comment `:76-85`: *"A handheld scanner types the barcode and ends with Enter, so the form submits on Enter and the barcode field takes focus back after every submit — including a failed one… The phone camera is the same count by another route… both meet in `countByBarcode`."*
- `barcodeRef` for focus return (`:91`); `SCAN_LOG_LIMIT = 10` (`:62`); `DEFAULT_QUANTITY = '1'` (`:74`); `PendingScan = { catalogVariantId; name; code }` (`:69`) — *"It holds the resolved variant rather than the code: re-resolving on confirm would let the answer change between the name the operator read and the line they get."* (`:64-68`).
- State set: `unknownBarcode`, `formError`, `announcement` (live region), `submitting`, `editing`, `rowError`, `labelNotice`, `printing`, `scannerOpen`, `scanStatus`, `scanLog`, `pendingScan` (`:94-110`).
- **404 → open the product picker** (`:288`); **409 → tell the floor the number moved and re-read** (`:369-377`, keyed `warehouseman.receiving.count.conflict`). The server-side 409 text it surfaces is minted at `src/modules/pz/commands/palletLines.ts:129-136`.
- Label notice is consumed once and bound to `palletId` so it can never be read against the wrong pallet (`:102-104`, `:122-125`).

### 8.5 `ScanQuantityStep.tsx` — scan → how many → confirm

`src/modules/warehouseman/components/ScanQuantityStep.tsx`: `COARSE_STEP = 10` (`:11`), props `{ productName, code, busy, error, onConfirm, onCancel }` (`:13-24`). Rationale `:26-38`: *"The question between a scan and a count: how many of these? … Everything here is sized for a warehouse glove… There is no way to scan past this: `BarcodeScannerDialog` accepts nothing while it is up."* Starts at `MIN_SCAN_QUANTITY` (`:50`), moves focus to the confirm button on mount (`:56-58`), holds typed entry as a string mid-edit (`:65-70`). This is ADR-0012 (`docs/adr/0012-a-scan-names-a-product-a-confirmation-step-names-the-amount.md`).

### 8.6 Shared state components

`src/modules/warehouseman/components/ReceivingStates.tsx`: `ScreenMessage` (`role="status"` + spinner, `:10-17`), `ScreenError` (`Alert status="error"`, `:19-25`), **`ScreenWarning`** (`:31-37`, *"The work went through and something alongside it did not… Deliberately not `ScreenError`: nothing here has to be redone."* `:27-30`), `ScreenEmpty` (`:39-47`), `PanelLinkButton` (`:50-67`, *"Every panel target is a glove target, link or not."*).

### 8.7 Pure helpers worth reusing

`src/modules/warehouseman/lib/receivingPanel.ts`: href builders (`:4-16`), `WarehouseFilter = string | null` with the note that the Assigned Warehouse is *"a filter and never a gate (ADR-0002)"* (`:18-23`), `normalizeScannedCode` (*"A handheld scanner appends its own whitespace and a terminating newline."* `:31-34`), `parseCountQuantity` / `resolveCountQuantity` / `formatCountQuantity` at `numeric(18,4)` scale (`:37-81`), `adjustScanQuantity` clamping at 1 (`:86-97`), `resolveApiMessage` (*"Every `pz` refusal carries an already-localized `error`"* `:100-109`), `productLabel` (`:111-118`), `describePalletPrintOutcome` (`:154-181`) and `describePalletLookupFailure` (`:183-196`).

`src/modules/warehouseman/lib/productScan.ts` is the closest existing precedent for **computing a location from WMS reads**: `InventoryBalanceRow` with `location_id`/`location_code` (`:15-21`), `StockLocation`/`StockSummary` (`:23-38`), `foldIntoLocations` (`:63-73`), deterministic tie-break `compareByWhereToWalk` (`:82-88`), `summarizeStock` (`:99-113`). Fetch side: `src/modules/warehouseman/lib/productScanApi.ts:38-55` — reads `/api/wms/inventory/balances` **under the caller's own scope**, explicitly noting *"a Warehouseman holds `wms.view`, which is what gates it, so nothing here widens what they may see"* (`:34-37`).

### 8.8 i18n

`src/modules/warehouseman/i18n/en.json` and `pl.json` are flat dotted-key JSON, **157 keys each, exactly in sync** (verified by key count). Keys are namespaced `warehouseman.<area>.<thing>`, e.g. `warehouseman.actions.receiving`, `warehouseman.panel.pendingDocuments`, `warehouseman.receiving.count.added` with `{product}`/`{quantity}` interpolation. `pz` owns `pz.pallets.*` / `pz.receiving.*` in `src/modules/pz/i18n/{en,pl}.json`. The repo has `yarn i18n:check-hardcoded` (`package.json`, `scripts.i18n:check-hardcoded`) plus `yarn ds:check`.

### 8.9 Panel ACL and entry point

`src/modules/warehouseman/acl.ts:1-7` — a single feature `warehouseman.panel.access`. The WMS sidebar entry is a headless injection widget (`src/modules/warehouseman/widgets/injection/panel-link-menu/widget.ts`, table at `widgets/injection-table.ts`), keyed by `WAREHOUSEMAN_PANEL_MENU_ITEM_ID = 'warehouseman.panel-link'` and `WAREHOUSEMAN_PANEL_HREF = '/warehouseman'` (`src/modules/warehouseman/lib/panelMenu.ts:9-12`), with the new-tab mechanism documented in `docs/adr/0012-the-wms-menu-reaches-the-panel-in-a-new-tab.md`.

---

## 9. Open gaps / could not verify

1. **Whether #44–#47 were closed as done, superseded or not-planned.** `gh issue view` in this environment does not expose `stateReason` (`gh issue list --json stateReason` errors with *Unknown JSON field*). All four are `CLOSED`; the code shows none of their acceptance criteria implemented (§3). I did **not** read their closing comments. A plan should not assume either reading without checking `gh issue view 44 --comments`.
2. **Issue #50's own body and comment thread.** I worked from the decisions supplied in the task brief plus `.ai/specs/2026-09-19-pallet-putaway.md:78-91`; I did not fetch #50 itself. The "Awizo" vocabulary in #44–#47 does not appear anywhere in the code (the repo instead renamed to "Goods Receipt Orders", commit `a411a50`), so the tracker and the code disagree on vocabulary and I could not reconcile them from source.
3. **Whether any environment holds `pz_pallets` rows worth migrating** (open question Q5 in the spec skeleton). Not answerable from the repo — no database was inspected, and I ran no DB command.
4. **`persistMovementWithIdempotency` → `createMovement` body.** I read the idempotency wrapper (`inventory-actions.ts:831-864`) but not `createMovement` itself, so I have not verified from source whether it stamps `metadata` verbatim or normalizes it. If a plan intends to carry a pallet id in `InventoryMovement.metadata`, verify `createMovement` first.
5. **`resolveScope` semantics when `ctx` and input disagree.** `resolveScope(ctx, input)` is at `inventory-actions.ts:193-201`; I read its signature in the function map but not its body line by line. The `ensureTenantScope`/`ensureOrganizationScope` guards are verified (§5.7), but the precedence of ctx vs. input is not.
6. **Whether `attachLocationLabelsToListItems` puts `location_from_code`/`location_to_code` on movement rows.** `api/inventory/movements/route.ts:106` calls it, but I did not read `api/listEnrichers.ts`, so the exact enriched field names on a movement row are unverified. This matters if a computed current location is to be read via the movements API rather than by id.
7. **Whether the installed `wms` module exposes a subscriber/extension seam this app could mount a putaway UI or guard onto.** I did not read `node_modules/@open-mercato/core/src/modules/wms/extension-points.ts`, `events.ts` or `api/interceptors.ts`.
8. **`src/modules/pz/api/goods-receipts/receiving-summary/route.ts` and `src/modules/pz/components/ReceivingSummary.tsx`.** Listed and known to be imported cross-module (`ReceivingSummaryScreen.tsx:4`) but not read; their response contract is part of the blast radius and is unverified here.
9. **`ReceivingCount.tsx` lines 130–740** were not read in full — only the header, the state declarations and the grep-located 404/409 branches. Other conflict or recovery affordances may exist in the unread region.
10. **The ADR-0012 numbering collision** is a fact of the tree (`docs/adr/` listing), but I did not check git history to learn which came first or whether one is intended to be renumbered. A plan adding an ADR should use **0013** and may want to flag the collision separately.
11. **Nothing was executed.** No `yarn generate`, no `yarn db:generate`, no tests, no dev server. All statements above are from reading files in this worktree, its `node_modules`, and `gh issue view` output.
