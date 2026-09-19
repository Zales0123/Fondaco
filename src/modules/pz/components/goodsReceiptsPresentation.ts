"use client"
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiCall, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { showRecordConflict, surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { extractOptimisticLockConflict } from '@open-mercato/ui/backend/utils/optimisticLock'

export const GOODS_RECEIPTS_ENTITY_ID = 'pz:goods_receipt'
export const GOODS_RECEIPTS_MANAGE_FEATURE = 'pz.goodsReceipts.manage'
export const GOODS_RECEIPTS_CONFIRM_FEATURE = 'pz.goodsReceipts.confirm'
export const GOODS_RECEIPTS_TABLE_ID = 'pz.goodsReceipts'
/** Shared so a screen that changes a goods receipt can invalidate the index it returns to. */
export const GOODS_RECEIPTS_QUERY_KEY = 'pz.goodsReceipts'
export const GOODS_RECEIPTS_LIST_HREF = '/backend/wms/goods-receipts'
export const GOODS_RECEIPTS_CREATE_HREF = `${GOODS_RECEIPTS_LIST_HREF}/create`

type WarehouseOptionsResponse = {
  items: Array<{ id: string; name: string }>
}

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map()

/**
 * Resolves Warehouse display names through the owning module's own list endpoint rather
 * than reading `wms` tables — a Goods Receipt holds a scalar warehouse id and nothing more
 * (ADR-0004).
 *
 * The lookup degrades instead of failing: a caller holding the Goods Receipt features but
 * not `wms.view` gets no names, and the caller renders its own fallback. An unreadable
 * warehouse must not turn a readable document list into an error page.
 */
export function useWarehouseNames(warehouseIds: readonly string[]): ReadonlyMap<string, string> {
  const ids = React.useMemo(
    () => Array.from(new Set(warehouseIds.filter((id) => typeof id === 'string' && id.length > 0))).sort(),
    [warehouseIds],
  )

  const { data } = useQuery<WarehouseOptionsResponse>({
    queryKey: ['pz.warehouseNames', ids],
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

export type GoodsReceiptPermissions = {
  canManage: boolean
  canConfirm: boolean
}

const NO_PERMISSIONS: GoodsReceiptPermissions = { canManage: false, canConfirm: false }

/**
 * Backend authorization is always the authority; this only stops the UI offering a door the
 * caller will be refused at. The check is wildcard-aware because it asks the server, which
 * resolves `pz.*` and `*` grants the same way the routes do.
 *
 * Editing and confirming are separate grants — a warehouse clerk may enter deliveries
 * without being the person who finalises them (ADR-0006) — so both are asked for at once
 * and answered independently.
 */
export function useGoodsReceiptPermissions(): GoodsReceiptPermissions {
  const [permissions, setPermissions] = React.useState(NO_PERMISSIONS)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      const features = [GOODS_RECEIPTS_MANAGE_FEATURE, GOODS_RECEIPTS_CONFIRM_FEATURE]
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
          canManage: holds(GOODS_RECEIPTS_MANAGE_FEATURE),
          canConfirm: holds(GOODS_RECEIPTS_CONFIRM_FEATURE),
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

/** Domain transitions carry the version the user saw so a stale action fails closed. */
export async function transitionGoodsReceipt(action: 'release' | 'withdraw' | 'confirm', id: string, expectedVersion: string | null): Promise<void> {
  await withScopedApiRequestHeaders(buildOptimisticLockHeader(expectedVersion), async () => {
    const call = await apiCall<{
      error?: string
      code?: string
      currentUpdatedAt?: string
      expectedUpdatedAt?: string
    }>(`/api/pz/goods-receipts/${action}`, {
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

export function confirmGoodsReceipt(id: string, expectedVersion: string | null): Promise<void> {
  return transitionGoodsReceipt('confirm', id, expectedVersion)
}

export function surfaceGoodsReceiptConflict(error: unknown, t: (key: string, fallback?: string) => string): boolean {
  const lock = extractOptimisticLockConflict(error)
  if (lock) {
    showRecordConflict({ message: error instanceof Error ? error.message : lock.error, currentUpdatedAt: lock.currentUpdatedAt })
    return true
  }
  return surfaceRecordConflict(error, t)
}
