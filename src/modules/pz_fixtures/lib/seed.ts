import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import { buildFixtureReceipts, FIXTURE_DOCUMENT_PREFIX, type FixtureReceipt } from './receipts'

export type PzFixtureScope = {
  tenantId: string
  organizationId: string
  userId?: string | null
}

export type SeedReceiptsSummary = {
  planned: number
  created: number
  alreadyPresent: number
  released: number
  failed: { documentNumber: string; reason: string }[]
}

type WarehouseRow = { id: string; name: string }
type ProductRow = { id: string; title: string | null }
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

async function readWarehouses(em: EntityManager, scope: PzFixtureScope): Promise<WarehouseRow[]> {
  return (await em.getConnection().execute(
    `select id, name
       from wms_warehouses
      where tenant_id = ? and organization_id = ? and deleted_at is null and is_active = true
      order by name asc, id asc`,
    [scope.tenantId, scope.organizationId],
  )) as WarehouseRow[]
}

/**
 * Only products that can physically arrive. The catalog example seed ships two services
 * billed by the hour, and a goods receipt for a haircut would be nonsense on a screen whose
 * whole job is comparing what was ordered against what turned up on a pallet.
 */
async function readStockableProducts(em: EntityManager, scope: PzFixtureScope): Promise<ProductRow[]> {
  return (await em.getConnection().execute(
    `select id, title
       from catalog_products
      where tenant_id = ? and organization_id = ? and deleted_at is null
        and coalesce(default_unit, '') not in ('hour', 'h', 'godz')
      order by title asc nulls last, id asc`,
    [scope.tenantId, scope.organizationId],
  )) as ProductRow[]
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
  options: { release?: number } = {},
): Promise<SeedReceiptsSummary> {
  const warehouses = await readWarehouses(em, scope)
  if (warehouses.length === 0) throw new Error('No active warehouse in scope. Seed wms first.')

  const products = await readStockableProducts(em, scope)
  if (products.length === 0) throw new Error('No stockable catalog product in scope. Seed the catalog first.')

  const planned = buildFixtureReceipts(warehouses, products)
  const existing = await readExistingFixtures(em, scope)
  const commandBus = container.resolve('commandBus') as CommandBus

  const summary: SeedReceiptsSummary = {
    planned: planned.length,
    created: 0,
    alreadyPresent: 0,
    released: 0,
    failed: [],
  }

  const createdIds: string[] = []
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
      createdIds.push(String(result.id))
      summary.created += 1
    } catch (error) {
      summary.failed.push({
        documentNumber: receipt.documentNumber,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const releaseTarget = Math.max(0, Math.min(options.release ?? 0, createdIds.length))
  for (const id of createdIds.slice(0, releaseTarget)) {
    try {
      // Re-read rather than reuse the create result: the release guard compares against the
      // stored `updated_at`, and the value the create returned is the one it must match.
      const [row] = (await em.getConnection().execute(
        'select updated_at from pz_goods_receipts where id = ? and tenant_id = ? and organization_id = ?',
        [id, scope.tenantId, scope.organizationId],
      )) as { updated_at: Date }[]
      if (!row) continue
      await commandBus.execute(
        'pz.goodsReceipts.release',
        { input: { id }, ctx: buildCommandContext(scope, container, lockRequest(new Date(row.updated_at))) },
      )
      summary.released += 1
    } catch (error) {
      summary.failed.push({
        documentNumber: id,
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
