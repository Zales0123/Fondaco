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
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { DestinationPicker, useDestinations } from './DestinationPicker'
import type { ReceivingSummaryResponse } from '../lib/receivingSummary'
import type { ConfirmationBlocker } from '../lib/stockPosting'
import {
  GOODS_RECEIPTS_LIST_HREF,
  GOODS_RECEIPTS_QUERY_KEY,
  retryStockPosting,
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

function ReceivingSummarySection({
  summary,
}: {
  summary: ReturnType<typeof useReceivingSummary>
}) {
  const t = useT()
  const { data, isLoading, error } = summary
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

/**
 * What became of putting this delivery's goods into stock, and the one action the office has
 * over it. The floor cannot fix a failed posting — the causes are configuration this screen's
 * reader owns — so the retry lives here (ADR-0011).
 */
function StockPostingSection({
  item,
  summary,
  pending,
  canRetry,
  onRetry,
}: {
  item: GoodsReceiptListItem
  summary: ReceivingSummaryResponse | undefined
  pending: boolean
  canRetry: boolean
  onRetry: () => Promise<void>
}) {
  const t = useT()
  const posting = summary?.stockPosting ?? item.stockPosting
  if (item.status !== 'confirmed' || posting.status === 'not_applicable') return null

  return (
    <section className="space-y-4 border-t pt-6" aria-labelledby="goods-receipt-posting-heading">
      <h2 id="goods-receipt-posting-heading" className="text-base font-semibold">
        {t('pz.receiving.posting.title')}
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge variant={POSTING_VARIANTS[posting.status]} dot>
          {t(`pz.receiving.posting.status.${posting.status}`)}
        </StatusBadge>
        {posting.reason ? (
          <span className="text-sm text-muted-foreground">{t(`pz.receiving.posting.reason.${posting.reason}`)}</span>
        ) : null}
      </div>
      {canRetry && (posting.status === 'failed' || posting.status === 'pending') ? (
        <Button variant="outline" disabled={pending} onClick={() => { void onRetry() }}>
          {t('pz.receiving.posting.retry')}
        </Button>
      ) : null}
    </section>
  )
}

const POSTING_VARIANTS: Record<GoodsReceiptListItem['stockPosting']['status'], StatusBadgeVariant> = {
  not_applicable: 'neutral',
  pending: 'info',
  posted: 'success',
  failed: 'error',
}

/**
 * The reasons confirmation would be refused, so the office is told before it presses rather
 * than after. The two a chosen destination resolves are dropped once one is chosen.
 */
function ConfirmBlockers({ blockers, hasDestination }: { blockers: ConfirmationBlocker[]; hasDestination: boolean }) {
  const t = useT()
  const remaining = visibleBlockers(blockers, hasDestination)
  if (remaining.length === 0) return null
  return (
    <Alert status="warning">
      <AlertDescription>
        <ul className="list-disc pl-5">
          {remaining.map((blocker) => (
            <li key={blocker.kind}>{describeBlocker(blocker, t)}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

function visibleBlockers(blockers: ConfirmationBlocker[], hasDestination: boolean): ConfirmationBlocker[] {
  return blockers.filter(
    (blocker) =>
      !hasDestination || (blocker.kind !== 'destinationRequired' && blocker.kind !== 'destinationInvalid'),
  )
}

function confirmIsBlocked(blockers: ConfirmationBlocker[], hasDestination: boolean): boolean {
  return visibleBlockers(blockers, hasDestination).length > 0
}

function destinationCode(
  options: Array<{ id: string; code: string }>,
  id: string | null,
  t: ReturnType<typeof useT>,
): string {
  if (!id) return t('pz.receiving.destination.none')
  return options.find((option) => option.id === id)?.code ?? id
}

function describeBlocker(blocker: ConfirmationBlocker, t: ReturnType<typeof useT>): string {
  switch (blocker.kind) {
    case 'palletsOpen':
      return t('pz.receiving.blocker.palletsOpen', undefined, { count: blocker.count })
    case 'trackedVariants':
      return t('pz.receiving.blocker.trackedVariants', undefined, { products: blocker.products.join(', ') })
    default:
      return t(`pz.receiving.blocker.${blocker.kind}`)
  }
}

export function GoodsReceiptDetail({ id }: { id: string }) {
  const t = useT()
  const locale = useLocale()
  const queryClient = useQueryClient()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const { canManage, canConfirm } = useGoodsReceiptPermissions()
  const [pending, setPending] = React.useState(false)
  const [destinationId, setDestinationId] = React.useState<string | null>(null)
  const [destinationTouched, setDestinationTouched] = React.useState(false)
  const scopeVersion = useOrganizationScopeVersion()
  const { data, isLoading, error } = useQuery<GoodsReceiptsResponse>({
    queryKey: [GOODS_RECEIPTS_QUERY_KEY, 'detail', id, scopeVersion],
    queryFn: () => fetchCrudList<GoodsReceiptListItem>('pz/goods-receipts', { ids: id, pageSize: '1' }),
  })
  const item = data?.items?.[0]
  const summary = useReceivingSummary(item?.id ?? '')
  const postingEnabled = summary.data?.stockPosting.enabled ?? false
  const destinations = useDestinations(item?.id ?? '', postingEnabled && item?.status === 'receiving')
  const defaultDestinationId = destinations.options.defaultLocationId
  React.useEffect(() => {
    if (!destinationTouched && defaultDestinationId) setDestinationId(defaultDestinationId)
  }, [defaultDestinationId, destinationTouched])
  const liveWarehouseIds = React.useMemo(
    () => item && !item.warehouseSnapshot ? [item.warehouseId] : [],
    [item],
  )
  const warehouseNames = useWarehouseNames(liveWarehouseIds)

  async function handleTransition(action: 'release' | 'withdraw' | 'confirm', receipt: GoodsReceiptListItem) {
    const prefix = action === 'confirm' ? 'pz.goodsReceipts.table.confirm.confirm' : `pz.goodsReceipts.form.${action}`
    const acknowledged = await confirm({
      title: t(`${prefix}.title`),
      description:
        action === 'confirm' && postingEnabled
          ? t('pz.goodsReceipts.table.confirm.confirm.descriptionWithDestination', undefined, {
              documentNumber: receipt.documentNumber,
              destination: destinationCode(destinations.options.items, destinationId, t),
            })
          : t(`${prefix}.description`, undefined, { documentNumber: receipt.documentNumber }),
      confirmText: t(`${prefix}.action`),
    })
    if (!acknowledged) return
    setPending(true)
    try {
      await transitionGoodsReceipt(
        action,
        receipt.id,
        receipt.updatedAt,
        action === 'confirm' && destinationId ? { destinationLocationId: destinationId } : {},
      )
      await queryClient.invalidateQueries({ queryKey: [GOODS_RECEIPTS_QUERY_KEY] })
      await summary.refetch()
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
                </TableRow>
              )) : (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    {t('pz.goodsReceipts.view.lines.empty')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>
      <PalletsSection goodsReceiptId={item.id} />
      <ReceivingSummarySection summary={summary} />
      <StockPostingSection
        item={item}
        summary={summary.data}
        pending={pending}
        canRetry={canConfirm}
        onRetry={async () => {
          setPending(true)
          try {
            await retryStockPosting(item.id, destinationId)
            await queryClient.invalidateQueries({ queryKey: [GOODS_RECEIPTS_QUERY_KEY] })
            await summary.refetch()
            flash(t('pz.goodsReceipts.form.flash.postingRetried'), 'success')
          } catch (err) {
            flash(err instanceof Error && err.message ? err.message : t('pz.receiving.errors.retryFailed'), 'error')
          } finally {
            setPending(false)
          }
        }}
      />
      {canConfirm && item.status === 'receiving' ? (
        <div className="flex flex-col gap-4">
          {postingEnabled ? (
            <DestinationPicker
              className="flex max-w-sm flex-col gap-2"
              options={destinations.options.items}
              value={destinationId}
              onChange={(next) => {
                setDestinationTouched(true)
                setDestinationId(next)
              }}
            />
          ) : null}
          <ConfirmBlockers blockers={summary.data?.blockers ?? []} hasDestination={Boolean(destinationId)} />
          <Button
            className="self-start"
            disabled={pending || confirmIsBlocked(summary.data?.blockers ?? [], Boolean(destinationId))}
            onClick={() => { void handleTransition('confirm', item) }}
          >
            {t('pz.goodsReceipts.form.actions.confirm')}
          </Button>
        </div>
      ) : null}
      {ConfirmDialogElement}
    </div>
  )
}
