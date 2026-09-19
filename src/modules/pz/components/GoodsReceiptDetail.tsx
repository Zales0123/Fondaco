"use client"

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchCrudList } from '@open-mercato/ui/backend/utils/crud'
import { ErrorMessage, LoadingMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { FormHeader } from '@open-mercato/ui/backend/forms'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@open-mercato/ui/primitives/table'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { formatDisplayDate } from '@open-mercato/ui/primitives/date-format'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import type { GoodsReceiptListItem } from '../lib/goodsReceiptListItem'
import { PalletsSection } from './PalletsSection'
import { ReceivingSummaryView, useReceivingSummary } from './ReceivingSummary'
import {
  GOODS_RECEIPTS_LIST_HREF,
  GOODS_RECEIPTS_QUERY_KEY,
  surfaceGoodsReceiptConflict,
  transitionGoodsReceipt,
  useGoodsReceiptPermissions,
  useWarehouseNames,
} from './goodsReceiptsPresentation'

type GoodsReceiptsResponse = { items: GoodsReceiptListItem[] }

const STATUS_VARIANTS: Record<GoodsReceiptListItem['status'], StatusBadgeVariant> = {
  draft: 'neutral',
  receiving: 'info',
  confirmed: 'success',
}

function ReceivingSummarySection({ goodsReceiptId }: { goodsReceiptId: string }) {
  const t = useT()
  const { data, isLoading, error } = useReceivingSummary(goodsReceiptId)
  return (
    <section className="space-y-4 border-t pt-6" aria-labelledby="goods-receipt-summary-heading">
      <h2 id="goods-receipt-summary-heading" className="text-base font-semibold">
        {t('pz.receiving.summary.title')}
      </h2>
      {isLoading ? <LoadingMessage label={t('pz.receiving.summary.loading')} />
        : error ? <ErrorMessage label={t('pz.receiving.summary.error')} />
        : data ? <ReceivingSummaryView summary={data} />
        : <ErrorMessage label={t('pz.receiving.summary.error')} />}
    </section>
  )
}

export function GoodsReceiptDetail({ id }: { id: string }) {
  const t = useT()
  const locale = useLocale()
  const queryClient = useQueryClient()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const { canManage, canConfirm } = useGoodsReceiptPermissions()
  const [pending, setPending] = React.useState(false)
  const scopeVersion = useOrganizationScopeVersion()
  const { data, isLoading, error } = useQuery<GoodsReceiptsResponse>({
    queryKey: [GOODS_RECEIPTS_QUERY_KEY, 'detail', id, scopeVersion],
    queryFn: () => fetchCrudList<GoodsReceiptListItem>('pz/goods-receipts', { ids: id, pageSize: '1' }),
  })
  const item = data?.items?.[0]
  const liveWarehouseIds = React.useMemo(
    () => item && !item.warehouseSnapshot ? [item.warehouseId] : [],
    [item],
  )
  const warehouseNames = useWarehouseNames(liveWarehouseIds)

  async function handleTransition(action: 'release' | 'withdraw' | 'confirm', receipt: GoodsReceiptListItem) {
    const prefix = action === 'confirm' ? 'pz.goodsReceipts.table.confirm.confirm' : `pz.goodsReceipts.form.${action}`
    const acknowledged = await confirm({
      title: t(`${prefix}.title`),
      description: t(`${prefix}.description`, undefined, { documentNumber: receipt.documentNumber }),
      confirmText: t(`${prefix}.action`),
    })
    if (!acknowledged) return
    setPending(true)
    try {
      await transitionGoodsReceipt(action, receipt.id, receipt.updatedAt)
      await queryClient.invalidateQueries({ queryKey: [GOODS_RECEIPTS_QUERY_KEY] })
      flash(t(`pz.goodsReceipts.form.flash.${action === 'confirm' ? 'confirmed' : action === 'release' ? 'released' : 'withdrawn'}`), 'success')
    } catch (err) {
      if (!surfaceGoodsReceiptConflict(err, t)) {
        flash(err instanceof Error && err.message ? err.message : t(`pz.goodsReceipts.form.error.${action}`), 'error')
      }
    } finally {
      setPending(false)
    }
  }

  if (isLoading) return <LoadingMessage label={t('pz.goodsReceipts.view.loading')} />
  if (error) return <ErrorMessage label={t('pz.goodsReceipts.view.error.load')} />
  if (!item) {
    return (
      <RecordNotFoundState
        label={t('pz.goodsReceipts.form.error.notFound')}
        backHref={GOODS_RECEIPTS_LIST_HREF}
        backLabel={t('pz.goodsReceipts.form.actions.backToList')}
      />
    )
  }

  const warehouse = item.warehouseSnapshot
    ? `${item.warehouseSnapshot.name} (${item.warehouseSnapshot.code})`
    : (warehouseNames.get(item.warehouseId) ?? item.warehouseId)
  const fields = [
    [t('pz.goodsReceipts.view.field.documentNumber'), item.documentNumber],
    [t('pz.goodsReceipts.view.field.documentDate'), formatDisplayDate(item.documentDate, locale) ?? '—'],
    [t('pz.goodsReceipts.view.field.supplier'), item.supplierName],
    [t('pz.goodsReceipts.view.field.warehouse'), warehouse],
  ]

  return (
    <div className="space-y-8" data-testid="goods-receipt-detail">
      <FormHeader
        mode="detail"
        title={t('pz.goodsReceipts.view.title', undefined, { documentNumber: item.documentNumber })}
        subtitle={t('pz.goodsReceipts.view.snapshotNote')}
        backHref={GOODS_RECEIPTS_LIST_HREF}
        backLabel={t('pz.goodsReceipts.form.actions.backToList')}
      />

      {canManage && (item.status === 'draft' || item.status === 'receiving') ? (
        <div className="flex flex-wrap gap-2">
          {item.status === 'draft' ? (
            <Button disabled={pending} onClick={() => { void handleTransition('release', item) }}>
              {t('pz.goodsReceipts.form.actions.release')}
            </Button>
          ) : (
            <Button variant="outline" disabled={pending} onClick={() => { void handleTransition('withdraw', item) }}>
              {t('pz.goodsReceipts.form.actions.withdraw')}
            </Button>
          )}
        </div>
      ) : null}

      <section className="space-y-4" aria-labelledby="goods-receipt-header-heading">
        <h2 id="goods-receipt-header-heading" className="text-base font-semibold">
          {t('pz.goodsReceipts.view.section.header')}
        </h2>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {fields.map(([label, value]) => (
            <div key={label} className="rounded border bg-muted/30 p-3">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
              <dd className="mt-1 break-words text-sm">{value}</dd>
            </div>
          ))}
          <div className="rounded border bg-muted/30 p-3">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('pz.goodsReceipts.view.field.status')}
            </dt>
            <dd className="mt-1">
              <StatusBadge variant={STATUS_VARIANTS[item.status]} dot>
                {t(`pz.goodsReceipts.status.${item.status}`)}
              </StatusBadge>
            </dd>
          </div>
        </dl>
      </section>

      <section className="space-y-4 border-t pt-6" aria-labelledby="goods-receipt-lines-heading">
        <h2 id="goods-receipt-lines-heading" className="text-base font-semibold">
          {t('pz.goodsReceipts.view.section.lines')}
        </h2>
        <div className="relative w-full overflow-x-auto">
          <Table>
            <TableCaption className="sr-only">{t('pz.goodsReceipts.view.lines.caption')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('pz.goodsReceipts.view.lines.column.position')}</TableHead>
                <TableHead scope="col">{t('pz.goodsReceipts.view.lines.column.product')}</TableHead>
                <TableHead scope="col">{t('pz.goodsReceipts.view.lines.column.sku')}</TableHead>
                <TableHead scope="col">{t('pz.goodsReceipts.view.lines.column.quantity')}</TableHead>
                <TableHead scope="col">{t('pz.goodsReceipts.view.lines.column.unit')}</TableHead>
                <TableHead scope="col">{t('pz.goodsReceipts.view.lines.column.purchaseOrder')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {item.lines?.length ? item.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>{line.lineNumber}</TableCell>
                  <TableCell>{line.catalogSnapshot?.name ?? t('pz.goodsReceipts.view.unknownProduct')}</TableCell>
                  <TableCell>{line.catalogSnapshot?.sku ?? '—'}</TableCell>
                  <TableCell>{line.quantity}</TableCell>
                  <TableCell>{line.uomSnapshot?.code ?? '—'}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {/*
                      The snapshot, not a live lookup: it is what this document committed to
                      when the line was saved, and it stays readable if the order is later
                      renumbered or the purchasing module is unavailable.
                    */}
                    {line.purchaseOrderSnapshot
                      ? `${line.purchaseOrderSnapshot.documentNumber} / ${line.purchaseOrderSnapshot.lineNumber}`
                      : '—'}
                  </TableCell>
                </TableRow>
              )) : (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    {t('pz.goodsReceipts.view.lines.empty')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>
      <PalletsSection goodsReceiptId={item.id} />
      <ReceivingSummarySection goodsReceiptId={item.id} />
      {canConfirm && item.status === 'receiving' ? (
        <Button disabled={pending} onClick={() => { void handleTransition('confirm', item) }}>
          {t('pz.goodsReceipts.form.actions.confirm')}
        </Button>
      ) : null}
      {ConfirmDialogElement}
    </div>
  )
}
