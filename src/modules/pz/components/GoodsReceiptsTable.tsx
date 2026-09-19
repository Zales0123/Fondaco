"use client"
import * as React from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import type { SortingState } from '@tanstack/react-table'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { formatDisplayDate } from '@open-mercato/ui/primitives/date-format'
import { deleteCrud, fetchCrudList } from '@open-mercato/ui/backend/utils/crud'
import { readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
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
  confirmGoodsReceipt,
  GOODS_RECEIPTS_QUERY_KEY,
  useGoodsReceiptPermissions,
  useWarehouseNames,
} from './goodsReceiptsPresentation'

const PAGE_SIZE = 50
const QUERY_KEY = GOODS_RECEIPTS_QUERY_KEY
/** Long enough that typing a document number is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300

type WarehouseOptionsResponse = { items: Array<{ id: string; name?: string | null; code?: string | null }> }

type GoodsReceiptFilters = {
  status: string
  warehouseId: string
  documentDateFrom: string
  documentDateTo: string
}

const NO_FILTERS: GoodsReceiptFilters = { status: '', warehouseId: '', documentDateFrom: '', documentDateTo: '' }

/**
 * What the user thinks of as one filter. A date range is two fields and one decision, so
 * removing "the last filter" must take both ends of it away together.
 */
type FilterGroup = 'status' | 'warehouseId' | 'documentDate'

const FILTER_GROUPS: FilterGroup[] = ['status', 'warehouseId', 'documentDate']

const FILTER_GROUP_FIELDS: Record<FilterGroup, Partial<GoodsReceiptFilters>> = {
  status: { status: '' },
  warehouseId: { warehouseId: '' },
  documentDate: { documentDateFrom: '', documentDateTo: '' },
}

function isGroupSet(filters: GoodsReceiptFilters, group: FilterGroup): boolean {
  if (group === 'documentDate') return filters.documentDateFrom !== '' || filters.documentDateTo !== ''
  return filters[group] !== ''
}

function hasAnyFilter(filters: GoodsReceiptFilters, search: string): boolean {
  return search.trim().length > 0 || Object.values(filters).some((value) => value.length > 0)
}

