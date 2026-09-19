import { z } from 'zod'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { PalletLine, type PalletLineCatalogSnapshot } from '../../data/entities'
import { serializePalletLine, type SerializedPalletLine } from '../../commands/palletLines'
import { toIsoTimestamp } from '../../lib/goodsReceiptListItem'
import { createPzCrudOpenApi, createPagedListResponseSchema } from '../openapi'

const F = {
  id: 'id',
  tenant_id: 'tenant_id',
  organization_id: 'organization_id',
  pallet_id: 'pallet_id',
  catalog_variant_id: 'catalog_variant_id',
  catalog_product_id: 'catalog_product_id',
  catalog_snapshot: 'catalog_snapshot',
  quantity: 'quantity',
  created_at: 'created_at',
  updated_at: 'updated_at',
} as const

const palletLineListSchema = z
  .object({
    palletId: z.string().uuid(),
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(200).default(100),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

type PalletLineListQuery = z.infer<typeof palletLineListSchema>

type PalletLineRow = {
  id: string
  catalog_variant_id: string
  catalog_snapshot: PalletLineCatalogSnapshot | null
  quantity: string | number
  updated_at: Date | string | null
}

type PalletLineItem = {
  id: string
  catalogVariantId: string
  name: string
  sku: string | null
  quantity: string
  updatedAt: string | null
}

/**
 * The snapshot is the answer: it is what the product was called when it was counted, and a
 * later rename must not rewrite a count somebody already checked. The live catalog is read
 * only for a row that has no snapshot at all, so the screen never shows a nameless line.
 */
function toPalletLineItem(row: PalletLineRow): PalletLineItem {
  return {
    id: String(row.id),
    catalogVariantId: String(row.catalog_variant_id),
    name: row.catalog_snapshot?.name ?? '',
    sku: row.catalog_snapshot?.sku ?? null,
    quantity: String(row.quantity),
    updatedAt: toIsoTimestamp(row.updated_at),
  }
}

type VariantRow = { id: string; name: string | null; sku: string | null }

async function fillMissingNames(
  payload: { items?: PalletLineItem[] },
  ctx: CrudCtx,
): Promise<void> {
  const items = Array.isArray(payload.items) ? payload.items : []
  const pending = items.filter((item) => item.name.length === 0)
  if (pending.length === 0) return
  // No trusted scope means no catalog read: a nameless row is a worse answer than an
  // unscoped one only until you consider that an unscoped one names another tenant's product.
  const tenantId = ctx.auth?.tenantId ?? null
  const organizationId = ctx.selectedOrganizationId ?? null
  if (!tenantId || !organizationId) return

  const variantIds = Array.from(new Set(pending.map((item) => item.catalogVariantId)))
  const queryEngine = ctx.container.resolve<QueryEngine>('queryEngine')
  const variants = await queryEngine.query<VariantRow>(E.catalog.catalog_product_variant, {
    tenantId,
    organizationId,
    fields: ['id', 'name', 'sku'],
    filters: { id: { $in: variantIds } },
    page: { page: 1, pageSize: variantIds.length },
  })

  const byId = new Map(variants.items.map((variant) => [String(variant.id), variant]))
  for (const item of pending) {
    const variant = byId.get(item.catalogVariantId)
    if (!variant) continue
    item.name = variant.name ?? ''
    item.sku = variant.sku ?? null
  }
}

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.view'] },
  POST: { requireAuth: true, requireFeatures: ['pz.receiving.count'] },
  PUT: { requireAuth: true, requireFeatures: ['pz.receiving.count'] },
  DELETE: { requireAuth: true, requireFeatures: ['pz.receiving.count'] },
}

/** The commands own validation so a refusal can name what the floor got wrong. */
const rawBodySchema = z.object({}).passthrough()

function toWriteResponse(result: unknown): { id: string; quantity: string; updatedAt: string | null } {
  const line = result as PalletLine
  const serialized: SerializedPalletLine = serializePalletLine(line)
  return { id: serialized.id, quantity: serialized.quantity, updatedAt: serialized.updatedAt }
}

export const { metadata, GET, POST, PUT, DELETE } = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: PalletLine,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    // Hard-deleted: a pallet line asserts that a product is on a pallet, and a removed
    // product is not on it.
    softDeleteField: null,
  },
  list: {
    schema: palletLineListSchema,
    entityId: E.pz.pallet_line,
    fields: [
      F.id,
      F.tenant_id,
      F.organization_id,
      F.pallet_id,
      F.catalog_variant_id,
      F.catalog_product_id,
      F.catalog_snapshot,
      F.quantity,
      F.created_at,
      F.updated_at,
    ],
    sortFieldMap: {
      createdAt: F.created_at,
      updatedAt: F.updated_at,
      quantity: F.quantity,
    },
    // Scan order. The floor reads the screen against the pile it just built, so the first
    // thing counted stays the first row however the quantities change afterwards.
    defaultSort: { field: 'createdAt', dir: 'asc' },
    tiebreakSortField: 'id',
    // A line the caller just counted has to be in the list they are sent back to.
    disableListCache: true,
    buildFilters: (query: PalletLineListQuery) => ({ [F.pallet_id]: query.palletId }),
    transformItem: (item: PalletLineRow): PalletLineItem => toPalletLineItem(item),
  },
  actions: {
    create: {
      commandId: 'pz.palletLines.count',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => parsed,
      response: ({ result }) => toWriteResponse(result),
    },
    update: {
      commandId: 'pz.palletLines.update',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => parsed,
      response: ({ result }) => toWriteResponse(result),
    },
    delete: {
      commandId: 'pz.palletLines.delete',
      response: ({ result }) => ({ id: (result as SerializedPalletLine).id }),
    },
  },
  hooks: {
    afterList: async (payload, ctx) => {
      await fillMissingNames(payload as { items?: PalletLineItem[] }, ctx)
    },
  },
})

