"use client"
import * as React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeftRight, ClipboardCheck, PackageOpen, ScanLine, type LucideIcon } from 'lucide-react'
import { cn } from '@open-mercato/shared/lib/utils'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { fetchReceivingDocuments, type ReceivingDocument } from '../lib/receivingApi'
import { RECEIVING_LIST_HREF } from '../lib/receivingPanel'

type PanelAction = { href: string; labelKey: string; Icon: LucideIcon; primary?: boolean }

const ACTIONS: readonly PanelAction[] = [
  { href: RECEIVING_LIST_HREF, labelKey: 'warehouseman.actions.receiving', Icon: PackageOpen, primary: true },
  { href: '/warehouseman/scan', labelKey: 'warehouseman.actions.scan', Icon: ScanLine },
  { href: '/warehouseman/transfer', labelKey: 'warehouseman.actions.transfer', Icon: ArrowLeftRight },
  { href: '/warehouseman/stocktake', labelKey: 'warehouseman.actions.stocktake', Icon: ClipboardCheck },
]

export function PanelHome({ assignedWarehouseId }: { assignedWarehouseId: string | null }) {
  const t = useT()
  // A badge is worth one request and no screen of its own: the count decides whether the
  // warehouseman walks to the dock at all. A failure leaves the tile unbadged, not broken.
  const { data } = useQuery<ReceivingDocument[]>({
    queryKey: ['warehouseman.receiving.documents', assignedWarehouseId],
    queryFn: () => fetchReceivingDocuments(assignedWarehouseId),
  })
  const pending = data?.length ?? 0

  return (
    <nav aria-label={t('warehouseman.panel.title')}>
      <ul className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {ACTIONS.map(({ href, labelKey, Icon, primary }) => (
          <li key={href}>
            <Link
              href={href}
              className={cn(
                'flex h-44 flex-col justify-between rounded-lg border-2 border-border p-4 focus-visible:outline-none focus-visible:shadow-focus',
                primary
                  ? 'bg-primary text-primary-foreground hover:bg-primary-hover'
                  : 'bg-card text-card-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <span className="flex items-start justify-between gap-2">
                <Icon className="size-11" aria-hidden="true" />
                {primary && pending > 0 ? (
                  <span className="inline-flex h-9 min-w-9 items-center justify-center rounded-md border-2 border-border bg-card px-2 text-xl font-bold text-card-foreground">
                    {pending}
                    <span className="sr-only"> {t('warehouseman.panel.pendingDocuments')}</span>
                  </span>
                ) : null}
              </span>
              <span className="text-xl font-bold leading-tight">{t(labelKey)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export default PanelHome
