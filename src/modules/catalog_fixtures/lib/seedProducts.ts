import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { createAttachmentFromBuffer } from '@open-mercato/core/modules/attachments/lib/createFromBuffer'
import {
  buildAttachmentImageUrl,
  slugifyAttachmentFileName,
} from '@open-mercato/core/modules/attachments/lib/imageUrls'
import { resolveCanonicalUnitCode } from '@open-mercato/core/modules/catalog/lib/unitResolution'
import { E } from '#generated/entities.ids.generated'
import { buildCommandContext, type CatalogFixtureScope } from './commandContext'
import {
  BEVERAGE_PRODUCTS,
  FIXTURE_MEDIA_ROOT,
  PREFERRED_UNIT_CODES,
  type BeverageFixture,
} from './products'

export type SeedProductsSummary = {
  created: number
  skipped: number
  images: number
  failed: { handle: string; reason: string }[]
}

const FIXTURE_CURRENCY = 'PLN'
const FIXTURE_GTIN_TYPE = 'ean13'
const UNIT_PRICE_REFERENCE_UNIT = 'l'

type ExistingKeys = { handles: Set<string>; barcodes: Set<string> }

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadExistingKeys(
  em: EntityManager,
  scope: CatalogFixtureScope,
): Promise<ExistingKeys> {
  const conn = em.getConnection()
  const products = (await conn.execute(
    `select handle
       from catalog_products
      where tenant_id = ? and organization_id = ? and deleted_at is null and handle is not null`,
    [scope.tenantId, scope.organizationId],
  )) as { handle: string }[]
  const variants = (await conn.execute(
    `select barcode
       from catalog_product_variants
      where tenant_id = ? and organization_id = ? and deleted_at is null and barcode is not null`,
    [scope.tenantId, scope.organizationId],
  )) as { barcode: string }[]

  return {
    handles: new Set(products.map((row) => row.handle.toLowerCase())),
    barcodes: new Set(variants.map((row) => row.barcode)),
  }
}

/**
 * The unit dictionary is per organization and its codes are not fixed, so the
 * base unit is looked up instead of assumed. A product with no resolvable unit
 * is still valid — the command rejects an unknown code outright, which would
 * cost us the whole product.
 */
async function resolveDefaultUnit(
  em: EntityManager,
  scope: CatalogFixtureScope,
): Promise<string | null> {
  for (const unitCode of PREFERRED_UNIT_CODES) {
    try {
      return await resolveCanonicalUnitCode(em, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        unitCode,
      })
    } catch {
      continue
    }
  }
  return null
}

async function attachProductImage(
  em: EntityManager,
  container: AwilixContainer,
  scope: CatalogFixtureScope,
  productId: string,
  fixture: BeverageFixture,
): Promise<{ id: string; url: string } | null> {
  const sourcePath = path.join(FIXTURE_MEDIA_ROOT, fixture.image)
  let buffer: Buffer
  try {
    buffer = await fs.readFile(sourcePath)
  } catch {
    return null
  }

  const attachment = await createAttachmentFromBuffer({
    em: em.fork(),
    dataEngine: container.resolve('dataEngine'),
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    entityId: E.catalog.catalog_product,
    recordId: productId,
    fileName: fixture.image,
    mimeType: 'image/jpeg',
    buffer,
  })

  return {
    id: attachment.id,
    url: buildAttachmentImageUrl(attachment.id, {
      slug: slugifyAttachmentFileName(fixture.image, 'produkt'),
    }),
  }
}

function buildProductInput(
  fixture: BeverageFixture,
  scope: CatalogFixtureScope,
  defaultUnit: string | null,
) {
  return {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    title: fixture.title,
    subtitle: fixture.subtitle,
    description: fixture.description,
    sku: fixture.sku,
    handle: fixture.handle,
    productType: 'simple',
    primaryCurrencyCode: FIXTURE_CURRENCY,
    ...(defaultUnit ? { defaultUnit } : {}),
    unitPrice: {
      enabled: true,
      referenceUnit: UNIT_PRICE_REFERENCE_UNIT,
      baseQuantity: 1,
    },
    weightValue: fixture.weightKg,
    weightUnit: 'kg',
    dimensions: fixture.dimensions,
    countryOfOriginCode: fixture.countryOfOriginCode,
    seoTitle: fixture.seoTitle,
    seoDescription: fixture.seoDescription,
    metadata: { netVolumeLitres: fixture.volumeLitres },
    isActive: true,
  }
}

function buildVariantInput(
  fixture: BeverageFixture,
  scope: CatalogFixtureScope,
  productId: string,
) {
  return {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    productId,
    name: fixture.variantName,
    sku: fixture.sku,
    barcode: fixture.barcode,
    gtinType: FIXTURE_GTIN_TYPE,
    isDefault: true,
    isActive: true,
    weightValue: fixture.weightKg,
    weightUnit: 'kg',
    dimensions: fixture.dimensions,
  }
}

/**
 * Seeds the beverage products, one default variant each, carrying the real
 * EAN-13 from the packaging. Re-runnable: a fixture whose handle or barcode is
 * already taken in the scope is left untouched rather than duplicated.
 *
 * Run this where the app reads its attachment storage. Under the dockerized dev
 * stack `/app/storage` is a named volume, not the repository, so a run from the
 * host writes image bytes the app container cannot see: the rows land in the
 * shared database and every product photo then 500s. Use
 * `docker compose exec app yarn mercato catalog_fixtures seed-products`.
 */
export async function seedBeverageProducts(
  em: EntityManager,
  container: AwilixContainer,
  scope: CatalogFixtureScope,
): Promise<SeedProductsSummary> {
  const existing = await loadExistingKeys(em, scope)
  const commandBus = container.resolve('commandBus') as CommandBus
  const ctx = buildCommandContext(scope, container)
  const defaultUnit = await resolveDefaultUnit(em, scope)

  const summary: SeedProductsSummary = { created: 0, skipped: 0, images: 0, failed: [] }

  for (const fixture of BEVERAGE_PRODUCTS) {
    if (existing.handles.has(fixture.handle) || existing.barcodes.has(fixture.barcode)) {
      summary.skipped += 1
      continue
    }

    try {
      const created = await commandBus.execute<unknown, { productId: string }>(
        'catalog.products.create',
        { input: buildProductInput(fixture, scope, defaultUnit), ctx },
      )
      const productId = created.result.productId

      const media = await attachProductImage(em, container, scope, productId, fixture)
      if (media) {
        await commandBus.execute('catalog.products.update', {
          input: {
            id: productId,
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            defaultMediaId: media.id,
            defaultMediaUrl: media.url,
          },
          ctx,
        })
        summary.images += 1
      }

      await commandBus.execute('catalog.variants.create', {
        input: buildVariantInput(fixture, scope, productId),
        ctx,
      })

      existing.handles.add(fixture.handle)
      existing.barcodes.add(fixture.barcode)
      summary.created += 1
    } catch (error) {
      summary.failed.push({ handle: fixture.handle, reason: reason(error) })
    }
  }

  return summary
}
