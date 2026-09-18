"use client"
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { formatDisplayDate } from '@open-mercato/ui/primitives/date-format'
import { fetchCrudList } from '@open-mercato/ui/backend/utils/crud'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { GoodsReceiptListItem } from '../lib/goodsReceiptListItem'
import { GOODS_RECEIPTS_ENTITY_ID, GOODS_RECEIPTS_TABLE_ID, useWarehouseNames } from './goodsReceiptsPresentation'

const PAGE_SIZE = 50

type GoodsReceiptRow = GoodsReceiptListItem & { warehouseLabel: string }

type GoodsReceiptsResponse = {
  items: GoodsReceiptListItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

const STATUS_VARIANTS: Record<GoodsReceiptListItem['status'], StatusBadgeVariant> = {
  draft: 'neutral',
  confirmed: 'success',
}

type Translate = ReturnType<typeof useT>

function buildColumns(t: Translate): ColumnDef<GoodsReceiptRow>[] {
  return [
    {
      accessorKey: 'documentNumber',
      header: t('pz.goodsReceipts.table.column.documentNumber'),
      meta: { priority: 1 },
    },
    {
      accessorKey: 'documentDate',
      header: t('pz.goodsReceipts.table.column.documentDate'),
      meta: { priority: 2 },
      cell: ({ getValue }) => {
        const value = getValue()
        const formatted = typeof value === 'string' ? formatDisplayDate(value) : null
        return formatted ?? '—'
      },
    },
    {
      accessorKey: 'supplierName',
      header: t('pz.goodsReceipts.table.column.supplier'),
      meta: { priority: 3 },
    },
    {
      accessorKey: 'warehouseLabel',
      header: t('pz.goodsReceipts.table.column.warehouse'),
      enableSorting: false,
      meta: { priority: 4 },
    },
    {
      accessorKey: 'status',
      header: t('pz.goodsReceipts.table.column.status'),
      meta: { priority: 5 },
      cell: ({ row }) => (
        <StatusBadge variant={STATUS_VARIANTS[row.original.status]} dot>
          {t(`pz.goodsReceipts.status.${row.original.status}`)}
        </StatusBadge>
      ),
    },
    {
      accessorKey: 'lineCount',
      header: t('pz.goodsReceipts.table.column.lineCount'),
      enableSorting: false,
      meta: { priority: 6 },
    },
  ]
}

export default function GoodsReceiptsTable() {
  const t = useT()
  const [page, setPage] = React.useState(1)
  const scopeVersion = useOrganizationScopeVersion()

  const { data, isLoading, error } = useQuery<GoodsReceiptsResponse>({
    queryKey: ['pz.goodsReceipts', page, scopeVersion],
    queryFn: async () =>
      fetchCrudList<GoodsReceiptListItem>('pz/goods-receipts', {
        page: String(page),
        pageSize: String(PAGE_SIZE),
      }),
  })

  const items = React.useMemo(() => data?.items ?? [], [data?.items])
  const warehouseNames = useWarehouseNames(items.map((item) => item.warehouseId))

  const rows = React.useMemo<GoodsReceiptRow[]>(
    () =>
      items.map((item) => ({
        ...item,
        // The snapshot is what a confirmed document means, so it wins over current
        // warehouse state; a Draft has none yet and resolves the live name instead.
        warehouseLabel:
          item.warehouseSnapshot?.name
          ?? warehouseNames.get(item.warehouseId)
          ?? t('pz.goodsReceipts.table.warehouse.unknown'),
      })),
    [items, t, warehouseNames],
  )

  const columns = React.useMemo(() => buildColumns(t), [t])

  return (
    <DataTable<GoodsReceiptRow>
      title={t('pz.goodsReceipts.page.title')}
      titleHeadingLevel={1}
      columns={columns}
      data={rows}
      entityId={GOODS_RECEIPTS_ENTITY_ID}
      extensionTableId={GOODS_RECEIPTS_TABLE_ID}
      isLoading={isLoading}
      error={error ? t('pz.goodsReceipts.table.error.load') : null}
      emptyState={(
        <EmptyState
          title={t('pz.goodsReceipts.table.empty.title')}
          description={t('pz.goodsReceipts.table.empty.description')}
        />
      )}
      pagination={{
        page,
        pageSize: PAGE_SIZE,
        total: data?.total ?? 0,
        totalPages: data?.totalPages ?? 0,
        onPageChange: setPage,
      }}
    />
  )
}
