"use client"
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { ReceivingApiError, type ResolvedVariant } from './receivingApi'
import { summarizeStock, type InventoryBalanceRow, type StockSummary } from './productScan'

export type { ResolvedVariant } from './receivingApi'

/**
 * Balances come back one bucket per (warehouse, location, lot, serial), so one variant in
 * one warehouse is routinely several rows. 100 is the ceiling the installed list schema
 * allows and is far above anything a single scanned product realistically has.
 */
const BALANCE_PAGE_SIZE = 100

type BalancesResponse = { items?: InventoryBalanceRow[] }

/**
 * What one scanned code turns into on this screen: the product the barcode names, and how
 * much of it is in stock. The stock is nullable because the two are separate reads — the
 * product is what the warehouseman scanned for, and throwing it away because the stock read
 * failed would be the worse of the two outcomes.
 */
export type ScannedProduct = {
  variant: ResolvedVariant
  /** Null when the stock read itself failed; the screen says so rather than showing a zero. */
  stock: StockSummary | null
}

/**
 * Every bucket the organization holds of one variant, summed. Read through the installed
 * WMS balances endpoint under the caller's own scope — a Warehouseman holds `wms.view`,
 * which is what gates it, so nothing here widens what they may see.
 */
export async function fetchVariantStock(catalogVariantId: string): Promise<StockSummary> {
  const query = new URLSearchParams({
    catalogVariantId,
    page: '1',
    pageSize: String(BALANCE_PAGE_SIZE),
  })
  const call = await apiCall<BalancesResponse>(`/api/wms/inventory/balances?${query.toString()}`)
  if (!call.ok) {
    const message = call.result && typeof call.result === 'object'
      ? (call.result as { error?: unknown }).error
      : null
    throw new ReceivingApiError(typeof message === 'string' ? message : '', call.status)
  }
  return summarizeStock(call.result?.items ?? [])
}
