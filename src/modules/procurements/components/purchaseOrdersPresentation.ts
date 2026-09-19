"use client"
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiCall, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { showRecordConflict, surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { extractOptimisticLockConflict } from '@open-mercato/ui/backend/utils/optimisticLock'
import type { StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import type { PurchaseOrderStatus } from '../data/entities'

export const PURCHASE_ORDERS_ENTITY_ID = 'procurements:purchase_order'
export const PURCHASE_ORDER_LINES_ENTITY_ID = 'procurements:purchase_order_line'
export const PURCHASE_ORDERS_MANAGE_FEATURE = 'procurements.purchaseOrders.manage'
export const PURCHASE_ORDERS_RELEASE_FEATURE = 'procurements.purchaseOrders.release'
export const PURCHASE_ORDERS_TABLE_ID = 'procurements.purchaseOrders'
export const PURCHASE_ORDER_LINES_TABLE_ID = 'procurements.purchaseOrderLines'
/** Shared so a screen that changes an order can invalidate the index it returns to. */
export const PURCHASE_ORDERS_QUERY_KEY = 'procurements.purchaseOrders'
export const PURCHASE_ORDER_LINES_QUERY_KEY = 'procurements.purchaseOrderLines'
export const PURCHASE_ORDERS_LIST_HREF = '/backend/purchases/orders'
export const PURCHASE_ORDERS_CREATE_HREF = `${PURCHASE_ORDERS_LIST_HREF}/create`
export const PURCHASE_ORDER_LINES_LIST_HREF = '/backend/purchases/order-lines'

/** Draft is unfinished, released is committed, cancelled is over — three different weights. */
export const PURCHASE_ORDER_STATUS_VARIANTS: Record<PurchaseOrderStatus, StatusBadgeVariant> = {
  draft: 'neutral',
  released: 'success',
  cancelled: 'error',
}

type WarehouseOptionsResponse = {
  items: Array<{ id: string; name: string }>
}

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map()

/**
 * Resolves Warehouse display names through the owning module's own list endpoint rather than
 * reading `wms` tables — a Purchase Order holds a scalar warehouse id and nothing more.
 *
 * The lookup degrades instead of failing: a caller holding the Purchase Order features but
 * not `wms.view` gets no names, and the caller renders its own fallback. An unreadable
 * warehouse must not turn a readable order list into an error page.
 */
export function useWarehouseNames(warehouseIds: readonly string[]): ReadonlyMap<string, string> {
  const ids = React.useMemo(
    () => Array.from(new Set(warehouseIds.filter((id) => typeof id === 'string' && id.length > 0))).sort(),
    [warehouseIds],
  )

  const { data } = useQuery<WarehouseOptionsResponse>({
    queryKey: ['procurements.warehouseNames', ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      try {
        return await readApiResultOrThrow<WarehouseOptionsResponse>(
          `/api/wms/warehouses?ids=${ids.join(',')}&pageSize=${ids.length}`,
        ) ?? { items: [] }
      } catch {
        return { items: [] }
      }
    },
  })

  return React.useMemo(() => {
    if (!data?.items?.length) return EMPTY_NAMES
    return new Map(data.items.map((item) => [item.id, item.name]))
  }, [data?.items])
}

export type PurchaseOrderPermissions = {
  canManage: boolean
  canRelease: boolean
}

const NO_PERMISSIONS: PurchaseOrderPermissions = { canManage: false, canRelease: false }

/**
 * Backend authorization is always the authority; this only stops the UI offering a door the
 * caller will be refused at. The check is wildcard-aware because it asks the server, which
 * resolves `procurements.*` and `*` grants the same way the routes do.
 *
 * Writing an order and committing the organization to it are separate grants, so both are
 * asked for at once and answered independently.
 */
export function usePurchaseOrderPermissions(): PurchaseOrderPermissions {
  const [permissions, setPermissions] = React.useState(NO_PERMISSIONS)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      const features = [PURCHASE_ORDERS_MANAGE_FEATURE, PURCHASE_ORDERS_RELEASE_FEATURE]
      try {
        const call = await apiCall<{ ok?: boolean; granted?: string[] }>('/api/auth/feature-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ features }),
        })
        if (cancelled) return
        // `ok` means every feature asked for was granted; otherwise only the listed ones were.
        const granted = new Set(Array.isArray(call.result?.granted) ? call.result.granted : [])
        const holds = (feature: string) => call.result?.ok === true || granted.has(feature)
        setPermissions({
          canManage: holds(PURCHASE_ORDERS_MANAGE_FEATURE),
          canRelease: holds(PURCHASE_ORDERS_RELEASE_FEATURE),
        })
      } catch {
        if (!cancelled) setPermissions(NO_PERMISSIONS)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  return permissions
}

export type PurchaseOrderTransition = 'release' | 'withdraw' | 'cancel'

/** Domain transitions carry the version the user saw so a stale action fails closed. */
export async function transitionPurchaseOrder(
  action: PurchaseOrderTransition,
  id: string,
  expectedVersion: string | null,
): Promise<void> {
  await withScopedApiRequestHeaders(buildOptimisticLockHeader(expectedVersion), async () => {
    const call = await apiCall<{
      error?: string
      code?: string
      currentUpdatedAt?: string
      expectedUpdatedAt?: string
    }>(`/api/procurements/purchase-orders/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!call.response.ok) {
      // No English fallback here: an empty message is what makes every caller fall back to
      // its own localized string rather than printing one this module hard-coded.
      throw Object.assign(new Error(call.result?.error ?? ''), call.result, { status: call.response.status })
    }
  })
}

export function surfacePurchaseOrderConflict(
  error: unknown,
  t: (key: string, fallback?: string) => string,
): boolean {
  const lock = extractOptimisticLockConflict(error)
  if (lock) {
    showRecordConflict({
      message: error instanceof Error ? error.message : lock.error,
      currentUpdatedAt: lock.currentUpdatedAt,
    })
    return true
  }
  return surfaceRecordConflict(error, t)
}

/**
 * Renders a stored decimal string as money in the document's own currency.
 *
 * The value never becomes a `number` on the way in: `Intl.NumberFormat` takes one, but the
 * string was produced by exact arithmetic on the server and parsing it back is the last place
 * a cent could go missing, so an unparseable value renders the placeholder instead of a
 * plausible wrong figure. The locale is passed explicitly so a Polish UI in an English browser
 * still prints Polish grouping, and server and client render the same text.
 */
export function formatMoney(
  value: string | null | undefined,
  currencyCode: string | null | undefined,
  locale: string,
  placeholder = '—',
): string {
  if (value == null || value === '') return placeholder
  const amount = Number(value)
  if (!Number.isFinite(amount)) return placeholder
  const currency = currencyCode?.trim()
  try {
    if (currency) {
      return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount)
    }
  } catch {
    // An unknown or malformed code must not take the row down; fall through to plain digits.
  }
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
}

/**
 * Renders a stored quantity without its trailing storage zeros: the column keeps four
 * decimals, but `12.0000` on screen reads as precision the buyer never typed.
 */
export function formatQuantity(value: string | null | undefined, placeholder = '—'): string {
  if (value == null || value === '') return placeholder
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}
