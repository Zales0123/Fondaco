import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { PalletDamageReport, type PalletLineCatalogSnapshot } from '../../data/entities'
import {
  serializePalletDamageReport,
  type SerializedPalletDamageReport,
} from '../../commands/palletDamageReports'
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
  photo_attachment_id: 'photo_attachment_id',
  note: 'note',
  status: 'status',
  resolution_note: 'resolution_note',
  reported_by: 'reported_by',
  resolved_by: 'resolved_by',
  resolved_at: 'resolved_at',
  created_at: 'created_at',
  updated_at: 'updated_at',
} as const

/**
 * `palletId` scopes the panel's per-pallet view; `palletIds` (comma-separated) scopes the
 * office's per-document view, which reads across every pallet a Goods Receipt has without
 * this module storing a redundant `goods_receipt_id` column.
 */
const palletDamageReportListSchema = z
  .object({
    palletId: z.string().uuid().optional(),
    palletIds: z.string().optional(),
    status: z.enum(['open', 'resolved']).optional(),
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(200).default(100),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()
  .refine((value) => Boolean(value.palletId || value.palletIds), {
    message: 'palletId or palletIds is required',
    path: ['palletId'],
  })

type PalletDamageReportListQuery = z.infer<typeof palletDamageReportListSchema>

type PalletDamageReportRow = {
  id: string
  pallet_id: string
  catalog_variant_id: string
  catalog_snapshot: PalletLineCatalogSnapshot | null
  quantity: string | number
  photo_attachment_id: string | null
  note: string | null
  status: 'open' | 'resolved'
  resolution_note: string | null
  reported_by: string
  resolved_by: string | null
  resolved_at: Date | string | null
  created_at: Date | string | null
  updated_at: Date | string | null
}

type PalletDamageReportItem = {
  id: string
  palletId: string
  catalogVariantId: string
  name: string
  sku: string | null
  quantity: string
  photoAttachmentId: string | null
  note: string | null
  status: 'open' | 'resolved'
  resolutionNote: string | null
  reportedBy: string
  resolvedBy: string | null
  resolvedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

function toPalletDamageReportItem(row: PalletDamageReportRow): PalletDamageReportItem {
  return {
    id: String(row.id),
    palletId: String(row.pallet_id),
    catalogVariantId: String(row.catalog_variant_id),
    name: row.catalog_snapshot?.name ?? '',
    sku: row.catalog_snapshot?.sku ?? null,
    quantity: String(row.quantity),
    photoAttachmentId: row.photo_attachment_id ? String(row.photo_attachment_id) : null,
    note: row.note ?? null,
    status: row.status,
    resolutionNote: row.resolution_note ?? null,
    reportedBy: String(row.reported_by),
    resolvedBy: row.resolved_by ? String(row.resolved_by) : null,
    resolvedAt: toIsoTimestamp(row.resolved_at),
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  }
}

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.view'] },
  POST: { requireAuth: true, requireFeatures: ['pz.palletDamageReports.report'] },
  PUT: { requireAuth: true, requireFeatures: ['pz.palletDamageReports.resolve'] },
}

/** The commands own validation so a refusal can name what the floor or the office got wrong. */
const rawBodySchema = z.object({}).passthrough()

type PalletDamageReportWriteResult = {
  id: string
  palletId: string
  status: 'open' | 'resolved'
  quantity: string
  updatedAt: string
}

function toWriteResponse(result: unknown): PalletDamageReportWriteResult {
  const serialized: SerializedPalletDamageReport = serializePalletDamageReport(result as PalletDamageReport)
  return {
    id: serialized.id,
    palletId: serialized.palletId,
    status: serialized.status,
    quantity: serialized.quantity,
    updatedAt: serialized.updatedAt,
  }
}

export const { metadata, GET, POST, PUT } = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: PalletDamageReport,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: null,
  },
  list: {
    schema: palletDamageReportListSchema,
    entityId: E.pz.pallet_damage_report,
    fields: [
      F.id,
      F.tenant_id,
      F.organization_id,
      F.pallet_id,
      F.catalog_variant_id,
      F.catalog_product_id,
      F.catalog_snapshot,
      F.quantity,
      F.photo_attachment_id,
      F.note,
      F.status,
      F.resolution_note,
      F.reported_by,
      F.resolved_by,
      F.resolved_at,
      F.created_at,
      F.updated_at,
    ],
    sortFieldMap: {
      createdAt: F.created_at,
      updatedAt: F.updated_at,
      status: F.status,
    },
    defaultSort: { field: 'createdAt', dir: 'asc' },
    tiebreakSortField: 'id',
    // A report the caller just filed or resolved has to be in the list they are sent back to.
    disableListCache: true,
    buildFilters: (query: PalletDamageReportListQuery) => {
      const filters: Record<string, unknown> = {}
      if (query.palletIds) {
        const ids = query.palletIds
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
        filters[F.pallet_id] = { $in: ids }
      } else if (query.palletId) {
        filters[F.pallet_id] = query.palletId
      }
      if (query.status) filters[F.status] = query.status
      return filters
    },
    transformItem: (item: PalletDamageReportRow): PalletDamageReportItem => toPalletDamageReportItem(item),
  },
  actions: {
    create: {
      commandId: 'pz.palletDamageReports.create',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => parsed,
      response: ({ result }) => toWriteResponse(result),
    },
    update: {
      commandId: 'pz.palletDamageReports.resolve',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => parsed,
      response: ({ result }) => toWriteResponse(result),
    },
  },
})

