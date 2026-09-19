import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { runGoodsReceiptAction } from '../../../lib/actionRoute'
import type { GoodsReceipt } from '../../../data/entities'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.manage'] },
}

const releaseRequestSchema = z.object({
  id: z.string().uuid(),
})

const releaseResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('receiving'),
  updatedAt: z.string().nullable(),
})

const errorSchema = z.object({ error: z.string() }).passthrough()

export async function POST(request: Request) {
  return runGoodsReceiptAction<z.infer<typeof releaseRequestSchema>, GoodsReceipt>(request, {
    commandId: 'pz.goodsReceipts.release',
    component: 'goods-receipt-release',
    requestSchema: releaseRequestSchema,
    toInput: (body) => ({ id: body.id }),
    toResponse: (result) => ({
      id: String(result.id),
      status: result.status,
      updatedAt: result.updatedAt?.toISOString() ?? null,
    }),
    failureKey: 'pz.goodsReceipts.errors.releaseFailed',
    failureFallback: 'The goods receipt could not be released.',
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Goods Receipts',
  summary: 'Release a goods receipt',
  methods: {
    POST: {
      summary: 'Release a goods receipt',
      description:
        'Releases a draft goods receipt to the floor for counting. The document and its lines become immutable while receiving. Send the record version in the `x-om-ext-optimistic-lock-expected-updated-at` header. Withdrawal is possible while no pallet exists. This action moves no stock.',
      tags: ['Goods Receipts'],
      requestBody: { schema: releaseRequestSchema },
      responses: [{ status: 200, description: 'The goods receipt is receiving.', schema: releaseResponseSchema }],
      errors: [
        { status: 400, description: 'Missing or malformed identifier', schema: errorSchema },
        { status: 401, description: 'Authentication required', schema: errorSchema },
        { status: 403, description: 'The caller does not hold pz.goodsReceipts.manage', schema: errorSchema },
        { status: 404, description: 'No such goods receipt in the caller scope', schema: errorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: errorSchema },
        {
          status: 409,
          description: 'The receipt is not draft, or the caller holds a stale version',
          schema: errorSchema,
        },
      ],
    },
  },
}
