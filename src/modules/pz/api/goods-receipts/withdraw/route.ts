import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { runGoodsReceiptAction } from '../../../lib/actionRoute'
import type { GoodsReceipt } from '../../../data/entities'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.manage'] },
}

const withdrawRequestSchema = z.object({
  id: z.string().uuid(),
})

const withdrawResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('draft'),
  updatedAt: z.string().nullable(),
})

const errorSchema = z.object({ error: z.string() }).passthrough()

export async function POST(request: Request) {
  return runGoodsReceiptAction<z.infer<typeof withdrawRequestSchema>, GoodsReceipt>(request, {
    commandId: 'pz.goodsReceipts.withdraw',
    component: 'goods-receipt-withdraw',
    requestSchema: withdrawRequestSchema,
    toInput: (body) => ({ id: body.id }),
    toResponse: (result) => ({
      id: String(result.id),
      status: result.status,
      updatedAt: result.updatedAt?.toISOString() ?? null,
    }),
    failureKey: 'pz.goodsReceipts.errors.withdrawFailed',
    failureFallback: 'The goods receipt could not be withdrawn.',
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Goods Receipts',
  summary: 'Withdraw a goods receipt',
  methods: {
    POST: {
      summary: 'Withdraw a goods receipt',
      description:
        'Withdraws a receiving goods receipt to draft while it has no pallets, allowing the document and its lines to be edited again. Send the record version in the `x-om-ext-optimistic-lock-expected-updated-at` header. This action moves no stock.',
      tags: ['Goods Receipts'],
      requestBody: { schema: withdrawRequestSchema },
      responses: [{ status: 200, description: 'The goods receipt is draft.', schema: withdrawResponseSchema }],
      errors: [
        { status: 400, description: 'Missing or malformed identifier', schema: errorSchema },
        { status: 401, description: 'Authentication required', schema: errorSchema },
        { status: 403, description: 'The caller does not hold pz.goodsReceipts.manage', schema: errorSchema },
        { status: 404, description: 'No such goods receipt in the caller scope', schema: errorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: errorSchema },
        {
          status: 409,
          description: 'The receipt is not receiving, has a pallet, or the caller holds a stale version',
          schema: errorSchema,
        },
      ],
    },
  },
}
