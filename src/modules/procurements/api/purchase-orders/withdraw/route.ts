import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  handlePurchaseOrderTransition,
  transitionErrorSchema,
  transitionRequestSchema,
} from '../transition'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['procurements.purchaseOrders.release'] },
}

const withdrawResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('draft'),
  updatedAt: z.string().nullable(),
})

export async function POST(request: Request) {
  return handlePurchaseOrderTransition(request, {
    commandId: 'procurements.purchaseOrders.withdraw',
    failureKey: 'procurements.purchaseOrders.errors.withdrawFailed',
    failureFallback: 'The purchase order could not be withdrawn to draft.',
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Purchase Orders',
  summary: 'Withdraw a purchase order to draft',
  methods: {
    POST: {
      summary: 'Withdraw a purchase order to draft',
      description:
        'Takes a released purchase order back to draft so it can be corrected, dropping the supplier and warehouse snapshots the release took. Send the record version in the `x-om-ext-optimistic-lock-expected-updated-at` header.',
      tags: ['Purchase Orders'],
      requestBody: { schema: transitionRequestSchema },
      responses: [{ status: 200, description: 'The purchase order is a draft again.', schema: withdrawResponseSchema }],
      errors: [
        { status: 400, description: 'Missing or malformed identifier', schema: transitionErrorSchema },
        { status: 401, description: 'Authentication required', schema: transitionErrorSchema },
        {
          status: 403,
          description: 'The caller does not hold procurements.purchaseOrders.release',
          schema: transitionErrorSchema,
        },
        { status: 404, description: 'No such purchase order in the caller scope', schema: transitionErrorSchema },
        { status: 422, description: 'The selected organization is no longer available', schema: transitionErrorSchema },
        {
          status: 409,
          description: 'The order is not released, or the caller holds a stale version',
          schema: transitionErrorSchema,
        },
      ],
    },
  },
}
