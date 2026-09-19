import { resolveNotificationService } from '@open-mercato/core/modules/notifications/lib/notificationService'
import {
  notifyStockPosted,
  type StockPostedEventPayload,
} from '../lib/stockPostingNotifications'

type ResolverContext = {
  resolve: <T = unknown>(name: string) => T
}

/**
 * Tells the office a delivery reached the shelves. The posting itself is settled and
 * committed by the time this runs, so nothing here can undo it and nothing here is retried
 * on its own account (ADR-0011).
 */
export const metadata = {
  event: 'pz.goods_receipt.stock_posted',
  persistent: true,
  id: 'pz:goods-receipt-stock-posted-notify',
}

export default async function handle(
  payload: StockPostedEventPayload,
  ctx: ResolverContext,
): Promise<void> {
  await notifyStockPosted(payload, { resolveService: () => resolveNotificationService(ctx) })
}
