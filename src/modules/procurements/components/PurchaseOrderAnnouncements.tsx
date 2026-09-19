"use client"

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
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
import { formatQuantity } from './purchaseOrdersPresentation'

export type PurchaseOrderAnnouncement = {
  id: string
  purchaseOrderLineId: string
  lineNumber: number | null
  catalogSnapshot: { name: string; sku: string | null } | null
  sourceType: string
  sourceDocumentId: string
  sourceDocumentNumber: string | null
  sourceLineNumber: number | null
  quantity: string
  status: string
  releasedAt: string | null
  createdAt: string | null
}

type AnnouncementsResponse = { items: PurchaseOrderAnnouncement[] }

/**
 * What warehouse delivery announcements currently hold against this order.
 *
 * Read-only on purpose: the quantity is claimed and released by the announcing document's
 * own lifecycle, so there is nothing to edit here. Offering a button would suggest the
 * order can take a claim back behind the warehouse's back, which it cannot.
 *
 * The announcing document is named by the number captured when the claim was made, so this
 * list stays readable without reaching into another module's tables.
 */
export function PurchaseOrderAnnouncements({ purchaseOrderId }: { purchaseOrderId: string }) {
  const t = useT()
  const locale = useLocale()
  const scopeVersion = useOrganizationScopeVersion()
  const { data, isLoading, error } = useQuery<AnnouncementsResponse>({
    queryKey: ['procurements.purchaseOrderAnnouncements', purchaseOrderId, scopeVersion],
    queryFn: async () =>
      (await readApiResultOrThrow<AnnouncementsResponse>(
        `/api/procurements/purchase-orders/announcements?purchaseOrderId=${encodeURIComponent(purchaseOrderId)}`,
      )) ?? { items: [] },
  })

  const items = data?.items ?? []

  return (
    <section className="space-y-4 border-t pt-6" aria-labelledby="purchase-order-announcements-heading">
      <h2 id="purchase-order-announcements-heading" className="text-base font-semibold">
        {t('procurements.purchaseOrders.view.section.announcements')}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t('procurements.purchaseOrders.view.announcements.hint')}
      </p>
      {isLoading ? (
        <LoadingMessage label={t('procurements.purchaseOrders.view.announcements.loading')} />
      ) : error ? (
        <ErrorMessage label={t('procurements.purchaseOrders.view.announcements.error')} />
      ) : (
        <div className="relative w-full overflow-x-auto">
          <Table>
            <TableCaption className="sr-only">
              {t('procurements.purchaseOrders.view.announcements.caption')}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">
                  {t('procurements.purchaseOrders.view.announcements.column.document')}
                </TableHead>
                <TableHead scope="col">
                  {t('procurements.purchaseOrders.view.announcements.column.position')}
                </TableHead>
                <TableHead scope="col">
                  {t('procurements.purchaseOrders.view.announcements.column.product')}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t('procurements.purchaseOrders.view.announcements.column.quantity')}
                </TableHead>
                <TableHead scope="col">
                  {t('procurements.purchaseOrders.view.announcements.column.status')}
                </TableHead>
                <TableHead scope="col">
                  {t('procurements.purchaseOrders.view.announcements.column.createdAt')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length ? items.map((announcement) => (
                <TableRow key={announcement.id}>
                  <TableCell className="whitespace-nowrap">
                    {announcement.sourceDocumentNumber
                      || t('procurements.purchaseOrders.view.announcements.unknownDocument')}
                    {announcement.sourceLineNumber != null ? (
                      <span className="text-muted-foreground"> / {announcement.sourceLineNumber}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>{announcement.lineNumber ?? '—'}</TableCell>
                  <TableCell>
                    {announcement.catalogSnapshot?.name ?? t('procurements.purchaseOrders.view.unknownProduct')}
                    {announcement.catalogSnapshot?.sku ? (
                      <span className="text-muted-foreground"> — {announcement.catalogSnapshot.sku}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQuantity(announcement.quantity)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge variant={announcement.status === 'outstanding' ? 'info' : 'neutral'} dot>
                      {t(`procurements.purchaseOrders.view.announcements.status.${announcement.status}`)}
                    </StatusBadge>
                  </TableCell>
                  <TableCell>{formatDisplayDate(announcement.createdAt, locale) ?? '—'}</TableCell>
                </TableRow>
              )) : (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    {t('procurements.purchaseOrders.view.announcements.empty')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

export default PurchaseOrderAnnouncements
