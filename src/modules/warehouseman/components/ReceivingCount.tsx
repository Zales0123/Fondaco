"use client"
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ScanLine } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  BarcodeScannerDialog,
  type ScannerLogEntry,
} from '@/modules/barcode_scanner/components/BarcodeScannerDialog'
import { PanelLinkButton, ScreenEmpty, ScreenError, ScreenMessage, ScreenWarning } from './ReceivingStates'
import {
  closePallet,
  countPalletLine,
  deletePalletLine,
  fetchPalletLines,
  fetchPallets,
  fetchReceivingDocument,
  printPalletLabel,
  reopenPallet,
  resolveVariantByBarcode,
  searchCatalogVariants,
  updatePalletLine,
  ReceivingApiError,
  type Pallet,
  type PalletLine,
  type ReceivingDocument,
} from '../lib/receivingApi'
import {
  describePalletPrintOutcome,
  describeScanMultiplier,
  formatCountQuantity,
  normalizeScannedCode,
  parseCountQuantity,
  productLabel,
  receivingReceiptHref,
  receivingSummaryHref,
  resolveCountQuantity,
  type PalletLabelNotice,
} from '../lib/receivingPanel'
import { takePalletLabelNotice } from '../lib/palletLabelNotice'

/**
 * How much of the scan history the screen keeps. The dialog shows only the last few, and a
 * pallet counted for an hour would otherwise grow this array for as long as the screen lives.
 */
const SCAN_LOG_LIMIT = 10

/**
 * How loudly the quantity field reads back what it will do to the next scan. An armed
 * multiplier is not an error — nobody typed it by accident — but it is not the resting
 * state either, and the difference between the two is a silent surplus on the pallet.
 */
const MULTIPLIER_TONE_CLASS: Record<ReturnType<typeof describeScanMultiplier>['kind'], string> = {
  default: 'text-muted-foreground',
  armed: 'text-status-warning-text',
  invalid: 'text-status-error-text',
}

/** The same three states, in the vocabulary the shared scanner dialog speaks. */
const MULTIPLIER_TONE: Record<
  ReturnType<typeof describeScanMultiplier>['kind'],
  'neutral' | 'notice' | 'error'
> = { default: 'neutral', armed: 'notice', invalid: 'error' }

export type ReceivingCountProps = { receiptId: string; palletId: string }

/**
 * The screen the whole feature exists for. A handheld scanner types the barcode and ends
 * with Enter, so the form submits on Enter and the barcode field takes focus back after
 * every submit — including a failed one, because the next thing that happens on the floor
 * is another scan.
 *
 * The phone camera is the same count by another route: it reads a barcode where a wedge
 * scanner would have typed one, and both meet in `countByBarcode`. Typing keeps working
 * regardless — over plain http a phone has no secure context and therefore no camera at all.
 */
