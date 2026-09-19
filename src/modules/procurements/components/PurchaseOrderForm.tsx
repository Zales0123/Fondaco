"use client"
import * as React from 'react'
import Link from 'next/link'
import { CrudForm, type CrudField, type CrudFieldOption, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { createCrud, deleteCrud, fetchCrudList, updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { withFlash } from '@open-mercato/ui/backend/utils/flash'
import { ErrorMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { getScheduleLocale } from '@open-mercato/ui/backend/schedule/localization'
import {
  PURCHASE_ORDERS_ENTITY_ID,
  PURCHASE_ORDERS_LIST_HREF,
} from './purchaseOrdersPresentation'
import { PurchaseOrderLinesEditor } from './PurchaseOrderLinesEditor'
import type { PurchaseOrderListItem } from '../lib/purchaseOrderListItem'
import {
  createEmptyLineDraft,
  toLinePayloads,
  type PurchaseOrderLineDraft,
} from '../lib/purchaseOrderLineDrafts'

type Translate = ReturnType<typeof useT>

type WarehousesResponse = {
  items: Array<{ id: string; name?: string | null; code?: string | null }>
}

type CurrencyOptionsResponse = {
  items: Array<{ value: string; label: string }>
}

/** The organization's own default; only used when nothing else says otherwise. */
const FALLBACK_CURRENCY = 'PLN'

export type PurchaseOrderFormValues = {
  id?: string
  documentNumber: string
  orderDate: string
  expectedDate: string
  supplierName: string
  warehouseId: string
  currencyCode: string
  notes: string
  lines: PurchaseOrderLineDraft[]
  /** Carries the version into `CrudForm`, which derives the lock header for update AND delete. */
  updatedAt?: string | null
}

function warehouseLabel(item: WarehousesResponse['items'][number]): string {
  const name = item.name?.trim() || item.id
  const code = item.code?.trim()
  return code ? `${name} (${code})` : name
}

async function loadWarehouseOptions(query?: string): Promise<CrudFieldOption[]> {
  const params = new URLSearchParams({ pageSize: '50', isActive: 'true' })
  if (query && query.trim()) params.set('search', query.trim())
  try {
    const data = await readApiResultOrThrow<WarehousesResponse>(`/api/wms/warehouses?${params.toString()}`)
    return (data?.items ?? []).map((item) => ({ value: item.id, label: warehouseLabel(item) }))
  } catch {
    return []
  }
}

async function resolveWarehouseLabel(warehouseId: string): Promise<string> {
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

/**
 * Currencies come from the installed `currencies` module's own option source rather than a
 * hard-coded list or a second query over its table, so an organization that trades in EUR
 * sees EUR and the labels match everywhere else in the app.
 *
 * The picker degrades to free entry — validated server-side as an ISO-4217 code — if that
 * module is unavailable or the caller lacks `currencies.view`: an order must not become
 * unwritable because a lookup failed.
 */
async function loadCurrencyOptions(query?: string): Promise<CrudFieldOption[]> {
  const params = new URLSearchParams({ limit: '100' })
  if (query && query.trim()) params.set('q', query.trim())
  try {
    const data = await readApiResultOrThrow<CurrencyOptionsResponse>(
      `/api/currencies/currencies/options?${params.toString()}`,
    )
    return (data?.items ?? []).filter((item) => typeof item.value === 'string' && item.value.length > 0)
  } catch {
    return []
  }
}

export function usePurchaseOrderFields(t: Translate): CrudField[] {
  // The date picker renders its own month names, weekday abbreviations and accessible labels,
  // and falls back to English when no locale is handed to it — so a Polish form would
  // otherwise open an English calendar.
  const dateLocale = getScheduleLocale(useLocale())
  return React.useMemo<CrudField[]>(() => [
    {
      id: 'documentNumber',
      label: t('procurements.purchaseOrders.form.fields.documentNumber.label'),
      type: 'text',
      required: true,
      layout: 'half',
      placeholder: t('procurements.purchaseOrders.form.fields.documentNumber.placeholder'),
      description: t('procurements.purchaseOrders.form.fields.documentNumber.description'),
    },
    {
      id: 'supplierName',
      label: t('procurements.purchaseOrders.form.fields.supplier.label'),
      type: 'text',
      required: true,
      layout: 'half',
      placeholder: t('procurements.purchaseOrders.form.fields.supplier.placeholder'),
      // Stated where the name is typed, because the supplier register is a separate module
      // still to come and a buyer should know this is a name today and a record later.
      description: t('procurements.purchaseOrders.form.fields.supplier.description'),
    },
    {
      id: 'orderDate',
      label: t('procurements.purchaseOrders.form.fields.orderDate.label'),
      type: 'date',
      required: true,
      layout: 'half',
      locale: dateLocale,
    },
    {
      id: 'expectedDate',
      label: t('procurements.purchaseOrders.form.fields.expectedDate.label'),
      type: 'date',
      layout: 'half',
      // The picker cannot explain what a blank date means, so the rule is stated where the
      // date is entered rather than left for the user to discover.
      description: t('procurements.purchaseOrders.form.fields.expectedDate.description'),
      locale: dateLocale,
    },
    {
      id: 'warehouseId',
      label: t('procurements.purchaseOrders.form.fields.warehouse.label'),
      type: 'combobox',
      required: true,
      layout: 'half',
      placeholder: t('procurements.purchaseOrders.form.fields.warehouse.placeholder'),
      loadOptions: loadWarehouseOptions,
      resolveLabel: resolveWarehouseLabel,
      allowCustomValues: false,
    },
    {
      id: 'currencyCode',
      label: t('procurements.purchaseOrders.form.fields.currency.label'),
      type: 'combobox',
      required: true,
      layout: 'half',
      placeholder: t('procurements.purchaseOrders.form.fields.currency.placeholder'),
      loadOptions: loadCurrencyOptions,
      // Custom values are allowed so an unavailable currency list cannot block an order; the
      // server still refuses anything that is not a three-letter code.
      allowCustomValues: true,
    },
    {
      id: 'notes',
      label: t('procurements.purchaseOrders.form.fields.notes.label'),
      type: 'textarea',
      placeholder: t('procurements.purchaseOrders.form.fields.notes.placeholder'),
    },
    {
      id: 'lines',
      label: t('procurements.purchaseOrders.form.lines.title'),
      type: 'custom',
      rendersOwnError: true,
      component: ({ value, values, setValue, error, disabled }) => (
        <PurchaseOrderLinesEditor
          value={Array.isArray(value) ? (value as PurchaseOrderLineDraft[]) : []}
          onChange={(next) => setValue(next)}
          // The running total is money, so it is labelled with the currency the header names
          // — reading it from the live form values keeps the two in step as the user changes
          // the currency.
          currencyCode={typeof values?.currencyCode === 'string' ? values.currencyCode : FALLBACK_CURRENCY}
          error={error}
          disabled={disabled}
        />
      ),
    },
  ], [dateLocale, t])
}

export function usePurchaseOrderGroups(t: Translate): CrudFormGroup[] {
  return React.useMemo<CrudFormGroup[]>(() => [
    {
      id: 'header',
      title: t('procurements.purchaseOrders.form.groups.header'),
      column: 1,
      fields: ['documentNumber', 'supplierName', 'orderDate', 'expectedDate', 'warehouseId', 'currencyCode'],
    },
    {
      id: 'lines',
      title: t('procurements.purchaseOrders.form.groups.lines'),
      column: 1,
      fields: ['lines'],
    },
    {
      id: 'notes',
      title: t('procurements.purchaseOrders.form.groups.notes'),
      column: 1,
      fields: ['notes'],
    },
  ], [t])
}

export function toPurchaseOrderWritePayload(values: PurchaseOrderFormValues) {
  return {
    documentNumber: values.documentNumber ?? '',
    orderDate: values.orderDate ?? '',
    expectedDate: values.expectedDate || null,
    supplierName: values.supplierName ?? '',
    warehouseId: values.warehouseId ?? '',
    currencyCode: values.currencyCode ?? '',
    notes: values.notes?.trim() ? values.notes : null,
    lines: toLinePayloads(values.lines ?? []),
  }
}

/** Maps a loaded purchase order into the form's state, keeping each line's stored id as its key. */
export function toPurchaseOrderFormValues(item: PurchaseOrderListItem): PurchaseOrderFormValues {
  return {
    id: item.id,
    documentNumber: item.documentNumber,
    orderDate: item.orderDate ?? '',
    expectedDate: item.expectedDate ?? '',
    supplierName: item.supplierName,
    warehouseId: item.warehouseId,
    currencyCode: item.currencyCode,
    notes: item.notes ?? '',
    lines: (item.lines ?? []).map((line) => ({
      key: line.id,
      catalogProductId: line.catalogProductId,
      quantityOrdered: line.quantityOrdered,
      unit: line.unit ?? '',
      unitPriceNet: line.unitPriceNet,
      expectedDate: line.expectedDate ?? '',
    })),
    updatedAt: item.updatedAt ?? null,
  }
}

/** The calendar day the browser is on, which is what a buyer means by "today". */
function today(): string {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

export function PurchaseOrderCreateForm() {
  const t = useT()
  const fields = usePurchaseOrderFields(t)
  const groups = usePurchaseOrderGroups(t)
  // One empty line up front: an order never exists without at least one line, so an empty
  // editor would ask the user to discover the Add button before they can start.
  const initialValues = React.useMemo<PurchaseOrderFormValues>(() => ({
    documentNumber: '',
    orderDate: today(),
    expectedDate: '',
    supplierName: '',
    warehouseId: '',
    currencyCode: FALLBACK_CURRENCY,
    notes: '',
    lines: [createEmptyLineDraft()],
  }), [])
  const successRedirect = React.useMemo(
    () => withFlash(PURCHASE_ORDERS_LIST_HREF, t('procurements.purchaseOrders.form.flash.created'), 'success'),
    [t],
  )

  return (
    <CrudForm<PurchaseOrderFormValues>
      title={t('procurements.purchaseOrders.form.create.title')}
      titleHeadingLevel={1}
      backHref={PURCHASE_ORDERS_LIST_HREF}
      entityId={PURCHASE_ORDERS_ENTITY_ID}
      fields={fields}
      groups={groups}
      initialValues={initialValues}
      submitLabel={t('procurements.purchaseOrders.form.create.submit')}
      cancelHref={PURCHASE_ORDERS_LIST_HREF}
      successRedirect={successRedirect}
      onSubmit={async (values) => {
        await createCrud('procurements/purchase-orders', toPurchaseOrderWritePayload(values))
      }}
    />
  )
}

export function PurchaseOrderEditForm({ id }: { id: string }) {
  const t = useT()
  const fields = usePurchaseOrderFields(t)
  const groups = usePurchaseOrderGroups(t)
  const [initial, setInitial] = React.useState<PurchaseOrderFormValues | null>(null)
  const [status, setStatus] = React.useState<PurchaseOrderListItem['status'] | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [isMissing, setIsMissing] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError(null)
      setIsMissing(false)
      try {
        const data = await fetchCrudList<PurchaseOrderListItem>('procurements/purchase-orders', {
          ids: String(id),
          pageSize: 1,
        })
        const item = data?.items?.[0]
        if (cancelled) return
        if (!item) {
          setIsMissing(true)
          return
        }
        setStatus(item.status)
        setInitial(toPurchaseOrderFormValues(item))
      } catch (error: unknown) {
        if (cancelled) return
        if ((error as { status?: number }).status === 404) setIsMissing(true)
        else {
          setLoadError(
            error instanceof Error && error.message
              ? error.message
              : t('procurements.purchaseOrders.form.error.load'),
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [id, t])

  const successRedirect = React.useMemo(
    () => withFlash(PURCHASE_ORDERS_LIST_HREF, t('procurements.purchaseOrders.form.flash.saved'), 'success'),
    [t],
  )
  const deleteRedirect = React.useMemo(
    () => withFlash(PURCHASE_ORDERS_LIST_HREF, t('procurements.purchaseOrders.form.flash.deleted'), 'success'),
    [t],
  )

  const fallbackValues = React.useMemo<PurchaseOrderFormValues>(() => ({
    id,
    documentNumber: '',
    orderDate: '',
    expectedDate: '',
    supplierName: '',
    warehouseId: '',
    currencyCode: FALLBACK_CURRENCY,
    notes: '',
    lines: [],
    updatedAt: null,
  }), [id])

  if (isMissing) {
    return (
      <RecordNotFoundState
        label={t('procurements.purchaseOrders.form.error.notFound')}
        backHref={PURCHASE_ORDERS_LIST_HREF}
        backLabel={t('procurements.purchaseOrders.form.actions.backToList')}
      />
    )
  }
  if (loadError) return <ErrorMessage label={loadError} />

  // Editing is restricted to drafts by construction rather than by hiding a button: the update
  // and delete endpoints refuse a released or cancelled order too. The detail screen is where
  // the way forward is — withdraw it, then edit.
  if (status && status !== 'draft') {
    return (
      <div className="space-y-4">
        <Alert status="warning">
          {t(
            status === 'released'
              ? 'procurements.purchaseOrders.form.error.releasedImmutable'
              : 'procurements.purchaseOrders.form.error.cancelledImmutable',
          )}
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href={`${PURCHASE_ORDERS_LIST_HREF}/${id}`}>
              {t('procurements.purchaseOrders.form.actions.open')}
            </Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href={PURCHASE_ORDERS_LIST_HREF}>
              {t('procurements.purchaseOrders.form.actions.backToList')}
            </Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <CrudForm<PurchaseOrderFormValues>
      title={t('procurements.purchaseOrders.form.edit.title')}
      titleHeadingLevel={1}
      backHref={PURCHASE_ORDERS_LIST_HREF}
      entityId={PURCHASE_ORDERS_ENTITY_ID}
      fields={fields}
      groups={groups}
      initialValues={initial ?? fallbackValues}
      isLoading={loading}
      loadingMessage={t('procurements.purchaseOrders.form.loading')}
      submitLabel={t('procurements.purchaseOrders.form.edit.submit')}
      cancelHref={PURCHASE_ORDERS_LIST_HREF}
      successRedirect={successRedirect}
      deleteRedirect={deleteRedirect}
      onSubmit={async (next) => {
        await updateCrud('procurements/purchase-orders', { id, ...toPurchaseOrderWritePayload(next) })
      }}
      onDelete={async () => {
        await deleteCrud('procurements/purchase-orders', String(id))
      }}
    />
  )
}

export default PurchaseOrderCreateForm
