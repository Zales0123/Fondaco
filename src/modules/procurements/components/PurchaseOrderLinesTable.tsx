"use client"
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import type { SortingState } from '@tanstack/react-table'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { formatDisplayDate } from '@open-mercato/ui/primitives/date-format'
import { fetchCrudList } from '@open-mercato/ui/backend/utils/crud'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import type { PurchaseOrderLineListItem } from '../lib/purchaseOrderListItem'
import {
  PURCHASE_ORDERS_LIST_HREF,
  PURCHASE_ORDER_LINES_ENTITY_ID,
  PURCHASE_ORDER_LINES_QUERY_KEY,
  PURCHASE_ORDER_LINES_TABLE_ID,
  PURCHASE_ORDER_STATUS_VARIANTS,
  formatMoney,
  formatQuantity,
  useWarehouseNames,
} from './purchaseOrdersPresentation'

const PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 300

type WarehouseOptionsResponse = { items: Array<{ id: string; name?: string | null; code?: string | null }> }

type LineFilters = {
  status: string
  warehouseId: string
  expectedDateFrom: string
  expectedDateTo: string
}

const NO_FILTERS: LineFilters = { status: '', warehouseId: '', expectedDateFrom: '', expectedDateTo: '' }

type FilterGroup = 'status' | 'warehouseId' | 'expectedDate'

const FILTER_GROUPS: FilterGroup[] = ['status', 'warehouseId', 'expectedDate']

const FILTER_GROUP_FIELDS: Record<FilterGroup, Partial<LineFilters>> = {
  status: { status: '' },
  warehouseId: { warehouseId: '' },
  expectedDate: { expectedDateFrom: '', expectedDateTo: '' },
}

function isGroupSet(filters: LineFilters, group: FilterGroup): boolean {
  if (group === 'expectedDate') return filters.expectedDateFrom !== '' || filters.expectedDateTo !== ''
  return filters[group] !== ''
}

function hasAnyFilter(filters: LineFilters, search: string): boolean {
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
    return []
  }
}

type LineRow = PurchaseOrderLineListItem & { warehouseLabel: string }

