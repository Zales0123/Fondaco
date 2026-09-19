"use client"
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, LockOpen, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
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
import { PanelLinkButton, ScreenEmpty, ScreenError, ScreenMessage } from './ReceivingStates'
import {
  closePallet,
  countPalletLine,
  deletePalletLine,
  fetchPalletLines,
  fetchPallets,
  fetchReceivingDocument,
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
  formatCountQuantity,
  normalizeScannedCode,
  parseCountQuantity,
  productLabel,
  receivingReceiptHref,
  receivingSummaryHref,
} from '../lib/receivingPanel'

export type ReceivingCountProps = { receiptId: string; palletId: string }

const DEFAULT_QUANTITY = '1'

/**
 * The screen the whole feature exists for. A handheld scanner types the barcode and ends
 * with Enter, so the form submits on Enter and the barcode field takes focus back after
 * every submit — including a failed one, because the next thing that happens on the floor
 * is another scan. The quantity stays at one between scans: counting is mostly one at a
 * time, and the stepper is there for the cases that are not.
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
  const [lastCounted, setLastCounted] = React.useState<{ product: string; quantity: string } | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [editing, setEditing] = React.useState<{ id: string; value: string } | null>(null)
  const [rowError, setRowError] = React.useState<{ id: string; message: string } | null>(null)

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
  // The field only exists once the pallet has loaded and is open, so the autofocus waits
  // for that rather than firing against a loading screen and never coming back.
  const countable = !!pallet && !closed
  React.useEffect(() => {
    if (countable) focusBarcode()
  }, [countable, focusBarcode])

  const invalidatePallets = () =>
    queryClient.invalidateQueries({ queryKey: ['warehouseman.receiving.pallets', receiptId] })

  async function recordCount(catalogVariantId: string, resolvedName: string | null) {
    const parsed = parseCountQuantity(quantity)
    if (!parsed) {
      setFormError(t('pz.palletLines.errors.quantityInvalid'))
      return
    }
    setSubmitting(true)
    try {
      const counted = await countPalletLine({ palletId, catalogVariantId, quantity: parsed })
      const refreshed = await lines.refetch()
      const row = refreshed.data?.find((candidate) => candidate.catalogVariantId === catalogVariantId)
      const product = productLabel(row?.name ?? resolvedName, unknownProduct)
      const total = formatCountQuantity(row?.quantity ?? counted.quantity)
      setLastCounted({ product, quantity: total })
      setAnnouncement(t('warehouseman.receiving.count.added', undefined, { product, quantity: total }))
      setBarcode('')
      setQuantity(DEFAULT_QUANTITY)
      setUnknownBarcode(null)
      setFormError(null)
      await invalidatePallets()
    } catch (error) {
      setFormError(messageOf(error, t('pz.palletLines.errors.countFailed')))
    } finally {
      setSubmitting(false)
      focusBarcode()
    }
  }

  async function onScan() {
    setFormError(null)
    const scanned = normalizeScannedCode(barcode)
    if (!scanned) {
      setFormError(t('pz.palletLines.errors.barcodeRequired'))
      focusBarcode()
      return
    }
    try {
      const variant = await resolveVariantByBarcode(scanned)
      await recordCount(variant.catalogVariantId, variant.name)
    } catch (error) {
      if (error instanceof ReceivingApiError && error.status === 404) {
        // The scanned code stays in the field: it is the only record of what is in the
        // person's hand, and the picker is how they say which product carries it.
        setUnknownBarcode(scanned)
        setFormError(t('warehouseman.receiving.count.unknownBarcode', undefined, { barcode: scanned }))
      } else {
        setFormError(messageOf(error, t('pz.palletLines.errors.countFailed')))
      }
      focusBarcode()
    }
  }

  async function onSaveEdit(line: PalletLine) {
    if (!editing) return
    setRowError(null)
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
      <p className="text-base text-muted-foreground">
        {document.data?.documentNumber ?? ''}
        {document.data?.supplierName ? ` · ${document.data.supplierName}` : ''}
      </p>

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
          <ScanField
            label={t('warehouseman.receiving.count.barcode.label')}
            placeholder={t('warehouseman.receiving.count.barcode.placeholder')}
            value={barcode}
            onChange={setBarcode}
            onSubmit={onScan}
            submitLabel={t('warehouseman.receiving.count.submit')}
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

          {formError ? <ScreenError>{formError}</ScreenError> : null}

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

          {lastCounted ? (
            <PanelCard className="flex items-center gap-3 border-status-success-border bg-status-success-bg">
              <Check className="size-8 shrink-0 text-status-success-text" aria-hidden="true" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-lg font-bold">{lastCounted.product}</span>
                <span className="text-base">
                  {t('warehouseman.receiving.count.lastScan', undefined, { quantity: lastCounted.quantity })}
                </span>
              </span>
            </PanelCard>
          ) : null}

          <p role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>
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
                          className="h-20 border-2 px-4"
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
        <PanelLinkButton href={receivingSummaryHref(receiptId)}>
          {t('warehouseman.receiving.count.summary')}
        </PanelLinkButton>
      </PanelFooter>
      {ConfirmDialogElement}
    </div>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export default ReceivingCount
