import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { runGoodsReceiptAction } from '../../../lib/actionRoute'
import type { GoodsReceipt } from '../../../data/entities'

/**
 * Confirmation is its own action with its own permission, not a status written through the
 * update endpoint (ADR-0006). The office calls this one; the floor calls
 * `/api/pz/receiving/confirm`, which carries the floor's own permission and dispatches the
 * same command (ADR-0011).
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['pz.goodsReceipts.confirm'] },
}

const confirmRequestSchema = z.object({
  id: z.string().uuid(),
  /**
   * Where the counted goods are put. Optional: left out, the warehouse's Default Destination
   * is used, and confirmation is refused when neither names an eligible location.
   */
  destinationLocationId: z.string().uuid().optional(),
})

const confirmResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('confirmed'),
  updatedAt: z.string().nullable(),
})

const errorSchema = z.object({ error: z.string() }).passthrough()

export async function POST(request: Request) {
  return runGoodsReceiptAction<z.infer<typeof confirmRequestSchema>, GoodsReceipt>(request, {
    commandId: 'pz.goodsReceipts.confirm',
    component: 'goods-receipt-confirm',
    requestSchema: confirmRequestSchema,
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
  summary: 'Confirm a goods receipt',
  methods: {
    POST: {
      summary: 'Confirm a goods receipt',
      description:
        'Finalises a goods receipt that is being received. Confirmation is one-way and there is no un-confirm: a confirmed document can no longer be updated or deleted. When the `wms_integration_procurement_goods_receipt` toggle is on it also starts the stock posting — the counted quantities of every pallet, summed per catalog variant, are posted into the given destination location by a subscriber after this request has committed, and the document reports `stockPostingStatus: pending` until that finishes. Confirmation is refused when the warehouse has no eligible destination, when no destination was chosen, or when any counted variant is tracked by lot or serial number. With the toggle off no stock moves and the document records that no posting applies. It emits `pz.goods_receipt.confirmed` carrying the header and its lines, after the write commits.',
      tags: ['Goods Receipts'],
      requestBody: { schema: confirmRequestSchema },
      responses: [{ status: 200, description: 'The goods receipt is confirmed.', schema: confirmResponseSchema }],
      errors: [
        { status: 400, description: 'Missing or malformed identifier or destination', schema: errorSchema },
        { status: 401, description: 'Authentication required', schema: errorSchema },
        { status: 403, description: 'The caller does not hold pz.goodsReceipts.confirm', schema: errorSchema },
        { status: 404, description: 'No such goods receipt in the caller scope', schema: errorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: errorSchema },
        {
          status: 409,
          description:
            'Already confirmed, has open pallets, has no lines, names a deleted warehouse, holds a stale version, has no usable destination, or counts a lot- or serial-tracked product',
          schema: errorSchema,
        },
      ],
    },
  },
}
