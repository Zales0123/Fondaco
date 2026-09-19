/**
 * Turning a finished Stock Posting into the bells the office sees.
 *
 * One notification per SKU, not one per delivery: the office acts on products — a line that
 * landed short, a product nobody expected — and a single "delivery posted" bell would make
 * them open the document to find out which. Pure, so the fan-out can be read and tested
 * without a warehouse, a queue, or a notification service behind it.
 */

import { buildFeatureNotificationFromType } from '@open-mercato/core/modules/notifications/lib/notificationBuilder'
import { STOCK_POSTED_NOTIFICATION_TYPE, stockPostedNotificationType } from '../notifications'
import { formatQuantityForDisplay } from './quantity'
import type { PostableQuantity } from './stockPosting'

export { STOCK_POSTED_NOTIFICATION_TYPE }

/**
 * Who hears about it. The office reads goods receipts, so seeing one is what makes the
 * posting news rather than noise; `pz` owns the feature, so this never gates on a `wms` or
 * `warehouseman` id (ADR-0004).
 */
export const STOCK_POSTED_NOTIFICATION_FEATURE = 'pz.goodsReceipts.view'

const SOURCE_ENTITY_TYPE = 'pz:goods_receipt'

/** How a variant was named on the pallet it was counted onto. */
export type CountedVariantDescriptor = {
  catalogVariantId: string
  sku: string | null
  name: string | null
}

/** One variant that actually reached stock, with the words to describe it. */
export type PostedStockLine = CountedVariantDescriptor & {
  /** Decimal string at storage precision, as posted. */
  quantity: string
}

export type GoodsReceiptStockPostedPayload = {
  id: string
  tenantId: string
  organizationId: string
  documentNumber: string
  /** Only what this run put into stock — a partly failed run carries the part that landed. */
  postedLines: PostedStockLine[]
}

type StockPostedBodyVariables = {
  sku: string
  quantity: string
  product: string
  documentNumber: string
}

/**
 * The `createForFeature` call one posted SKU turns into. Everything the type catalogue
 * already states — the id, the keys, the icon, the severity — comes from the definition
 * rather than being restated here, so the bell cannot drift from the preferences screen.
 */
export type StockPostedNotification = ReturnType<typeof buildFeatureNotificationFromType> & {
  titleVariables: { sku: string }
  bodyVariables: StockPostedBodyVariables
  restrictRecipientsToOrganization: true
  channels: string[]
}

function trimmed(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 ? text : null
}

/**
 * Pairs what was posted with what it was called.
 *
 * The posting sums a variant across every Pallet of the document, so the names come from a
 * different list than the quantities and have to be joined back on. A pallet line counted
 * before its catalog snapshot was filled in contributes nothing, rather than blanking out a
 * SKU a later line does carry — a nameless bell is worse than a late-named one.
 */
export function describePostedLines(
  postable: readonly PostableQuantity[],
  counted: readonly CountedVariantDescriptor[],
): PostedStockLine[] {
  const descriptors = new Map<string, { sku: string | null; name: string | null }>()
  for (const line of counted) {
    const current = descriptors.get(line.catalogVariantId)
    descriptors.set(line.catalogVariantId, {
      sku: current?.sku ?? trimmed(line.sku),
      name: current?.name ?? trimmed(line.name),
    })
  }
  return postable.map((entry) => ({
    catalogVariantId: entry.catalogVariantId,
    sku: descriptors.get(entry.catalogVariantId)?.sku ?? null,
    name: descriptors.get(entry.catalogVariantId)?.name ?? null,
    quantity: entry.quantity,
  }))
}

/**
 * What the bell calls the product. The SKU is what the office recognises; the name is the
 * fallback a barcode-only variant leaves, and the id is the last resort — a notification
 * titled after nothing is one nobody can act on.
 */
export function resolveVariantLabel(line: PostedStockLine): string {
  return trimmed(line.sku) ?? trimmed(line.name) ?? line.catalogVariantId
}

/**
 * The group key that makes a retry idempotent.
 *
 * `wms` receives are idempotent, so a retry replays the movements it already wrote and the
 * posting loop reports those variants as posted again. Keying on the document and the
 * variant makes the notification service refresh the existing row instead of raising a
 * second bell, so a retry only adds the SKUs that were genuinely missing. A recipient who
 * dismissed the first one does get a fresh bell: the service only refreshes rows that are
 * still active, and re-telling somebody who binned the news beats losing it.
 */
function groupKeyFor(goodsReceiptId: string, catalogVariantId: string): string {
  return `${STOCK_POSTED_NOTIFICATION_TYPE}:${goodsReceiptId}:${catalogVariantId}`
}

export function buildStockPostedNotifications(
  payload: GoodsReceiptStockPostedPayload,
): StockPostedNotification[] {
  return payload.postedLines.map((line) => {
    const sku = resolveVariantLabel(line)
    const titleVariables = { sku }
    const bodyVariables: StockPostedBodyVariables = {
      sku,
      quantity: formatQuantityForDisplay(line.quantity),
      product: trimmed(line.name) ?? sku,
      documentNumber: payload.documentNumber,
    }
    return {
      ...buildFeatureNotificationFromType(stockPostedNotificationType, {
        requiredFeature: STOCK_POSTED_NOTIFICATION_FEATURE,
        titleVariables,
        bodyVariables,
        sourceEntityType: SOURCE_ENTITY_TYPE,
        sourceEntityId: payload.id,
        linkHref: `/backend/wms/goods-receipts/${payload.id}`,
        groupKey: groupKeyFor(payload.id, line.catalogVariantId),
      }),
      titleVariables,
      bodyVariables,
      // Another organization's staff may hold the feature tenant-wide; the delivery is not
      // their news, and the fan-out is told to re-check each candidate against this scope.
      restrictRecipientsToOrganization: true,
      channels: [...(stockPostedNotificationType.channels ?? [])],
    }
  })
}
