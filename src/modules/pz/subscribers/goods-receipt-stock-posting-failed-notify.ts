import { resolveNotificationService } from '@open-mercato/core/modules/notifications/lib/notificationService'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import {
  notifyStockPostingFailed,
  type StockPostingFailedEventPayload,
} from '../lib/stockPostingNotifications'

type ResolverContext = {
  resolve: <T = unknown>(name: string) => T
}

/**
 * Puts a refused posting in front of the office, because nobody else will look: the floor's
 * work ended when the counting did, and the document sits at `failed` until somebody retries
 * it from the panel. Only a settled failure gets here — a transient one leaves the posting
 * pending and is retried by the durable queue instead of announced (ADR-0011).
 */
export const metadata = {
  event: 'pz.goods_receipt.stock_posting_failed',
  persistent: true,
  id: 'pz:goods-receipt-stock-posting-failed-notify',
}

export default async function handle(
  payload: StockPostingFailedEventPayload,
  ctx: ResolverContext,
): Promise<void> {
  const { translate } = await resolveTranslations()
  await notifyStockPostingFailed(payload, {
    resolveService: () => resolveNotificationService(ctx),
    translate,
  })
}
