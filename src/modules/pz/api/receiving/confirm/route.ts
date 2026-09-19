import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { runGoodsReceiptAction } from '../../../lib/actionRoute'
import type { GoodsReceipt } from '../../../data/entities'

/**
 * The floor's way to finish a delivery. It dispatches the same confirm command the office's
 * endpoint dispatches — one transition with one set of rules — and differs only in the
 * permission it requires, so completing a counted delivery can be granted without handing
 * out every office confirm surface with it (ADR-0011).
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['pz.receiving.confirm'] },
}

const completeRequestSchema = z.object({
  id: z.string().uuid(),
  destinationLocationId: z.string().uuid().optional(),
})

const completeResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('confirmed'),
  updatedAt: z.string().nullable(),
})

const errorSchema = z.object({ error: z.string() }).passthrough()

export async function POST(request: Request) {
  return runGoodsReceiptAction<z.infer<typeof completeRequestSchema>, GoodsReceipt>(request, {
    commandId: 'pz.goodsReceipts.confirm',
    component: 'receiving-confirm',
    requestSchema: completeRequestSchema,
    toInput: (body) => ({ id: body.id, destinationLocationId: body.destinationLocationId ?? null }),
    toResponse: (result) => ({
      id: String(result.id),
      status: result.status,
      updatedAt: result.updatedAt?.toISOString() ?? null,
    }),
    failureKey: 'pz.goodsReceipts.errors.confirmFailed',
    failureFallback: 'The goods receipt could not be confirmed.',
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Goods Receipts',
  summary: 'Complete a delivery from the warehouseman panel',
  methods: {
    POST: {
      summary: 'Complete a delivery',
      description:
        'Finishes a delivery the floor has counted: it confirms the goods receipt and starts the stock posting, exactly as `/api/pz/goods-receipts/confirm` does, and is refused under exactly the same conditions. It exists so that completing a delivery is a separately grantable permission (`pz.receiving.confirm`) from confirming goods receipts in the back office. Send the record version in the `x-om-ext-optimistic-lock-expected-updated-at` header.',
      tags: ['Goods Receipts'],
      requestBody: { schema: completeRequestSchema },
      responses: [{ status: 200, description: 'The delivery is confirmed.', schema: completeResponseSchema }],
      errors: [
        { status: 400, description: 'Missing or malformed identifier or destination', schema: errorSchema },
        { status: 401, description: 'Authentication required', schema: errorSchema },
        { status: 403, description: 'The caller does not hold pz.receiving.confirm', schema: errorSchema },
        { status: 404, description: 'No such goods receipt in the caller scope', schema: errorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: errorSchema },
        {
          status: 409,
          description:
            'Not receiving, has open pallets, has no lines, holds a stale version, has no usable destination, or counts a lot- or serial-tracked product',
          schema: errorSchema,
        },
      ],
    },
  },
}
