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

export default ReceivingDocuments
