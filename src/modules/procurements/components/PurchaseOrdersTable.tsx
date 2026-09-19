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
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { formatDisplayDate } from '@open-mercato/ui/primitives/date-format'
import { deleteCrud, fetchCrudList } from '@open-mercato/ui/backend/utils/crud'
import { readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import type { PurchaseOrderListItem } from '../lib/purchaseOrderListItem'
import {
  PURCHASE_ORDERS_CREATE_HREF,
  PURCHASE_ORDERS_ENTITY_ID,
  PURCHASE_ORDERS_LIST_HREF,
  PURCHASE_ORDERS_QUERY_KEY,
  PURCHASE_ORDERS_TABLE_ID,
  PURCHASE_ORDER_STATUS_VARIANTS,
  formatMoney,
  surfacePurchaseOrderConflict,
  transitionPurchaseOrder,
  usePurchaseOrderPermissions,
  useWarehouseNames,
} from './purchaseOrdersPresentation'

const PAGE_SIZE = 50
const QUERY_KEY = PURCHASE_ORDERS_QUERY_KEY
/** Long enough that typing a document number is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300

type WarehouseOptionsResponse = { items: Array<{ id: string; name?: string | null; code?: string | null }> }

type PurchaseOrderFilters = {
  status: string
  warehouseId: string
  orderDateFrom: string
  orderDateTo: string
  expectedDateFrom: string
  expectedDateTo: string
}

const NO_FILTERS: PurchaseOrderFilters = {
  status: '',
  warehouseId: '',
  orderDateFrom: '',
  orderDateTo: '',
  expectedDateFrom: '',
  expectedDateTo: '',
}

/**
 * What the user thinks of as one filter. A date range is two fields and one decision, so
 * removing "the last filter" must take both ends of it away together.
 */
type FilterGroup = 'status' | 'warehouseId' | 'orderDate' | 'expectedDate'

const FILTER_GROUPS: FilterGroup[] = ['status', 'warehouseId', 'orderDate', 'expectedDate']

const FILTER_GROUP_FIELDS: Record<FilterGroup, Partial<PurchaseOrderFilters>> = {
  status: { status: '' },
  warehouseId: { warehouseId: '' },
  orderDate: { orderDateFrom: '', orderDateTo: '' },
  expectedDate: { expectedDateFrom: '', expectedDateTo: '' },
}

function isGroupSet(filters: PurchaseOrderFilters, group: FilterGroup): boolean {
  if (group === 'orderDate') return filters.orderDateFrom !== '' || filters.orderDateTo !== ''
  if (group === 'expectedDate') return filters.expectedDateFrom !== '' || filters.expectedDateTo !== ''
  return filters[group] !== ''
}

function hasAnyFilter(filters: PurchaseOrderFilters, search: string): boolean {
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

type PurchaseOrderRow = PurchaseOrderListItem & { warehouseLabel: string }

type PurchaseOrdersResponse = {
  items: PurchaseOrderListItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

type Translate = ReturnType<typeof useT>

function buildColumns(t: Translate, locale: string): ColumnDef<PurchaseOrderRow>[] {
  const day = (value: unknown) => (typeof value === 'string' ? formatDisplayDate(value, locale) ?? '—' : '—')
  return [
    {
      accessorKey: 'documentNumber',
      header: t('procurements.purchaseOrders.table.column.documentNumber'),
      enableSorting: true,
      meta: { priority: 1 },
    },
    {
      accessorKey: 'supplierName',
      // Supplier is searchable rather than sortable: the API sorts on the columns the route
      // maps, and offering a header the server would ignore is a broken promise.
      enableSorting: false,
      header: t('procurements.purchaseOrders.table.column.supplier'),
      meta: { priority: 2 },
      // A released order shows the name it was released with, not a later rename.
      cell: ({ row }) => row.original.supplierSnapshot?.name ?? row.original.supplierName,
    },
    {
      accessorKey: 'status',
      header: t('procurements.purchaseOrders.table.column.status'),
      enableSorting: true,
      meta: { priority: 3 },
      cell: ({ row }) => (
        <StatusBadge variant={PURCHASE_ORDER_STATUS_VARIANTS[row.original.status]} dot>
          {t(`procurements.purchaseOrders.status.${row.original.status}`)}
        </StatusBadge>
      ),
    },
    {
      accessorKey: 'orderDate',
      header: t('procurements.purchaseOrders.table.column.orderDate'),
      enableSorting: true,
      meta: { priority: 4 },
      cell: ({ getValue }) => day(getValue()),
    },
    {
      accessorKey: 'expectedDate',
      header: t('procurements.purchaseOrders.table.column.expectedDate'),
      enableSorting: true,
      meta: { priority: 5 },
      cell: ({ getValue }) => day(getValue()),
    },
    {
      accessorKey: 'warehouseLabel',
      header: t('procurements.purchaseOrders.table.column.warehouse'),
      enableSorting: false,
      meta: { priority: 6 },
    },
    {
      accessorKey: 'lineCount',
      header: t('procurements.purchaseOrders.table.column.lineCount'),
      enableSorting: false,
      meta: { priority: 7 },
    },
    {
      accessorKey: 'netTotal',
      header: t('procurements.purchaseOrders.table.column.netTotal'),
      enableSorting: false,
      meta: { priority: 8, align: 'right' },
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatMoney(row.original.netTotal, row.original.currencyCode, locale)}
        </span>
      ),
    },
  ]
}

export default function PurchaseOrdersTable() {
  const t = useT()
  const locale = useLocale()
  const queryClient = useQueryClient()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [page, setPage] = React.useState(1)
  const [searchInput, setSearchInput] = React.useState('')
  const [search, setSearch] = React.useState('')
  const [filters, setFilters] = React.useState<PurchaseOrderFilters>(NO_FILTERS)
  // Sorting is server-side, so the table only reports what the user asked for; an empty state
  // means "whatever the API calls default", which is Order Date descending.
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [appliedOrder, setAppliedOrder] = React.useState<FilterGroup[]>([])
  const scopeVersion = useOrganizationScopeVersion()

  // Typing a document number should be one request, not one per character.
  React.useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  // Any narrowing invalidates the page the user is on: page 7 of the old result set is rarely
  // page 7 of the new one, and is usually past its end.
  React.useEffect(() => { setPage(1) }, [search, filters, sorting])

  const { data, isLoading, error } = useQuery<PurchaseOrdersResponse>({
    queryKey: [QUERY_KEY, page, search, filters, sorting, scopeVersion],
    queryFn: async () => {
      const params: Record<string, string> = {
        page: String(page),
        pageSize: String(PAGE_SIZE),
      }
      if (search.trim()) params.search = search.trim()
      if (filters.status) params.status = filters.status
      if (filters.warehouseId) params.warehouseId = filters.warehouseId
      if (filters.orderDateFrom) params.orderDateFrom = filters.orderDateFrom
      if (filters.orderDateTo) params.orderDateTo = filters.orderDateTo
      if (filters.expectedDateFrom) params.expectedDateFrom = filters.expectedDateFrom
      if (filters.expectedDateTo) params.expectedDateTo = filters.expectedDateTo
      const [sort] = sorting
      if (sort) {
        params.sortField = sort.id
        params.sortDir = sort.desc ? 'desc' : 'asc'
      }
      return fetchCrudList<PurchaseOrderListItem>('procurements/purchase-orders', params)
    },
  })

  const items = React.useMemo(() => data?.items ?? [], [data?.items])
  const liveWarehouseIds = React.useMemo(
    () => items.filter((item) => !item.warehouseSnapshot).map((item) => item.warehouseId),
    [items],
  )
  const warehouseNames = useWarehouseNames(liveWarehouseIds)

  const rows = React.useMemo<PurchaseOrderRow[]>(
    () =>
      items.map((item) => ({
        ...item,
        // The snapshot is what a released order means, so it wins over current warehouse
        // state; a draft has none yet and resolves the live name instead.
        warehouseLabel:
          item.warehouseSnapshot?.name
          ?? warehouseNames.get(item.warehouseId)
          ?? t('procurements.purchaseOrders.table.warehouse.unknown'),
      })),
    [items, t, warehouseNames],
  )

  const columns = React.useMemo(() => buildColumns(t, locale), [locale, t])
  const editHref = (row: PurchaseOrderRow) => `${PURCHASE_ORDERS_LIST_HREF}/${row.id}/edit`
  const viewHref = (row: PurchaseOrderRow) => `${PURCHASE_ORDERS_LIST_HREF}/${row.id}`
  const { canManage, canRelease } = usePurchaseOrderPermissions()
  const createLabel = t('procurements.purchaseOrders.table.actions.create')
  // Offering a create action to someone the create page will refuse is a dead end, not a
  // permission check — the route metadata stays the authority either way.
  const createAction = canManage ? (
    <Button asChild>
      <Link href={PURCHASE_ORDERS_CREATE_HREF}>{createLabel}</Link>
    </Button>
  ) : null

  const filterDefs = React.useMemo<FilterDef[]>(() => [
    {
      id: 'status',
      label: t('procurements.purchaseOrders.table.filter.status'),
      type: 'select',
      placeholder: t('procurements.purchaseOrders.table.filter.status.any'),
      options: [
        { value: 'draft', label: t('procurements.purchaseOrders.status.draft') },
        { value: 'released', label: t('procurements.purchaseOrders.status.released') },
        { value: 'cancelled', label: t('procurements.purchaseOrders.status.cancelled') },
      ],
    },
    {
      id: 'warehouseId',
      label: t('procurements.purchaseOrders.table.filter.warehouse'),
      type: 'combobox',
      placeholder: t('procurements.purchaseOrders.table.filter.warehouse.placeholder'),
      loadOptions: loadWarehouseFilterOptions,
    },
    {
      id: 'orderDate',
      label: t('procurements.purchaseOrders.table.filter.orderDate'),
      type: 'dateRange',
    },
    {
      id: 'expectedDate',
      label: t('procurements.purchaseOrders.table.filter.expectedDate'),
      type: 'dateRange',
    },
  ], [t])

  // The bar speaks `{ from, to }` for a range; the API takes the two ends separately.
  const filterValues = React.useMemo<FilterValues>(() => ({
    status: filters.status || undefined,
    warehouseId: filters.warehouseId || undefined,
    orderDate: filters.orderDateFrom || filters.orderDateTo
      ? { from: filters.orderDateFrom || undefined, to: filters.orderDateTo || undefined }
      : undefined,
    expectedDate: filters.expectedDateFrom || filters.expectedDateTo
      ? { from: filters.expectedDateFrom || undefined, to: filters.expectedDateTo || undefined }
      : undefined,
  }), [filters])

  const handleFiltersApply = React.useCallback((values: FilterValues) => {
    const orderRange = (values.orderDate ?? {}) as { from?: string; to?: string }
    const expectedRange = (values.expectedDate ?? {}) as { from?: string; to?: string }
    const next: PurchaseOrderFilters = {
      status: typeof values.status === 'string' ? values.status : '',
      warehouseId: typeof values.warehouseId === 'string' ? values.warehouseId : '',
      orderDateFrom: typeof orderRange.from === 'string' ? orderRange.from : '',
      orderDateTo: typeof orderRange.to === 'string' ? orderRange.to : '',
      expectedDateFrom: typeof expectedRange.from === 'string' ? expectedRange.from : '',
      expectedDateTo: typeof expectedRange.to === 'string' ? expectedRange.to : '',
    }
    setFilters((current) => {
      // "Remove the last filter" needs to know which one that was, and the bar hands over the
      // whole set rather than the change, so the newly-filled fields are the answer.
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

  const handleDelete = React.useCallback(async (row: PurchaseOrderRow) => {
    const confirmed = await confirm({
      title: t('procurements.purchaseOrders.table.confirm.delete.title'),
      description: t('procurements.purchaseOrders.table.confirm.delete.description', undefined, {
        documentNumber: row.documentNumber,
      }),
      variant: 'destructive',
    })
    if (!confirmed) return
    try {
      // The row carries its own version, so a list rendered before someone else edited the
      // order fails with a conflict instead of deleting a draft this user never saw.
      await withScopedApiRequestHeaders(
        buildOptimisticLockHeader(row.updatedAt),
        () => deleteCrud('procurements/purchase-orders', row.id),
      )
      flash(t('procurements.purchaseOrders.form.flash.deleted'), 'success')
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
    } catch (err) {
      if (surfacePurchaseOrderConflict(err, t)) {
        queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
        return
      }
      flash(
        err instanceof Error && err.message ? err.message : t('procurements.purchaseOrders.table.error.delete'),
        'error',
      )
    }
  }, [confirm, queryClient, t])

  const handleTransition = React.useCallback(async (
    action: 'release' | 'cancel',
    row: PurchaseOrderRow,
  ) => {
    const acknowledged = await confirm({
      title: t(`procurements.purchaseOrders.confirm.${action}.title`),
      description: t(`procurements.purchaseOrders.confirm.${action}.description`, undefined, {
        documentNumber: row.documentNumber,
      }),
      confirmText: t(`procurements.purchaseOrders.confirm.${action}.action`),
      variant: action === 'cancel' ? 'destructive' : undefined,
    })
    if (!acknowledged) return
    try {
      await transitionPurchaseOrder(action, row.id, row.updatedAt)
      // Awaited, so the row is never left showing the old status and offering an action the
      // server has just closed off.
      await queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
      flash(t(`procurements.purchaseOrders.form.flash.${action === 'release' ? 'released' : 'cancelled'}`), 'success')
    } catch (err) {
      if (surfacePurchaseOrderConflict(err, t)) {
        queryClient.invalidateQueries({ queryKey: [QUERY_KEY] })
        return
      }
      flash(
        err instanceof Error && err.message
          ? err.message
          : t(`procurements.purchaseOrders.table.error.${action}`),
        'error',
      )
    }
  }, [confirm, queryClient, t])

  return (
    <>
      <DataTable<PurchaseOrderRow>
        title={t('procurements.purchaseOrders.page.title')}
        titleHeadingLevel={1}
        actions={createAction}
        columns={columns}
        data={rows}
        entityId={PURCHASE_ORDERS_ENTITY_ID}
        extensionTableId={PURCHASE_ORDERS_TABLE_ID}
        isLoading={isLoading}
        error={error ? t('procurements.purchaseOrders.table.error.load') : null}
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        searchPlaceholder={t('procurements.purchaseOrders.table.search.placeholder')}
        filters={filterDefs}
        filterValues={filterValues}
        onFiltersApply={handleFiltersApply}
        onFiltersClear={clearFilters}
        sortable
        manualSorting
        sorting={sorting}
        onSortingChange={setSorting}
        // Two different nothings. This one is "there are no purchase orders at all", which
        // invites the user to write the first one.
        emptyState={(
          <EmptyState
            title={t('procurements.purchaseOrders.table.empty.title')}
            description={t('procurements.purchaseOrders.table.empty.description')}
            actions={createAction}
          />
        )}
        // The other nothing is "your filters match none of them", which must not offer to
        // create an order the user did not come here to write.
        filterAwareEmptyState={{
          active: filtering,
          entityNamePlural: t('procurements.purchaseOrders.page.title'),
          canRemoveLast: appliedOrder.length > 0,
          onClearAll: clearFilters,
          onRemoveLast: removeLastFilter,
        }}
        // No `onRowClick`: the row action carries the navigation, named explicitly because the
        // fallback matches an action's English label and would stop working in Polish.
        rowClickActionIds={['procurements.purchaseOrders.edit', 'procurements.purchaseOrders.view']}
        rowActions={(row) => {
          // Only offer what the row can actually do: the edit route refuses a frozen order
          // and a caller without the manage feature, so pointing at it anyway would just be a
          // door that closes in the user's face.
          const isDraft = row.status === 'draft'
          const items = []
          // View needs no more than the feature that put the row on screen.
          items.push({
            id: 'procurements.purchaseOrders.view',
            label: t('procurements.purchaseOrders.table.actions.view'),
            href: viewHref(row),
          })
          if (canManage && isDraft) {
            items.push(
              {
                id: 'procurements.purchaseOrders.edit',
                label: t('procurements.purchaseOrders.table.actions.edit'),
                href: editHref(row),
              },
              {
                id: 'procurements.purchaseOrders.delete',
                label: t('procurements.purchaseOrders.table.actions.delete'),
                destructive: true,
                onSelect: () => { void handleDelete(row) },
              },
            )
          }
          // Committing the organization to an order is a separate grant from writing it.
          if (canRelease && isDraft) {
            items.push({
              id: 'procurements.purchaseOrders.release',
              label: t('procurements.purchaseOrders.table.actions.release'),
              onSelect: () => { void handleTransition('release', row) },
            })
          }
          if (canRelease && row.status === 'released') {
            items.push({
              id: 'procurements.purchaseOrders.cancel',
              label: t('procurements.purchaseOrders.table.actions.cancel'),
              destructive: true,
              onSelect: () => { void handleTransition('cancel', row) },
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
