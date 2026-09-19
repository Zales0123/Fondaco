"use client"
import * as React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@open-mercato/ui/primitives/button'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { formatDisplayDate } from '@open-mercato/ui/primitives/date-format'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { PANEL_HOME_PATH } from './PanelLoginForm'
import { PanelLinkButton, ScreenEmpty, ScreenError, ScreenMessage } from './ReceivingStates'
import {
  fetchReceivingDocuments,
  resolveWarehouseLabel,
  searchWarehouses,
  ReceivingApiError,
  type ReceivingDocument,
} from '../lib/receivingApi'
import { receivingReceiptHref, type WarehouseFilter } from '../lib/receivingPanel'

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
      <h2 className="text-xl font-semibold">{t('warehouseman.receiving.list.title')}</h2>

      {widening ? (
        <label className="flex flex-col gap-2">
          {/* `ComboboxInput` takes no id and no `aria-label`, so the label has to contain it. */}
          <span className="text-lg">{t('warehouseman.receiving.list.warehouse.label')}</span>
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
      ) : (
        <Button
          type="button"
          size="lg"
          variant="outline"
          className="h-16 w-full text-lg"
          onClick={() => setWidening(true)}
        >
          {t('warehouseman.receiving.list.warehouse.widen')}
        </Button>
      )}

      {documents.length === 0 ? (
        <ScreenEmpty
          title={t('warehouseman.receiving.list.empty.title')}
          description={t('warehouseman.receiving.list.empty.description')}
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {documents.map((document) => (
            <li key={document.id}>
              <Link
                href={receivingReceiptHref(document.id)}
                className="flex min-h-16 flex-col gap-1 rounded-md border border-border p-4 text-lg hover:bg-muted focus-visible:outline-none focus-visible:shadow-focus"
              >
                <span className="font-semibold">{document.documentNumber}</span>
                <span className="text-muted-foreground">
                  {t('warehouseman.receiving.list.supplier', undefined, { supplier: document.supplierName })}
                </span>
                <span className="text-muted-foreground">
                  {formatDisplayDate(document.documentDate, locale) ?? '—'}
                </span>
                <span className="text-muted-foreground">
                  {t('warehouseman.receiving.list.palletCount', undefined, { count: document.palletCount ?? 0 })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <PanelLinkButton href={PANEL_HOME_PATH}>{t('warehouseman.stub.back')}</PanelLinkButton>
    </div>
  )
}

export default ReceivingDocuments
