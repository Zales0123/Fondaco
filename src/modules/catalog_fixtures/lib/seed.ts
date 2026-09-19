import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { allocateFixtureEan13, FIXTURE_GTIN_TYPE } from './barcodes'

export type CatalogFixtureScope = {
  tenantId: string
  organizationId: string
  userId?: string | null
}

export type AssignBarcodesSummary = {
  total: number
  assigned: number
  alreadyPresent: number
  failed: { sku: string; reason: string }[]
}

type VariantRow = {
  id: string
  sku: string | null
  barcode: string | null
}

/**
 * Commands, not a direct ORM write.
 *
 * `catalog.variants.update` re-validates the GTIN against the merged record
 * (zod alone cannot see the stored half of the gtinType/barcode pair), enforces
 * tenant and organization scope, and emits the lifecycle events that keep audit,
 * undo and the search index in step. A `em.nativeUpdate` loop here would set the
 * column and silently skip every one of those.
 */
function buildCommandContext(
  scope: CatalogFixtureScope,
  container: AwilixContainer,
): CommandRuntimeContext {
  return {
    container,
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

export async function assignFixtureBarcodes(
  em: EntityManager,
  container: AwilixContainer,
  scope: CatalogFixtureScope,
  options: { force?: boolean } = {},
): Promise<AssignBarcodesSummary> {
  const conn = em.getConnection()

  const variants = (await conn.execute(
    `select id, sku, barcode
       from catalog_product_variants
      where tenant_id = ? and organization_id = ? and deleted_at is null
      order by sku asc nulls last, id asc`,
    [scope.tenantId, scope.organizationId],
  )) as VariantRow[]

  // Seed the taken-set from every barcode already stored for the scope, not just
  // the rows being changed, so a generated value cannot collide with one a user
  // entered by hand.
  const taken = new Set<string>(
    variants.map((row) => row.barcode).filter((value): value is string => Boolean(value)),
  )

  const commandBus = container.resolve('commandBus') as CommandBus
  const ctx = buildCommandContext(scope, container)

  const summary: AssignBarcodesSummary = {
    total: variants.length,
    assigned: 0,
    alreadyPresent: 0,
    failed: [],
  }

  for (const variant of variants) {
    const label = variant.sku ?? variant.id
    if (variant.barcode && !options.force) {
      summary.alreadyPresent += 1
      continue
    }

    const barcode = allocateFixtureEan13(label, taken)
    try {
      await commandBus.execute('catalog.variants.update', {
        input: { id: variant.id, barcode, gtinType: FIXTURE_GTIN_TYPE },
        ctx,
      })
      taken.add(barcode)
      summary.assigned += 1
    } catch (error) {
      summary.failed.push({
        sku: label,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return summary
}
