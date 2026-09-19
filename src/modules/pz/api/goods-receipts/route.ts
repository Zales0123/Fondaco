import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { GoodsReceipt, type GoodsReceiptWarehouseSnapshot } from '../../data/entities'
import {
  goodsReceiptListSchema,
  goodsReceiptWriteBodySchema,
  type GoodsReceiptListQuery,
} from '../../data/validators'
import { createPzCrudOpenApi, createPagedListResponseSchema } from '../openapi'
import {
  toGoodsReceiptListItem,
  type GoodsReceiptListItem,
  type GoodsReceiptListRow,
} from '../../lib/goodsReceiptListItem'

const F = {
  id: 'id',
  tenant_id: 'tenant_id',
  organization_id: 'organization_id',
  document_number: 'document_number',
  document_date: 'document_date',
  supplier_name: 'supplier_name',
  warehouse_id: 'warehouse_id',
  warehouse_snapshot: 'warehouse_snapshot',
  status: 'status',
  created_at: 'created_at',
  updated_at: 'updated_at',
} as const

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.view'] },
  POST: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.manage'] },
}

/**
 * The command owns validation so a rejection can name the field that caused it; the route
 * passes the body through untouched.
 */
const rawBodySchema = z.object({}).passthrough()

/**
 * Line counts are a per-page aggregate, not a column: the header deliberately stores no
 * denormalised total, and `transformItem` is synchronous. `afterList` is the one hook
 * that can issue the grouped count for exactly the ids the page already resolved.
 */
type PzReadDatabase = {
  pz_goods_receipt_lines: {
    id: string
    goods_receipt_id: string
    tenant_id: string
    organization_id: string
  }
}

/**
 * Mirrors the scope the CRUD factory applied to the headers themselves: `null` is the only
 * value that means unrestricted within the tenant, and an empty array is deny-all — the
 * factory short-circuits that case to an empty page, so widening it back to the selected
 * organization here would count lines the caller was refused the headers for.
 */
function resolveScopedOrganizationIds(ctx: CrudCtx): string[] | null {
  if (ctx.organizationIds === null) return null
  if (!Array.isArray(ctx.organizationIds)) return []
  return Array.from(
    new Set(ctx.organizationIds.filter((value): value is string => typeof value === 'string' && value.length > 0)),
  )
}

async function decorateLineCounts(
  payload: { items?: GoodsReceiptListItem[] },
  ctx: CrudCtx,
): Promise<void> {
  const items = Array.isArray(payload.items) ? payload.items : []
  if (items.length === 0) return
  // No trusted tenant means no trusted count. Leaving every `lineCount` at its serialised
  // 0 is the fail-closed answer; an unscoped aggregate is not.
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) return
  const scopedOrgIds = resolveScopedOrganizationIds(ctx)
  if (scopedOrgIds !== null && scopedOrgIds.length === 0) return

  const ids = items.map((item) => item.id)
  const em = ctx.container.resolve<EntityManager>('em')
  let query = em
    .getKysely<PzReadDatabase>()
    .selectFrom('pz_goods_receipt_lines')
    .select('goods_receipt_id')
    .select((eb) => eb.fn.count<string>('id').as('line_count'))
    .where('goods_receipt_id', 'in', ids)
    .where('tenant_id', '=', tenantId)
  // The foreign key does not constrain a line's scope to its header's, so the count
  // repeats the caller's organization predicate instead of trusting the parent id alone.
  if (scopedOrgIds !== null) query = query.where('organization_id', 'in', scopedOrgIds)
  const rows = await query.groupBy('goods_receipt_id').execute()

  const counts = new Map(rows.map((row) => [String(row.goods_receipt_id), Number(row.line_count)]))
  for (const item of items) {
    item.lineCount = counts.get(item.id) ?? 0
  }
}

export const { metadata, GET, POST } = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: GoodsReceipt,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  indexer: { entityType: E.pz.goods_receipt },
  list: {
    schema: goodsReceiptListSchema,
    entityId: E.pz.goods_receipt,
    fields: [
      F.id,
      F.tenant_id,
      F.organization_id,
      F.document_number,
      F.document_date,
      F.supplier_name,
      F.warehouse_id,
      F.warehouse_snapshot,
      F.status,
      F.created_at,
      F.updated_at,
    ],
    sortFieldMap: {
      documentNumber: F.document_number,
      documentDate: F.document_date,
      status: F.status,
      createdAt: F.created_at,
      updatedAt: F.updated_at,
    },
    defaultSort: { field: 'documentDate', dir: 'desc' },
    // Document Date is day-granular, so same-day receipts would otherwise come back in
    // the database's arbitrary row order and duplicate or skip rows across pages.
    tiebreakSortField: 'id',
    // A freshly created goods receipt has to be in the index it redirects to.
    disableListCache: true,
    buildFilters: async (query: GoodsReceiptListQuery) => {
      const filters: Record<string, unknown> = {}
      if (query.id) filters[F.id] = query.id
      if (typeof query.ids === 'string' && query.ids.trim().length > 0) {
        const ids = query.ids
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
        if (ids.length > 0) filters[F.id] = { $in: ids }
      }
      return filters
    },
    transformItem: (item: GoodsReceiptListRow): GoodsReceiptListItem => toGoodsReceiptListItem(item),
  },
  actions: {
    create: {
      commandId: 'pz.goodsReceipts.create',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => parsed,
      response: ({ result }) => ({
        id: String((result as GoodsReceipt).id),
        updatedAt: (result as GoodsReceipt).updatedAt?.toISOString() ?? null,
      }),
      status: 201,
    },
  },
  hooks: {
    afterList: async (payload, ctx) => {
      await decorateLineCounts(payload as { items?: GoodsReceiptListItem[] }, ctx)
    },
  },
})

const warehouseSnapshotSchema: z.ZodType<GoodsReceiptWarehouseSnapshot | null> = z
  .object({ name: z.string(), code: z.string() })
  .nullable()

const goodsReceiptListItemSchema = z.object({
  id: z.string().uuid(),
  documentNumber: z.string(),
  documentDate: z.string().nullable(),
  supplierName: z.string(),
  warehouseId: z.string().uuid(),
  warehouseSnapshot: warehouseSnapshotSchema,
  status: z.enum(['draft', 'confirmed']),
  lineCount: z.number().int(),
  updatedAt: z.string().nullable(),
})

const goodsReceiptCreatedSchema = z.object({
  id: z.string().uuid(),
  updatedAt: z.string().nullable(),
})

export const openApi: OpenApiRouteDoc = createPzCrudOpenApi({
  resourceName: 'Goods Receipt',
  pluralName: 'Goods Receipts',
  querySchema: goodsReceiptListSchema,
  listResponseSchema: createPagedListResponseSchema(goodsReceiptListItemSchema),
  create: {
    schema: goodsReceiptWriteBodySchema,
    responseSchema: goodsReceiptCreatedSchema,
    description:
      'Creates a goods receipt and all of its lines in one transaction. Tenant and organization scope come from the session, never from the body.',
  },
})
