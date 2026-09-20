"use client"

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { CheckboxField } from '@open-mercato/ui/primitives/checkbox-field'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@open-mercato/ui/primitives/table'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { cn } from '@open-mercato/shared/lib/utils'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { formatQuantityForDisplay } from '../lib/quantity'
import type { ReceivingSummary, ReceivingSummaryResponse, ReceivingSummaryRow } from '../lib/receivingSummary'

const SUMMARY_COLUMN_COUNT = 5

/**
 * The comparison the office reads before pressing Confirm, and the floor reads to find out
 * what is still missing. Read-only on both surfaces and free of page chrome, so it drops
 * into the admin detail page and into `PanelShell` unchanged and takes its width from
 * whichever one is rendering it.
 */
export function ReceivingSummaryView({ summary, className }: { summary: ReceivingSummary; className?: string }) {
  const t = useT()
  const [showMatching, setShowMatching] = React.useState(false)
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set())

  const matchingCount = summary.items.filter(isMatching).length
  const rows = showMatching ? summary.items : summary.items.filter((row) => !isMatching(row))

  function toggleBreakdown(catalogVariantId: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(catalogVariantId)) next.add(catalogVariantId)
      return next
    })
  }

  return (
    <div className={cn('flex flex-col gap-4', className)} data-testid="receiving-summary">
      <p className="text-sm text-muted-foreground">
        {t('pz.receiving.summary.subtitle', undefined, {
          palletCount: summary.palletCount,
          closedCount: summary.palletsClosed,
        })}
      </p>

      {matchingCount > 0 ? (
        <CheckboxField
          checked={showMatching}
          onCheckedChange={(checked) => setShowMatching(checked === true)}
          label={t('pz.receiving.summary.showMatching', undefined, { count: matchingCount })}
        />
      ) : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pz.receiving.summary.empty')}</p>
      ) : (
        /**
         * One table at every width rather than a table and a separate stacked list: the
         * cells only change how they lay out below 768px, and the explicit roles keep the
         * headers announced once `display` stops making them implicit.
         */
        <Table role="table" className="block md:table">
          <TableCaption className="sr-only">{t('pz.receiving.summary.title')}</TableCaption>
          <TableHeader role="rowgroup" className="hidden md:table-header-group">
            <TableRow role="row">
              <TableHead role="columnheader" scope="col">{t('pz.receiving.summary.column.product')}</TableHead>
              <TableHead role="columnheader" scope="col">{t('pz.receiving.summary.column.sku')}</TableHead>
              <TableHead role="columnheader" scope="col">{t('pz.receiving.summary.column.expected')}</TableHead>
              <TableHead role="columnheader" scope="col">{t('pz.receiving.summary.column.counted')}</TableHead>
              <TableHead role="columnheader" scope="col">{t('pz.receiving.summary.column.difference')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody role="rowgroup" className="block md:table-row-group">
            {rows.map((row) => (
              <SummaryRow
                key={row.catalogVariantId}
                row={row}
                expanded={expanded.has(row.catalogVariantId)}
                onToggle={() => toggleBreakdown(row.catalogVariantId)}
              />
            ))}
          </TableBody>
          <TableFooter role="rowgroup" className="block md:table-footer-group">
            <TableRow role="row" className="block md:table-row">
              <TableCell role="cell" colSpan={SUMMARY_COLUMN_COUNT} className="block md:table-cell">
                <span aria-live="polite">{formatUnitTotals(summary.totalsByUnit, t)}</span>
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      )}
    </div>
  )
}

