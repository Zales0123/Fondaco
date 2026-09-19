"use client"

import * as React from 'react'
import Link from 'next/link'
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
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { formatDisplayDate } from '@open-mercato/ui/primitives/date-format'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import type { PurchaseOrderListItem } from '../lib/purchaseOrderListItem'
import {
  PURCHASE_ORDERS_LIST_HREF,
  PURCHASE_ORDERS_QUERY_KEY,
  PURCHASE_ORDER_LINES_QUERY_KEY,
  PURCHASE_ORDER_STATUS_VARIANTS,
  formatMoney,
  formatQuantity,
  surfacePurchaseOrderConflict,
  transitionPurchaseOrder,
  usePurchaseOrderPermissions,
  useWarehouseNames,
  type PurchaseOrderTransition,
} from './purchaseOrdersPresentation'
import { PurchaseOrderAnnouncements } from './PurchaseOrderAnnouncements'

type PurchaseOrdersResponse = { items: PurchaseOrderListItem[] }

const FLASH_KEY: Record<PurchaseOrderTransition, string> = {
  release: 'released',
  withdraw: 'withdrawn',
  cancel: 'cancelled',
}

export function PurchaseOrderDetail({ id }: { id: string }) {
  const t = useT()
  const locale = useLocale()
  const queryClient = useQueryClient()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const { canManage, canRelease } = usePurchaseOrderPermissions()
  const [pending, setPending] = React.useState(false)
  const scopeVersion = useOrganizationScopeVersion()
  const { data, isLoading, error } = useQuery<PurchaseOrdersResponse>({
    queryKey: [PURCHASE_ORDERS_QUERY_KEY, 'detail', id, scopeVersion],
    queryFn: () => fetchCrudList<PurchaseOrderListItem>('procurements/purchase-orders', { ids: id, pageSize: '1' }),
  })
  const item = data?.items?.[0]
  const liveWarehouseIds = React.useMemo(
    () => (item && !item.warehouseSnapshot ? [item.warehouseId] : []),
    [item],
  )
  const warehouseNames = useWarehouseNames(liveWarehouseIds)

  async function handleTransition(action: PurchaseOrderTransition, order: PurchaseOrderListItem) {
    const acknowledged = await confirm({
      title: t(`procurements.purchaseOrders.confirm.${action}.title`),
      description: t(`procurements.purchaseOrders.confirm.${action}.description`, undefined, {
        documentNumber: order.documentNumber,
      }),
      confirmText: t(`procurements.purchaseOrders.confirm.${action}.action`),
      variant: action === 'cancel' ? 'destructive' : 'default',
    })
    if (!acknowledged) return
    setPending(true)
    try {
      await transitionPurchaseOrder(action, order.id, order.updatedAt)
      await queryClient.invalidateQueries({ queryKey: [PURCHASE_ORDERS_QUERY_KEY] })
      // The cross-order line view shows each line's order status, so it is stale too.
      await queryClient.invalidateQueries({ queryKey: [PURCHASE_ORDER_LINES_QUERY_KEY] })
      flash(t(`procurements.purchaseOrders.form.flash.${FLASH_KEY[action]}`), 'success')
    } catch (err) {
      if (!surfacePurchaseOrderConflict(err, t)) {
        flash(
          err instanceof Error && err.message
            ? err.message
            : t(`procurements.purchaseOrders.table.error.${action}`),
          'error',
        )
      }
    } finally {
      setPending(false)
    }
  }

  if (isLoading) return <LoadingMessage label={t('procurements.purchaseOrders.view.loading')} />
  if (error) return <ErrorMessage label={t('procurements.purchaseOrders.view.error.load')} />
  if (!item) {
    return (
      <RecordNotFoundState
        label={t('procurements.purchaseOrders.form.error.notFound')}
        backHref={PURCHASE_ORDERS_LIST_HREF}
        backLabel={t('procurements.purchaseOrders.form.actions.backToList')}
      />
    )
  }

  const warehouse = item.warehouseSnapshot
    ? `${item.warehouseSnapshot.name} (${item.warehouseSnapshot.code})`
    : (warehouseNames.get(item.warehouseId) ?? item.warehouseId)
  const fields: Array<[string, string]> = [
    [t('procurements.purchaseOrders.view.field.documentNumber'), item.documentNumber],
    [
      t('procurements.purchaseOrders.view.field.supplier'),
      item.supplierSnapshot?.name ?? item.supplierName,
    ],
    [t('procurements.purchaseOrders.view.field.orderDate'), formatDisplayDate(item.orderDate, locale) ?? '—'],
    [
      t('procurements.purchaseOrders.view.field.expectedDate'),
      formatDisplayDate(item.expectedDate, locale) ?? '—',
    ],
    [t('procurements.purchaseOrders.view.field.warehouse'), warehouse],
    [
      t('procurements.purchaseOrders.view.field.netTotal'),
      formatMoney(item.netTotal, item.currencyCode, locale),
    ],
  ]

  const isDraft = item.status === 'draft'
  const isReleased = item.status === 'released'

  return (
    <div className="space-y-8" data-testid="purchase-order-detail">
      <FormHeader
        mode="detail"
        title={t('procurements.purchaseOrders.view.title', undefined, { documentNumber: item.documentNumber })}
        subtitle={t('procurements.purchaseOrders.view.subtitle')}
        backHref={PURCHASE_ORDERS_LIST_HREF}
        backLabel={t('procurements.purchaseOrders.form.actions.backToList')}
      />

      {canManage || canRelease ? (
        <div className="flex flex-wrap gap-2">
          {canManage && isDraft ? (
            <Button asChild variant="outline">
              <Link href={`${PURCHASE_ORDERS_LIST_HREF}/${item.id}/edit`}>
                {t('procurements.purchaseOrders.view.actions.edit')}
              </Link>
            </Button>
          ) : null}
          {canRelease && isDraft ? (
            <Button disabled={pending} onClick={() => { void handleTransition('release', item) }}>
              {t('procurements.purchaseOrders.view.actions.release')}
            </Button>
          ) : null}
          {canRelease && isReleased ? (
            <>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => { void handleTransition('withdraw', item) }}
              >
                {t('procurements.purchaseOrders.view.actions.withdraw')}
              </Button>
              <Button
                variant="destructive-solid"
                disabled={pending}
                onClick={() => { void handleTransition('cancel', item) }}
              >
                {t('procurements.purchaseOrders.view.actions.cancel')}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      <section className="space-y-4" aria-labelledby="purchase-order-header-heading">
        <h2 id="purchase-order-header-heading" className="text-base font-semibold">
          {t('procurements.purchaseOrders.view.section.header')}
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
              {t('procurements.purchaseOrders.view.field.status')}
            </dt>
            <dd className="mt-1">
              <StatusBadge variant={PURCHASE_ORDER_STATUS_VARIANTS[item.status]} dot>
                {t(`procurements.purchaseOrders.status.${item.status}`)}
              </StatusBadge>
            </dd>
          </div>
        </dl>
        {item.notes ? (
          <div className="rounded border bg-muted/30 p-3">
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('procurements.purchaseOrders.view.field.notes')}
            </h3>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{item.notes}</p>
          </div>
        ) : null}
      </section>

      <section className="space-y-4 border-t pt-6" aria-labelledby="purchase-order-lines-heading">
        <h2 id="purchase-order-lines-heading" className="text-base font-semibold">
          {t('procurements.purchaseOrders.view.section.lines')}
        </h2>
        <div className="relative w-full overflow-x-auto">
          <Table>
            <TableCaption className="sr-only">{t('procurements.purchaseOrders.view.lines.caption')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('procurements.purchaseOrders.view.lines.column.position')}</TableHead>
                <TableHead scope="col">{t('procurements.purchaseOrders.view.lines.column.product')}</TableHead>
                <TableHead scope="col">{t('procurements.purchaseOrders.view.lines.column.sku')}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t('procurements.purchaseOrders.view.lines.column.quantity')}
                </TableHead>
                <TableHead scope="col">{t('procurements.purchaseOrders.view.lines.column.unit')}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t('procurements.purchaseOrders.view.lines.column.announced')}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t('procurements.purchaseOrders.view.lines.column.free')}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t('procurements.purchaseOrders.view.lines.column.unitPrice')}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t('procurements.purchaseOrders.view.lines.column.netValue')}
                </TableHead>
                <TableHead scope="col">{t('procurements.purchaseOrders.view.lines.column.expectedDate')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {item.lines?.length ? item.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>{line.lineNumber}</TableCell>
                  <TableCell>
                    {line.catalogSnapshot?.name ?? t('procurements.purchaseOrders.view.unknownProduct')}
                  </TableCell>
                  <TableCell>{line.catalogSnapshot?.sku ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQuantity(line.quantityOrdered)}
                  </TableCell>
                  <TableCell>{line.uomSnapshot?.code ?? line.unit ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQuantity(line.quantityAnnounced)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {/* Null is "the ledger does not add up", not "nothing left to announce". */}
                    {line.quantityFree === null
                      ? (
                        <span className="text-muted-foreground">
                          {t('procurements.purchaseOrderLines.table.freeUnknown')}
                        </span>
                      )
                      : formatQuantity(line.quantityFree)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(line.unitPriceNet, item.currencyCode, locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(line.netValue, item.currencyCode, locale)}
                  </TableCell>
                  <TableCell>{formatDisplayDate(line.expectedDate, locale) ?? '—'}</TableCell>
                </TableRow>
              )) : (
                <TableRow>
                  <TableCell colSpan={10} className="text-muted-foreground">
                    {t('procurements.purchaseOrders.view.lines.empty')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <PurchaseOrderAnnouncements purchaseOrderId={item.id} />
      {ConfirmDialogElement}
    </div>
  )
}

export default PurchaseOrderDetail
