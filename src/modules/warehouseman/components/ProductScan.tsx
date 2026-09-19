"use client"
import * as React from 'react'
import { Camera } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { BarcodeScannerDialog } from '@/modules/barcode_scanner/components/BarcodeScannerDialog'
import { PANEL_PRIMARY, PanelCard, PanelFooter, ScanField, SectionLabel, StatTile } from './PanelUI'
import { ScreenEmpty, ScreenError, ScreenWarning } from './ReceivingStates'
import { resolveVariantByBarcode, ReceivingApiError } from '../lib/receivingApi'
import { fetchVariantStock, type ScannedProduct } from '../lib/productScanApi'
import { formatStockQuantity } from '../lib/productScan'
import { normalizeScannedCode, productLabel } from '../lib/receivingPanel'

export type ProductScanProps = {
  /** The signed-in warehouseman's own warehouse; null when nobody has assigned them one. */
  warehouseId: string | null
  warehouseName: string | null
}

/**
 * Scan a product, read what it is.
 *
 * The screen asks one question and answers it: what is this, and how many of them are in
 * this warehouse. It writes nothing, which is what lets the camera open the moment the
 * screen does — a warehouseman taps "Scan product" because they are already holding the
 * item, and a second tap to start the camera is a step that buys nothing.
 *
 * The barcode lookup is the same one the counting screen uses, so a code that names a
 * product while counting a delivery names the same product here. Stock is read separately
 * and is allowed to fail on its own: the product is the answer that was scanned for.
 */
export function ProductScan({ warehouseId, warehouseName }: ProductScanProps) {
  const t = useT()
  const [code, setCode] = React.useState('')
  const [scannerOpen, setScannerOpen] = React.useState(true)
  const [looking, setLooking] = React.useState(false)
  const [status, setStatus] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<ScannedProduct | null>(null)
  // The camera fires `onDetected` on every frame it decodes, so the guard has to be read
  // synchronously — a state flag would let a second lookup start inside the same tick.
  const lookupInFlight = React.useRef(false)

  /**
   * The screen's only lookup. A typed code and a code read off a label meet here, so the
   * camera can never name a product the keyboard would have refused.
   */
  const lookUp = React.useCallback(
    async (scanned: string) => {
      if (lookupInFlight.current) return
      lookupInFlight.current = true
      setLooking(true)
      setError(null)
      setStatus(t('warehouseman.scan.looking', undefined, { code: scanned }))
      try {
        const variant = await resolveVariantByBarcode(scanned)
        let stock = null
        // Without an assigned warehouse there is no stock question to answer. Falling back
        // to every warehouse's total would put a number on the screen that answers a
        // different question than the one the header says this panel is asking.
        if (warehouseId) {
          try {
            stock = await fetchVariantStock(variant.catalogVariantId, warehouseId)
          } catch {
            // The product is on the screen either way. A stock read that failed is reported
            // as missing rather than as zero — zero is an answer, and the wrong one.
            stock = null
          }
        }
        setResult({ variant, stock })
        setStatus(null)
        setScannerOpen(false)
      } catch (failure) {
        // An unknown barcode is an ordinary outcome, not a breakage: the dialog stays open
        // so the next code is scanned without reopening the camera.
        setError(
          failure instanceof ReceivingApiError && failure.status === 404
            ? t('warehouseman.scan.unknownBarcode', undefined, { barcode: scanned })
            : messageOf(failure, t('warehouseman.scan.failed')),
        )
        setStatus(null)
      } finally {
        lookupInFlight.current = false
        setLooking(false)
      }
    },
    [t, warehouseId],
  )

  function onSubmit() {
    const scanned = normalizeScannedCode(code)
    if (!scanned) {
      setError(t('warehouseman.scan.barcodeRequired'))
      return
    }
    void lookUp(scanned)
  }

  const onDetected = React.useCallback(
    (raw: string) => {
      const scanned = normalizeScannedCode(raw)
      if (!scanned) return
      void lookUp(scanned)
    },
    [lookUp],
  )

  function onOpenScanner() {
    setError(null)
    setStatus(null)
    setScannerOpen(true)
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      {/* Typing stays the path that always works: over plain http a phone has no secure
          context and therefore no camera at all, so the camera is an addition, never a
          replacement. */}
      <ScanField
        label={t('warehouseman.scan.field.label')}
        placeholder={t('warehouseman.scan.field.placeholder')}
        value={code}
        onChange={setCode}
        onSubmit={onSubmit}
        submitLabel={looking ? t('warehouseman.scan.field.submitting') : t('warehouseman.scan.field.submit')}
        onCamera={onOpenScanner}
        cameraLabel={t('warehouseman.scan.open')}
        disabled={looking}
        emphasis
      />

      {error && !scannerOpen ? <ScreenError>{error}</ScreenError> : null}

      {result ? (
        <>
          <SectionLabel>{t('warehouseman.scan.result')}</SectionLabel>
          <ScannedProductCard
            product={result}
            hasWarehouse={warehouseId != null}
            warehouseName={warehouseName}
          />
        </>
      ) : !error ? (
        <ScreenEmpty
          title={t('warehouseman.scan.empty.title')}
          description={t('warehouseman.scan.empty.description')}
        />
      ) : null}

      <PanelFooter>
        <Button type="button" className={PANEL_PRIMARY} onClick={onOpenScanner} disabled={looking}>
          <Camera className="size-7" aria-hidden="true" />
          {result ? t('warehouseman.scan.scanAnother') : t('warehouseman.scan.open')}
        </Button>
      </PanelFooter>

      <BarcodeScannerDialog
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={onDetected}
        busy={looking}
        statusMessage={status}
        errorMessage={error}
        title={t('warehouseman.scan.scanner.title')}
        description={t('warehouseman.scan.scanner.description')}
        manualLabel={t('warehouseman.scan.scanner.manualLabel')}
        manualPlaceholder={t('warehouseman.scan.scanner.manualPlaceholder')}
      />
    </div>
  )
}