function SummaryRow({
  row,
  expanded,
  onToggle,
}: {
  row: ReceivingSummaryRow
  expanded: boolean
  onToggle: () => void
}) {
  const t = useT()
  const breakdownId = `receiving-summary-breakdown-${row.catalogVariantId}`
  const product = row.name ?? t('pz.receiving.summary.unknownProduct')

  return (
    <>
      <TableRow role="row" className="block border-b p-2 md:table-row md:p-0">
        <StackedCell label={t('pz.receiving.summary.column.product')}>{product}</StackedCell>
        <StackedCell label={t('pz.receiving.summary.column.sku')}>{row.sku ?? '—'}</StackedCell>
        <StackedCell label={t('pz.receiving.summary.column.expected')}>
          {row.expected === null ? t('pz.receiving.summary.expected.none') : withUnit(formatQuantityForDisplay(row.expected), row.unit)}
        </StackedCell>
        <StackedCell label={t('pz.receiving.summary.column.counted')}>
          {withUnit(formatQuantityForDisplay(row.counted), row.unit)}
        </StackedCell>
        <StackedCell label={t('pz.receiving.summary.column.difference')}>
          <span className="flex w-full flex-wrap items-center gap-2">
            <DifferenceBadge row={row} />
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-controls={breakdownId}
              // 44px minimum target: this is tapped with gloves on a handheld.
              className="ml-auto inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="sr-only">
                {t(expanded ? 'pz.receiving.summary.breakdown.hide' : 'pz.receiving.summary.breakdown.show', undefined, {
                  product,
                })}
              </span>
              <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
            </button>
          </span>
        </StackedCell>
      </TableRow>
      <TableRow role="row" id={breakdownId} className={cn('border-b', expanded ? 'block md:table-row' : 'hidden')}>
        <TableCell role="cell" colSpan={SUMMARY_COLUMN_COUNT} className="block text-sm text-muted-foreground md:table-cell">
          {row.pallets.length === 0
            ? t('pz.receiving.summary.expected.none')
            : row.pallets.map((pallet) => `${pallet.code}: ${formatQuantityForDisplay(pallet.quantity)}`).join(' · ')}
        </TableCell>
      </TableRow>
    </>
  )
}

/**
 * Below 768px the cells stack, so each one repeats its column header inline — the header row
 * is the one thing a stacked layout cannot keep on screen.
 */
function StackedCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <TableCell role="cell" className="flex flex-wrap items-center gap-2 px-2 py-1 md:table-cell md:px-4 md:py-2">
      <span className="text-xs uppercase tracking-wide text-muted-foreground md:hidden">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </TableCell>
  )
}

const DIFFERENCE_VARIANTS: Record<'short' | 'over' | 'surplus' | 'match', StatusBadgeVariant> = {
  short: 'error',
  over: 'warning',
  surplus: 'info',
  match: 'success',
}

/** The difference is stated in words: colour alone would leave it unreadable to half the floor. */
function DifferenceBadge({ row }: { row: ReceivingSummaryRow }) {
  const t = useT()
  const kind = differenceKind(row)
  return (
    <StatusBadge variant={DIFFERENCE_VARIANTS[kind]} dot>
      {t(`pz.receiving.summary.difference.${kind}`, undefined, { count: formatQuantityForDisplay(absolute(row.difference)) })}
    </StatusBadge>
  )
}

function differenceKind(row: ReceivingSummaryRow): 'short' | 'over' | 'surplus' | 'match' {
  if (row.surplus) return 'surplus'
  if (row.difference.startsWith('-')) return 'short'
  return isMatching(row) ? 'match' : 'over'
}

function isMatching(row: ReceivingSummaryRow): boolean {
  return !row.surplus && /^-?0*\.?0*$/.test(row.difference)
}

function absolute(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value
}

function withUnit(quantity: string, unit: string | null): string {
  return unit ? `${quantity} ${unit}` : quantity
}

/**
 * One total per unit. Cartons and pieces are not addable, and this line sits next to the
 * button that posts the delivery into stock, so a single number summed across them would be
 * a figure that is true of nothing.
 */
function formatUnitTotals(
  totals: ReceivingSummary['totalsByUnit'],
  t: ReturnType<typeof useT>,
): string {
  if (totals.length === 0) return t('pz.receiving.summary.totals.none')
  return totals
    .map((total) =>
      t('pz.receiving.summary.totals.unit', undefined, {
        unit: total.unit ?? t('pz.receiving.summary.totals.noUnit'),
        expected: formatQuantityForDisplay(total.expected),
        counted: formatQuantityForDisplay(total.counted),
      }),
    )
    .join(' · ')
}

/**
 * The summary is derived on every read rather than cached: a Warehouseman refreshing it
 * mid-count is asking what is on the pallets right now.
 */
export function useReceivingSummary(goodsReceiptId: string) {
  const { data, isLoading, error, refetch } = useQuery<ReceivingSummaryResponse>({
    queryKey: ['pz.receivingSummary', goodsReceiptId],
    enabled: goodsReceiptId.length > 0,
    queryFn: async () => {
      const result = await readApiResultOrThrow<ReceivingSummaryResponse>(
        `/api/pz/goods-receipts/receiving-summary?id=${encodeURIComponent(goodsReceiptId)}`,
      )
      if (!result) throw new Error('[internal] The receiving summary response was empty.')
      return result
    },
  })
  return { data, isLoading, error, refetch }
}
