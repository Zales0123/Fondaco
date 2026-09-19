"use client"
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
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
  formatCountQuantity,
  normalizeScannedCode,
  parseCountQuantity,
  productLabel,
  receivingReceiptHref,
  receivingSummaryHref,
} from '../lib/receivingPanel'

export type ReceivingCountProps = { receiptId: string; palletId: string }

/**
 * The screen the whole feature exists for. A handheld scanner types the barcode and ends
 * with Enter, so the form submits on Enter and the barcode field takes focus back after
 * every submit — including a failed one, because the next thing that happens on the floor
 * is another scan.
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
      setAnnouncement(
        t('warehouseman.receiving.count.added', undefined, {
          product: productLabel(row?.name ?? resolvedName, unknownProduct),
          quantity: formatCountQuantity(row?.quantity ?? counted.quantity),
        }),
      )
      setBarcode('')
      setQuantity('')
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

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
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

      <form className="flex flex-col gap-2" onSubmit={onSubmit}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
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
          </label>
        </div>
        <Button type="submit" size="lg" className="h-16 w-full text-lg" disabled={closed || submitting}>
          {t('warehouseman.receiving.count.submit')}
        </Button>
      </form>

      {formError ? <ScreenError>{formError}</ScreenError> : null}

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
      {ConfirmDialogElement}
    </div>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export default ReceivingCount
