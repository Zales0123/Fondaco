"use client"
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { CrudForm, type CrudField, type CrudFieldOption, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { createCrud, deleteCrud, fetchCrudList, updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { withFlash } from '@open-mercato/ui/backend/utils/flash'
import { ErrorMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { getScheduleLocale } from '@open-mercato/ui/backend/schedule/localization'
import {
  confirmGoodsReceipt,
  GOODS_RECEIPTS_ENTITY_ID,
  GOODS_RECEIPTS_LIST_HREF,
  GOODS_RECEIPTS_QUERY_KEY,
  useGoodsReceiptPermissions,
} from './goodsReceiptsPresentation'
import { GoodsReceiptLinesEditor } from './GoodsReceiptLinesEditor'
import type { GoodsReceiptListItem } from '../lib/goodsReceiptListItem'
import {
  createEmptyLineDraft,
  toLinePayloads,
  type GoodsReceiptLineDraft,
} from '../lib/goodsReceiptLineDrafts'

type Translate = ReturnType<typeof useT>

type WarehousesResponse = {
  items: Array<{ id: string; name?: string | null; code?: string | null }>
}

export type GoodsReceiptFormValues = {
  id?: string
  documentNumber: string
  documentDate: string
  supplierName: string
  warehouseId: string
  lines: GoodsReceiptLineDraft[]
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

export function useGoodsReceiptFields(t: Translate): CrudField[] {
  // The date picker renders its own month names, weekday abbreviations and accessible
  // labels, and falls back to English when no locale is handed to it — so a Polish form
  // would otherwise open an English calendar.
  const dateLocale = getScheduleLocale(useLocale())
  return React.useMemo<CrudField[]>(() => [
    {
      id: 'documentNumber',
      label: t('pz.goodsReceipts.form.fields.documentNumber.label'),
      type: 'text',
      required: true,
      layout: 'half',
      placeholder: t('pz.goodsReceipts.form.fields.documentNumber.placeholder'),
      description: t('pz.goodsReceipts.form.fields.documentNumber.description'),
    },
    {
      id: 'documentDate',
      label: t('pz.goodsReceipts.form.fields.documentDate.label'),
      type: 'date',
      required: true,
      layout: 'half',
      // The picker cannot explain a day it refuses to offer, so the rule is stated where
      // the date is entered rather than left for the user to discover.
      description: t('pz.goodsReceipts.form.fields.documentDate.description'),
      // A delivery cannot arrive tomorrow, so the picker refuses what the server refuses.
      // Built on mount rather than at module scope so it follows the browser's own day.
      maxDate: new Date(),
      locale: dateLocale,
    },
    {
      id: 'supplierName',
      label: t('pz.goodsReceipts.form.fields.supplier.label'),
      type: 'text',
      required: true,
      layout: 'half',
      placeholder: t('pz.goodsReceipts.form.fields.supplier.placeholder'),
    },
    {
      id: 'warehouseId',
      label: t('pz.goodsReceipts.form.fields.warehouse.label'),
      type: 'combobox',
      required: true,
      layout: 'half',
      placeholder: t('pz.goodsReceipts.form.fields.warehouse.placeholder'),
      loadOptions: loadWarehouseOptions,
      resolveLabel: resolveWarehouseLabel,
      allowCustomValues: false,
    },
    {
      id: 'lines',
      label: t('pz.goodsReceipts.form.lines.title'),
      type: 'custom',
      rendersOwnError: true,
      component: ({ value, setValue, error, disabled }) => (
        <GoodsReceiptLinesEditor
          value={Array.isArray(value) ? (value as GoodsReceiptLineDraft[]) : []}
          onChange={(next) => setValue(next)}
          error={error}
          disabled={disabled}
        />
      ),
    },
  ], [dateLocale, t])
}

export function useGoodsReceiptGroups(t: Translate): CrudFormGroup[] {
  return React.useMemo<CrudFormGroup[]>(() => [
    {
      id: 'header',
      title: t('pz.goodsReceipts.form.groups.header'),
      column: 1,
      fields: ['documentNumber', 'documentDate', 'supplierName', 'warehouseId'],
    },
    {
      id: 'lines',
      title: t('pz.goodsReceipts.form.groups.lines'),
      column: 1,
      fields: ['lines'],
    },
  ], [t])
}

export function toGoodsReceiptWritePayload(values: GoodsReceiptFormValues) {
  return {
    documentNumber: values.documentNumber ?? '',
    documentDate: values.documentDate ?? '',
    supplierName: values.supplierName ?? '',
    warehouseId: values.warehouseId ?? '',
    lines: toLinePayloads(values.lines ?? []),
  }
}

/** Maps a loaded goods receipt into the form's state, keeping each line's stored id as its key. */
export function toGoodsReceiptFormValues(item: GoodsReceiptListItem): GoodsReceiptFormValues {
  return {
    id: item.id,
    documentNumber: item.documentNumber,
    documentDate: item.documentDate ?? '',
    supplierName: item.supplierName,
    warehouseId: item.warehouseId,
    lines: (item.lines ?? []).map((line) => ({
      key: line.id,
      catalogProductId: line.catalogProductId,
      quantity: line.quantity,
      unit: line.unit ?? '',
      purchaseOrderId: line.purchaseOrderId ?? '',
      purchaseOrderLineId: line.purchaseOrderLineId ?? '',
      // The snapshot is what the document already says, so an edit renders the chosen
      // order without another lookup — and still shows it if the order has since changed.
      purchaseOrderLabel: line.purchaseOrderSnapshot
        ? `${line.purchaseOrderSnapshot.documentNumber} / ${line.purchaseOrderSnapshot.lineNumber}`
        : '',
    })),
    updatedAt: item.updatedAt ?? null,
  }
}


export function GoodsReceiptCreateForm() {
  const t = useT()
  const fields = useGoodsReceiptFields(t)
  const groups = useGoodsReceiptGroups(t)
  // One empty line up front: a goods receipt never exists without at least one line, so an
  // empty editor would ask the user to discover the Add button before they can start.
  const initialValues = React.useMemo<GoodsReceiptFormValues>(() => ({
    documentNumber: '',
    documentDate: '',
    supplierName: '',
    warehouseId: '',
    lines: [createEmptyLineDraft()],
  }), [])
  const successRedirect = React.useMemo(
    () => `${GOODS_RECEIPTS_LIST_HREF}?flash=${encodeURIComponent(t('pz.goodsReceipts.form.flash.created'))}&type=success`,
    [t],
  )

  return (
    <CrudForm<GoodsReceiptFormValues>
      title={t('pz.goodsReceipts.form.create.title')}
      titleHeadingLevel={1}
      backHref={GOODS_RECEIPTS_LIST_HREF}
      entityId={GOODS_RECEIPTS_ENTITY_ID}
      fields={fields}
      groups={groups}
      initialValues={initialValues}
      submitLabel={t('pz.goodsReceipts.form.create.submit')}
      cancelHref={GOODS_RECEIPTS_LIST_HREF}
      successRedirect={successRedirect}
      onSubmit={async (values) => {
        await createCrud('pz/goods-receipts', toGoodsReceiptWritePayload(values))
      }}
    />
  )
}

export function GoodsReceiptEditForm({ id }: { id: string }) {
  const t = useT()
  const fields = useGoodsReceiptFields(t)
  const groups = useGoodsReceiptGroups(t)
  const [initial, setInitial] = React.useState<GoodsReceiptFormValues | null>(null)
  const [status, setStatus] = React.useState<GoodsReceiptListItem['status'] | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [isMissing, setIsMissing] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const { canConfirm } = useGoodsReceiptPermissions()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const router = useRouter()
  const queryClient = useQueryClient()

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError(null)
      setIsMissing(false)
      try {
        const data = await fetchCrudList<GoodsReceiptListItem>('pz/goods-receipts', { ids: String(id), pageSize: 1 })
        const item = data?.items?.[0]
        if (cancelled) return
        if (!item) {
          setIsMissing(true)
          return
        }
        setStatus(item.status)
        setInitial(toGoodsReceiptFormValues(item))
      } catch (error: unknown) {
        if (cancelled) return
        if ((error as { status?: number }).status === 404) setIsMissing(true)
        else setLoadError(error instanceof Error && error.message ? error.message : t('pz.goodsReceipts.form.error.load'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [id, t])

  const successRedirect = React.useMemo(
    () => withFlash(GOODS_RECEIPTS_LIST_HREF, t('pz.goodsReceipts.form.flash.saved'), 'success'),
    [t],
  )
  const deleteRedirect = React.useMemo(
    () => withFlash(GOODS_RECEIPTS_LIST_HREF, t('pz.goodsReceipts.form.flash.deleted'), 'success'),
    [t],
  )
  /**
   * Confirmation is offered beside the form rather than as a status field, because it is a
   * one-way transition with its own permission rather than another edit (ADR-0006). The
   * warning is the point: nothing undoes it afterwards.
   */
  const handleConfirm = React.useCallback(async () => {
    const acknowledged = await confirm({
      title: t('pz.goodsReceipts.form.confirm.title'),
      description: t('pz.goodsReceipts.form.confirm.description'),
      confirmText: t('pz.goodsReceipts.form.confirm.action'),
    })
    if (!acknowledged) return
    setConfirming(true)
    try {
      await confirmGoodsReceipt(id, initial?.updatedAt ?? null)
      // The index this returns to renders from a cached list; without this it would show
      // the document as a draft, and offer to confirm it again, until a refetch lands.
      await queryClient.invalidateQueries({ queryKey: [GOODS_RECEIPTS_QUERY_KEY] })
      router.push(withFlash(GOODS_RECEIPTS_LIST_HREF, t('pz.goodsReceipts.form.flash.confirmed'), 'success'))
    } catch (error) {
      setConfirming(false)
      if (surfaceRecordConflict(error, t)) return
      flash(error instanceof Error && error.message ? error.message : t('pz.goodsReceipts.form.error.confirm'), 'error')
    }
  }, [confirm, id, initial?.updatedAt, queryClient, router, t])

  const fallbackValues = React.useMemo<GoodsReceiptFormValues>(() => ({
    id,
    documentNumber: '',
    documentDate: '',
    supplierName: '',
    warehouseId: '',
    lines: [],
    updatedAt: null,
  }), [id])

  if (isMissing) {
    return (
      <RecordNotFoundState
        label={t('pz.goodsReceipts.form.error.notFound')}
        backHref={GOODS_RECEIPTS_LIST_HREF}
        backLabel={t('pz.goodsReceipts.form.actions.backToList')}
      />
    )
  }
  if (loadError) return <ErrorMessage label={loadError} />

  // Editing is restricted to drafts by construction rather than by hiding a button: the
  // update and delete endpoints refuse a confirmed document too (ADR-0006).
  if (status && status !== 'draft') {
    return (
      <div className="space-y-4">
        <Alert status="warning">{t('pz.goodsReceipts.form.error.confirmedImmutable')}</Alert>
        <Button asChild variant="outline">
          <Link href={GOODS_RECEIPTS_LIST_HREF}>{t('pz.goodsReceipts.form.actions.backToList')}</Link>
        </Button>
      </div>
    )
  }

  const confirmAction = canConfirm && status === 'draft' ? (
    <Button type="button" variant="outline" onClick={() => { void handleConfirm() }} disabled={confirming}>
      {t('pz.goodsReceipts.form.actions.confirm')}
    </Button>
  ) : null

  return (
    <>
    <CrudForm<GoodsReceiptFormValues>
      title={t('pz.goodsReceipts.form.edit.title')}
      titleHeadingLevel={1}
      backHref={GOODS_RECEIPTS_LIST_HREF}
      entityId={GOODS_RECEIPTS_ENTITY_ID}
      fields={fields}
      groups={groups}
      initialValues={initial ?? fallbackValues}
      isLoading={loading}
      loadingMessage={t('pz.goodsReceipts.form.loading')}
      submitLabel={t('pz.goodsReceipts.form.edit.submit')}
      cancelHref={GOODS_RECEIPTS_LIST_HREF}
      successRedirect={successRedirect}
      deleteRedirect={deleteRedirect}
      onSubmit={async (next) => {
        await updateCrud('pz/goods-receipts', { id, ...toGoodsReceiptWritePayload(next) })
      }}
      onDelete={async () => {
        await deleteCrud('pz/goods-receipts', String(id))
      }}
      extraActions={confirmAction}
    />
    {ConfirmDialogElement}
    </>
  )
}


export default GoodsReceiptCreateForm