export function ReceivingCount({ receiptId, palletId }: ReceivingCountProps) {
  const t = useT()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const barcodeRef = React.useRef<HTMLInputElement>(null)
  const unknownProduct = t('pz.receiving.summary.unknownProduct')

  const [barcode, setBarcode] = React.useState('')
  const [quantity, setQuantity] = React.useState('')
  const [unknownBarcode, setUnknownBarcode] = React.useState<string | null>(null)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [announcement, setAnnouncement] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [editing, setEditing] = React.useState<{ id: string; value: string } | null>(null)
  const [rowError, setRowError] = React.useState<{ id: string; message: string } | null>(null)
  // The notice carries the pallet it is about: this screen is reused when one pallet is
  // opened after another, and a label warning must never be read against the wrong pallet.
  const [labelNotice, setLabelNotice] = React.useState<(PalletLabelNotice & { palletId: string }) | null>(null)
  const [printing, setPrinting] = React.useState(false)
  const [scannerOpen, setScannerOpen] = React.useState(false)
  const [scanStatus, setScanStatus] = React.useState<string | null>(null)
  const [scanLog, setScanLog] = React.useState<ScannerLogEntry[]>([])
  // The camera fires `onDetected` on every frame it decodes, so the guard has to be read
  // synchronously — a state flag would let a second count start inside the same tick.
  const countInFlight = React.useRef(false)
  // Read inside async handlers, which is why the open state is mirrored here rather than
  // closed over: by the time a count settles the rendered value may be a tick behind.
  const scannerOpenRef = React.useRef(false)
  const logSequence = React.useRef(0)

  // Creating a pallet prints its label and then opens the pallet, so the outcome of that
  // print is waiting here. Reading it consumes it: coming back to this pallet later must
  // not resurrect what the printer did half an hour ago.
  React.useEffect(() => {
    const carried = takePalletLabelNotice(palletId)
    if (carried) setLabelNotice({ ...carried, palletId })
  }, [palletId])

  const document = useQuery<ReceivingDocument | null>({
    queryKey: ['warehouseman.receiving.document', receiptId],
    queryFn: () => fetchReceivingDocument(receiptId),
  })
  const pallets = useQuery<Pallet[]>({
    queryKey: ['warehouseman.receiving.pallets', receiptId],
    queryFn: () => fetchPallets(receiptId),
  })
  const lines = useQuery<PalletLine[]>({
    queryKey: ['warehouseman.receiving.palletLines', palletId],
    queryFn: () => fetchPalletLines(palletId),
  })

  const pallet = pallets.data?.find((candidate) => candidate.id === palletId) ?? null
  const closed = pallet?.status === 'closed'

  const focusBarcode = React.useCallback(() => barcodeRef.current?.focus(), [])
  /**
   * While the camera holds the screen the dialog owns focus, and pulling it back would fight
   * the modal's own focus trap. Every other path ends on the barcode field, because the next
   * thing that happens on the floor is another scan.
   */
  const focusBarcodeUnlessScanning = React.useCallback(() => {
    if (scannerOpenRef.current) return
    focusBarcode()
  }, [focusBarcode])

  const closeScanner = React.useCallback(() => {
    scannerOpenRef.current = false
    setScannerOpen(false)
    setScanStatus(null)
    // The dialog hands focus back to whatever opened it, so the barcode field is claimed once
    // that has happened — a wedge scanner types into it and the floor keeps counting.
    window.setTimeout(focusBarcode, 0)
  }, [focusBarcode])

  // A closed pallet takes no counts, so the camera is dismissed with every other mutating
  // control rather than staying up over a screen that can only refuse it.
  React.useEffect(() => {
    if (closed && scannerOpenRef.current) closeScanner()
  }, [closed, closeScanner])

  /**
   * Newest first and bounded. Each entry carries a stable id so the dialog can key its list
   * without re-mounting rows the operator is reading.
   */
  const pushScanLog = React.useCallback((tone: ScannerLogEntry['tone'], label: string) => {
    logSequence.current += 1
    const entry: ScannerLogEntry = { id: `scan-${logSequence.current}`, label, tone }
    setScanLog((previous) => [entry, ...previous].slice(0, SCAN_LOG_LIMIT))
  }, [])
  // The field only exists once the pallet has loaded and is open, so the autofocus waits
  // for that rather than firing against a loading screen and never coming back.
  const countable = !!pallet && !closed
  React.useEffect(() => {
    if (countable) focusBarcode()
  }, [countable, focusBarcode])

  const invalidatePallets = () =>
    queryClient.invalidateQueries({ queryKey: ['warehouseman.receiving.pallets', receiptId] })

  /**
   * Records one count, whichever input named the product. The quantity field is a multiplier
   * rather than an entry the floor owes us: left blank a scan counts one unit, which is what
   * `resolveCountQuantity` says, and a typed multiplier is still refused when it is not a
   * quantity.
   */
  async function recordCount(catalogVariantId: string, resolvedName: string | null) {
    const parsed = resolveCountQuantity(quantity)
    if (!parsed) {
      const message = t('pz.palletLines.errors.quantityInvalid')
      setFormError(message)
      pushScanLog('error', message)
      setScanStatus(null)
      return
    }
    setSubmitting(true)
    try {
      const counted = await countPalletLine({ palletId, catalogVariantId, quantity: parsed })
      const refreshed = await lines.refetch()
      const row = refreshed.data?.find((candidate) => candidate.catalogVariantId === catalogVariantId)
      const product = productLabel(row?.name ?? resolvedName, unknownProduct)
      const total = formatCountQuantity(row?.quantity ?? counted.quantity)
      setAnnouncement(
        t('warehouseman.receiving.count.added', undefined, { product, quantity: total }),
      )
      // The running total, not only what this scan added: counting onto a pallet is a tally,
      // and the number the operator checks against the goods in front of them is the total.
      pushScanLog(
        'success',
        t('warehouseman.receiving.count.scanner.logAdded', undefined, {
          product,
          added: formatCountQuantity(parsed),
          total,
        }),
      )
      setBarcode('')
      // The multiplier never survives a count. A quantity left over from the last product
      // would silently multiply the next scan, and nobody would see it happen.
      setQuantity('')
      setUnknownBarcode(null)
      setFormError(null)
      setScanStatus(null)
      await invalidatePallets()
    } catch (error) {
      // The server's refusal is already localized, so it is what the log and the screen say.
      const message = messageOf(error, t('pz.palletLines.errors.countFailed'))
      setFormError(message)
      pushScanLog('error', message)
      setScanStatus(null)
    } finally {
      setSubmitting(false)
      focusBarcodeUnlessScanning()
    }
  }

  /**
   * The screen's only counting-by-barcode path. A typed code and a code the camera read meet
   * here, so the camera can never record something the keyboard would have refused — nor be
   * refused on different terms.
   */
  async function countByBarcode(scanned: string): Promise<void> {
    const code = normalizeScannedCode(scanned)
    if (!code) {
      setFormError(t('pz.palletLines.errors.barcodeRequired'))
      focusBarcodeUnlessScanning()
      return
    }
    if (countInFlight.current) return
    countInFlight.current = true
    setFormError(null)
    setSubmitting(true)
    setScanStatus(t('warehouseman.receiving.count.scanner.looking', undefined, { code }))
    try {
      const variant = await resolveVariantByBarcode(code)
      await recordCount(variant.catalogVariantId, variant.name)
    } catch (error) {
      setScanStatus(null)
      if (error instanceof ReceivingApiError && error.status === 404) {
        // The scanned code stays in the field: it is the only record of what is in the
        // person's hand, and the picker is how they say which product carries it.
        setBarcode(code)
        setUnknownBarcode(code)
        const message = t('warehouseman.receiving.count.unknownBarcode', undefined, { barcode: code })
        setFormError(message)
        pushScanLog('error', message)
        // The camera cannot help with this recovery — the answer is in the catalog picker
        // below, which the operator has to read and tap. Leaving the camera running over a
        // screen they must act on is worse than closing it, so the dialog goes.
        closeScanner()
      } else {
        const message = messageOf(error, t('pz.palletLines.errors.countFailed'))
        setFormError(message)
        pushScanLog('error', message)
        focusBarcodeUnlessScanning()
      }
    } finally {
      countInFlight.current = false
      setSubmitting(false)
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await countByBarcode(barcode)
  }

  function onDetected(raw: string) {
    void countByBarcode(raw)
  }

  function openScanner() {
    setFormError(null)
    setScanStatus(null)
    // The log is deliberately not cleared: reopening the camera after fixing an unknown
    // barcode should still show what was counted a minute ago.
    scannerOpenRef.current = true
    setScannerOpen(true)
  }

  async function onSaveEdit(line: PalletLine) {
    if (!editing) return
    setRowError(null)
    // A correction replaces the stored total, so blank is not "one more" here — it is somebody
    // who has not said what the quantity should be. This stays the strict parser.
    const parsed = parseCountQuantity(editing.value)
    if (!parsed) {
      setRowError({ id: line.id, message: t('pz.palletLines.errors.quantityInvalid') })
      return
    }
    try {
      await updatePalletLine({ id: line.id, quantity: parsed, expectedVersion: line.updatedAt })
      const refreshed = await lines.refetch()
      const row = refreshed.data?.find((candidate) => candidate.id === line.id)
      setEditing(null)
      setAnnouncement(
        t('warehouseman.receiving.count.added', undefined, {
          product: productLabel(row?.name ?? line.name, unknownProduct),
          quantity: formatCountQuantity(row?.quantity ?? parsed),
        }),
      )
    } catch (error) {
      if (error instanceof ReceivingApiError && error.status === 409) {
        // Somebody counted onto the same product mid-correction. Show them the total that
        // is actually stored and make them re-enter, rather than replaying a stale number.
        const refreshed = await lines.refetch()
        const row = refreshed.data?.find((candidate) => candidate.id === line.id)
        setEditing({ id: line.id, value: '' })
        setRowError({
          id: line.id,
          message: t('warehouseman.receiving.count.conflict', undefined, {
            quantity: formatCountQuantity(row?.quantity ?? line.quantity),
          }),
        })
        return
      }
      setRowError({ id: line.id, message: messageOf(error, t('pz.palletLines.errors.updateFailed')) })
    }
  }

  async function onRemove(line: PalletLine) {
    setRowError(null)
    const confirmed = await confirm({
      title: t('warehouseman.receiving.count.remove.title'),
      description: t('warehouseman.receiving.count.remove.description', undefined, {
        product: productLabel(line.name, unknownProduct),
        code: pallet?.code ?? '',
      }),
      confirmText: t('warehouseman.receiving.count.remove.action'),
      variant: 'destructive',
    })
    if (!confirmed) return
    try {
      await deletePalletLine(line.id, line.updatedAt)
      await lines.refetch()
      await invalidatePallets()
    } catch (error) {
      setRowError({ id: line.id, message: messageOf(error, t('pz.palletLines.errors.deleteFailed')) })
    }
  }

  /**
   * A torn or missing sticker, reprinted. Nothing about the pallet changes, so a printer
   * that refuses is a warning here too — the count carries on either way.
   */
  async function onPrintLabel() {
    if (printing) return
    setPrinting(true)
    setLabelNotice(null)
    let printFailure: unknown = null
    try {
      await printPalletLabel(palletId)
    } catch (error) {
      printFailure = error
    }
    setLabelNotice({
      ...describePalletPrintOutcome(printFailure, {
        success: t('warehouseman.receiving.count.print.success'),
        failure: (reason) => t('warehouseman.receiving.count.print.failed', undefined, { reason }),
        unknownReason: t('warehouseman.receiving.print.unknownReason'),
      }),
      palletId,
    })
    setPrinting(false)
  }

  async function onClose() {
    if (!pallet) return
    const confirmed = await confirm({
      title: t('warehouseman.receiving.count.close.title'),
      description: t('warehouseman.receiving.count.close.description', undefined, { code: pallet.code }),
      confirmText: t('warehouseman.receiving.count.close.action'),
    })
    if (!confirmed) return
    try {
      await closePallet(pallet.id, pallet.updatedAt)
      await invalidatePallets()
      router.push(receivingReceiptHref(receiptId))
    } catch (error) {
      setFormError(messageOf(error, t('pz.pallets.errors.closeFailed')))
    }
  }

  async function onReopen() {
    if (!pallet) return
    try {
      await reopenPallet(pallet.id, pallet.updatedAt)
      await invalidatePallets()
      focusBarcode()
    } catch (error) {
      setFormError(messageOf(error, t('pz.pallets.errors.reopenFailed')))
    }
  }

  if (lines.isLoading || pallets.isLoading) {
    return <ScreenMessage>{t('warehouseman.receiving.count.loading')}</ScreenMessage>
  }

  if (lines.error || pallets.error || !pallet) {
    return (
      <div className="flex flex-col gap-4">
        <ScreenError>
          {messageOf(lines.error ?? pallets.error, t('warehouseman.receiving.count.error'))}
        </ScreenError>
        <PanelLinkButton href={receivingReceiptHref(receiptId)}>
          {t('warehouseman.receiving.count.backToPallets')}
        </PanelLinkButton>
      </div>
    )
  }

  const rows = lines.data ?? []
  // The same multiplier the form field holds, read back as a sentence about the *next* scan.
  // The camera is why this exists: the value is armed on one surface and spent on another,
  // so it has to keep saying what it will do rather than wait to be noticed.
  const multiplier = describeScanMultiplier(quantity, {
    each: t('warehouseman.receiving.count.quantity.hint'),
    armed: (value) =>
      t('warehouseman.receiving.count.quantity.armed', undefined, { quantity: value }),
    invalid: t('pz.palletLines.errors.quantityInvalid'),
  })
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">
          {t('warehouseman.receiving.count.title', undefined, {
            documentNumber: document.data?.documentNumber ?? '',
            code: pallet.code,
          })}
        </h2>
        <p className="text-muted-foreground">
          {t('warehouseman.receiving.list.supplier', undefined, {
            supplier: document.data?.supplierName ?? '',
          })}
        </p>
        <p className="text-muted-foreground">
          {t('warehouseman.receiving.pallets.lineCount', undefined, { count: rows.length })}
        </p>
      </div>

      {closed ? (
        <div className="flex flex-col gap-4">
          <ScreenError>{t('warehouseman.receiving.count.closed')}</ScreenError>
          <Button type="button" size="lg" className="h-16 w-full text-lg" onClick={onReopen}>
            {t('warehouseman.receiving.count.reopen')}
          </Button>
        </div>
      ) : (
        <Button type="button" size="lg" variant="outline" className="h-16 w-full text-lg" onClick={onClose}>
          {t('warehouseman.receiving.count.close')}
        </Button>
      )}

      <Button
        type="button"
        size="lg"
        variant="outline"
        className="h-16 w-full text-lg"
        onClick={onPrintLabel}
        disabled={printing}
      >
        {printing
          ? t('warehouseman.receiving.count.printing')
          : t('warehouseman.receiving.count.printLabel')}
      </Button>

      {labelNotice && labelNotice.palletId === palletId ? (
        labelNotice.kind === 'warning' ? (
          <ScreenWarning>{labelNotice.message}</ScreenWarning>
        ) : (
          <ScreenMessage>{labelNotice.message}</ScreenMessage>
        )
      ) : null}

      <form className="flex flex-col gap-2" onSubmit={onSubmit}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-1 items-end gap-2">
            <label className="flex flex-1 flex-col gap-2">
              <span className="text-lg">{t('warehouseman.receiving.count.barcode.label')}</span>
              <Input
                ref={barcodeRef}
                value={barcode}
                className="h-18"
                inputClassName="h-full text-lg"
                placeholder={t('warehouseman.receiving.count.barcode.placeholder')}
                autoComplete="off"
                disabled={closed || submitting}
                onChange={(event) => setBarcode(event.target.value)}
              />
            </label>
            {/* Typing stays the path that always works: over plain http a phone has no secure
                context and therefore no camera, so the camera is an addition, never a
                replacement. */}
            <Button
              type="button"
              size="lg"
              variant="outline"
              className="h-18 w-18 shrink-0"
              aria-label={t('warehouseman.receiving.count.scanner.open')}
              title={t('warehouseman.receiving.count.scanner.open')}
              onClick={openScanner}
              disabled={closed || submitting}
            >
              <ScanLine className="size-6" aria-hidden="true" />
            </Button>
          </div>
          <label className="flex flex-col gap-2 sm:w-40">
            <span className="text-lg">{t('warehouseman.receiving.count.quantity.label')}</span>
            <Input
              value={quantity}
              inputMode="decimal"
              className="h-18"
              inputClassName="h-full text-lg"
              placeholder={t('warehouseman.receiving.count.quantity.placeholder')}
              disabled={closed || submitting}
              onChange={(event) => setQuantity(event.target.value)}
            />
            {/* The same sentence the camera dialog shows. One value must not read two ways
                depending on which surface the operator happens to be looking at. */}
            <span className={MULTIPLIER_TONE_CLASS[multiplier.kind]}>{multiplier.message}</span>
          </label>
        </div>
        <Button type="submit" size="lg" className="h-16 w-full text-lg" disabled={closed || submitting}>
          {t('warehouseman.receiving.count.submit')}
        </Button>
      </form>

      {/* The dialog prints the same refusal itself while it is up, so the screen behind it
          does not repeat it. */}
      {formError && !scannerOpen ? <ScreenError>{formError}</ScreenError> : null}

      {unknownBarcode ? (
        <label className="flex flex-col gap-2">
          <span className="text-lg">{t('warehouseman.receiving.count.productSearch.label')}</span>
          <ComboboxInput
            value=""
            onChange={(variantId) => {
              if (variantId) void recordCount(variantId, null)
            }}
            placeholder={t('warehouseman.receiving.count.productSearch.placeholder')}
            loadSuggestions={searchCatalogVariants}
            allowCustomValues={false}
            clearable={false}
            disabled={closed || submitting}
          />
        </label>
      ) : null}

      <p role="status" aria-live="polite" className="text-lg text-muted-foreground">
        {announcement}
      </p>

      {rows.length === 0 ? (
        <ScreenEmpty
          title={t('warehouseman.receiving.count.empty.title')}
          description={t('warehouseman.receiving.count.empty.description')}
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {rows.map((line) => (
            <li key={line.id} className="flex flex-col gap-2 rounded-md border border-border p-4 text-lg">
              <span className="font-semibold">{productLabel(line.name, unknownProduct)}</span>
              <span className="text-muted-foreground">{line.sku ?? '—'}</span>
              {editing?.id === line.id ? (
                <div className="flex flex-col gap-2">
                  <label className="flex flex-col gap-2">
                    <span className="text-lg">
                      {t('warehouseman.receiving.count.edit', undefined, {
                        product: productLabel(line.name, unknownProduct),
                      })}
                    </span>
                    <Input
                      value={editing.value}
                      inputMode="decimal"
                      className="h-18"
                      inputClassName="h-full text-lg"
                      autoFocus
                      onChange={(event) => setEditing({ id: line.id, value: event.target.value })}
                    />
                  </label>
                  <Button type="button" size="lg" className="h-16 w-full text-lg" onClick={() => onSaveEdit(line)}>
                    {t('warehouseman.receiving.count.editSave')}
                  </Button>
                  <Button
                    type="button"
                    size="lg"
                    variant="outline"
                    className="h-16 w-full text-lg"
                    onClick={() => {
                      setEditing(null)
                      setRowError(null)
                    }}
                  >
                    {t('warehouseman.receiving.count.editCancel')}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <span className="font-semibold">{formatCountQuantity(line.quantity)}</span>
                  <Button
                    type="button"
                    size="lg"
                    variant="outline"
                    className="h-16 w-full text-lg"
                    disabled={closed}
                    onClick={() => {
                      setRowError(null)
                      setEditing({ id: line.id, value: formatCountQuantity(line.quantity) })
                    }}
                  >
                    {t('warehouseman.receiving.count.edit', undefined, {
                      product: productLabel(line.name, unknownProduct),
                    })}
                  </Button>
                  <Button
                    type="button"
                    size="lg"
                    variant="outline"
                    className="h-16 w-full text-lg"
                    disabled={closed}
                    onClick={() => onRemove(line)}
                  >
                    {t('warehouseman.receiving.count.remove', undefined, {
                      product: productLabel(line.name, unknownProduct),
                    })}
                  </Button>
                </div>
              )}
              {rowError?.id === line.id ? <ScreenError>{rowError.message}</ScreenError> : null}
            </li>
          ))}
        </ul>
      )}

      <PanelLinkButton href={receivingSummaryHref(receiptId)}>
        {t('warehouseman.receiving.count.summary')}
      </PanelLinkButton>
      <PanelLinkButton href={receivingReceiptHref(receiptId)}>
        {t('warehouseman.receiving.count.backToPallets')}
      </PanelLinkButton>
      {/* Counting is a run of scans, not one lookup, so the camera stays live between them and
          the operator decides when it is done. `busy` suspends acceptance while a count is
          posting rather than letting decoded frames queue up behind it. */}
      <BarcodeScannerDialog
        open={scannerOpen}
        onClose={closeScanner}
        onDetected={onDetected}
        busy={submitting}
        statusMessage={scanStatus}
        errorMessage={formError}
        continuous
        log={scanLog}
        // The dialog is modal, so the form's own quantity field is unreachable behind it.
        // This is the same state, not a copy: a multiplier typed here is the one
        // `recordCount` reads, and it is cleared by the same count that consumes it.
        quantity={quantity}
        onQuantityChange={setQuantity}
        quantityLabel={t('warehouseman.receiving.count.quantity.label')}
        quantityPlaceholder={t('warehouseman.receiving.count.quantity.placeholder')}
        quantityHint={multiplier.message}
        quantityHintTone={MULTIPLIER_TONE[multiplier.kind]}
        title={t('warehouseman.receiving.count.scanner.title')}
        description={t('warehouseman.receiving.count.scanner.description')}
        manualLabel={t('warehouseman.receiving.count.scanner.manualLabel')}
        manualPlaceholder={t('warehouseman.receiving.count.scanner.manualPlaceholder')}
      />
      {ConfirmDialogElement}
    </div>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export default ReceivingCount