/**
 * What the scan found. The stock figures are tiles because they are the reason somebody
 * scanned at all; the name and SKU above them are how they check the camera read the label
 * they were pointing at. Nothing here is tappable — the screen changes no data.
 */
function ScannedProductCard({
  product,
  hasWarehouse,
  warehouseName,
}: {
  product: ScannedProduct
  /** Whether a warehouse was assigned at all, which is why a missing stock figure differs. */
  hasWarehouse: boolean
  warehouseName: string | null
}) {
  const t = useT()
  const { variant, stock } = product
  return (
    <PanelCard className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-2xl font-bold">
          {productLabel(variant.name, t('warehouseman.scan.unknownProduct'))}
        </p>
        <p className="font-mono text-base text-muted-foreground">
          {t('warehouseman.scan.sku', undefined, { sku: variant.sku || t('warehouseman.scan.noSku') })}
        </p>
        <p className="font-mono text-base text-muted-foreground">
          {t('warehouseman.scan.barcode', undefined, { barcode: variant.barcode })}
        </p>
      </div>

      {stock ? (
        <div className="flex flex-col gap-2">
          {/* The header names the warehouse too, but the number needs it beside it: a
              stock figure read without knowing where it is counted is worse than none. */}
          {warehouseName ? (
            <p className="text-base text-muted-foreground">
              {t('warehouseman.scan.stock.inWarehouse', undefined, { warehouse: warehouseName })}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <StatTile
              label={t('warehouseman.scan.stock.label')}
              value={formatStockQuantity(stock.onHand)}
            />
            <StatTile
              label={t('warehouseman.scan.stock.availableLabel')}
              value={formatStockQuantity(stock.available)}
            />
          </div>
        </div>
      ) : (
        <ScreenWarning>
          {hasWarehouse
            ? t('warehouseman.scan.stock.unavailable')
            : t('warehouseman.scan.stock.noWarehouse')}
        </ScreenWarning>
      )}
    </PanelCard>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export default ProductScan
