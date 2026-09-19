"use client"

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { apiCall, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { Button } from '@open-mercato/ui/primitives/button'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { formatDisplayDate } from '@open-mercato/ui/primitives/date-format'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@open-mercato/ui/primitives/table'
import { cn } from '@open-mercato/shared/lib/utils'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useGoodsReceiptPermissions } from './goodsReceiptsPresentation'

type Translate = ReturnType<typeof useT>

type PalletRow = { id: string }
type PalletsResponse = { items: PalletRow[] }

type PalletDamageReportItem = {
  id: string
  palletId: string
  catalogVariantId: string
  name: string
  sku: string | null
  quantity: string
  photoAttachmentId: string | null
  note: string | null
  status: 'open' | 'resolved'
  resolutionNote: string | null
  reportedBy: string
  resolvedBy: string | null
  resolvedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}
type ReportsResponse = { items: PalletDamageReportItem[] }

type AttachmentItem = { id: string; url: string; fileName: string }
type AttachmentsResponse = { items?: AttachmentItem[] }

const STATUS_VARIANTS: Record<PalletDamageReportItem['status'], StatusBadgeVariant> = {
  open: 'warning',
  resolved: 'success',
}
const COLUMN_COUNT = 5

/** Trailing zeros are storage precision, not something the office should read as a measurement. */
function formatQuantity(value: string): string {
  if (!value.includes('.')) return value
  return value.replace(/\.?0+$/, '') || '0'
}

/**
 * Filed by the floor, resolved by the office — a separate section from `ReceivingSummary`
 * because a damage report is not a quantity discrepancy and never affects it (see the
 * module's `AGENTS.md`). Read-only for anyone without `pz.goodsReceipts.manage`; resolving
 * is offered only to whoever holds it, same as editing the document itself.
 */
