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

const releaseResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('released'),
  updatedAt: z.string().nullable(),
})

export async function POST(request: Request) {
  return handlePurchaseOrderTransition(request, {
    commandId: 'procurements.purchaseOrders.release',
    failureKey: 'procurements.purchaseOrders.errors.releaseFailed',
    failureFallback: 'The purchase order could not be released.',
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Purchase Orders',
  summary: 'Release a purchase order',
  methods: {
    POST: {
      summary: 'Release a purchase order',
      description:
        'Releases a draft purchase order: the document and its lines become immutable and the supplier and warehouse snapshots are taken. Send the record version in the `x-om-ext-optimistic-lock-expected-updated-at` header. This does not send anything to the supplier and moves no stock.',
      tags: ['Purchase Orders'],
      requestBody: { schema: transitionRequestSchema },
      responses: [{ status: 200, description: 'The purchase order is released.', schema: releaseResponseSchema }],
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
          description: 'The order is not a draft, has no lines, names a missing warehouse, or the caller holds a stale version',
          schema: transitionErrorSchema,
        },
      ],
    },
  },
}
