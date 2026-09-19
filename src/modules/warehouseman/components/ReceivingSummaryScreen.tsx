"use client"
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useMutation } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ReceivingSummaryView, useReceivingSummary } from '@/modules/pz/components/ReceivingSummary'
import { DestinationPicker, useDestinations, type Destination } from '@/modules/pz/components/DestinationPicker'
import type { ReceivingSummaryResponse, ReceivingSummaryUnitTotal } from '@/modules/pz/lib/receivingSummary'
import type { ConfirmationBlocker } from '@/modules/pz/lib/stockPosting'
import { PANEL_PRIMARY, PanelCard, PanelFooter, SectionLabel, StatTile } from './PanelUI'
import { PanelLinkButton, ScreenError, ScreenMessage, ScreenWarning } from './ReceivingStates'
import { confirmDelivery, ReceivingApiError } from '../lib/receivingApi'
import { receivingReceiptHref, RECEIVING_LIST_HREF, resolveApiMessage } from '../lib/receivingPanel'

export type ReceivingSummaryScreenProps = { receiptId: string }

/**
 * Expected against counted, and the one irreversible thing the floor can do.
 *
 * The comparison is the same component the office reads on the goods receipt order detail
 * page — two renderings of one comparison would be two chances to disagree about what
 * arrived. The panel puts the numbers that decide whether to call the office above it, at a
 * size readable at arm's length, and the finish below it: where the goods go, and the button
 * that confirms the document and starts the Stock Posting (ADR-0011).
 */
export function ReceivingSummaryScreen({ receiptId }: ReceivingSummaryScreenProps) {
  const t = useT()
  const router = useRouter()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const { data, isLoading, error, refetch } = useReceivingSummary(receiptId)
  const [destinationId, setDestinationId] = React.useState<string | null>(null)
  const [touched, setTouched] = React.useState(false)
  const [actionError, setActionError] = React.useState<string | null>(null)

  const postingEnabled = data?.stockPosting.enabled ?? false
  const destinations = useDestinations(receiptId, postingEnabled && data?.status === 'receiving')

  // The warehouse's Default Destination is a starting point, not a decision: once the floor
  // has touched the picker, their choice stands even if a refetch reports another default.
  const defaultDestinationId = destinations.options.defaultLocationId
  React.useEffect(() => {
    if (!touched && defaultDestinationId) setDestinationId(defaultDestinationId)
  }, [defaultDestinationId, touched])

  const confirmation = useMutation({
    mutationFn: (expectedVersion: string | null) =>
      confirmDelivery({ id: receiptId, destinationLocationId: destinationId, expectedVersion }),
    onSuccess: () => router.push(RECEIVING_LIST_HREF),
    onError: (err: unknown) => {
      setActionError(messageOf(err, t('warehouseman.receiving.confirm.error')))
      // A refused confirmation is almost always somebody else's write landing first, so the
      // screen is brought up to date rather than left showing what was refused.
      void refetch()
    },
  })

  if (isLoading) return <ScreenMessage>{t('pz.receiving.summary.loading')}</ScreenMessage>
  if (error || !data) return <ScreenError>{t('pz.receiving.summary.error')}</ScreenError>

  const blockers = remainingBlockers(data, destinationId)
  const options = destinations.options.items

  return (
    <div className="flex flex-col gap-4">
      <UnitTotals totals={data.totalsByUnit} />
      <SectionLabel>{t('pz.receiving.summary.title')}</SectionLabel>
      <ReceivingSummaryView summary={data} />

      {data.status === 'receiving' ? (
        <>
          {postingEnabled ? (
            <PanelCard>
              <DestinationPicker
                className="flex flex-col gap-2"
                labelClassName="text-sm font-bold uppercase tracking-widest text-muted-foreground"
                options={options}
                value={destinationId}
                onChange={(next) => {
                  setTouched(true)
                  setDestinationId(next)
                }}
              />
            </PanelCard>
          ) : null}

          {blockers.length > 0 ? (
            <ScreenWarning>
              <ul className="flex flex-col gap-1">
                {blockers.map((blocker) => (
                  <li key={blocker.kind}>{describeBlocker(blocker, t)}</li>
                ))}
              </ul>
            </ScreenWarning>
          ) : null}

          {actionError ? <ScreenError>{actionError}</ScreenError> : null}

          <PanelFooter>
            <Button
              type="button"
              className={PANEL_PRIMARY}
              disabled={blockers.length > 0 || confirmation.isPending}
              onClick={() => {
                void (async () => {
                  setActionError(null)
                  const acknowledged = await confirm({
                    title: t('warehouseman.receiving.confirm.title'),
                    description: t('warehouseman.receiving.confirm.description', undefined, {
                      counted: describeCounted(data, t),
                      destination: destinationLabel(options, destinationId, t),
                    }),
                    confirmText: t('warehouseman.receiving.confirm.action'),
                  })
                  if (!acknowledged) return
                  // The version sent is the one the floor was looking at, never a freshly
                  // read one: re-reading it here would make the lock accept a change nobody
                  // saw.
                  confirmation.mutate(data.updatedAt)
                })()
              }}
            >
              <Check aria-hidden="true" className="size-7" />
              {t('warehouseman.receiving.confirm.action')}
            </Button>
            <PanelLinkButton href={receivingReceiptHref(receiptId)}>
              {t('warehouseman.receiving.summary.backToPallets')}
            </PanelLinkButton>
          </PanelFooter>
        </>
      ) : (
        <>
          <PostingState summary={data} />
          <PanelFooter>
            <PanelLinkButton href={receivingReceiptHref(receiptId)}>
              {t('warehouseman.receiving.summary.backToPallets')}
            </PanelLinkButton>
          </PanelFooter>
        </>
      )}
      {ConfirmDialogElement}
    </div>
  )
}

