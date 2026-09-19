import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import {
  resolveOrganizationScopeForRequest,
  type OrganizationScope,
} from '@open-mercato/core/modules/directory/utils/organizationScope'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type {
  GoodsReceiptCatalogSnapshot,
  PalletLineCatalogSnapshot,
  PalletStatus,
} from '../../../data/entities'
import {
  buildReceivingSummary,
  type ReceivingSummary,
  type ReceivingSummaryExpectedLine,
  type ReceivingSummaryPallet,
  type ReceivingSummaryPalletLine,
} from '../../../lib/receivingSummary'

const logger = createLogger('pz').child({ component: 'receiving-summary' })

/**
 * Read-only on both surfaces: corrections happen on the counting screen, so nothing here can
 * be edited by accident while somebody else is still counting.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.view'] },
}

const summaryQuerySchema = z.object({ id: z.string().uuid() })

const palletBreakdownSchema = z.object({
  palletId: z.string().uuid(),
  code: z.string(),
  quantity: z.string(),
})

const summaryRowSchema = z.object({
  catalogVariantId: z.string().uuid(),
  name: z.string().nullable(),
  sku: z.string().nullable(),
  unit: z.string().nullable(),
  expected: z.string().nullable(),
  counted: z.string(),
  difference: z.string(),
  surplus: z.boolean(),
  pallets: z.array(palletBreakdownSchema),
})

const summaryResponseSchema = z.object({
  items: z.array(summaryRowSchema),
  totals: z.object({ expected: z.string(), counted: z.string() }),
  palletCount: z.number().int(),
  palletsOpen: z.number().int(),
  palletsClosed: z.number().int(),
})

const errorSchema = z.object({ error: z.string() }).passthrough()

type ReceivingSummaryDatabase = {
  pz_goods_receipts: {
    id: string
    tenant_id: string
    organization_id: string
    deleted_at: Date | null
  }
  pz_goods_receipt_lines: {
    goods_receipt_id: string
    tenant_id: string
    organization_id: string
    catalog_variant_id: string
    catalog_snapshot: GoodsReceiptCatalogSnapshot | null
    quantity: string
    unit: string | null
    line_number: number
  }
  pz_pallets: {
    id: string
    goods_receipt_id: string
    tenant_id: string
    organization_id: string
    code: string
    status: PalletStatus
  }
  pz_pallet_lines: {
    pallet_id: string
    tenant_id: string
    organization_id: string
    catalog_variant_id: string
    catalog_snapshot: PalletLineCatalogSnapshot | null
    quantity: string
  }
}

/**
 * `null` is the only value that means unrestricted within the tenant; an empty array is
 * deny-all. Widening deny-all back to the selected organization would answer with a document
 * the caller was refused.
 */
function resolveScopedOrganizationIds(scope: OrganizationScope): string[] | null {
  if (scope.filterIds === null) return null
  if (!Array.isArray(scope.filterIds)) return []
  return Array.from(new Set(scope.filterIds.filter((value): value is string => typeof value === 'string' && value.length > 0)))
}

type ScopedRead = {
  em: EntityManager
  tenantId: string
  /** `null` means unrestricted within the tenant; an array restricts, and an empty one denies. */
  organizationIds: string[] | null
}

/**
 * Every read repeats the tenant and organization predicate rather than trusting the parent
 * id: a foreign key does not constrain a line's scope to its header's, and a pallet the
 * caller may not see would be a leak however the receipt itself was resolved.
 */
async function receiptIsVisible(read: ScopedRead, goodsReceiptId: string): Promise<boolean> {
  let query = read.em
    .getKysely<ReceivingSummaryDatabase>()
    .selectFrom('pz_goods_receipts')
    .select('id')
    .where('id', '=', goodsReceiptId)
    .where('tenant_id', '=', read.tenantId)
    .where('deleted_at', 'is', null)
  if (read.organizationIds !== null) query = query.where('organization_id', 'in', read.organizationIds)
  return Boolean(await query.executeTakeFirst())
}

async function loadExpectedLines(read: ScopedRead, goodsReceiptId: string): Promise<ReceivingSummaryExpectedLine[]> {
  let query = read.em
    .getKysely<ReceivingSummaryDatabase>()
    .selectFrom('pz_goods_receipt_lines')
    .select(['catalog_variant_id', 'catalog_snapshot', 'quantity', 'unit'])
    .where('goods_receipt_id', '=', goodsReceiptId)
    .where('tenant_id', '=', read.tenantId)
  if (read.organizationIds !== null) query = query.where('organization_id', 'in', read.organizationIds)
  const rows = await query.orderBy('line_number', 'asc').execute()
  return rows.map((row) => ({
    catalogVariantId: String(row.catalog_variant_id),
    quantity: String(row.quantity),
    unit: row.unit ?? null,
    name: row.catalog_snapshot?.name ?? null,
    sku: row.catalog_snapshot?.sku ?? null,
  }))
}

