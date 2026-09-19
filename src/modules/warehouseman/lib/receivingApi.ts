"use client"
import { apiCall, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { buildFailedPostingsQuery, buildReceivingListQuery, type WarehouseFilter } from './receivingPanel'
import type { ReceivingExpectedLine } from './expectedContents'

export type { ReceivingExpectedLine } from './expectedContents'

export type StockPostingState = {
  status: 'not_applicable' | 'pending' | 'posted' | 'failed'
  postedAt: string | null
  reason: string | null
  locationId: string | null
}

export type ReceivingDocument = {
  id: string
  documentNumber: string
  documentDate: string | null
  supplierName: string
  warehouseId: string
  warehouseSnapshot: { name: string; code: string } | null
  palletCount: number
  stockPosting: StockPostingState
  /**
   * What the document says should arrive. Only a single-record read carries them; a list page
   * answers `null`, so "not loaded" and "expects nothing" never look the same.
   */
  lines: ReceivingExpectedLine[] | null
  updatedAt: string | null
}

export type PalletStatus = 'open' | 'closed'

export type Pallet = {
  id: string
  code: string
  label: string | null
  status: PalletStatus
  lineCount: number
  updatedAt: string | null
}

export type PalletLine = {
  id: string
  catalogVariantId: string
  /** Empty when the variant has neither a count-time snapshot nor a live catalog row. */
  name: string
  sku: string | null
  quantity: string
  updatedAt: string | null
}

/** What a pallet transition and a pallet creation answer with — never the whole list row. */
export type PalletWriteResult = {
  id: string
  code?: string
  status: PalletStatus
  updatedAt: string | null
}

export type PalletLineWriteResult = {
  id: string
  quantity: string
  updatedAt: string | null
}

export type PalletCodeMatch = {
  id: string
  code: string
  goodsReceiptId: string
  status: PalletStatus
}

export type ResolvedVariant = {
  catalogVariantId: string
  catalogProductId: string
  name: string | null
  sku: string | null
  barcode: string
}

export type VariantOption = { value: string; label: string }

/**
 * A refusal the panel has to react to by status — a 404 opens the product picker, a 409 on a
 * pallet code names another document, a 409 on a quantity reloads the row. `message` is the
 * server's already-localized text, or empty so every call site falls back to its own key.
 */
export class ReceivingApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ReceivingApiError'
  }
}

type ListResponse<T> = { items?: T[] }

async function readList<T>(url: string): Promise<T[]> {
  const call = await apiCall<ListResponse<T>>(url)
  if (!call.ok) throw toApiError(call.status, call.result)
  return call.result?.items ?? []
}

async function send<T>(
  url: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body: Record<string, unknown>,
  expectedVersion?: string | null,
  signal?: AbortSignal,
): Promise<T> {
  return withScopedApiRequestHeaders(buildOptimisticLockHeader(expectedVersion), async () => {
    const call = await apiCall<T>(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!call.ok) throw toApiError(call.status, call.result)
    return call.result as T
  })
}

function toApiError(status: number, payload: unknown): ReceivingApiError {
  const message = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : null
  return new ReceivingApiError(typeof message === 'string' ? message : '', status)
}

export async function fetchReceivingDocuments(warehouse: WarehouseFilter): Promise<ReceivingDocument[]> {
  const query = new URLSearchParams(buildReceivingListQuery(warehouse))
  return readList<ReceivingDocument>(`/api/pz/goods-receipts?${query.toString()}`)
}

export async function fetchReceivingDocument(id: string): Promise<ReceivingDocument | null> {
  const items = await readList<ReceivingDocument>(
    `/api/pz/goods-receipts?ids=${encodeURIComponent(id)}&pageSize=1`,
  )
  return items[0] ?? null
}

/** The confirmed deliveries whose goods never reached stock — the floor's only unfinished business. */
export async function fetchFailedPostings(warehouse: WarehouseFilter): Promise<ReceivingDocument[]> {
  const query = new URLSearchParams(buildFailedPostingsQuery(warehouse))
  return readList<ReceivingDocument>(`/api/pz/goods-receipts?${query.toString()}`)
}