type LinesResponse = {
  items: PurchaseOrderLineListItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

type Translate = ReturnType<typeof useT>

function buildColumns(t: Translate, locale: string): ColumnDef<LineRow>[] {
  return [
    {
      accessorKey: 'documentNumber',
      header: t('procurements.purchaseOrderLines.table.column.order'),
      // The header number lives on another table, so the server cannot sort on it here.
      enableSorting: false,
      meta: { priority: 1 },
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {row.original.documentNumber || '—'}
          <span className="text-muted-foreground"> / {row.original.lineNumber}</span>
        </span>
      ),
    },
    {
      accessorKey: 'supplierName',
      header: t('procurements.purchaseOrderLines.table.column.supplier'),
      enableSorting: false,
      meta: { priority: 2 },
      cell: ({ row }) => row.original.supplierName || '—',
    },
    {
      accessorKey: 'product',
      header: t('procurements.purchaseOrderLines.table.column.product'),
      enableSorting: false,
      meta: { priority: 3 },
      cell: ({ row }) => {
        const snapshot = row.original.catalogSnapshot
        const name = snapshot?.name ?? t('procurements.purchaseOrders.view.unknownProduct')
        return snapshot?.sku ? `${name} — ${snapshot.sku}` : name
      },
    },
    {
      accessorKey: 'quantityOrdered',
      header: t('procurements.purchaseOrderLines.table.column.quantity'),
      enableSorting: true,
      meta: { priority: 4, align: 'right' },
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatQuantity(row.original.quantityOrdered)}
          {row.original.uomSnapshot?.code || row.original.unit
            ? ` ${row.original.uomSnapshot?.code ?? row.original.unit}`
            : ''}
        </span>
      ),
    },
    {
      accessorKey: 'quantityAnnounced',
      header: t('procurements.purchaseOrderLines.table.column.announced'),
      enableSorting: false,
      meta: { priority: 5, align: 'right' },
      cell: ({ row }) => (
        <span className="tabular-nums">{formatQuantity(row.original.quantityAnnounced)}</span>
      ),
    },
    {
      accessorKey: 'quantityFree',
      header: t('procurements.purchaseOrderLines.table.column.free'),
      enableSorting: false,
      meta: { priority: 6, align: 'right' },
      cell: ({ row }) => {
        // A null free quantity is not "nothing left" — it is "the ledger does not add up",
        // which the buyer has to be able to tell apart from a fully announced line.
        if (row.original.quantityFree === null) {
          return (
            <span className="text-muted-foreground" title={t('procurements.purchaseOrderLines.table.freeUnknownHint')}>
              {t('procurements.purchaseOrderLines.table.freeUnknown')}
            </span>
          )
        }
        return <span className="tabular-nums">{formatQuantity(row.original.quantityFree)}</span>
      },
    },
    {
      accessorKey: 'netValue',
      header: t('procurements.purchaseOrderLines.table.column.netValue'),
      enableSorting: false,
      meta: { priority: 7, align: 'right' },
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatMoney(row.original.netValue, row.original.currencyCode, locale)}
        </span>
      ),
    },
    {
      accessorKey: 'expectedDate',
      header: t('procurements.purchaseOrderLines.table.column.expectedDate'),
      enableSorting: true,
      meta: { priority: 8 },
      cell: ({ getValue }) => {
        const value = getValue()
        return (typeof value === 'string' ? formatDisplayDate(value, locale) : null) ?? '—'
      },
    },
    {
      accessorKey: 'status',
      header: t('procurements.purchaseOrderLines.table.column.status'),
      enableSorting: false,
      meta: { priority: 9 },
      cell: ({ row }) => (
        <StatusBadge variant={PURCHASE_ORDER_STATUS_VARIANTS[row.original.status]} dot>
          {t(`procurements.purchaseOrders.status.${row.original.status}`)}
        </StatusBadge>
      ),
    },
    {
      accessorKey: 'warehouseLabel',
      header: t('procurements.purchaseOrderLines.table.column.warehouse'),
      enableSorting: false,
      meta: { priority: 10 },
    },
  ]
}

/**
 * Every line of every order in one place, which is how a buyer asks "what is due next" —
 * a question the per-order screen cannot answer.
 *
 * It reads the same records the order detail shows, through the line read model rather than a
 * second copy, so an id and a quantity here are the same id and quantity there.
 */