async function loadPallets(read: ScopedRead, goodsReceiptId: string): Promise<ReceivingSummaryPallet[]> {
  let query = read.em
    .getKysely<ReceivingSummaryDatabase>()
    .selectFrom('pz_pallets')
    .select(['id', 'code', 'status'])
    .where('goods_receipt_id', '=', goodsReceiptId)
    .where('tenant_id', '=', read.tenantId)
  if (read.organizationIds !== null) query = query.where('organization_id', 'in', read.organizationIds)
  const rows = await query.orderBy('code', 'asc').execute()
  return rows.map((row) => ({ id: String(row.id), code: String(row.code), status: row.status }))
}

async function loadPalletLines(
  read: ScopedRead,
  pallets: ReceivingSummaryPallet[],
): Promise<ReceivingSummaryPalletLine[]> {
  if (pallets.length === 0) return []
  let query = read.em
    .getKysely<ReceivingSummaryDatabase>()
    .selectFrom('pz_pallet_lines')
    .select(['pallet_id', 'catalog_variant_id', 'catalog_snapshot', 'quantity'])
    .where('pallet_id', 'in', pallets.map((pallet) => pallet.id))
    .where('tenant_id', '=', read.tenantId)
  if (read.organizationIds !== null) query = query.where('organization_id', 'in', read.organizationIds)
  const rows = await query.execute()

  const codes = new Map(pallets.map((pallet) => [pallet.id, pallet.code]))
  return rows.map((row) => ({
    palletId: String(row.pallet_id),
    palletCode: codes.get(String(row.pallet_id)) ?? '',
    catalogVariantId: String(row.catalog_variant_id),
    quantity: String(row.quantity),
    name: row.catalog_snapshot?.name ?? null,
    sku: row.catalog_snapshot?.sku ?? null,
  }))
}

async function loadSummary(read: ScopedRead, goodsReceiptId: string): Promise<ReceivingSummary | null> {
  if (!(await receiptIsVisible(read, goodsReceiptId))) return null
  const [expectedLines, pallets] = await Promise.all([
    loadExpectedLines(read, goodsReceiptId),
    loadPallets(read, goodsReceiptId),
  ])
  return buildReceivingSummary({ expectedLines, pallets, palletLines: await loadPalletLines(read, pallets) })
}

export async function GET(request: Request) {
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { translate } = await resolveTranslations()
  const parsed = summaryQuerySchema.safeParse({ id: new URL(request.url).searchParams.get('id') ?? undefined })
  if (!parsed.success) {
    return Response.json(
      { error: translate('pz.receiving.errors.idRequired', 'A goods receipt identifier is required.') },
      { status: 400 },
    )
  }

  const container = await createRequestContainer()
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request })
  if (scope.selectionRejected) {
    return Response.json(
      {
        error: translate(
          'pz.goodsReceipts.errors.organizationSelectionInvalid',
          'Your selected organization is no longer available. Please re-select an organization and try again.',
        ),
        code: 'organization_selection_invalid',
      },
      { status: 422 },
    )
  }

  try {
    const summary = await loadSummary(
      {
        em: container.resolve('em') as EntityManager,
        tenantId: scope.tenantId ?? auth.tenantId,
        organizationIds: resolveScopedOrganizationIds(scope),
      },
      parsed.data.id,
    )
    if (!summary) {
      return Response.json(
        { error: translate('pz.goodsReceipts.errors.notFound', 'That goods receipt no longer exists.') },
        { status: 404 },
      )
    }
    return Response.json(summary)
  } catch (error) {
    logger.error('Receiving summary failed', { err: error })
    return Response.json(
      { error: translate('pz.receiving.errors.summaryFailed', 'The receiving summary could not be built.') },
      { status: 500 },
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Goods Receipts',
  summary: 'Receiving summary for a goods receipt',
  methods: {
    GET: {
      summary: 'Compare expected against counted quantities',
      description:
        'Returns, per catalog variant, the quantity the goods receipt expected against the quantity counted across every one of its pallets, with the per-pallet breakdown. A variant no line expected is reported as a surplus row with a null expected quantity. Quantities are decimal strings at the storage precision, because a JSON number cannot carry numeric(18,4) faithfully. Rows come back worst first: shortages by absolute difference descending, then surplus rows, then over-counts, then matching rows. The endpoint is read-only and scoped to the authenticated tenant and organization.',
      tags: ['Goods Receipts'],
      query: summaryQuerySchema,
      responses: [{ status: 200, description: 'The receiving summary.', schema: summaryResponseSchema }],
      errors: [
        { status: 400, description: 'Missing or malformed identifier', schema: errorSchema },
        { status: 401, description: 'Authentication required', schema: errorSchema },
        { status: 403, description: 'The caller does not hold pz.goodsReceipts.view', schema: errorSchema },
        { status: 404, description: 'No such goods receipt in the caller scope', schema: errorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: errorSchema },
      ],
    },
  },
}
