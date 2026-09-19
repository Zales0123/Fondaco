"use client"
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ReceivingSummaryView, useReceivingSummary } from '@/modules/pz/components/ReceivingSummary'
import { PanelLinkButton, ScreenError, ScreenMessage } from './ReceivingStates'
import { receivingReceiptHref } from '../lib/receivingPanel'

export type ReceivingSummaryScreenProps = { receiptId: string }

/**
 * Expected against counted, read-only, and deliberately the same component the office
 * reads on the goods receipt detail page — two renderings of one comparison would be two
 * chances to disagree about what arrived.
 */
export function ReceivingSummaryScreen({ receiptId }: ReceivingSummaryScreenProps) {
  const t = useT()
  const { data, isLoading, error } = useReceivingSummary(receiptId)

  return (
    <div className="flex flex-col gap-4">
      {isLoading ? <ScreenMessage>{t('pz.receiving.summary.loading')}</ScreenMessage> : null}
      {error ? <ScreenError>{t('pz.receiving.summary.error')}</ScreenError> : null}
      {data ? <ReceivingSummaryView summary={data} /> : null}
      <PanelLinkButton href={receivingReceiptHref(receiptId)}>
        {t('warehouseman.receiving.summary.backToPallets')}
      </PanelLinkButton>
    </div>
  )
}

export default ReceivingSummaryScreen
