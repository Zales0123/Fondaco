"use client"
import * as React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Warehouse } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { formatDisplayDate } from '@open-mercato/ui/primitives/date-format'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { SectionLabel } from './PanelUI'
import { PanelLinkButton, ScreenEmpty, ScreenError, ScreenMessage } from './ReceivingStates'
import {
  fetchFailedPostings,
  fetchReceivingDocuments,
  resolveWarehouseLabel,
  searchWarehouses,
  ReceivingApiError,
  type ReceivingDocument,
} from '../lib/receivingApi'
import { receivingReceiptHref, type WarehouseFilter } from '../lib/receivingPanel'
import { PANEL_HOME_PATH } from './PanelLoginForm'

export type ReceivingDocumentsProps = {
  assignedWarehouseId: string | null
}

/**
 * The documents the office has released to this floor. The Assigned Warehouse only picks
 * the starting filter: widening to another Warehouse of the same Organization is an
 * ordinary choice here, and clearing the picker asks for all of them (ADR-0002).
 */
export function ReceivingDocuments({ assignedWarehouseId }: ReceivingDocumentsProps) {
  const t = useT()
  const locale = useLocale()
  const [warehouse, setWarehouse] = React.useState<WarehouseFilter>(assignedWarehouseId)
  const [widening, setWidening] = React.useState(false)

  const { data, isLoading, error } = useQuery<ReceivingDocument[]>({
    queryKey: ['warehouseman.receiving.documents', warehouse],
    queryFn: () => fetchReceivingDocuments(warehouse),
  })
  /**
   * A stock posting fails minutes after the delivery left this list, so there is no screen
   * for it to appear on unless this one goes looking. It is polled rather than pushed
   * because the failure happens in a worker the browser holds no channel to, and one small
   * query a minute is the cheapest honest way to stop a stuck delivery going unnoticed.
   */
  const failed = useQuery<ReceivingDocument[]>({
    queryKey: ['warehouseman.receiving.failedPostings', warehouse],
    queryFn: () => fetchFailedPostings(warehouse),
    refetchInterval: 60_000,
  })

  if (isLoading) return <ScreenMessage>{t('warehouseman.receiving.list.loading')}</ScreenMessage>

  if (error) {
    const denied = error instanceof ReceivingApiError && (error.status === 401 || error.status === 403)
    return (
      <div className="flex flex-col gap-4">
        <ScreenError>
          {denied
            ? t('warehouseman.receiving.list.denied')
            : (error instanceof Error && error.message) || t('warehouseman.receiving.list.error')}
        </ScreenError>
        <PanelLinkButton href={PANEL_HOME_PATH}>{t('warehouseman.stub.back')}</PanelLinkButton>
      </div>
    )
  }

  const documents = data ?? []
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <SectionLabel className="flex-1">
          {t('warehouseman.receiving.list.count', undefined, { count: documents.length })}
        </SectionLabel>
        {widening ? null : (
          <Button
            type="button"
            variant="outline"
            className="h-14 border-2 px-4 text-lg font-semibold"
            onClick={() => setWidening(true)}
          >
            <Warehouse aria-hidden="true" className="size-6" />
            {t('warehouseman.receiving.list.warehouse.widen')}
          </Button>
        )}
      </div>

      {widening ? (
        <label className="flex flex-col gap-2">
          {/* `ComboboxInput` takes no id and no `aria-label`, so the label has to contain it. */}
          <span className="text-lg font-semibold">{t('warehouseman.receiving.list.warehouse.label')}</span>
          <ComboboxInput
            value={warehouse ?? ''}
            onChange={(next) => setWarehouse(next || null)}
            placeholder={t('warehouseman.receiving.list.warehouse.all')}
            loadSuggestions={searchWarehouses}
            resolveLabel={resolveWarehouseLabel}
            allowCustomValues={false}
            clearable
            clearLabel={t('warehouseman.receiving.list.warehouse.all')}
          />
        </label>
      ) : null}

      <FailedPostings documents={failed.data ?? []} />

      {documents.length === 0 ? (
        <ScreenEmpty
          title={t('warehouseman.receiving.list.empty.title')}
          description={t('warehouseman.receiving.list.empty.description')}
        />
      ) : (
        <ul className="flex flex-col gap-4 md:grid md:grid-cols-2">
          {documents.map((document) => (
            <li key={document.id}>
              <Link
                href={receivingReceiptHref(document.id)}
                className="flex h-full flex-col gap-3 rounded-lg border-2 border-border bg-card p-4 hover:bg-accent focus-visible:outline-none focus-visible:shadow-focus"
              >
                <span className="flex items-center gap-3">
                  <span className="text-2xl font-bold tracking-tight">{document.documentNumber}</span>
                  <ChevronRight className="ml-auto size-7 shrink-0" aria-hidden="true" />
                </span>
                <dl className="flex flex-wrap gap-x-6 gap-y-2">
                  <DocumentFact label={t('warehouseman.receiving.list.supplier.label')}>
                    {document.supplierName}
                  </DocumentFact>
                  <DocumentFact label={t('warehouseman.receiving.list.date.label')}>
                    {formatDisplayDate(document.documentDate, locale) ?? '—'}
                  </DocumentFact>
                  <DocumentFact label={t('warehouseman.receiving.list.pallets.label')}>
                    {document.palletCount ?? 0}
                  </DocumentFact>
                  {document.warehouseSnapshot ? (
                    <DocumentFact label={t('warehouseman.receiving.list.warehouse.label')}>
                      {document.warehouseSnapshot.name}
                    </DocumentFact>
                  ) : null}
                </dl>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <PanelLinkButton href={PANEL_HOME_PATH}>{t('warehouseman.stub.back')}</PanelLinkButton>
    </div>
  )
}

function DocumentFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="truncate text-lg font-semibold">{children}</dd>
    </div>
  )
}

/**
 * Deliveries this floor confirmed whose goods never reached stock. It names them and says who
 * fixes them: the causes are configuration the office owns, so offering the floor a retry
 * here would offer them a button that cannot work (ADR-0011).
 */
function FailedPostings({ documents }: { documents: ReceivingDocument[] }) {
  const t = useT()
  if (documents.length === 0) return null
  return (
    <ScreenError>
      <p className="font-bold">{t('warehouseman.receiving.posting.failedList')}</p>
      <ul className="mt-1 flex flex-col gap-1 font-mono">
        {documents.map((document) => (
          <li key={document.id}>{document.documentNumber}</li>
        ))}
      </ul>
    </ScreenError>
  )
}

export default ReceivingDocuments