/**
 * Finishes the delivery: confirms the document and starts the stock posting. The version is
 * what makes a completion fail closed when somebody counted onto it since this screen loaded.
 */
export async function confirmDelivery(input: {
  id: string
  destinationLocationId: string | null
  expectedVersion: string | null
}): Promise<{ id: string; status: string; updatedAt: string | null }> {
  return send<{ id: string; status: string; updatedAt: string | null }>(
    '/api/pz/receiving/confirm',
    'POST',
    input.destinationLocationId
      ? { id: input.id, destinationLocationId: input.destinationLocationId }
      : { id: input.id },
    input.expectedVersion,
  )
}

export async function fetchPallets(goodsReceiptId: string): Promise<Pallet[]> {
  return readList<Pallet>(`/api/pz/pallets?goodsReceiptId=${encodeURIComponent(goodsReceiptId)}&pageSize=100`)
}

export async function createPallet(goodsReceiptId: string): Promise<PalletWriteResult> {
  return send<PalletWriteResult>('/api/pz/pallets', 'POST', { goodsReceiptId })
}

export async function deletePallet(id: string, expectedVersion: string | null): Promise<void> {
  await send<{ id: string }>('/api/pz/pallets', 'DELETE', { id }, expectedVersion)
}

/** Throws 404 for a code nobody has, and 409 when the code belongs to another document. */
export async function findPalletByCode(code: string, goodsReceiptId: string): Promise<PalletCodeMatch> {
  const query = new URLSearchParams({ code, goodsReceiptId })
  const call = await apiCall<PalletCodeMatch>(`/api/pz/pallets/by-code?${query.toString()}`)
  if (!call.ok) throw toApiError(call.status, call.result)
  return call.result as PalletCodeMatch
}

/** The `label_printing` scope that resolves a pallet into the code printed on its sticker. */
const PALLET_LABEL_SCOPE = 'pz.pallet'

/**
 * Last resort against a request that never comes back.
 *
 * This is a backstop, not a patience setting: it stays ABOVE what the route can
 * legitimately take, so it does not abandon a slow print that is about to
 * succeed and report a failure for a label that did come out. The service
 * bounds itself at `openTimeoutMs` (30s) + `jobTimeoutMs` (60s) +
 * `closeTimeoutMs` (5s) = 95s, and the rest is slack for the work the route
 * does outside those bounds — resolving the label subject from the database,
 * rendering the barcode and rasterizing it. That slack is generous rather than
 * derived: those steps are sub-second in practice, so this cannot be a proof,
 * only a margin wide enough that hitting it means a hang.
 *
 * It does not make the wait pleasant — a dead printer still stalls the screen for
 * a minute and a half. Fixing that means not awaiting the print at all, which is
 * a change to when the effect runs, not to this bound.
 */
const PRINT_REQUEST_TIMEOUT_MS = 105_000

/**
 * Prints one pallet's label on the NiimBot. The printer is an exclusive resource, so a
 * concurrent job is refused with 409 and an unreachable one with 503; both arrive here as a
 * `ReceivingApiError` carrying the server's already-localized text. Every caller treats that
 * as a warning about the sticker — the pallet it belongs to is already committed.
 *
 * A silent request is the one case that is not a `ReceivingApiError`: it surfaces as the
 * abort's own `TimeoutError`, which callers report through their unknown-reason wording.
 */
export async function printPalletLabel(
  palletId: string,
  timeoutMs: number = PRINT_REQUEST_TIMEOUT_MS,
): Promise<void> {
  await send<{ ok: true; message: string }>(
    '/api/label_printing/print-label',
    'POST',
    { scope: PALLET_LABEL_SCOPE, id: palletId },
    null,
    AbortSignal.timeout(timeoutMs),
  )
}

export async function closePallet(id: string, expectedVersion: string | null): Promise<PalletWriteResult> {
  return send<PalletWriteResult>('/api/pz/pallets/close', 'POST', { id }, expectedVersion)
}

