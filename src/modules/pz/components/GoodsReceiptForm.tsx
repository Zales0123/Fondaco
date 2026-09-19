"use client"
import * as React from 'react'
import { CrudForm, type CrudField, type CrudFieldOption, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { createCrud } from '@open-mercato/ui/backend/utils/crud'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { GOODS_RECEIPTS_ENTITY_ID, GOODS_RECEIPTS_LIST_HREF } from './goodsReceiptsPresentation'
import { GoodsReceiptLinesEditor } from './GoodsReceiptLinesEditor'
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
      // A delivery cannot arrive tomorrow, so the picker refuses what the server refuses.
      // Built on mount rather than at module scope so it follows the browser's own day.
      maxDate: new Date(),
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
  ], [t])
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

export function toGoodsReceiptCreatePayload(values: GoodsReceiptFormValues) {
  return {
    documentNumber: values.documentNumber ?? '',
    documentDate: values.documentDate ?? '',
    supplierName: values.supplierName ?? '',
    warehouseId: values.warehouseId ?? '',
    lines: toLinePayloads(values.lines ?? []),
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
        await createCrud('pz/goods-receipts', toGoodsReceiptCreatePayload(values))
      }}
    />
  )
}

export default GoodsReceiptCreateForm
