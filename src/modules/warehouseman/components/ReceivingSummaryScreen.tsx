"use client"
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ReceivingSummaryView, useReceivingSummary } from '@/modules/pz/components/ReceivingSummary'
import { SectionLabel, StatTile } from './PanelUI'
import { PanelLinkButton, ScreenError, ScreenMessage } from './ReceivingStates'
import { receivingReceiptHref } from '../lib/receivingPanel'

export type ReceivingSummaryScreenProps = { receiptId: string }

/**
 * Expected against counted, read-only, and deliberately the same component the office
 * reads on the goods receipt detail page — two renderings of one comparison would be two
 * chances to disagree about what arrived. The panel only puts the three numbers that
 * decide whether to call the office above it, at a size readable at arm's length.
 */
export function ReceivingSummaryScreen({ receiptId }: ReceivingSummaryScreenProps) {
  const t = useT()
  const { data, isLoading, error } = useReceivingSummary(receiptId)

  const difference = data ? toNumber(data.totals.counted) - toNumber(data.totals.expected) : 0

  return (
    <div className="flex flex-col gap-4">
      {isLoading ? <ScreenMessage>{t('pz.receiving.summary.loading')}</ScreenMessage> : null}
      {error ? <ScreenError>{t('pz.receiving.summary.error')}</ScreenError> : null}
      {data ? (
        <>
          <div className="grid grid-cols-3 gap-3">
            <StatTile label={t('pz.receiving.summary.column.expected')} value={trim(data.totals.expected)} />
            <StatTile label={t('pz.receiving.summary.column.counted')} value={trim(data.totals.counted)} />
            <StatTile
              label={t('pz.receiving.summary.column.difference')}
              value={difference > 0 ? `+${trim(String(difference))}` : trim(String(difference))}
              tone={difference === 0 ? 'success' : 'error'}
            />
          </div>
          <SectionLabel>{t('pz.receiving.summary.title')}</SectionLabel>
          <ReceivingSummaryView summary={data} />
        </>
      ) : null}
      <PanelLinkButton href={receivingReceiptHref(receiptId)}>
        {t('warehouseman.receiving.summary.backToPallets')}
      </PanelLinkButton>
    </div>
  )
}

function toNumber(raw: string): number {
  return Number.parseFloat(raw) || 0
}

/** Storage precision is not something to read off a wall-mounted tablet. */
function trim(raw: string): string {
  const value = toNumber(raw)
  return String(Number(value.toFixed(4)))
}

export default ReceivingSummaryScreen
