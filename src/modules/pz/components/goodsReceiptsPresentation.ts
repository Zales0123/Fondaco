"use client"
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'

export const GOODS_RECEIPTS_ENTITY_ID = 'pz:goods_receipt'
export const GOODS_RECEIPTS_TABLE_ID = 'pz.goodsReceipts'
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
