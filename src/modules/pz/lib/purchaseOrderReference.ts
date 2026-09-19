import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { E } from '@/.mercato/generated/entities.ids.generated'
import type { GoodsReceiptPurchaseOrderSnapshot } from '../data/entities'

/**
 * Resolving the Purchase Order line an announcement settles.
 *
 * `pz` does not import anything from `procurements`: it reads that module's records through
 * the query engine by their generated entity ids, exactly as it already reads `catalog`.
 * That keeps the reference a scalar id plus a snapshot (ADR-0004) and leaves purchasing free
 * to change its own tables.
 */

export type PurchaseOrderLineReference = {
  purchaseOrderId: string
  purchaseOrderLineId: string
  snapshot: GoodsReceiptPurchaseOrderSnapshot
  catalogVariantId: string
  /** The order line's ordered quantity, for a caller that wants to show it beside the count. */
  quantityOrdered: string
}

export type PurchaseOrderReferenceRequest = {
  purchaseOrderId: string
  purchaseOrderLineId: string
  /** The variant the announcing line is for; the order line has to agree. */
  catalogVariantId: string
}

export type PurchaseOrderReferenceFailure =
  | { reason: 'line_missing'; purchaseOrderLineId: string }
  | { reason: 'order_mismatch'; purchaseOrderLineId: string }
  | { reason: 'order_not_released'; purchaseOrderLineId: string }
  | { reason: 'variant_mismatch'; purchaseOrderLineId: string }

export type PurchaseOrderReferenceResult = {
  resolved: Map<string, PurchaseOrderLineReference>
  failures: PurchaseOrderReferenceFailure[]
}

type PurchaseOrderLineRow = {
  id: string
  purchase_order_id: string
  line_number: number
  catalog_variant_id: string
  quantity_ordered: string | number
}

type PurchaseOrderRow = {
  id: string
  document_number: string
  status: string
}

/**
 * Checks each requested reference and reports every problem rather than the first.
 *
 * Three things are verified, and none of them can be taken from the caller:
 *
 * - the line exists inside the caller's own tenant and organization;
 * - it really belongs to the order the caller named, so a valid line id cannot be paired
 *   with someone else's order number on the document;
 * - it is for the same product variant, so position 1 of an order cannot be settled by a
 *   delivery of something else entirely;
 * - and the order is `released`, because a draft is still being written and a cancelled
 *   order will not be delivered.
 */
export async function resolvePurchaseOrderReferences(
  ctx: CommandRuntimeContext,
  scope: { tenantId: string; organizationId: string },
  requests: readonly PurchaseOrderReferenceRequest[],
): Promise<PurchaseOrderReferenceResult> {
  const resolved = new Map<string, PurchaseOrderLineReference>()
  const failures: PurchaseOrderReferenceFailure[] = []
  const lineIds = Array.from(new Set(requests.map((request) => request.purchaseOrderLineId)))
  if (lineIds.length === 0) return { resolved, failures }

  const queryEngine = ctx.container.resolve<QueryEngine>('queryEngine')
  const lines = await queryEngine.query<PurchaseOrderLineRow>(E.procurements.purchase_order_line, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['id', 'purchase_order_id', 'line_number', 'catalog_variant_id', 'quantity_ordered'],
    filters: { id: { $in: lineIds } },
    page: { page: 1, pageSize: lineIds.length },
  })
  const linesById = new Map(lines.items.map((row) => [String(row.id), row]))

  const orderIds = Array.from(new Set(lines.items.map((row) => String(row.purchase_order_id))))
  const orders = orderIds.length === 0
    ? { items: [] as PurchaseOrderRow[] }
    : await queryEngine.query<PurchaseOrderRow>(E.procurements.purchase_order, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      fields: ['id', 'document_number', 'status'],
      filters: { id: { $in: orderIds } },
      page: { page: 1, pageSize: orderIds.length },
    })
  const ordersById = new Map(orders.items.map((row) => [String(row.id), row]))

  for (const request of requests) {
    const line = linesById.get(request.purchaseOrderLineId)
    if (!line) {
      failures.push({ reason: 'line_missing', purchaseOrderLineId: request.purchaseOrderLineId })
      continue
    }
    if (String(line.purchase_order_id) !== request.purchaseOrderId) {
      failures.push({ reason: 'order_mismatch', purchaseOrderLineId: request.purchaseOrderLineId })
      continue
    }
    const order = ordersById.get(String(line.purchase_order_id))
    if (!order) {
      failures.push({ reason: 'line_missing', purchaseOrderLineId: request.purchaseOrderLineId })
      continue
    }
    if (order.status !== 'released') {
      failures.push({ reason: 'order_not_released', purchaseOrderLineId: request.purchaseOrderLineId })
      continue
    }
    if (String(line.catalog_variant_id) !== request.catalogVariantId) {
      failures.push({ reason: 'variant_mismatch', purchaseOrderLineId: request.purchaseOrderLineId })
      continue
    }
    resolved.set(request.purchaseOrderLineId, {
      purchaseOrderId: String(line.purchase_order_id),
      purchaseOrderLineId: String(line.id),
      snapshot: {
        documentNumber: String(order.document_number),
        lineNumber: Number(line.line_number),
      },
      catalogVariantId: String(line.catalog_variant_id),
      quantityOrdered: String(line.quantity_ordered),
    })
  }

  return { resolved, failures }
}
