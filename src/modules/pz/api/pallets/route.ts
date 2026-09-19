import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { Pallet } from '../../data/entities'
import { palletStatusSchema } from '../../data/validators'
import type { SerializedPallet } from '../../commands/pallets'
import { createPzCrudOpenApi, createPagedListResponseSchema } from '../openapi'

const F = {
  id: 'id',
  goods_receipt_id: 'goods_receipt_id',
  code: 'code',
  label: 'label',
  status: 'status',
  created_at: 'created_at',
  updated_at: 'updated_at',
} as const

/**
 * The goods receipt is required rather than optional: a pallet is only ever read in the
 * context of the document it belongs to, and an optional parent would turn this into a
 * listing of every pallet in the Organization.
 */
const palletListSchema = z
  .object({
    goodsReceiptId: z.string().uuid(),
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

type PalletListQuery = z.infer<typeof palletListSchema>

type PalletListRow = {
  id: string
  code: string
  label: string | null
  status: string
  updated_at: Date | string | null
}

type PalletListItem = {
  id: string
  code: string
  label: string | null
  status: z.infer<typeof palletStatusSchema>
  lineCount: number
  updatedAt: string | null
}

type PalletLineCountDatabase = {
  pz_pallet_lines: {
    id: string
    pallet_id: string
    tenant_id: string
    organization_id: string
  }
}

function toIsoTimestamp(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function toPalletListItem(row: PalletListRow): PalletListItem {
  return {
    id: String(row.id),
    code: row.code,
    label: row.label ?? null,
    status: palletStatusSchema.catch('open').parse(row.status),
    lineCount: 0,
    updatedAt: toIsoTimestamp(row.updated_at),
  }
}

/**
 * Mirrors the scope the CRUD factory applied to the pallets themselves: `null` is the only
 * value that means unrestricted within the tenant, and an empty array is deny-all.
 */
function resolveScopedOrganizationIds(ctx: CrudCtx): string[] | null {
  if (ctx.organizationIds === null) return null
  if (!Array.isArray(ctx.organizationIds)) return []
  return Array.from(
    new Set(ctx.organizationIds.filter((value): value is string => typeof value === 'string' && value.length > 0)),
  )
}

/**
 * How many products are on each pallet is a per-page aggregate, not a column — a stored total
 * would be one more thing every count has to keep true. One grouped query answers the whole
 * page, so the list never issues a query per row.
 */
async function decorateLineCounts(payload: { items?: PalletListItem[] }, ctx: CrudCtx): Promise<void> {
  const items = Array.isArray(payload.items) ? payload.items : []
  if (items.length === 0) return
  // No trusted tenant means no trusted count; the serialised 0 is the fail-closed answer.
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) return
  const scopedOrgIds = resolveScopedOrganizationIds(ctx)
  if (scopedOrgIds !== null && scopedOrgIds.length === 0) return

  const em = ctx.container.resolve<EntityManager>('em')
  let counted = em
    .getKysely<PalletLineCountDatabase>()
    .selectFrom('pz_pallet_lines')
    .select('pallet_id')
    .select((eb) => eb.fn.count<string>('id').as('line_count'))
    .where('pallet_id', 'in', items.map((item) => item.id))
    .where('tenant_id', '=', tenantId)
  // The foreign key does not constrain a line's scope to its pallet's, so the read repeats
  // the caller's organization predicate instead of trusting the parent id alone.
  if (scopedOrgIds !== null) counted = counted.where('organization_id', 'in', scopedOrgIds)
  const rows = await counted.groupBy('pallet_id').execute()

  const counts = new Map(rows.map((row) => [String(row.pallet_id), Number(row.line_count)]))
  for (const item of items) {
    item.lineCount = counts.get(item.id) ?? 0
  }
}

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.view'] },
  POST: { requireAuth: true, requireFeatures: ['pz.receiving.count'] },
  PUT: { requireAuth: true, requireFeatures: ['pz.receiving.count'] },
  DELETE: { requireAuth: true, requireFeatures: ['pz.receiving.count'] },
}

/** The command owns validation so a rejection can name what it refused and speak the caller's language. */
const rawBodySchema = z.object({}).passthrough()

export const { metadata, GET, POST, PUT, DELETE } = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: Pallet,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    // Pallets are hard-deleted, so there is no soft-delete column to filter on.
    softDeleteField: null,
  },
  list: {
    schema: palletListSchema,
    entityId: E.pz.pallet,
    fields: [F.id, F.goods_receipt_id, F.code, F.label, F.status, F.created_at, F.updated_at],
    sortFieldMap: {
      code: F.code,
      status: F.status,
      createdAt: F.created_at,
      updatedAt: F.updated_at,
    },
    // The floor reads its pallets in the order it made them, which is also the order of
    // their codes. The code settles every tie on its own — it is unique per organization.
    defaultSort: { field: 'createdAt', dir: 'asc' },
    tiebreakSortField: 'code',
    // A pallet the warehouseman just created has to be in the list they return to.
    disableListCache: true,
    buildFilters: (query: PalletListQuery) => ({ [F.goods_receipt_id]: query.goodsReceiptId }),
    transformItem: (item: PalletListRow): PalletListItem => toPalletListItem(item),
  },
  actions: {
    create: {
      commandId: 'pz.pallets.create',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => parsed,
      response: ({ result }) => {
        const pallet = result as Pallet
        return {
          id: String(pallet.id),
          code: pallet.code,
          status: pallet.status,
          updatedAt: pallet.updatedAt?.toISOString() ?? null,
        }
      },
      status: 201,
    },
    update: {
      commandId: 'pz.pallets.update',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => parsed,
      response: ({ result }) => {
        const pallet = result as Pallet
        return {
          id: String(pallet.id),
          label: pallet.label ?? null,
          updatedAt: pallet.updatedAt?.toISOString() ?? null,
        }
      },
    },
    delete: {
      commandId: 'pz.pallets.delete',
      response: ({ result }) => ({ id: (result as SerializedPallet).id }),
    },
  },
  hooks: {
    afterList: async (payload, ctx) => {
      await decorateLineCounts(payload as { items?: PalletListItem[] }, ctx)
    },
  },
})

const palletListItemSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  label: z.string().nullable(),
  status: palletStatusSchema,
  lineCount: z.number().int(),
  updatedAt: z.string().nullable(),
})

const palletCreateBodySchema = z.object({
  goodsReceiptId: z.string().uuid(),
  label: z.string().max(120).nullable().optional().describe('A free note for the floor. The code is generated and never supplied.'),
})

const palletCreatedSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  status: z.literal('open'),
  updatedAt: z.string().nullable(),
})

const palletUpdateBodySchema = z.object({
  id: z.string().uuid(),
  label: z.string().max(120).nullable().optional(),
})

const palletUpdatedSchema = z.object({
  id: z.string().uuid(),
  label: z.string().nullable(),
  updatedAt: z.string().nullable(),
})

const palletDeleteBodySchema = z.object({ id: z.string().uuid() })

const palletDeletedSchema = z.object({ id: z.string().uuid() })

export const openApi: OpenApiRouteDoc = createPzCrudOpenApi({
  tag: 'Pallets',
  resourceName: 'Pallet',
  pluralName: 'Pallets',
  querySchema: palletListSchema,
  listResponseSchema: createPagedListResponseSchema(palletListItemSchema),
  create: {
    schema: palletCreateBodySchema,
    responseSchema: palletCreatedSchema,
    description:
      'Creates a pallet for a goods receipt that has been released to the floor, with a code generated and unique within the organization. The receipt must be in `receiving`; anything else is refused with 409.',
  },
  update: {
    schema: palletUpdateBodySchema,
    responseSchema: palletUpdatedSchema,
    description:
      'Renames the pallet note. The code is the physical label and can never be changed. Send the record version in the `x-om-ext-optimistic-lock-expected-updated-at` header; a stale version is answered with 409, as is a closed pallet.',
  },
  del: {
    schema: palletDeleteBodySchema,
    responseSchema: palletDeletedSchema,
    description:
      'Hard-deletes an empty, open pallet, freeing its code for reuse. A closed pallet, or one that still carries counted goods, is refused with 409.',
  },
})
