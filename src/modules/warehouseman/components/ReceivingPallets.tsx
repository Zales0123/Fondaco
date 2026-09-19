"use client"
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ScanLine } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { BarcodeScannerDialog } from '@/modules/barcode_scanner/components/BarcodeScannerDialog'
import { PanelLinkButton, ScreenEmpty, ScreenError, ScreenMessage } from './ReceivingStates'
import {
  createPallet,
  deletePallet,
  fetchPallets,
  fetchReceivingDocument,
  findPalletByCode,
  printPalletLabel,
  type Pallet,
  type PalletStatus,
  type ReceivingDocument,
} from '../lib/receivingApi'
import {
  describePalletLookupFailure,
  describePalletPrintOutcome,
  normalizeScannedCode,
  receivingPalletHref,
  receivingSummaryHref,
  RECEIVING_LIST_HREF,
} from '../lib/receivingPanel'
import { stashPalletLabelNotice } from '../lib/palletLabelNotice'

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
  const [scanStatus, setScanStatus] = React.useState<string | null>(null)
  const [scanning, setScanning] = React.useState(false)
  const [scannerOpen, setScannerOpen] = React.useState(false)
  const [actionError, setActionError] = React.useState<string | null>(null)
  // The camera fires `onDetected` on every frame it decodes, so the guard has to be read
  // synchronously — a state flag would let a second lookup start inside the same tick.
  const lookupInFlight = React.useRef(false)

  const document = useQuery<ReceivingDocument | null>({
    queryKey: ['warehouseman.receiving.document', receiptId],
    queryFn: () => fetchReceivingDocument(receiptId),
  })
  const pallets = useQuery<Pallet[]>({
    queryKey: ['warehouseman.receiving.pallets', receiptId],
    queryFn: () => fetchPallets(receiptId),
  })

  const create = useMutation({
    mutationFn: async () => {
      const pallet = await createPallet(receiptId)
      // Printing is a post-commit effect. From this line on the pallet exists whatever the
      // printer does, so a printer that is off, busy or unreachable is captured rather than
      // thrown: it must never be reported as a failed pallet, and it must never stop the
      // warehouseman from landing inside the pallet they just made.
      try {
        await printPalletLabel(pallet.id)
        return { pallet, printFailure: null as unknown }
      } catch (printFailure) {
        return { pallet, printFailure }
      }
    },
    onSuccess: ({ pallet, printFailure }) => {
      // The reprint button lives on the pallet screen, which is where this navigation ends,
      // so the outcome travels with it instead of flashing on a screen nobody stays on.
      stashPalletLabelNotice(
        pallet.id,
        describePalletPrintOutcome(printFailure, {
          success: t('warehouseman.receiving.pallets.print.success'),
          failure: (reason) => t('warehouseman.receiving.pallets.print.failed', undefined, { reason }),
          unknownReason: t('warehouseman.receiving.print.unknownReason'),
        }),
      )
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

  /**
   * The panel's only pallet lookup. A typed code and a code read off a printed label meet
   * here, so the camera can never open a pallet the keyboard would have refused — nor be
   * refused on different terms.
   */
  const openPalletByCode = React.useCallback(
    async (scanned: string) => {
      if (lookupInFlight.current) return
      lookupInFlight.current = true
      setScanning(true)
      setScanError(null)
      setScanStatus(t('warehouseman.receiving.pallets.scanner.looking', undefined, { code: scanned }))
      try {
        const pallet = await findPalletByCode(scanned, receiptId)
        setScanStatus(t('warehouseman.receiving.pallets.scanner.opening'))
        setScannerOpen(false)
        router.push(receivingPalletHref(receiptId, pallet.id))
      } catch (error) {
        // A pallet of another document is refused by name and the screen stays put: following
        // the scan would file the goods in front of the person against the wrong delivery.
        // The dialog stays open, so the next label is scanned without reopening the camera.
        setScanError(
          describePalletLookupFailure(error, {
            notFound: t('warehouseman.receiving.pallets.scan.notFound', undefined, { code: scanned }),
            failed: t('pz.pallets.errors.notFound'),
          }),
        )
        setScanStatus(null)
      } finally {
        lookupInFlight.current = false
        setScanning(false)
      }
    },
    [receiptId, router, t],
  )

  async function onScan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setScanError(null)
    const scanned = normalizeScannedCode(code)
    if (!scanned) {
      setScanError(t('pz.pallets.errors.codeRequired'))
      return
    }
    await openPalletByCode(scanned)
  }

  const onDetected = React.useCallback(
    (raw: string) => {
      const scanned = normalizeScannedCode(raw)
      if (!scanned) return
      void openPalletByCode(scanned)
    },
    [openPalletByCode],
  )

  function onOpenScanner() {
    setScanError(null)
    setScanStatus(null)
    setScannerOpen(true)
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

      {/* Typing stays the path that always works: over plain http a phone has no secure
          context and therefore no camera at all, so the camera is an addition, never a
          replacement. */}
      <form className="flex flex-col gap-2" onSubmit={onScan}>
        <div className="flex items-end gap-2">
          <label className="flex flex-1 flex-col gap-2">
            <span className="text-lg">{t('warehouseman.receiving.pallets.scan.label')}</span>
            <Input
              value={code}
              className="h-18"
              inputClassName="h-full text-lg"
              placeholder={t('warehouseman.receiving.pallets.scan.placeholder')}
              autoComplete="off"
              disabled={scanning}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <Button
            type="button"
            size="lg"
            variant="outline"
            className="h-18 w-18 shrink-0"
            aria-label={t('warehouseman.receiving.pallets.scanner.open')}
            title={t('warehouseman.receiving.pallets.scanner.open')}
            onClick={onOpenScanner}
            disabled={scanning}
          >
            <ScanLine className="size-6" aria-hidden="true" />
          </Button>
        </div>
        <Button
          type="submit"
          size="lg"
          variant="outline"
          className="h-16 w-full text-lg"
          disabled={scanning}
        >
          {scanning
            ? t('warehouseman.receiving.pallets.scan.submitting')
            : t('warehouseman.receiving.pallets.scan.submit')}
        </Button>
      </form>

      {scanError && !scannerOpen ? <ScreenError>{scanError}</ScreenError> : null}
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
      <BarcodeScannerDialog
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={onDetected}
        busy={scanning}
        statusMessage={scanStatus}
        errorMessage={scanError}
        title={t('warehouseman.receiving.pallets.scanner.title')}
        description={t('warehouseman.receiving.pallets.scanner.description')}
        manualLabel={t('warehouseman.receiving.pallets.scanner.manualLabel')}
        manualPlaceholder={t('warehouseman.receiving.pallets.scanner.manualPlaceholder')}
      />
      {ConfirmDialogElement}
    </div>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export default ReceivingPallets
