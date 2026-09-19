/**
 * The products a demo delivery may be built from, each one carrying the two facts that decide
 * what kind of document it can appear on: whether `pz` can resolve a line for it at all, and
 * whether `wms` would refuse to receive it without a lot number.
 *
 * Both facts are read exactly the way `pz` reads them at write and at confirmation time —
 * the default-variant rule from `resolveCatalogLines`, the tracking rule from
 * `loadTrackedVariantIds` — rather than approximated from the fixture SKUs. A fixture that
 * invented its own rule would shape documents against a rule nothing enforces, and would
 * start lying the day either module changed its mind.
 */
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { loadTrackedVariantIds } from '@/modules/pz/lib/destinations'
import { E } from '#generated/entities.ids.generated'
import type { PzFixtureScope } from './scope'

export type FixtureProductRow = {
  id: string
  title: string | null
  /** Exactly one default variant, so `pz.goodsReceipts.create` can resolve a line for it. */
  receivable: boolean
  /** `wms` tracks that default variant by lot or serial number, so it cannot be posted. */
  tracked: boolean
}

type ProductRow = { id: string; title: string | null }
type VariantRow = { id: string; product_id: string; is_default: boolean | null }

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

export async function readFixtureProducts(
  em: EntityManager,
  container: AwilixContainer,
  scope: PzFixtureScope,
): Promise<FixtureProductRow[]> {
  const products = await readStockableProducts(em, scope)
  if (products.length === 0) return []

  const productIds = products.map((product) => String(product.id))
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  const variants = await queryEngine.query<VariantRow>(E.catalog.catalog_product_variant, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    // `is_default` is projected as well as filtered: the engine resolves a filter against the
    // selected projection, so filtering on a column it was not asked to read silently returns
    // every variant. Same caveat `pz` documents on the same query.
    fields: ['id', 'product_id', 'is_default'],
    filters: { product_id: { $in: productIds }, is_default: { $eq: true } },
    // Room for more than one default per product, so an ambiguous catalog is detected rather
    // than truncated to whichever row the page happened to include — `pz` refuses such a
    // product, so a fixture must not count on it either.
    page: { page: 1, pageSize: Math.min(productIds.length * 4, 1000) },
  })

  const defaultsByProduct = new Map<string, string[]>()
  for (const variant of variants.items) {
    const productId = String(variant.product_id)
    const bucket = defaultsByProduct.get(productId) ?? []
    bucket.push(String(variant.id))
    defaultsByProduct.set(productId, bucket)
  }

  const receivableVariantIds = Array.from(defaultsByProduct.values())
    .filter((bucket) => bucket.length === 1)
    .map((bucket) => bucket[0])
  const trackedVariantIds = await loadTrackedVariantIds(queryEngine, scope, receivableVariantIds)

  return products.map((product) => {
    const id = String(product.id)
    const defaults = defaultsByProduct.get(id) ?? []
    const receivable = defaults.length === 1
    return {
      id,
      title: product.title,
      receivable,
      tracked: receivable && trackedVariantIds.has(defaults[0]),
    }
  })
}
