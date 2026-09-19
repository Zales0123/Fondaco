import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import {
  ASSIGNMENTS,
  CYCLE_COUNTS,
  LOCATIONS,
  LOTS,
  MOVES,
  PROFILES,
  RECEIPTS,
  RESERVATIONS,
  WAREHOUSES,
  ZONES,
} from './data'

export type WmsFixtureScope = { tenantId: string; organizationId: string }

export type WmsFixtureSummary = {
  skipped: boolean
  reason?: string
  warehouses: number
  zones: number
  locations: number
  profiles: number
  lots: number
  receipts: number
  moves: number
  reservations: number
  cycleCounts: number
  assignments: number
  warnings: string[]
}

type VariantRef = { id: string; productId: string; sku: string }

function emptySummary(): WmsFixtureSummary {
  return {
    skipped: false,
    warehouses: 0,
    zones: 0,
    locations: 0,
    profiles: 0,
    lots: 0,
    receipts: 0,
    moves: 0,
    reservations: 0,
    cycleCounts: 0,
    assignments: 0,
    warnings: [],
  }
}

function daysFromNow(days: number): Date {
  const date = new Date()
  date.setUTCHours(9, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + days)
  return date
}

/**
 * Trusted, non-interactive command context. `organizationScope` stays null so
 * `ensureOrganizationScope` takes its system/worker branch and validates against
 * `selectedOrganizationId`; `auth` carries a real actor so audit log rows and
 * `resolveScope(ctx)` lookups inside the wms commands resolve to this tenant.
 */
function buildCommandContext(
  container: AwilixContainer,
  scope: WmsFixtureScope,
  actorUserId: string,
): CommandRuntimeContext {
  return {
    container,
    auth: {
      sub: actorUserId,
      tenantId: scope.tenantId,
      orgId: scope.organizationId,
      roles: ['admin'],
    },
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    request: undefined,
    systemActor: true,
  }
}

// Cross-module reads are id-only lookups by design: AGENTS.md forbids ORM
// relations across module boundaries, and the wms module itself reads catalog
// variants the same way (see lib/loadOperationalDashboard.ts).
async function resolveVariantsBySku(em: EntityManager, scope: WmsFixtureScope): Promise<Map<string, VariantRef>> {
  const rows = (await em.getConnection().execute(
    `select id, sku, product_id from catalog_product_variants
     where organization_id = ? and tenant_id = ? and deleted_at is null and sku is not null`,
    [scope.organizationId, scope.tenantId],
  )) as Array<{ id: string; sku: string; product_id: string }>
  const map = new Map<string, VariantRef>()
  for (const row of rows) {
    if (row.id && row.sku && row.product_id) {
      map.set(row.sku, { id: row.id, productId: row.product_id, sku: row.sku })
    }
  }
  return map
}

async function resolveOrdersByNumber(em: EntityManager, scope: WmsFixtureScope): Promise<Map<string, string>> {
  const rows = (await em.getConnection().execute(
    `select id, order_number from sales_orders
     where organization_id = ? and tenant_id = ? and deleted_at is null`,
    [scope.organizationId, scope.tenantId],
  )) as Array<{ id: string; order_number: string }>
  const map = new Map<string, string>()
  for (const row of rows) {
    if (row.id && row.order_number) map.set(row.order_number, row.id)
  }
  return map
}

async function resolveActorUserId(em: EntityManager, scope: WmsFixtureScope): Promise<string | null> {
  const rows = (await em.getConnection().execute(
    `select id from users
     where tenant_id = ? and deleted_at is null
     order by created_at asc, id asc limit 1`,
    [scope.tenantId],
  )) as Array<{ id: string }>
  return rows[0]?.id ?? null
}

async function warehouseCodesInUse(em: EntityManager, scope: WmsFixtureScope): Promise<Set<string>> {
  const rows = (await em.getConnection().execute(
    `select code from wms_warehouses
     where organization_id = ? and tenant_id = ? and deleted_at is null`,
    [scope.organizationId, scope.tenantId],
  )) as Array<{ code: string }>
  return new Set(rows.map((row) => row.code))
}

/**
 * Loads the WMS demo dataset for one tenant/organization.
 *
 * Everything goes through the command bus rather than the ORM: inventory
 * balances, movements and reservations are a ledger whose invariants (movement
 * idempotency keys, balance-bucket upserts, reservation allocation across
 * buckets) only `wms.inventory.*` maintains. Writing those rows directly is
 * exactly the drift `mercato wms verify-balances` exists to detect.
 *
 * Idempotent: returns early when a fixture warehouse already exists.
 */