export function DamageReportsSection({ goodsReceiptId }: { goodsReceiptId: string }) {
  const t = useT()
  const queryClient = useQueryClient()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const { canManage } = useGoodsReceiptPermissions()
  const scopeVersion = useOrganizationScopeVersion()
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set())
  const [notes, setNotes] = React.useState<Record<string, string>>({})
  const [pending, setPending] = React.useState<string | null>(null)

  const pallets = useQuery<PalletsResponse>({
    queryKey: ['pz.pallets', goodsReceiptId, scopeVersion],
    queryFn: () => readApiResultOrThrow<PalletsResponse>(
      `/api/pz/pallets?goodsReceiptId=${encodeURIComponent(goodsReceiptId)}&pageSize=200`,
    ),
  })
  const palletIds = React.useMemo(() => (pallets.data?.items ?? []).map((pallet) => pallet.id), [pallets.data])

  const reports = useQuery<ReportsResponse>({
    queryKey: ['pz.palletDamageReports', goodsReceiptId, palletIds, scopeVersion],
    enabled: palletIds.length > 0,
    queryFn: () => readApiResultOrThrow<ReportsResponse>(
      `/api/pz/pallet-damage-reports?palletIds=${encodeURIComponent(palletIds.join(','))}&pageSize=200`,
    ),
  })

  const items = reports.data?.items ?? []
  const loading = pallets.isLoading || (palletIds.length > 0 && reports.isLoading)
  const failed = pallets.error || reports.error

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  async function resolveReport(item: PalletDamageReportItem) {
    const confirmed = await confirm({
      title: t('pz.palletDamageReports.section.resolve.confirm.title'),
      description: t('pz.palletDamageReports.section.resolve.confirm.description'),
      confirmText: t('pz.palletDamageReports.section.resolve.confirm.action'),
    })
    if (!confirmed) return
    setPending(item.id)
    try {
      await withScopedApiRequestHeaders(buildOptimisticLockHeader(item.updatedAt), async () => {
        const call = await apiCall<{ error?: string }>('/api/pz/pallet-damage-reports', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: item.id, resolutionNote: notes[item.id]?.trim() || null }),
        })
        if (!call.response.ok) {
          throw Object.assign(new Error(call.result?.error ?? ''), call.result, { status: call.response.status })
        }
      })
      flash(t('pz.palletDamageReports.section.resolve.flash'), 'success')
      await queryClient.invalidateQueries({ queryKey: ['pz.palletDamageReports', goodsReceiptId] })
    } catch (error) {
      flash(
        error instanceof Error && error.message ? error.message : t('pz.palletDamageReports.errors.resolveFailed'),
        'error',
      )
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="space-y-4 border-t pt-6" aria-labelledby="goods-receipt-damage-reports-heading">
      <h2 id="goods-receipt-damage-reports-heading" className="text-base font-semibold">
        {t('pz.goodsReceipts.view.section.damageReports')}
      </h2>
      {loading ? (
        <LoadingMessage label={t('pz.palletDamageReports.section.loading')} />
      ) : failed ? (
        <ErrorMessage label={t('pz.palletDamageReports.section.error')} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pz.palletDamageReports.section.empty')}</p>
      ) : (
        <div className="relative w-full overflow-x-auto">
          <Table>
            <TableCaption className="sr-only">{t('pz.palletDamageReports.section.title')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('pz.palletDamageReports.section.column.product')}</TableHead>
                <TableHead scope="col">{t('pz.palletDamageReports.section.column.quantity')}</TableHead>
                <TableHead scope="col">{t('pz.palletDamageReports.section.column.status')}</TableHead>
                <TableHead scope="col">{t('pz.palletDamageReports.section.column.reportedAt')}</TableHead>
                <TableHead scope="col" className="sr-only">{t('pz.palletDamageReports.section.column.photo')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <DamageReportRow
                  key={item.id}
                  item={item}
                  expanded={expanded.has(item.id)}
                  onToggle={() => toggle(item.id)}
                  canManage={canManage}
                  note={notes[item.id] ?? ''}
                  onNoteChange={(value) => setNotes((current) => ({ ...current, [item.id]: value }))}
                  onResolve={() => { void resolveReport(item) }}
                  pending={pending === item.id}
                  t={t}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {ConfirmDialogElement}
    </section>
  )
}

function DamageReportRow({
  item,
  expanded,
  onToggle,
  canManage,
  note,
  onNoteChange,
  onResolve,
  pending,
  t,
}: {
  item: PalletDamageReportItem
  expanded: boolean
  onToggle: () => void
  canManage: boolean
  note: string
  onNoteChange: (value: string) => void
  onResolve: () => void
  pending: boolean
  t: Translate
}) {
  const locale = useLocale()
  const product = item.name || t('pz.receiving.summary.unknownProduct')
  const detailsId = `pz-damage-report-details-${item.id}`
  const reportedAt = item.createdAt ? formatDisplayDate(item.createdAt, locale) : null

  return (
    <>
      <TableRow>
        <TableCell>{item.sku ? `${product} (${item.sku})` : product}</TableCell>
        <TableCell>{formatQuantity(item.quantity)}</TableCell>
        <TableCell>
          <StatusBadge variant={STATUS_VARIANTS[item.status]} dot>
            {t(`pz.palletDamageReports.status.${item.status}`)}
          </StatusBadge>
        </TableCell>
        <TableCell>{reportedAt ?? '—'}</TableCell>
        <TableCell>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={detailsId}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="sr-only">
              {t(expanded ? 'pz.receiving.summary.breakdown.hide' : 'pz.receiving.summary.breakdown.show', undefined, {
                product,
              })}
            </span>
            <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
          </button>
        </TableCell>
      </TableRow>
      <TableRow id={detailsId} className={expanded ? undefined : 'hidden'}>
        <TableCell colSpan={COLUMN_COUNT} className="text-sm">
          <div className="flex flex-col gap-3 py-2">
            <div>
              <span className="font-medium">{t('pz.palletDamageReports.section.column.note')}: </span>
              <span className="text-muted-foreground">{item.note || t('pz.palletDamageReports.section.note.none')}</span>
            </div>
            <DamageReportPhoto reportId={item.id} hasPhoto={Boolean(item.photoAttachmentId)} t={t} />
            {item.status === 'resolved' ? (
              <div>
                <span className="font-medium">{t('pz.palletDamageReports.section.resolvedBy')}: </span>
                <span className="text-muted-foreground">
                  {item.resolutionNote || t('pz.palletDamageReports.section.note.none')}
                </span>
              </div>
            ) : canManage ? (
              <div className="flex max-w-md flex-col gap-2">
                <Textarea
                  value={note}
                  placeholder={t('pz.palletDamageReports.section.resolve.note.placeholder')}
                  disabled={pending}
                  onChange={(event) => onNoteChange(event.target.value)}
                />
                <Button type="button" disabled={pending} onClick={onResolve} className="self-start">
                  {t('pz.palletDamageReports.section.resolve.action')}
                </Button>
              </div>
            ) : null}
          </div>
        </TableCell>
      </TableRow>
    </>
  )
}

/** Fetched on demand through the installed attachments endpoint rather than carried on the
 *  report's own list row, so this section owns no photo storage or URL-building of its own. */
function DamageReportPhoto({ reportId, hasPhoto, t }: { reportId: string; hasPhoto: boolean; t: Translate }) {
  const { data } = useQuery<AttachmentsResponse>({
    queryKey: ['pz.palletDamageReports.photo', reportId],
    enabled: hasPhoto,
    queryFn: () => readApiResultOrThrow<AttachmentsResponse>(
      `/api/attachments?entityId=pz:pallet_damage_report&recordId=${encodeURIComponent(reportId)}&pageSize=1`,
    ),
  })
  if (!hasPhoto) {
    return (
      <div>
        <span className="font-medium">{t('pz.palletDamageReports.section.column.photo')}: </span>
        <span className="text-muted-foreground">{t('pz.palletDamageReports.section.photo.none')}</span>
      </div>
    )
  }
  const photo = data?.items?.[0]
  if (!photo) return null
  return (
    <div>
      <span className="font-medium">{t('pz.palletDamageReports.section.column.photo')}: </span>
      <a className="underline" href={photo.url} target="_blank" rel="noreferrer">
        {t('pz.palletDamageReports.section.photo.view')}
      </a>
    </div>
  )
}