async function loadWarehouseFilterOptions(query?: string) {
  const params = new URLSearchParams({ pageSize: '50' })
  if (query && query.trim()) params.set('search', query.trim())
  try {
    const data = await readApiResultOrThrow<WarehouseOptionsResponse>(`/api/wms/warehouses?${params.toString()}`)
    return (data?.items ?? []).map((item) => ({
      value: item.id,
      label: item.code?.trim() ? `${item.name?.trim() || item.id} (${item.code.trim()})` : (item.name?.trim() || item.id),
    }))
  } catch {
    // A warehouse list the caller may not read must not take the filter bar down with it.
    return []
  }
}

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
      enableSorting: true,
      meta: { priority: 1 },
    },
    {
      accessorKey: 'documentDate',
      header: t('pz.goodsReceipts.table.column.documentDate'),
      enableSorting: true,
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
      // Supplier is searchable rather than sortable: the API sorts on the three columns the
      // spec names, and offering a header that the server would ignore is a broken promise.
      enableSorting: false,
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
      enableSorting: true,
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
  const [searchInput, setSearchInput] = React.useState('')
  const [search, setSearch] = React.useState('')
  const [filters, setFilters] = React.useState<GoodsReceiptFilters>(NO_FILTERS)
  // Sorting is server-side, so the table only reports what the user asked for; an empty
  // state means "whatever the API calls default", which is Document Date descending.
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [appliedOrder, setAppliedOrder] = React.useState<FilterGroup[]>([])
  const scopeVersion = useOrganizationScopeVersion()

  // Typing a document number should be one request, not one per character.
  React.useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  // Any narrowing invalidates the page the user is on: page 7 of the old result set is
  // rarely page 7 of the new one, and is usually past its end.
  React.useEffect(() => { setPage(1) }, [search, filters, sorting])

  const { data, isLoading, error } = useQuery<GoodsReceiptsResponse>({
    queryKey: [QUERY_KEY, page, search, filters, sorting, scopeVersion],
    queryFn: async () => {
      const params: Record<string, string> = {
        page: String(page),
        pageSize: String(PAGE_SIZE),
      }
      if (search.trim()) params.search = search.trim()
      if (filters.status) params.status = filters.status
      if (filters.warehouseId) params.warehouseId = filters.warehouseId
      if (filters.documentDateFrom) params.documentDateFrom = filters.documentDateFrom
      if (filters.documentDateTo) params.documentDateTo = filters.documentDateTo
      const [sort] = sorting
      if (sort) {
        params.sortField = sort.id
        params.sortDir = sort.desc ? 'desc' : 'asc'
      }
      return fetchCrudList<GoodsReceiptListItem>('pz/goods-receipts', params)
    },
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
  const viewHref = (row: GoodsReceiptRow) => `${GOODS_RECEIPTS_LIST_HREF}/${row.id}`
  const { canManage, canConfirm } = useGoodsReceiptPermissions()
  const createLabel = t('pz.goodsReceipts.table.actions.create')
  // Offering a create action to someone the create page will refuse is a dead end, not a
  // permission check — the route metadata stays the authority either way.
  const createAction = canManage ? (
    <Button asChild>
      <Link href={GOODS_RECEIPTS_CREATE_HREF}>{createLabel}</Link>
    </Button>
  ) : null

  const filterDefs = React.useMemo<FilterDef[]>(() => [
    {
      id: 'status',
      label: t('pz.goodsReceipts.table.filter.status'),
      type: 'select',
      placeholder: t('pz.goodsReceipts.table.filter.status.any'),
      options: [
        { value: 'draft', label: t('pz.goodsReceipts.status.draft') },
        { value: 'confirmed', label: t('pz.goodsReceipts.status.confirmed') },
      ],
    },
    {
      id: 'warehouseId',
      label: t('pz.goodsReceipts.table.filter.warehouse'),
      type: 'combobox',
      placeholder: t('pz.goodsReceipts.table.filter.warehouse.placeholder'),
      loadOptions: loadWarehouseFilterOptions,
    },
    {
      id: 'documentDate',
      label: t('pz.goodsReceipts.table.filter.documentDate'),
      type: 'dateRange',
    },
  ], [t])

  // The bar speaks `{ from, to }` for a range; the API takes the two ends separately.
  const filterValues = React.useMemo<FilterValues>(() => ({
    status: filters.status || undefined,
    warehouseId: filters.warehouseId || undefined,
    documentDate: filters.documentDateFrom || filters.documentDateTo
      ? { from: filters.documentDateFrom || undefined, to: filters.documentDateTo || undefined }
      : undefined,
  }), [filters])

  const handleFiltersApply = React.useCallback((values: FilterValues) => {
    const range = (values.documentDate ?? {}) as { from?: string; to?: string }
    const next: GoodsReceiptFilters = {
      status: typeof values.status === 'string' ? values.status : '',
      warehouseId: typeof values.warehouseId === 'string' ? values.warehouseId : '',
      documentDateFrom: typeof range.from === 'string' ? range.from : '',
      documentDateTo: typeof range.to === 'string' ? range.to : '',
    }
    setFilters((current) => {
      // "Remove the last filter" needs to know which one that was, and the bar hands over
      // the whole set rather than the change, so the newly-filled fields are the answer.
      const added = FILTER_GROUPS.filter((group) => !isGroupSet(current, group) && isGroupSet(next, group))
      if (added.length > 0) setAppliedOrder((order) => [...order.filter((g) => !added.includes(g)), ...added])
      const cleared = FILTER_GROUPS.filter((group) => isGroupSet(current, group) && !isGroupSet(next, group))
      if (cleared.length > 0) setAppliedOrder((order) => order.filter((group) => !cleared.includes(group)))
      return next
    })
  }, [])

  const clearFilters = React.useCallback(() => {
    setFilters(NO_FILTERS)
    setAppliedOrder([])
    setSearchInput('')
    setSearch('')
  }, [])

  const removeLastFilter = React.useCallback(() => {
    setAppliedOrder((order) => {
      const last = order[order.length - 1]
      if (!last) return order
      setFilters((current) => ({ ...current, ...FILTER_GROUP_FIELDS[last] }))
      return order.slice(0, -1)
    })
  }, [])

  const filtering = hasAnyFilter(filters, search)

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

  const handleConfirm = React.useCallback(async (row: GoodsReceiptRow) => {
    const acknowledged = await confirm({
      title: t('pz.goodsReceipts.table.confirm.confirm.title'),
      description: t('pz.goodsReceipts.table.confirm.confirm.description', undefined, {
        documentNumber: row.documentNumber,
      }),
      confirmText: t('pz.goodsReceipts.table.confirm.confirm.action'),
    })
    if (!acknowledged) return
    try {
      await confirmGoodsReceipt(row.id, row.updatedAt)
      // Awaited, so the row is never left showing Draft and offering an action the server
      // has just closed off for good.
      await queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
      flash(t('pz.goodsReceipts.form.flash.confirmed'), 'success')
    } catch (err) {
      if (surfaceRecordConflict(err, t)) {
        queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
        return
      }
      flash(err instanceof Error && err.message ? err.message : t('pz.goodsReceipts.table.error.confirm'), 'error')
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
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        searchPlaceholder={t('pz.goodsReceipts.table.search.placeholder')}
        filters={filterDefs}
        filterValues={filterValues}
        onFiltersApply={handleFiltersApply}
        onFiltersClear={clearFilters}
        sortable
        manualSorting
        sorting={sorting}
        onSortingChange={setSorting}
        // Two different nothings. This one is "there are no goods receipts at all", which
        // invites the user to write the first one.
        emptyState={(
          <EmptyState
            title={t('pz.goodsReceipts.table.empty.title')}
            description={t('pz.goodsReceipts.table.empty.description')}
            actions={createAction}
          />
        )}
        // The other nothing is "your filters match none of them", which must not offer to
        // create a document the user did not come here to write. The shared surface says so
        // in the product's own words and offers the way back out.
        filterAwareEmptyState={{
          active: filtering,
          entityNamePlural: t('pz.goodsReceipts.page.title'),
          canRemoveLast: appliedOrder.length > 0,
          onClearAll: clearFilters,
          onRemoveLast: removeLastFilter,
        }}
        // No `onRowClick`: the row action carries the navigation, named explicitly because
        // the fallback matches an action's English label and would stop working in Polish.
        // A draft opens its editor and a confirmed document opens its read-only view, so
        // every row leads somewhere.
        rowClickActionIds={['pz.goodsReceipts.edit', 'pz.goodsReceipts.view']}
        rowActions={(row) => {
          // Only offer what the row can actually do: the edit route refuses a confirmed
          // document and a caller without the manage feature, so pointing at it anyway
          // would just be a door that closes in the user's face.
          const isDraft = row.status === 'draft'
          const items = []
          // A confirmed document is read-only, so it gets a View rather than an Edit. The
          // view needs no more than the feature that put the row on screen.
          if (!isDraft) {
            items.push({
              id: 'pz.goodsReceipts.view',
              label: t('pz.goodsReceipts.table.actions.view'),
              href: viewHref(row),
            })
          }
          if (canManage && isDraft) {
            items.push(
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
            )
          }
          // Confirming is a separate grant from editing, so someone who may finalise a
          // delivery without entering one still gets the action.
          if (canConfirm && isDraft) {
            items.push({
              id: 'pz.goodsReceipts.confirm',
              label: t('pz.goodsReceipts.table.actions.confirm'),
              onSelect: () => { void handleConfirm(row) },
            })
          }
          if (items.length === 0) return null
          return <RowActions items={items} />
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
