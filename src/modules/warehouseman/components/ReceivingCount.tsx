"use client"
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, LockOpen, Pencil, Printer, Trash2 } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  BarcodeScannerDialog,
  type ScannerLogEntry,
} from '@/modules/barcode_scanner/components/BarcodeScannerDialog'
import {
  PANEL_ACTION,
  PANEL_PRIMARY,
  PanelCard,
  PanelFooter,
  ProgressStrip,
  QtyStepper,
  ScanField,
  SectionLabel,
} from './PanelUI'
import { PanelLinkButton, ScreenEmpty, ScreenError, ScreenMessage, ScreenWarning } from './ReceivingStates'
import { ScanQuantityStep } from './ScanQuantityStep'
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
  COUNT_QUANTITY_SCALE,
  describePalletPrintOutcome,
  formatCountQuantity,
  normalizeScannedCode,
  parseCountQuantity,
  productLabel,
  receivingReceiptHref,
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
 * A scan that has named a product and is waiting to be told how many. It holds the resolved
 * variant rather than the code: the lookup already happened, and re-resolving on confirm
 * would let the answer change between the name the operator read and the line they get.
 */
type PendingScan = { catalogVariantId: string; name: string | null; code: string }

export type ReceivingCountProps = { receiptId: string; palletId: string }

