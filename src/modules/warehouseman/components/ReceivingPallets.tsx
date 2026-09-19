"use client"
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
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
  receivingSummaryHref,
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

  async function onScan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
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

  const documentNumber = document.data?.documentNumber ?? ''
  const rows = pallets.data ?? []
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">
        {t('warehouseman.receiving.pallets.title', undefined, { documentNumber })}
      </h2>

      <Button
        type="button"
        size="lg"
        className="h-16 w-full text-lg"
        onClick={() => create.mutate()}
        disabled={create.isPending}
      >
        {create.isPending
          ? t('warehouseman.receiving.pallets.creating')
          : t('warehouseman.receiving.pallets.create')}
      </Button>

      <form className="flex flex-col gap-2" onSubmit={onScan}>
        <label className="flex flex-col gap-2">
          <span className="text-lg">{t('warehouseman.receiving.pallets.scan.label')}</span>
          <Input
            value={code}
            className="h-18"
            inputClassName="h-full text-lg"
            placeholder={t('warehouseman.receiving.pallets.scan.placeholder')}
            autoComplete="off"
            onChange={(event) => setCode(event.target.value)}
          />
        </label>
        <Button type="submit" size="lg" variant="outline" className="h-16 w-full text-lg">
          {t('warehouseman.receiving.pallets.scan.submit')}
        </Button>
      </form>

      {scanError ? <ScreenError>{scanError}</ScreenError> : null}
      {actionError ? <ScreenError>{actionError}</ScreenError> : null}

      {rows.length === 0 ? (
        <ScreenEmpty
          title={t('warehouseman.receiving.pallets.empty.title')}
          description={t('warehouseman.receiving.pallets.empty.description')}
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {rows.map((pallet) => (
            <li key={pallet.id} className="flex flex-col gap-2 rounded-md border border-border p-4">
              <Link
                href={receivingPalletHref(receiptId, pallet.id)}
                className="flex min-h-16 flex-col gap-1 text-lg focus-visible:outline-none focus-visible:shadow-focus"
              >
                <span className="font-semibold">{pallet.code}</span>
                {pallet.label ? <span className="text-muted-foreground">{pallet.label}</span> : null}
                <span className="text-muted-foreground">
                  {t('warehouseman.receiving.pallets.lineCount', undefined, { count: pallet.lineCount })}
                </span>
                <StatusBadge variant={PALLET_STATUS_VARIANTS[pallet.status]} dot>
                  {t(`pz.pallets.status.${pallet.status}`)}
                </StatusBadge>
              </Link>
              {pallet.status === 'open' && pallet.lineCount === 0 ? (
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  className="h-16 w-full text-lg"
                  onClick={() => onDelete(pallet)}
                  disabled={remove.isPending}
                >
                  {t('warehouseman.receiving.pallets.delete', undefined, { code: pallet.code })}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <PanelLinkButton href={receivingSummaryHref(receiptId)}>
        {t('warehouseman.receiving.count.summary')}
      </PanelLinkButton>
      <PanelLinkButton href={RECEIVING_LIST_HREF}>
        {t('warehouseman.receiving.pallets.backToList')}
      </PanelLinkButton>
      {ConfirmDialogElement}
    </div>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export default ReceivingPallets