export async function seedWmsFixtures(
  em: EntityManager,
  container: AwilixContainer,
  scope: WmsFixtureScope,
): Promise<WmsFixtureSummary> {
  const summary = emptySummary()

  // Not transactional: a mid-run failure leaves the warehouses already created, so this guard
  // makes every later run skip. Recovering needs `yarn dev:reset` or `mercato init --reinstall`
  // rather than simply re-running the seed.
  const existingCodes = await warehouseCodesInUse(em, scope)
  const alreadySeeded = WAREHOUSES.filter((warehouse) => existingCodes.has(warehouse.code))
  if (alreadySeeded.length > 0) {
    summary.skipped = true
    summary.reason = `warehouse ${alreadySeeded.map((w) => w.code).join(', ')} already exists`
    return summary
  }

  const actorUserId = await resolveActorUserId(em, scope)
  if (!actorUserId) {
    summary.skipped = true
    summary.reason = 'no user exists for this tenant to attribute inventory movements to'
    return summary
  }

  const variants = await resolveVariantsBySku(em, scope)
  const orders = await resolveOrdersByNumber(em, scope)
  const commandBus = container.resolve<CommandBus>('commandBus')
  const ctx = buildCommandContext(container, scope, actorUserId)
  const scoped = { tenantId: scope.tenantId, organizationId: scope.organizationId }

  const warehouseIds = new Map<string, string>()
  const locationIds = new Map<string, string>() // `${warehouseCode}/${locationCode}`
  const lotIds = new Map<string, string>() // `${sku}/${lotNumber}`

  const locationKey = (warehouseCode: string, code: string) => `${warehouseCode}/${code}`
  const lotKey = (sku: string, lotNumber: string) => `${sku}/${lotNumber}`

  for (const warehouse of WAREHOUSES) {
    // WH-MAIN is primary, so upstream `enforcePrimaryWarehouse` demotes any existing primary
    // whose code the skip guard above does not recognise. Irrelevant on a fresh `init`, and
    // recoverable: the create's undo payload keeps `demotedPrimariesBefore`.
    const { result } = await commandBus.execute<unknown, { warehouseId: string }>('wms.warehouses.create', {
      input: { ...scoped, ...warehouse, isActive: true },
      ctx,
    })
    warehouseIds.set(warehouse.code, result.warehouseId)
    summary.warehouses += 1
  }

  for (const zone of ZONES) {
    const warehouseId = warehouseIds.get(zone.warehouseCode)
    if (!warehouseId) continue
    await commandBus.execute('wms.zones.create', {
      input: { ...scoped, warehouseId, code: zone.code, name: zone.name, priority: zone.priority },
      ctx,
    })
    summary.zones += 1
  }

  for (const location of LOCATIONS) {
    const warehouseId = warehouseIds.get(location.warehouseCode)
    if (!warehouseId) continue
    const parentId = location.parentCode
      ? locationIds.get(locationKey(location.warehouseCode, location.parentCode)) ?? null
      : null
    const { result } = await commandBus.execute<unknown, { locationId: string }>('wms.locations.create', {
      input: {
        ...scoped,
        warehouseId,
        code: location.code,
        type: location.type,
        parentId,
        isActive: true,
        capacityUnits: location.capacityUnits,
      },
      ctx,
    })
    locationIds.set(locationKey(location.warehouseCode, location.code), result.locationId)
    summary.locations += 1
  }

  for (const profile of PROFILES) {
    const variant = variants.get(profile.sku)
    if (!variant) {
      summary.warnings.push(`skipped inventory profile: no catalog variant with SKU ${profile.sku}`)
      continue
    }
    await commandBus.execute('wms.inventoryProfiles.create', {
      input: {
        ...scoped,
        catalogProductId: variant.productId,
        catalogVariantId: variant.id,
        defaultUom: profile.defaultUom,
        defaultStrategy: profile.defaultStrategy,
        trackLot: profile.trackLot,
        trackSerial: false,
        trackExpiration: profile.trackExpiration,
        reorderPoint: profile.reorderPoint,
        safetyStock: profile.safetyStock,
      },
      ctx,
    })
    summary.profiles += 1
  }

  for (const lot of LOTS) {
    const variant = variants.get(lot.sku)
    if (!variant) {
      summary.warnings.push(`skipped lot ${lot.lotNumber}: no catalog variant with SKU ${lot.sku}`)
      continue
    }
    const { result } = await commandBus.execute<unknown, { lotId: string }>('wms.lots.create', {
      input: {
        ...scoped,
        catalogVariantId: variant.id,
        sku: lot.sku,
        lotNumber: lot.lotNumber,
        batchNumber: lot.batchNumber,
        manufacturedAt: daysFromNow(lot.manufacturedAtDays),
        bestBeforeAt: lot.bestBeforeAtDays === undefined ? undefined : daysFromNow(lot.bestBeforeAtDays),
        expiresAt: lot.expiresAtDays === undefined ? undefined : daysFromNow(lot.expiresAtDays),
        status: 'available',
      },
      ctx,
    })
    lotIds.set(lotKey(lot.sku, lot.lotNumber), result.lotId)
    summary.lots += 1
  }

  for (const receipt of RECEIPTS) {
    const variant = variants.get(receipt.sku)
    const warehouseId = warehouseIds.get(receipt.warehouseCode)
    const locationId = locationIds.get(locationKey(receipt.warehouseCode, receipt.locationCode))
    if (!variant || !warehouseId || !locationId) {
      summary.warnings.push(`skipped receipt of ${receipt.sku} into ${receipt.locationCode}: unresolved reference`)
      continue
    }
    const performedAt = daysFromNow(receipt.daysAgo * -1)
    await commandBus.execute('wms.inventory.receive', {
      input: {
        ...scoped,
        warehouseId,
        locationId,
        catalogVariantId: variant.id,
        lotId: receipt.lotNumber ? lotIds.get(lotKey(receipt.sku, receipt.lotNumber)) : undefined,
        quantity: receipt.quantity,
        referenceType: receipt.referenceType,
        referenceId: receipt.referenceId,
        performedBy: actorUserId,
        performedAt,
        receivedAt: performedAt,
        reason: receipt.reason,
      },
      ctx,
    })
    summary.receipts += 1
  }

  for (const move of MOVES) {
    const variant = variants.get(move.sku)
    const warehouseId = warehouseIds.get(move.warehouseCode)
    const fromLocationId = locationIds.get(locationKey(move.warehouseCode, move.fromLocationCode))
    const toLocationId = locationIds.get(locationKey(move.warehouseCode, move.toLocationCode))
    if (!variant || !warehouseId || !fromLocationId || !toLocationId) {
      summary.warnings.push(`skipped move of ${move.sku}: unresolved reference`)
      continue
    }
    await commandBus.execute('wms.inventory.move', {
      input: {
        ...scoped,
        warehouseId,
        fromLocationId,
        toLocationId,
        catalogVariantId: variant.id,
        lotId: move.lotNumber ? lotIds.get(lotKey(move.sku, move.lotNumber)) : undefined,
        quantity: move.quantity,
        type: move.type,
        reason: move.reason,
        referenceType: 'manual',
        referenceId: move.referenceId,
        performedBy: actorUserId,
        performedAt: daysFromNow(move.daysAgo * -1),
      },
      ctx,
    })
    summary.moves += 1
  }

  for (const reservation of RESERVATIONS) {
    const variant = variants.get(reservation.sku)
    const warehouseId = warehouseIds.get(reservation.warehouseCode)
    const orderId = orders.get(reservation.orderNumber)
    if (!variant || !warehouseId || !orderId) {
      summary.warnings.push(`skipped reservation for ${reservation.orderNumber}: unresolved reference`)
      continue
    }
    const { result } = await commandBus.execute<unknown, { reservationId: string }>('wms.inventory.reserve', {
      input: {
        ...scoped,
        warehouseId,
        catalogVariantId: variant.id,
        quantity: reservation.quantity,
        sourceType: 'order',
        sourceId: orderId,
      },
      ctx,
    })
    summary.reservations += 1

    if (reservation.outcome === 'allocated') {
      await commandBus.execute('wms.inventory.allocate', {
        input: { ...scoped, reservationId: result.reservationId },
        ctx,
      })
    } else if (reservation.outcome === 'released') {
      await commandBus.execute('wms.inventory.release', {
        input: {
          ...scoped,
          reservationId: result.reservationId,
          reason: reservation.releaseReason ?? 'Released by fixture seed',
          reasonCode: 'demo_release',
        },
        ctx,
      })
    }
  }

  for (const count of CYCLE_COUNTS) {
    const variant = variants.get(count.sku)
    const warehouseId = warehouseIds.get(count.warehouseCode)
    const locationId = locationIds.get(locationKey(count.warehouseCode, count.locationCode))
    if (!variant || !warehouseId || !locationId) {
      summary.warnings.push(`skipped cycle count at ${count.locationCode}: unresolved reference`)
      continue
    }
    await commandBus.execute('wms.inventory.cycleCount', {
      input: {
        ...scoped,
        warehouseId,
        locationId,
        catalogVariantId: variant.id,
        lotId: count.lotNumber ? lotIds.get(lotKey(count.sku, count.lotNumber)) : undefined,
        countedQuantity: count.countedQuantity,
        autoAdjust: true,
        reason: count.reason,
        referenceId: count.referenceId,
        performedBy: actorUserId,
      },
      ctx,
    })
    summary.cycleCounts += 1
  }

  for (const assignment of ASSIGNMENTS) {
    const warehouseId = warehouseIds.get(assignment.warehouseCode)
    const orderId = orders.get(assignment.orderNumber)
    if (!warehouseId || !orderId) {
      summary.warnings.push(`skipped warehouse assignment for ${assignment.orderNumber}: unresolved reference`)
      continue
    }
    await commandBus.execute('wms.sales-order.assign-warehouse', {
      input: { ...scoped, salesOrderId: orderId, warehouseId, notes: assignment.notes },
      ctx,
    })
    summary.assignments += 1
  }

  return summary
}