const palletLineItemSchema = z.object({
  id: z.string().uuid(),
  catalogVariantId: z.string().uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  quantity: z.string(),
  updatedAt: z.string().nullable(),
})

const palletLineCountBodySchema = z.object({
  palletId: z.string().uuid(),
  catalogVariantId: z.string().uuid(),
  quantity: z
    .union([z.string(), z.number().int().positive()])
    .describe('Decimal string (e.g. "2.5"), or a whole number. Must be greater than zero.'),
})

const palletLineUpdateBodySchema = z.object({
  id: z.string().uuid(),
  quantity: z
    .union([z.string(), z.number().int().positive()])
    .describe('Decimal string (e.g. "2.5"), or a whole number. Must be greater than zero.'),
})

const palletLineDeleteBodySchema = z.object({ id: z.string().uuid() })

const palletLineWriteResponseSchema = z.object({
  id: z.string().uuid(),
  quantity: z.string(),
  updatedAt: z.string().nullable(),
})

const palletLineDeletedSchema = z.object({ id: z.string().uuid() })

export const openApi: OpenApiRouteDoc = createPzCrudOpenApi({
  resourceName: 'Pallet Line',
  pluralName: 'Pallet Lines',
  querySchema: palletLineListSchema,
  listResponseSchema: createPagedListResponseSchema(palletLineItemSchema),
  create: {
    schema: palletLineCountBodySchema,
    responseSchema: palletLineWriteResponseSchema,
    description:
      'Counts a quantity of one catalog variant onto a pallet. The quantity is ADDED to the (pallet, variant) row, which is created on the first count — two identical scans legitimately mean two items, so counting is idempotent per request and never per barcode. Refused with 409 when the pallet is closed or its goods receipt has not been released to the floor.',
  },
  update: {
    schema: palletLineUpdateBodySchema,
    responseSchema: palletLineWriteResponseSchema,
    description:
      'Replaces the counted quantity. Send the record version in the `x-om-ext-optimistic-lock-expected-updated-at` header; a concurrent count is answered with 409 so the corrected value never overwrites it silently.',
  },
  del: {
    schema: palletLineDeleteBodySchema,
    responseSchema: palletLineDeletedSchema,
    description:
      'Removes a counted product from a pallet. The row is hard-deleted, because a quantity of zero would assert presence and absence at once. Send the record version in the optimistic-lock header.',
  },
})
