import {
  postStockForConfirmedReceipt,
  type GoodsReceiptConfirmedPayload,
  type StockPostingEventContext,
} from '../lib/stockPostingAutomation'

/**
 * The subscriber ADR-0005 left room for. Confirming a goods receipt now starts a Stock
 * Posting, and this is where it runs: after the commit, so stock can never be moved for a
 * confirmation that did not happen, and durably, so a momentarily unavailable worker delays
 * the posting rather than losing it (ADR-0011).
 */
export const metadata = {
  event: 'pz.goods_receipt.confirmed',
  persistent: true,
  id: 'pz:goods-receipt-confirmed-post-stock',
}

export default async function handle(
  payload: GoodsReceiptConfirmedPayload,
  ctx: StockPostingEventContext,
): Promise<void> {
  await postStockForConfirmedReceipt(payload, ctx)
}
