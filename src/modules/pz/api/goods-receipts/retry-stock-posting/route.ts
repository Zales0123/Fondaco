import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { runGoodsReceiptAction } from '../../../lib/actionRoute'
import type { StockPostingResult } from '../../../commands/stockPosting'

/**
 * Retrying a failed Stock Posting is the office's job, not the floor's: a posting fails over
 * something only the office can fix — an unusable destination, a product `wms` will not
 * receive — and the floor's work ended when the counting did (ADR-0011).
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.confirm'] },
}

const retryRequestSchema = z.object({
  id: z.string().uuid(),
  /**
   * A different destination for this attempt. Accepted only while nothing of this delivery
   * has posted: the location is part of the movement idempotency key, so changing it after a
   * partial posting would stock the posted variants a second time.
   */
  destinationLocationId: z.string().uuid().optional(),
})

const retryResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['posted', 'failed']),
  posted: z.number().int(),
  reason: z.string().nullable(),
})

const errorSchema = z.object({ error: z.string() }).passthrough()

export async function POST(request: Request) {
  return runGoodsReceiptAction<z.infer<typeof retryRequestSchema>, StockPostingResult>(request, {
    commandId: 'pz.goodsReceipts.postStock',
    component: 'goods-receipt-retry-stock-posting',
    requestSchema: retryRequestSchema,
    toInput: (body) => ({ id: body.id, destinationLocationId: body.destinationLocationId ?? null }),
    toResponse: (result) => ({
      id: result.id,
      status: result.status,
      posted: result.posted,
      reason: result.reason,
    }),
    failureKey: 'pz.receiving.errors.retryFailed',
    failureFallback: 'The stock posting could not be retried.',
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Goods Receipts',
  summary: 'Retry the stock posting of a confirmed goods receipt',
  methods: {
    POST: {
      summary: 'Retry a stock posting',
      description:
        'Runs the stock posting again for a confirmed goods receipt whose posting is pending or failed. Retrying is safe: the counted quantities and the pinned destination are fixed at confirmation, so every movement already written is replayed as a no-op by the wms idempotency key and only the missing ones are posted. A different destination may be supplied only while nothing has posted yet. The response reports whether the posting finished and, when it did not, a stable reason code.',
      tags: ['Goods Receipts'],
      requestBody: { schema: retryRequestSchema },
      responses: [{ status: 200, description: 'The posting ran.', schema: retryResponseSchema }],
      errors: [
        { status: 400, description: 'Missing or malformed identifier or destination', schema: errorSchema },
        { status: 401, description: 'Authentication required', schema: errorSchema },
        { status: 403, description: 'The caller does not hold pz.goodsReceipts.confirm', schema: errorSchema },
        { status: 404, description: 'No such goods receipt in the caller scope', schema: errorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: errorSchema },
        {
          status: 409,
          description:
            'The receipt is not confirmed, its posting is already settled, or its destination can no longer be changed',
          schema: errorSchema,
        },
      ],
    },
  },
}
