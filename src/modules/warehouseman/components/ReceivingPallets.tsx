"use client"
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, ListChecks, Plus, Trash2 } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { cn } from '@open-mercato/shared/lib/utils'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PANEL_PRIMARY, PanelFooter, ScanField, SectionLabel } from './PanelUI'
import { PanelLinkButton, ScreenEmpty, ScreenError, ScreenMessage } from './ReceivingStates'
import {
  createPallet,
  deletePallet,
  fetchPallets,
  fetchReceivingDocument,
  findPalletByCode,
  ReceivingApiError,
  type Pallet,
  type PalletStatus,
  type ReceivingDocument,
} from '../lib/receivingApi'
import {
  normalizeScannedCode,
  receivingPalletHref,
  RECEIVING_LIST_HREF,
} from '../lib/receivingPanel'

const PALLET_STATUS_VARIANTS: Record<PalletStatus, StatusBadgeVariant> = {
  open: 'info',
  closed: 'success',
}

export type ReceivingPalletsProps = { receiptId: string }

/**
 * The pallets of one released document. Creating one lands the warehouseman inside it:
 * a pallet exists to be counted onto, and making them tap the new row first is a step
 * nobody on the floor wants.
 */
export function ReceivingPallets({ receiptId }: ReceivingPalletsProps) {
  const t = useT()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [code, setCode] = React.useState('')
  const [scanError, setScanError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)

  const document = useQuery<ReceivingDocument | null>({
    queryKey: ['warehouseman.receiving.document', receiptId],
    queryFn: () => fetchReceivingDocument(receiptId),
  })
  const pallets = useQuery<Pallet[]>({
    queryKey: ['warehouseman.receiving.pallets', receiptId],
    queryFn: () => fetchPallets(receiptId),
  })

  const create = useMutation({
    mutationFn: () => createPallet(receiptId),
    onSuccess: (pallet) => {
      queryClient.invalidateQueries({ queryKey: ['warehouseman.receiving.pallets', receiptId] })
      router.push(receivingPalletHref(receiptId, pallet.id))
    },
    onError: (error: unknown) => setActionError(messageOf(error, t('pz.pallets.errors.createFailed'))),
  })

  const remove = useMutation({
    mutationFn: (pallet: Pallet) => deletePallet(pallet.id, pallet.updatedAt),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['warehouseman.receiving.pallets', receiptId] }),
    onError: (error: unknown) => setActionError(messageOf(error, t('pz.pallets.errors.deleteFailed'))),
  })

  async function onScan() {
    setScanError(null)
    const scanned = normalizeScannedCode(code)
    if (!scanned) {
      setScanError(t('pz.pallets.errors.codeRequired'))
      return
    }
    try {
      const pallet = await findPalletByCode(scanned, receiptId)
      router.push(receivingPalletHref(receiptId, pallet.id))
    } catch (error) {
      // A pallet of another document is refused by name and the screen stays put: following
      // the scan would file the goods in front of the person against the wrong delivery.
      setScanError(
        error instanceof ReceivingApiError && error.status === 404
          ? t('warehouseman.receiving.pallets.scan.notFound', undefined, { code: scanned })
          : messageOf(error, t('pz.pallets.errors.notFound')),
      )
    }
  }

  async function onDelete(pallet: Pallet) {
    setActionError(null)
    const confirmed = await confirm({
      title: t('warehouseman.receiving.pallets.delete.title'),
      description: t('warehouseman.receiving.pallets.delete.description', undefined, { code: pallet.code }),
      confirmText: t('warehouseman.receiving.pallets.delete.action'),
      variant: 'destructive',
    })
    if (confirmed) remove.mutate(pallet)
  }

  if (pallets.isLoading) return <ScreenMessage>{t('warehouseman.receiving.pallets.loading')}</ScreenMessage>

  if (pallets.error) {
    return (
      <div className="flex flex-col gap-4">
        <ScreenError>{messageOf(pallets.error, t('warehouseman.receiving.pallets.error'))}</ScreenError>
        <PanelLinkButton href={RECEIVING_LIST_HREF}>
          {t('warehouseman.receiving.pallets.backToList')}
        </PanelLinkButton>
      </div>
    )
  }

  const rows = pallets.data ?? []
  return (
    <div className="flex flex-1 flex-col gap-4">
      <p className="text-lg">
        <span className="font-bold">{document.data?.documentNumber ?? ''}</span>
        {document.data?.supplierName ? (
          <span className="text-muted-foreground">
            {' · '}
            {t('warehouseman.receiving.list.supplier', undefined, { supplier: document.data.supplierName })}
          </span>
        ) : null}
      </p>

      <ScanField
        label={t('warehouseman.receiving.pallets.scan.label')}
        placeholder={t('warehouseman.receiving.pallets.scan.placeholder')}
        value={code}
        onChange={setCode}
        onSubmit={onScan}
        submitLabel={t('warehouseman.receiving.pallets.scan.submit')}
      />

      {scanError ? <ScreenError>{scanError}</ScreenError> : null}
      {actionError ? <ScreenError>{actionError}</ScreenError> : null}

      <SectionLabel>{t('warehouseman.receiving.pallets.onDocument')}</SectionLabel>

      {rows.length === 0 ? (
        <ScreenEmpty
          title={t('warehouseman.receiving.pallets.empty.title')}
          description={t('warehouseman.receiving.pallets.empty.description')}
        />
      ) : (
        <ul className="flex flex-col gap-3 md:grid md:grid-cols-2">
          {rows.map((pallet) => (
            <li key={pallet.id} className="flex items-center gap-3 rounded-lg border-2 border-border bg-card p-3">
              <Link
                href={receivingPalletHref(receiptId, pallet.id)}
                className="flex min-w-0 flex-1 items-center gap-3 focus-visible:outline-none focus-visible:shadow-focus"
              >
                <span
                  className={cn(
                    'flex size-14 shrink-0 items-center justify-center rounded-lg border-2',
                    pallet.status === 'closed'
                      ? 'border-status-success-border bg-status-success-bg text-status-success-text'
                      : 'border-border bg-accent text-accent-foreground',
                  )}
                  aria-hidden="true"
                >
                  {pallet.status === 'closed' ? <Check className="size-7" /> : <ListChecks className="size-7" />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate font-mono text-xl font-semibold">{pallet.code}</span>
                  {pallet.label ? (
                    <span className="truncate text-base text-muted-foreground">{pallet.label}</span>
                  ) : null}
                  <span className="flex items-center gap-2">
                    <StatusBadge variant={PALLET_STATUS_VARIANTS[pallet.status]} dot>
                      {t(`pz.pallets.status.${pallet.status}`)}
                    </StatusBadge>
                    <span className="text-base text-muted-foreground">
                      {t('warehouseman.receiving.pallets.lineCount', undefined, { count: pallet.lineCount })}
                    </span>
                  </span>
                </span>
                <ChevronRight className="size-7 shrink-0" aria-hidden="true" />
              </Link>
              {pallet.status === 'open' && pallet.lineCount === 0 ? (
                <IconButton
                  type="button"
                  variant="outline"
                  className="size-14 shrink-0 border-2 text-destructive"
                  aria-label={t('warehouseman.receiving.pallets.delete', undefined, { code: pallet.code })}
                  disabled={remove.isPending}
                  onClick={() => onDelete(pallet)}
                >
                  <Trash2 className="size-6" aria-hidden="true" />
                </IconButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <PanelFooter>
        <Button
          type="button"
          className={PANEL_PRIMARY}
          onClick={() => create.mutate()}
          disabled={create.isPending}
        >
          <Plus aria-hidden="true" className="size-7" />
          {create.isPending
            ? t('warehouseman.receiving.pallets.creating')
            : t('warehouseman.receiving.pallets.create')}
        </Button>
      </PanelFooter>
      {ConfirmDialogElement}
    </div>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export default ReceivingPallets
