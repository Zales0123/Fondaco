"use client"
import * as React from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { formatDisplayDate } from '@open-mercato/ui/primitives/date-format'
import { deleteCrud, fetchCrudList } from '@open-mercato/ui/backend/utils/crud'
import { withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import type { GoodsReceiptListItem } from '../lib/goodsReceiptListItem'
import {
  GOODS_RECEIPTS_CREATE_HREF,
  GOODS_RECEIPTS_ENTITY_ID,
  GOODS_RECEIPTS_LIST_HREF,
  GOODS_RECEIPTS_TABLE_ID,
  useCanManageGoodsReceipts,
  useWarehouseNames,
} from './goodsReceiptsPresentation'

const PAGE_SIZE = 50
const QUERY_KEY = 'pz.goodsReceipts'

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

function buildColumns(t: Translate, locale: string): ColumnDef<GoodsReceiptRow>[] {
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
        // Without the app locale this falls back to the browser's, so a Polish UI in an
        // English browser would print English dates.
        const formatted = typeof value === 'string' ? formatDisplayDate(value, locale) : null
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
  const locale = useLocale()
  const queryClient = useQueryClient()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [page, setPage] = React.useState(1)
  const scopeVersion = useOrganizationScopeVersion()

  const { data, isLoading, error } = useQuery<GoodsReceiptsResponse>({
    queryKey: [QUERY_KEY, page, scopeVersion],
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

  const columns = React.useMemo(() => buildColumns(t, locale), [locale, t])
  const editHref = (row: GoodsReceiptRow) => `${GOODS_RECEIPTS_LIST_HREF}/${row.id}/edit`
  const canManage = useCanManageGoodsReceipts()
  const createLabel = t('pz.goodsReceipts.table.actions.create')
  // Offering a create action to someone the create page will refuse is a dead end, not a
  // permission check — the route metadata stays the authority either way.
  const createAction = canManage ? (
    <Button asChild>
      <Link href={GOODS_RECEIPTS_CREATE_HREF}>{createLabel}</Link>
    </Button>
  ) : null

  const handleDelete = React.useCallback(async (row: GoodsReceiptRow) => {
    const confirmed = await confirm({
      title: t('pz.goodsReceipts.table.confirm.delete.title'),
      description: t('pz.goodsReceipts.table.confirm.delete.description', undefined, {
        documentNumber: row.documentNumber,
      }),
      variant: 'destructive',
    })
    if (!confirmed) return
    try {
      // The row carries its own version, so a list rendered before someone else edited the
      // document fails with a conflict instead of deleting a draft this user never saw.
      await withScopedApiRequestHeaders(
        buildOptimisticLockHeader(row.updatedAt),
        () => deleteCrud('pz/goods-receipts', row.id),
      )
      flash(t('pz.goodsReceipts.form.flash.deleted'), 'success')
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
    } catch (err) {
      if (surfaceRecordConflict(err, t)) {
        queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
        return
      }
      flash(err instanceof Error && err.message ? err.message : t('pz.goodsReceipts.table.error.delete'), 'error')
    }
  }, [confirm, queryClient, t])


  return (
    <>
      <DataTable<GoodsReceiptRow>
        title={t('pz.goodsReceipts.page.title')}
        titleHeadingLevel={1}
        actions={createAction}
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
            actions={createAction}
          />
        )}
        // No `onRowClick`: `DataTable` makes every row look clickable as soon as one is
        // supplied, and a confirmed row has nowhere to go yet. The Edit row action carries
        // the navigation for the rows that do — named explicitly, because the fallback
        // matches an action's English label and would stop working in Polish.
        rowClickActionIds={['pz.goodsReceipts.edit']}
        rowActions={(row) => {
          // Only offer what the row can actually do: the edit route refuses a confirmed
          // document and a caller without the manage feature, so pointing at it anyway
          // would just be a door that closes in the user's face.
          const editable = canManage && row.status === 'draft'
          if (!editable) return null
          return (
            <RowActions
              items={[
                {
                  id: 'pz.goodsReceipts.edit',
                  label: t('pz.goodsReceipts.table.actions.edit'),
                  href: editHref(row),
                },
                {
                  id: 'pz.goodsReceipts.delete',
                  label: t('pz.goodsReceipts.table.actions.delete'),
                  destructive: true,
                  onSelect: () => { void handleDelete(row) },
                },
              ]}
            />
          )
        }}
        pagination={{
          page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          totalPages: data?.totalPages ?? 0,
          onPageChange: setPage,
        }}
      />
      {ConfirmDialogElement}
    </>
  )
}