/** One of the thing in your hand — the gesture the floor makes most. */
const DEFAULT_QUANTITY = '1'

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
  const [quantity, setQuantity] = React.useState(DEFAULT_QUANTITY)
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
  // A camera scan that has named its product and is waiting to be told how many.
  const [pendingScan, setPendingScan] = React.useState<PendingScan | null>(null)
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
    // An unanswered step dies with the camera that raised it. Nothing was counted, and
    // leaving it pending would ask about a product on the next session's first scan.
    setPendingScan(null)
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
   * Records one count, whichever input named the product.
   *
   * `confirmed` is the amount the camera's quantity step settled on. Without it the typed
   * path's own quantity field is read, where blank means one unit — a typed barcode with an
   * empty quantity is still the gesture "one more of these". The two paths name their amount
   * differently on purpose; they must not read each other's.
   */
  async function recordCount(
    catalogVariantId: string,
    resolvedName: string | null,
    confirmed?: number,
  ): Promise<boolean> {
    const parsed = confirmed != null ? String(confirmed) : resolveCountQuantity(quantity)
    if (!parsed) {
      const message = t('pz.palletLines.errors.quantityInvalid')
      setFormError(message)
      pushScanLog('error', message)
      setScanStatus(null)
      return false
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
      // A typed quantity belongs to the product it was typed for. Left behind it would
      // silently apply to the next one, and nobody would see it happen.
      setQuantity(DEFAULT_QUANTITY)
      setUnknownBarcode(null)
      setFormError(null)
      setScanStatus(null)
      await invalidatePallets()
      return true
    } catch (error) {
      // The server's refusal is already localized, so it is what the log and the screen say.
      const message = messageOf(error, t('pz.palletLines.errors.countFailed'))
      setFormError(message)
      pushScanLog('error', message)
      setScanStatus(null)
      return false
    } finally {
      setSubmitting(false)
      focusBarcodeUnlessScanning()
    }
  }

  /**
   * The screen's only counting-by-barcode path. A typed code and a code the camera read meet
   * here, so the camera can never record something the keyboard would have refused — nor be
   * refused on different terms.
   *
   * They part company only after the code has resolved, and only over *how many*: a typed
   * code carries its quantity in the form beside it and counts straight away, while a camera
   * scan has no field to have filled in, so it stops here and asks. Both have already been
   * refused, or not, on identical terms by then.
   */
  async function countByBarcode(scanned: string, fromCamera = false): Promise<void> {
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
      if (fromCamera) {
        // Nothing is counted yet. The step owns the rest, and the dialog accepts no further
        // scan while it is up, so this product cannot be overtaken by the next carton.
        setPendingScan({ catalogVariantId: variant.catalogVariantId, name: variant.name, code })
        setScanStatus(null)
        return
      }
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

  async function onSubmit() {
    await countByBarcode(barcode)
  }

  function onDetected(raw: string) {
    void countByBarcode(raw, true)
  }

  /**
   * The step's answer. The count is recorded here rather than in the step so the pending
   * scan only clears once it is actually on the pallet — a refusal leaves the step up with
   * the number intact, because re-choosing 24 after a dropped connection is pure loss.
   */
  async function onConfirmPendingScan(confirmed: number) {
    if (!pendingScan) return
    const recorded = await recordCount(pendingScan.catalogVariantId, pendingScan.name, confirmed)
    if (recorded) setPendingScan(null)
  }

  function onCancelPendingScan() {
    // Nothing was written, so there is nothing to undo: the scan simply did not become a
    // count. The camera picks up again the moment the step is gone.
    setPendingScan(null)
    setFormError(null)
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
  const countedTotal = formatCountQuantity(
    rows.reduce((total, line) => total + (Number.parseFloat(line.quantity) || 0), 0).toFixed(COUNT_QUANTITY_SCALE),
  )

  return (
    <div className="flex flex-1 flex-col gap-4">
      <ProgressStrip
        label={t('warehouseman.receiving.count.counted', undefined, { quantity: countedTotal })}
        detail={t('warehouseman.receiving.pallets.lineCount', undefined, { count: rows.length })}
      />

      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-base text-muted-foreground">
          <span className="font-mono text-lg font-semibold text-foreground">{pallet.code}</span>
          {document.data?.documentNumber ? ` · ${document.data.documentNumber}` : ''}
          {document.data?.supplierName ? ` · ${document.data.supplierName}` : ''}
        </p>
        <Button
          type="button"
          variant="outline"
          className="h-14 shrink-0 border-2 px-4 text-base font-semibold"
          onClick={onPrintLabel}
          disabled={printing}
        >
          <Printer aria-hidden="true" className="size-6" />
          {printing
            ? t('warehouseman.receiving.count.printing')
            : t('warehouseman.receiving.count.printLabel')}
        </Button>
      </div>

      {labelNotice && labelNotice.palletId === palletId ? (
        labelNotice.kind === 'warning' ? (
          <ScreenWarning>{labelNotice.message}</ScreenWarning>
        ) : (
          <ScreenMessage>{labelNotice.message}</ScreenMessage>
        )
      ) : null}

      {closed ? (
        <div className="flex flex-col gap-3">
          <ScreenError>{t('warehouseman.receiving.count.closed')}</ScreenError>
          <Button type="button" className={PANEL_PRIMARY} onClick={onReopen}>
            <LockOpen aria-hidden="true" className="size-7" />
            {t('warehouseman.receiving.count.reopen')}
          </Button>
        </div>
      ) : null}

      {/* The counting controls keep the wireframe's narrower column; the list takes the rest. */}
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-5 lg:items-start lg:gap-6">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {/* Typing stays the path that always works: over plain http a phone has no secure
              context and therefore no camera, so the camera is an addition, never a
              replacement. */}
          <ScanField
            label={t('warehouseman.receiving.count.barcode.label')}
            placeholder={t('warehouseman.receiving.count.barcode.placeholder')}
            value={barcode}
            onChange={setBarcode}
            onSubmit={onSubmit}
            submitLabel={t('warehouseman.receiving.count.submit')}
            onCamera={openScanner}
            cameraLabel={t('warehouseman.receiving.count.scanner.open')}
            disabled={closed || submitting}
            emphasis={!closed}
            inputRef={barcodeRef}
          />

          <QtyStepper
            label={t('warehouseman.receiving.count.quantity.label')}
            value={quantity}
            onChange={setQuantity}
            decrementLabel={t('warehouseman.receiving.count.quantity.decrement')}
            incrementLabel={t('warehouseman.receiving.count.quantity.increment')}
            disabled={closed || submitting}
          />

          {/* The dialog prints the same refusal itself while it is up, so the screen behind it
              does not repeat it. */}
          {formError && !scannerOpen ? <ScreenError>{formError}</ScreenError> : null}

          {unknownBarcode ? (
            <label className="flex flex-col gap-2">
              <span className="text-lg font-semibold">{t('warehouseman.receiving.count.productSearch.label')}</span>
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

          {announcement ? (
            <PanelCard className="flex items-center gap-3 border-status-success-border bg-status-success-bg">
              <Check className="size-8 shrink-0 text-status-success-text" aria-hidden="true" />
              <p role="status" aria-live="polite" className="min-w-0 text-lg font-semibold">
                {announcement}
              </p>
            </PanelCard>
          ) : (
            <p role="status" aria-live="polite" className="sr-only" />
          )}
        </div>

        <div className="flex flex-col gap-3 lg:col-span-3">
          <SectionLabel>{t('warehouseman.receiving.count.onPallet')}</SectionLabel>
          {rows.length === 0 ? (
            <ScreenEmpty
              title={t('warehouseman.receiving.count.empty.title')}
              description={t('warehouseman.receiving.count.empty.description')}
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {rows.map((line) => (
                <li key={line.id} className="rounded-lg border-2 border-border bg-card p-3">
                  {editing?.id === line.id ? (
                    <div className="flex flex-col gap-3">
                      <label className="flex flex-col gap-2">
                        <span className="text-lg font-semibold">
                          {t('warehouseman.receiving.count.edit', undefined, {
                            product: productLabel(line.name, unknownProduct),
                          })}
                        </span>
                        <Input
                          value={editing.value}
                          inputMode="decimal"
                          className="h-20 min-w-0 border-2 px-4"
                          inputClassName="h-full text-2xl font-bold"
                          autoFocus
                          onChange={(event) => setEditing({ id: line.id, value: event.target.value })}
                        />
                      </label>
                      <div className="flex gap-2">
                        <Button type="button" className={PANEL_ACTION} onClick={() => onSaveEdit(line)}>
                          {t('warehouseman.receiving.count.editSave')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className={`${PANEL_ACTION} border-2`}
                          onClick={() => {
                            setEditing(null)
                            setRowError(null)
                          }}
                        >
                          {t('warehouseman.receiving.count.editCancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-lg font-bold">
                          {productLabel(line.name, unknownProduct)}
                        </span>
                        <span className="truncate font-mono text-base text-muted-foreground">
                          {line.sku ?? '—'}
                        </span>
                      </span>
                      <span className="shrink-0 text-2xl font-bold tabular-nums">
                        {formatCountQuantity(line.quantity)}
                      </span>
                      <IconButton
                        type="button"
                        variant="outline"
                        className="size-14 shrink-0 border-2"
                        aria-label={t('warehouseman.receiving.count.edit', undefined, {
                          product: productLabel(line.name, unknownProduct),
                        })}
                        disabled={closed}
                        onClick={() => {
                          setRowError(null)
                          setEditing({ id: line.id, value: formatCountQuantity(line.quantity) })
                        }}
                      >
                        <Pencil className="size-6" aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        type="button"
                        variant="outline"
                        className="size-14 shrink-0 border-2 text-destructive"
                        aria-label={t('warehouseman.receiving.count.remove', undefined, {
                          product: productLabel(line.name, unknownProduct),
                        })}
                        disabled={closed}
                        onClick={() => onRemove(line)}
                      >
                        <Trash2 className="size-6" aria-hidden="true" />
                      </IconButton>
                    </div>
                  )}
                  {rowError?.id === line.id ? (
                    <div className="mt-3">
                      <ScreenError>{rowError.message}</ScreenError>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <PanelFooter>
        {closed ? null : (
          <Button type="button" className={PANEL_PRIMARY} onClick={onClose}>
            <Check aria-hidden="true" className="size-7" />
            {t('warehouseman.receiving.count.close')}
          </Button>
        )}
      </PanelFooter>

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
        // A resolved scan takes over the dialog until it is told how many. The dialog stops
        // accepting scans for as long as this is here, which is what makes one carton
        // impossible to overtake with the next.
        interruption={
          pendingScan ? (
            <ScanQuantityStep
              productName={productLabel(pendingScan.name, unknownProduct)}
              code={pendingScan.code}
              busy={submitting}
              error={formError}
              onConfirm={(confirmed) => void onConfirmPendingScan(confirmed)}
              onCancel={onCancelPendingScan}
            />
          ) : null
        }
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
