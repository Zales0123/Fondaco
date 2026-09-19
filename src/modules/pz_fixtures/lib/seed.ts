import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import {
  buildFixtureReceipts,
  FIXTURE_DOCUMENT_PREFIX,
  type FixtureIntent,
  type FixtureReceipt,
} from './receipts'
import { readFixtureProducts } from './catalog'
import { readWarehouseDefaultStates, readWarehouses } from './warehouses'
import { planDefaultDestinations } from './postingPlan'
import { enableStockPosting, type StockPostingSetupSummary } from './posting'
import type { PzFixtureScope } from './scope'

export type { PzFixtureScope } from './scope'

/** What one planned document turned out to be, for the CLI to report. */
export type SeededDocument = {
  documentNumber: string
  warehouseId: string
  warehouseName: string
  intent: FixtureIntent
  intentSatisfied: boolean
  released: boolean
}

export type SeedReceiptsSummary = {
  planned: number
  created: number
  alreadyPresent: number
  released: number
  failed: { documentNumber: string; reason: string }[]
  /** Null when the operator opted out of the toggle flip with `--no-posting`. */
  posting: StockPostingSetupSummary | null
  documents: SeededDocument[]
}

type ReceiptRow = { id: string; document_number: string; status: string; updated_at: Date }

/**
 * Commands, not a direct ORM write.
 *
 * `pz.goodsReceipts.create` resolves each line against the live catalog, takes the
 * snapshots the document keeps, enforces tenant and organization scope and writes the
 * audit and undo trail. An `em.insert` loop here would produce rows that look right and
 * carry none of that, which is exactly the sort of demo data that misleads later.
 */
function buildCommandContext(
  scope: PzFixtureScope,
  container: AwilixContainer,
  request?: Request,
): CommandRuntimeContext {
  return {
    container,
    request,
    auth: {
      sub: scope.userId ?? undefined,
      tenantId: scope.tenantId,
      orgId: scope.organizationId,
    },
    organizationScope: {
      selectedId: scope.organizationId,
      filterIds: [scope.organizationId],
      allowedIds: [scope.organizationId],
      tenantId: scope.tenantId,
    },
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  } as CommandRuntimeContext
}

/**
 * `pz.goodsReceipts.release` requires the record version in the optimistic-lock header and
 * reads it off `ctx.request`, because every caller it was written for is an HTTP route.
 * A CLI has no request, so one is synthesised carrying only that header rather than
 * relaxing the command's guard for the benefit of fixtures.
 */
function lockRequest(updatedAt: Date): Request {
  return new Request('http://pz-fixtures.local/release', {
    headers: { [OPTIMISTIC_LOCK_HEADER_NAME]: updatedAt.toISOString() },
  })
}

async function readExistingFixtures(em: EntityManager, scope: PzFixtureScope): Promise<Map<string, ReceiptRow>> {
  const rows = (await em.getConnection().execute(
    `select id, document_number, status, updated_at
       from pz_goods_receipts
      where tenant_id = ? and organization_id = ? and deleted_at is null
        and document_number like ?`,
    [scope.tenantId, scope.organizationId, `${FIXTURE_DOCUMENT_PREFIX}%`],
  )) as ReceiptRow[]
  return new Map(rows.map((row) => [row.document_number, row]))
}

export async function seedGoodsReceipts(
  em: EntityManager,
  container: AwilixContainer,
  scope: PzFixtureScope,
  options: { release?: number; enablePosting?: boolean } = {},
): Promise<SeedReceiptsSummary> {
  const warehouses = await readWarehouses(em, scope)
  if (warehouses.length === 0) throw new Error('No active warehouse in scope. Seed wms first.')

  const products = await readFixtureProducts(em, container, scope)
  if (products.length === 0) throw new Error('No stockable catalog product in scope. Seed the catalog first.')

  // Posting is set up before the documents are planned, not after: which Warehouses can be
  // posted into is what decides where the postable document goes, and the same read answers
  // both questions. Opting out skips the writes, never the read — a document promising to be
  // postable still has to land somewhere that can take it.
  const posting = options.enablePosting === false
    ? null
    : await enableStockPosting(em, container, scope, warehouses)
  const destinations = posting?.destinations
    ?? planDefaultDestinations(await readWarehouseDefaultStates(em, container, scope, warehouses))
  const eligibleByWarehouse = new Map(destinations.map((plan) => [plan.warehouseId, plan.eligibleCount > 0]))
  const nameByWarehouse = new Map(warehouses.map((warehouse) => [String(warehouse.id), warehouse.name]))

  const planned = buildFixtureReceipts(
    warehouses.map((warehouse) => ({
      id: String(warehouse.id),
      hasEligibleDestination: eligibleByWarehouse.get(String(warehouse.id)) === true,
    })),
    products.map((product) => ({ id: product.id, tracked: product.tracked, receivable: product.receivable })),
  )
  const existing = await readExistingFixtures(em, scope)
  const commandBus = container.resolve('commandBus') as CommandBus

  const summary: SeedReceiptsSummary = {
    planned: planned.length,
    created: 0,
    alreadyPresent: 0,
    released: 0,
    failed: [],
    posting,
    documents: planned.map((receipt) => ({
      documentNumber: receipt.documentNumber,
      warehouseId: receipt.warehouseId,
      warehouseName: nameByWarehouse.get(receipt.warehouseId) ?? receipt.warehouseId,
      intent: receipt.intent,
      intentSatisfied: receipt.intentSatisfied,
      released: false,
    })),
  }

  const createdIds: { id: string; documentNumber: string }[] = []
  for (const receipt of planned) {
    if (existing.has(receipt.documentNumber)) {
      summary.alreadyPresent += 1
      continue
    }
    try {
      const { result } = await commandBus.execute<Record<string, unknown>, { id: string }>(
        'pz.goodsReceipts.create',
        { input: toCreateInput(receipt), ctx: buildCommandContext(scope, container) },
      )
      createdIds.push({ id: String(result.id), documentNumber: receipt.documentNumber })
      summary.created += 1
    } catch (error) {
      summary.failed.push({
        documentNumber: receipt.documentNumber,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const releaseTarget = Math.max(0, Math.min(options.release ?? 0, createdIds.length))
  for (const created of createdIds.slice(0, releaseTarget)) {
    try {
      // Re-read rather than reuse the create result: the release guard compares against the
      // stored `updated_at`, and the value the create returned is the one it must match.
      const [row] = (await em.getConnection().execute(
        'select updated_at from pz_goods_receipts where id = ? and tenant_id = ? and organization_id = ?',
        [created.id, scope.tenantId, scope.organizationId],
      )) as { updated_at: Date }[]
      if (!row) continue
      await commandBus.execute(
        'pz.goodsReceipts.release',
        { input: { id: created.id }, ctx: buildCommandContext(scope, container, lockRequest(new Date(row.updated_at))) },
      )
      summary.released += 1
      const document = summary.documents.find((entry) => entry.documentNumber === created.documentNumber)
      if (document) document.released = true
    } catch (error) {
      summary.failed.push({
        documentNumber: created.documentNumber,
        reason: `release failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return summary
}

function toCreateInput(receipt: FixtureReceipt): Record<string, unknown> {
  return {
    documentNumber: receipt.documentNumber,
    documentDate: receipt.documentDate,
    supplierName: receipt.supplierName,
    warehouseId: receipt.warehouseId,
    lines: receipt.lines.map((line) => ({
      catalogProductId: line.catalogProductId,
      quantity: line.quantity,
    })),
  }
}
