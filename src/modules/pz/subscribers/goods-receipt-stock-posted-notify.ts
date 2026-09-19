import { resolveNotificationService } from '@open-mercato/core/modules/notifications/lib/notificationService'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  buildStockPostedNotifications,
  type GoodsReceiptStockPostedPayload,
} from '../lib/stockPostedNotifications'

const logger = createLogger('pz').child({ component: 'stock-posted-notifications' })

type StockPostedEventContext = {
  resolve: <T = unknown>(name: string) => T
}

/**
 * Tells the office what reached the shelves.
 *
 * Persistent, because the bell is the only place a posting that ran minutes after the
 * confirmation announces itself: dropping it because a worker blinked would leave stock
 * moved and nobody told. Idempotent through the group key each notification carries, so a
 * redelivered event refreshes the existing bells rather than raising a second set.
 */
export const metadata = {
  event: 'pz.goods_receipt.stock_posted',
  persistent: true,
  id: 'pz:goods-receipt-stock-posted-notify',
}

/**
 * The event crosses a durable queue, so it arrives as JSON rather than as the object that
 * was emitted. Scope is read from it because a subscriber has no actor to derive one from,
 * and a payload missing any part of it is dropped rather than widened to "everyone".
 */
function parsePayload(payload: GoodsReceiptStockPostedPayload): GoodsReceiptStockPostedPayload | null {
  const id = typeof payload?.id === 'string' ? payload.id : null
  const tenantId = typeof payload?.tenantId === 'string' ? payload.tenantId : null
  const organizationId = typeof payload?.organizationId === 'string' ? payload.organizationId : null
  const postedLines = Array.isArray(payload?.postedLines) ? payload.postedLines : []
  if (!id || !tenantId || !organizationId || postedLines.length === 0) return null
  return {
    id,
    tenantId,
    organizationId,
    documentNumber: typeof payload.documentNumber === 'string' ? payload.documentNumber : '',
    postedLines,
  }
}

export default async function handle(
  payload: GoodsReceiptStockPostedPayload,
  ctx: StockPostedEventContext,
): Promise<void> {
  const event = parsePayload(payload)
  if (!event) return

  const notifications = resolveNotificationService(ctx)
  // Sequential on purpose: each SKU takes an advisory lock on its own group key, and a
  // fifty-line delivery firing fifty concurrent fan-outs would hold fifty connections to
  // save milliseconds on work nobody is waiting for.
  for (const notification of buildStockPostedNotifications(event)) {
    try {
      await notifications.createForFeature(notification, {
        tenantId: event.tenantId,
        organizationId: event.organizationId,
      })
    } catch (error) {
      // One SKU's bell is not worth losing the rest of the delivery's: the goods are already
      // in stock, and rethrowing would replay every notification this run already wrote.
      logger.error('Goods receipt stock posting notification failed', {
        err: error,
        goodsReceiptId: event.id,
        groupKey: notification.groupKey,
      })
    }
  }
}