export async function reopenPallet(id: string, expectedVersion: string | null): Promise<PalletWriteResult> {
  return send<PalletWriteResult>('/api/pz/pallets/reopen', 'POST', { id }, expectedVersion)
}

export async function fetchPalletLines(palletId: string): Promise<PalletLine[]> {
  return readList<PalletLine>(`/api/pz/pallet-lines?palletId=${encodeURIComponent(palletId)}&pageSize=100`)
}

/** Adds to the (pallet, variant) row, creating it when this is the first scan of the product. */
export async function countPalletLine(input: {
  palletId: string
  catalogVariantId: string
  quantity: string
}): Promise<PalletLineWriteResult> {
  return send<PalletLineWriteResult>('/api/pz/pallet-lines', 'POST', input)
}

/** Replaces the counted quantity; the version is what makes a concurrent count answer 409. */
export async function updatePalletLine(input: {
  id: string
  quantity: string
  expectedVersion: string | null
}): Promise<PalletLineWriteResult> {
  return send<PalletLineWriteResult>('/api/pz/pallet-lines', 'PUT', { id: input.id, quantity: input.quantity }, input.expectedVersion)
}

export async function deletePalletLine(id: string, expectedVersion: string | null): Promise<void> {
  await send<{ id: string }>('/api/pz/pallet-lines', 'DELETE', { id }, expectedVersion)
}

/** Throws 404 when no catalog variant carries the barcode, which opens the product picker. */
export async function resolveVariantByBarcode(barcode: string): Promise<ResolvedVariant> {
  const call = await apiCall<ResolvedVariant>(
    `/api/pz/receiving/variant-by-barcode?barcode=${encodeURIComponent(barcode)}`,
  )
  if (!call.ok) throw toApiError(call.status, call.result)
  return call.result as ResolvedVariant
}

type CatalogVariantsResponse = {
  items: Array<{ id: string; name?: string | null; sku?: string | null }>
}

function variantLabel(item: CatalogVariantsResponse['items'][number]): string {
  const name = item.name?.trim() || item.id
  const sku = item.sku?.trim()
  return sku ? `${name} — ${sku}` : name
}

/**
 * The installed catalog variant option source, used only for the unknown-barcode fallback.
 * A failed lookup offers nothing rather than taking the counting screen down: the barcode
 * path is what the floor uses, and the picker is already the exceptional route.
 */
export async function searchCatalogVariants(query?: string): Promise<VariantOption[]> {
  const params = new URLSearchParams({ pageSize: '20', isActive: 'true' })
  if (query && query.trim()) params.set('search', query.trim())
  try {
    const data = await readApiResultOrThrow<CatalogVariantsResponse>(`/api/catalog/variants?${params.toString()}`)
    return (data?.items ?? []).map((item) => ({ value: item.id, label: variantLabel(item) }))
  } catch {
    return []
  }
}

type WarehousesResponse = {
  items: Array<{ id: string; name?: string | null; code?: string | null }>
}

function warehouseLabel(item: WarehousesResponse['items'][number]): string {
  const name = item.name?.trim() || item.id
  const code = item.code?.trim()
  return code ? `${name} (${code})` : name
}

/** The same Warehouse option source the goods receipt form uses, degrading the same way. */
export async function searchWarehouses(query?: string): Promise<VariantOption[]> {
  const params = new URLSearchParams({ pageSize: '50', isActive: 'true' })
  if (query && query.trim()) params.set('search', query.trim())
  try {
    const data = await readApiResultOrThrow<WarehousesResponse>(`/api/wms/warehouses?${params.toString()}`)
    return (data?.items ?? []).map((item) => ({ value: item.id, label: warehouseLabel(item) }))
  } catch {
    return []
  }
}

export async function resolveWarehouseLabel(warehouseId: string): Promise<string> {
  try {
    const data = await readApiResultOrThrow<WarehousesResponse>(
      `/api/wms/warehouses?ids=${encodeURIComponent(warehouseId)}&pageSize=1`,
    )
    const item = data?.items?.[0]
    return item ? warehouseLabel(item) : warehouseId
  } catch {
    return warehouseId
  }
}