export default function PurchaseOrderLinesTable() {
  const t = useT()
  const locale = useLocale()
  const [page, setPage] = React.useState(1)
  const [searchInput, setSearchInput] = React.useState('')
  const [search, setSearch] = React.useState('')
  const [filters, setFilters] = React.useState<LineFilters>(NO_FILTERS)
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [appliedOrder, setAppliedOrder] = React.useState<FilterGroup[]>([])
  const scopeVersion = useOrganizationScopeVersion()

  React.useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  React.useEffect(() => { setPage(1) }, [search, filters, sorting])

  const { data, isLoading, error } = useQuery<LinesResponse>({
    queryKey: [PURCHASE_ORDER_LINES_QUERY_KEY, page, search, filters, sorting, scopeVersion],
    queryFn: async () => {
      const params: Record<string, string> = {
        page: String(page),
        pageSize: String(PAGE_SIZE),
      }
      if (search.trim()) params.search = search.trim()
      if (filters.status) params.status = filters.status
      if (filters.warehouseId) params.warehouseId = filters.warehouseId
      if (filters.expectedDateFrom) params.expectedDateFrom = filters.expectedDateFrom
      if (filters.expectedDateTo) params.expectedDateTo = filters.expectedDateTo
      const [sort] = sorting
      if (sort) {
        params.sortField = sort.id
        params.sortDir = sort.desc ? 'desc' : 'asc'
      }
      return fetchCrudList<PurchaseOrderLineListItem>('procurements/purchase-order-lines', params)
    },
  })

  const items = React.useMemo(() => data?.items ?? [], [data?.items])
  const warehouseNames = useWarehouseNames(items.map((item) => item.warehouseId))

  const rows = React.useMemo<LineRow[]>(
    () =>
      items.map((item) => ({
        ...item,
        warehouseLabel:
          warehouseNames.get(item.warehouseId)
          ?? t('procurements.purchaseOrders.table.warehouse.unknown'),
      })),
    [items, t, warehouseNames],
  )

  const columns = React.useMemo(() => buildColumns(t, locale), [locale, t])

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
      id: 'expectedDate',
      label: t('procurements.purchaseOrders.table.filter.expectedDate'),
      type: 'dateRange',
    },
  ], [t])

  const filterValues = React.useMemo<FilterValues>(() => ({
    status: filters.status || undefined,
    warehouseId: filters.warehouseId || undefined,
    expectedDate: filters.expectedDateFrom || filters.expectedDateTo
      ? { from: filters.expectedDateFrom || undefined, to: filters.expectedDateTo || undefined }
      : undefined,
  }), [filters])

  const handleFiltersApply = React.useCallback((values: FilterValues) => {
    const range = (values.expectedDate ?? {}) as { from?: string; to?: string }
    const next: LineFilters = {
      status: typeof values.status === 'string' ? values.status : '',
      warehouseId: typeof values.warehouseId === 'string' ? values.warehouseId : '',
      expectedDateFrom: typeof range.from === 'string' ? range.from : '',
      expectedDateTo: typeof range.to === 'string' ? range.to : '',
    }
    setFilters((current) => {
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

  return (
    <DataTable<LineRow>
      title={t('procurements.purchaseOrderLines.page.title')}
      titleHeadingLevel={1}
      columns={columns}
      data={rows}
      entityId={PURCHASE_ORDER_LINES_ENTITY_ID}
      extensionTableId={PURCHASE_ORDER_LINES_TABLE_ID}
      isLoading={isLoading}
      error={error ? t('procurements.purchaseOrderLines.table.error.load') : null}
      searchValue={searchInput}
      onSearchChange={setSearchInput}
      searchPlaceholder={t('procurements.purchaseOrderLines.table.search.placeholder')}
      filters={filterDefs}
      filterValues={filterValues}
      onFiltersApply={handleFiltersApply}
      onFiltersClear={clearFilters}
      sortable
      manualSorting
      sorting={sorting}
      onSortingChange={setSorting}
      // Nothing to create here: a line only exists on an order, so the empty state points at
      // the orders list rather than offering an action this screen does not own.
      emptyState={(
        <EmptyState
          title={t('procurements.purchaseOrderLines.table.empty.title')}
          description={t('procurements.purchaseOrderLines.table.empty.description')}
        />
      )}
      filterAwareEmptyState={{
        active: hasAnyFilter(filters, search),
        entityNamePlural: t('procurements.purchaseOrderLines.page.title'),
        canRemoveLast: appliedOrder.length > 0,
        onClearAll: clearFilters,
        onRemoveLast: removeLastFilter,
      }}
      rowClickActionIds={['procurements.purchaseOrderLines.openOrder']}
      rowActions={(row) => {
        // A line the caller cannot trace back to its order is not worth a dead link; the
        // header is blank exactly when the order was not readable.
        if (!row.purchaseOrderId || !row.documentNumber) return null
        return (
          <RowActions
            items={[{
              id: 'procurements.purchaseOrderLines.openOrder',
              label: t('procurements.purchaseOrderLines.table.actions.openOrder'),
              href: `${PURCHASE_ORDERS_LIST_HREF}/${row.purchaseOrderId}`,
            }]}
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
  )
}
