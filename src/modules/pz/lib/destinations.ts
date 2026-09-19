/**
 * The `wms` reads confirmation depends on: which Locations a delivery may be posted into,
 * which one the Warehouse preselects, and which counted variants `wms` refuses to receive
 * without a lot or serial number.
 *
 * Everything here goes through the query engine or the installed custom-field loader under
 * the caller's trusted scope. This module holds no ORM relation into `wms` (ADR-0004), and
 * the decisions made from these reads are the pure functions in `stockPosting.ts`.
 */
import type { EntityManager } from '@mikro-orm/postgresql'
import { loadCustomFieldValues } from '@open-mercato/shared/lib/crud/custom-fields'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { FeatureTogglesService } from '@open-mercato/core/modules/feature_toggles/lib/feature-flag-check'
import { resolveWmsIntegrationToggleEnabled } from '@open-mercato/core/modules/wms/lib/wmsIntegrationToggles'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { DEFAULT_DESTINATION_FIELD_KEY } from './customFields'
import { isEligibleDestination, type DestinationCandidate } from './stockPosting'

export type DestinationScope = { tenantId: string; organizationId: string }

/** A Location the floor may choose, as the picker shows it. */
export type EligibleDestination = {
  id: string
  code: string
  type: string
}

type LocationRow = {
  id: string
  warehouse_id: string | null
  parent_id: string | null
  code: string | null
  type: string | null
  is_active: boolean | null
}

/**
 * Every Location of one Warehouse, in one read: whether a Location has children is a fact
 * about its siblings, so the eligible ones cannot be selected by a filter.
 */
export async function loadWarehouseDestinations(
  queryEngine: QueryEngine,
  scope: DestinationScope,
  warehouseId: string,
): Promise<EligibleDestination[]> {
  const result = await queryEngine.query<LocationRow>(E.wms.warehouse_location, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['id', 'warehouse_id', 'parent_id', 'code', 'type', 'is_active'],
    filters: { warehouse_id: warehouseId },
    page: { page: 1, pageSize: 1000 },
  })

  const parents = new Set(
    result.items
      .map((row) => (typeof row.parent_id === 'string' ? row.parent_id : null))
      .filter((value): value is string => Boolean(value)),
  )
  const candidates: DestinationCandidate[] = result.items.map((row) => ({
    id: String(row.id),
    code: row.code ?? String(row.id),
    type: row.type ?? '',
    warehouseId: String(row.warehouse_id ?? ''),
    isActive: row.is_active !== false,
    hasChildren: parents.has(String(row.id)),
  }))

  return candidates
    .filter((candidate) => isEligibleDestination(candidate, warehouseId))
    .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0))
    .map(({ id, code, type }) => ({ id, code, type }))
}

/**
 * The Warehouse's configured Default Destination, or nothing. It is only a preselection:
 * the caller validates it against the eligible Locations exactly as it validates a Location
 * somebody picked by hand, so a stale or foreign value simply preselects nothing.
 */
export async function readDefaultDestinationId(
  em: EntityManager,
  scope: DestinationScope,
  warehouseId: string,
): Promise<string | null> {
  const values = await loadCustomFieldValues({
    em,
    entityId: E.wms.warehouse,
    recordIds: [warehouseId],
    tenantIdByRecord: { [warehouseId]: scope.tenantId },
    organizationIdByRecord: { [warehouseId]: scope.organizationId },
    tenantFallbacks: [scope.tenantId],
  })
  // The loader answers under the `cf_` prefixed key, not the bare field key.
  const raw = values[warehouseId]?.[`cf_${DEFAULT_DESTINATION_FIELD_KEY}`]
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

type InventoryProfileRow = {
  catalog_variant_id: string | null
  track_lot: boolean | null
  track_serial: boolean | null
}

/**
 * The counted variants `wms` will not receive from us. `wms.inventory.receive` throws when a
 * variant's inventory profile tracks lots or serial numbers and neither is supplied, and this
 * module captures neither, anywhere — so a delivery containing one cannot be posted and must
 * be refused before the confirmation becomes irreversible (ADR-0011).
 *
 * `wms` resolves a profile by variant only, with no product-level fallback, so this read
 * matches its rule exactly rather than approximating it.
 */
export async function loadTrackedVariantIds(
  queryEngine: QueryEngine,
  scope: DestinationScope,
  catalogVariantIds: readonly string[],
): Promise<Set<string>> {
  const unique = Array.from(new Set(catalogVariantIds))
  if (unique.length === 0) return new Set()

  const result = await queryEngine.query<InventoryProfileRow>(E.wms.product_inventory_profile, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['catalog_variant_id', 'track_lot', 'track_serial'],
    filters: { catalog_variant_id: { $in: unique } },
    page: { page: 1, pageSize: unique.length },
  })

  return new Set(
    result.items
      .filter((row) => row.track_lot === true || row.track_serial === true)
      .map((row) => String(row.catalog_variant_id)),
  )
}

export const STOCK_POSTING_TOGGLE = 'wms_integration_procurement_goods_receipt' as const

/**
 * Whether confirming posts stock at all. The toggle is the one `wms` ships for this exact
 * integration and it defaults to off (ADR-0005).
 *
 * An unreadable toggle answers "off". `wms` is an optional peer, and the alternative —
 * assuming posting is on when we cannot tell — would move stock in an installation that
 * never asked for it.
 */
export async function isStockPostingEnabled(
  resolve: <T = unknown>(name: string) => T,
  tenantId: string,
): Promise<boolean> {
  try {
    return await resolveWmsIntegrationToggleEnabled(
      resolve<FeatureTogglesService>('featureTogglesService'),
      resolve<EntityManager>('em'),
      STOCK_POSTING_TOGGLE,
      tenantId,
    )
  } catch {
    return false
  }
}