/**
 * The three numbers a glance lands on, once per unit. A document written in one unit — nearly
 * all of them — reads exactly as it did before; one mixing cartons and pieces gets a row
 * each, because a single sum across them is a figure that is true of nothing, and this sits
 * directly above the button that posts the stock.
 */
function UnitTotals({ totals }: { totals: ReceivingSummaryUnitTotal[] }) {
  const t = useT()
  if (totals.length === 0) return null
  return (
    <div className="flex flex-col gap-3">
      {totals.map((total) => {
        const difference = toNumber(total.counted) - toNumber(total.expected)
        return (
          <div key={total.unit ?? ''} className="flex flex-col gap-1">
            {totals.length > 1 ? (
              <SectionLabel>{total.unit ?? t('pz.receiving.summary.totals.noUnit')}</SectionLabel>
            ) : null}
            <div className="grid grid-cols-3 gap-3">
              <StatTile label={t('pz.receiving.summary.column.expected')} value={trim(total.expected)} />
              <StatTile label={t('pz.receiving.summary.column.counted')} value={trim(total.counted)} />
              <StatTile
                label={t('pz.receiving.summary.column.difference')}
                value={difference > 0 ? `+${trim(String(difference))}` : trim(String(difference))}
                tone={difference === 0 ? 'success' : 'error'}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** What the floor is told once the document is no longer theirs to finish. */
function PostingState({ summary }: { summary: ReceivingSummaryResponse }) {
  const t = useT()
  if (summary.stockPosting.status === 'failed') {
    return <ScreenError>{t('warehouseman.receiving.posting.failed')}</ScreenError>
  }
  if (summary.stockPosting.status === 'pending') {
    return <ScreenWarning>{t('warehouseman.receiving.posting.pending')}</ScreenWarning>
  }
  return <ScreenMessage>{t('warehouseman.receiving.posting.done')}</ScreenMessage>
}

/**
 * The server answers with the blockers as they stand for the warehouse's default choice, so
 * the two that a picked destination resolves are dropped once one is picked. Everything else
 * is a fact about the delivery and stands whatever this screen does.
 */
function remainingBlockers(summary: ReceivingSummaryResponse, destinationId: string | null): ConfirmationBlocker[] {
  return summary.blockers.filter((blocker) => {
    if (!destinationId) return true
    return blocker.kind !== 'destinationRequired' && blocker.kind !== 'destinationInvalid'
  })
}

function describeBlocker(blocker: ConfirmationBlocker, t: ReturnType<typeof useT>): string {
  switch (blocker.kind) {
    case 'palletsOpen':
      return t('pz.receiving.blocker.palletsOpen', undefined, { count: blocker.count })
    case 'trackedVariants':
      return t('pz.receiving.blocker.trackedVariants', undefined, {
        products: blocker.products.join(', '),
      })
    default:
      return t(`pz.receiving.blocker.${blocker.kind}`)
  }
}

/** Per unit, never one sum: this sentence is the last thing read before an irreversible act. */
function describeCounted(summary: ReceivingSummaryResponse, t: ReturnType<typeof useT>): string {
  if (summary.totalsByUnit.length === 0) return t('warehouseman.receiving.confirm.counted.none')
  return summary.totalsByUnit
    .map((total) =>
      t('warehouseman.receiving.confirm.counted.unit', undefined, {
        counted: trim(total.counted),
        unit: total.unit ?? t('pz.receiving.summary.totals.noUnit'),
      }),
    )
    .join(' · ')
}

function destinationLabel(options: Destination[], id: string | null, t: ReturnType<typeof useT>): string {
  if (!id) return t('pz.receiving.destination.none')
  return options.find((option) => option.id === id)?.code ?? id
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ReceivingApiError) return resolveApiMessage({ error: error.message }, fallback)
  return error instanceof Error && error.message ? error.message : fallback
}

function toNumber(raw: string): number {
  return Number.parseFloat(raw) || 0
}

/** Storage precision is not something to read off a wall-mounted tablet. */
function trim(raw: string): string {
  return String(Number(toNumber(raw).toFixed(4)))
}

export default ReceivingSummaryScreen