const palletDamageReportItemSchema = z.object({
  id: z.string().uuid(),
  palletId: z.string().uuid(),
  catalogVariantId: z.string().uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  quantity: z.string(),
  photoAttachmentId: z.string().uuid().nullable(),
  note: z.string().nullable(),
  status: z.enum(['open', 'resolved']),
  resolutionNote: z.string().nullable(),
  reportedBy: z.string().uuid(),
  resolvedBy: z.string().uuid().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
})

const palletDamageReportCreateBodySchema = z.object({
  id: z.string().uuid().optional().describe('Client-minted id, required only when a photo was uploaded ahead of this call under that same id as its attachment record id.'),
  palletId: z.string().uuid(),
  catalogVariantId: z.string().uuid(),
  quantity: z
    .union([z.string(), z.number().int().positive()])
    .describe('Decimal string (e.g. "2.5"), or a whole number. Must be greater than zero.'),
  note: z.string().nullable().optional(),
  photoAttachmentId: z.string().uuid().nullable().optional(),
})

const palletDamageReportResolveBodySchema = z.object({
  id: z.string().uuid(),
  resolutionNote: z.string().nullable().optional(),
})

const palletDamageReportWriteResponseSchema = z.object({
  id: z.string().uuid(),
  palletId: z.string().uuid(),
  status: z.enum(['open', 'resolved']),
  quantity: z.string(),
  updatedAt: z.string(),
})

export const openApi: OpenApiRouteDoc = createPzCrudOpenApi({
  resourceName: 'Pallet Damage Report',
  pluralName: 'Pallet Damage Reports',
  querySchema: palletDamageReportListSchema,
  listResponseSchema: createPagedListResponseSchema(palletDamageReportItemSchema),
  create: {
    schema: palletDamageReportCreateBodySchema,
    responseSchema: palletDamageReportWriteResponseSchema,
    description:
      'Files a damage report against a product on an open pallet. Refused with 409 when the pallet is closed. Upload the photo first through `/api/attachments` (`entityId=pz:pallet_damage_report`, `recordId` equal to the `id` sent here) and pass its id as `photoAttachmentId`.',
  },
  update: {
    schema: palletDamageReportResolveBodySchema,
    responseSchema: palletDamageReportWriteResponseSchema,
    description:
      'Marks an open damage report resolved, with an optional office note. Available regardless of the Goods Receipt or pallet status. Send the record version in the `x-om-ext-optimistic-lock-expected-updated-at` header.',
  },
})
