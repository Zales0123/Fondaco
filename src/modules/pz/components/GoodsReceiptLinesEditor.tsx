"use client"
import * as React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@open-mercato/ui/primitives/table'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { GoodsReceiptLineDraft } from '../lib/goodsReceiptLineDrafts'
import { createEmptyLineDraft } from '../lib/goodsReceiptLineDrafts'

type ProductOption = { value: string; label: string }

type ProductsResponse = {
  items: Array<{
    id: string
    title?: string | null
    sku?: string | null
    default_unit?: string | null
  }>
}

type AnnounceableLine = {
  purchaseOrderLineId: string
  purchaseOrderId: string
  documentNumber: string
  lineNumber: number
  supplierName: string
  quantityFree: string
  expectedDate: string | null
}

type AnnounceableResponse = { items: AnnounceableLine[] }

export type GoodsReceiptLinesEditorProps = {
  value: GoodsReceiptLineDraft[]
  onChange: (next: GoodsReceiptLineDraft[]) => void
  error?: string
  disabled?: boolean
}

function formatProductLabel(item: ProductsResponse['items'][number]): string {
  const title = item.title?.trim() || item.id
  const sku = item.sku?.trim()
  return sku ? `${title} — ${sku}` : title
}

/**
 * `ZZ/2026/001 / 2 · 40 free` — the order, the position and what is left to announce, which
 * is what decides whether this is the right line to pick.
 */
function formatAnnounceableLabel(item: AnnounceableLine): string {
  const free = item.quantityFree.includes('.')
    ? item.quantityFree.replace(/0+$/, '').replace(/\.$/, '')
    : item.quantityFree
  return `${item.documentNumber} / ${item.lineNumber} · ${free}`
}

export function GoodsReceiptLinesEditor({ value, onChange, error, disabled }: GoodsReceiptLinesEditorProps) {
  const t = useT()
  // Remembers what the product picker already resolved, so choosing a product can prefill
  // its default unit and an already-chosen product still renders its name on reload.
  const productCache = React.useRef(new Map<string, { label: string; defaultUnit: string | null }>())
  // Keeps the chosen order line renderable after a reload, and carries the order id the
  // server needs alongside it.
  const purchaseOrderCache = React.useRef(new Map<string, { label: string; purchaseOrderId: string }>())

  const loadProducts = React.useCallback(async (query?: string): Promise<ProductOption[]> => {
    const params = new URLSearchParams({ pageSize: '20' })
    if (query && query.trim()) params.set('search', query.trim())
    try {
      const data = await readApiResultOrThrow<ProductsResponse>(`/api/catalog/products?${params.toString()}`)
      const items = data?.items ?? []
      return items.map((item) => {
        const label = formatProductLabel(item)
        productCache.current.set(item.id, { label, defaultUnit: item.default_unit?.trim() || null })
        return { value: item.id, label }
      })
    } catch {
      // A failed lookup must not take the whole form down; the picker simply offers nothing
      // and the field-level validation still refuses an empty product.
      return []
    }
  }, [])

  const resolveProductLabel = React.useCallback(async (productId: string): Promise<string> => {
    const cached = productCache.current.get(productId)
    if (cached) return cached.label
    try {
      const data = await readApiResultOrThrow<ProductsResponse>(`/api/catalog/products?id=${encodeURIComponent(productId)}&pageSize=1`)
      const item = data?.items?.[0]
      if (!item) return productId
      const label = formatProductLabel(item)
      productCache.current.set(item.id, { label, defaultUnit: item.default_unit?.trim() || null })
      return label
    } catch {
      return productId
    }
  }, [])

  /**
   * The purchase order positions this line could settle.
   *
   * Narrowed to the product already chosen on the row: a delivery of one product cannot
   * settle an order for another, and the server refuses that pairing anyway — so offering it
   * would only produce an error the user cannot act on. With no product chosen yet the
   * picker stays empty rather than listing the whole order book.
   */
  const loadPurchaseOrderLines = React.useCallback(
    async (productId: string, query?: string): Promise<ProductOption[]> => {
      if (!productId) return []
      const params = new URLSearchParams({ limit: '20', catalogProductId: productId })
      if (query && query.trim()) params.set('search', query.trim())
      try {
        const data = await readApiResultOrThrow<AnnounceableResponse>(
          `/api/procurements/purchase-order-lines/announceable?${params.toString()}`,
        )
        return (data?.items ?? []).map((item) => {
          const label = formatAnnounceableLabel(item)
          purchaseOrderCache.current.set(item.purchaseOrderLineId, {
            label,
            purchaseOrderId: item.purchaseOrderId,
          })
          return { value: item.purchaseOrderLineId, label }
        })
      } catch {
        // Purchasing being unreadable — module disabled, or the caller lacking its view
        // feature — must not block recording a delivery. The picker simply offers nothing.
        return []
      }
    },
    [],
  )

  const resolvePurchaseOrderLabel = React.useCallback(async (lineId: string): Promise<string> => {
    return purchaseOrderCache.current.get(lineId)?.label ?? lineId
  }, [])

  const handlePurchaseOrderChange = (key: string, purchaseOrderLineId: string) => {
    const cached = purchaseOrderCache.current.get(purchaseOrderLineId)
    onChange(
      value.map((entry) =>
        entry.key === key
          ? {
              ...entry,
              purchaseOrderLineId,
              // Both halves move together: the server refuses a reference that names only
              // one of them, and clearing the picker has to clear the order too.
              purchaseOrderId: purchaseOrderLineId ? (cached?.purchaseOrderId ?? '') : '',
              purchaseOrderLabel: purchaseOrderLineId ? (cached?.label ?? '') : '',
            }
          : entry,
      ),
    )
  }

  const patchLine = (key: string, patch: Partial<GoodsReceiptLineDraft>) => {
    onChange(value.map((line) => (line.key === key ? { ...line, ...patch } : line)))
  }

  const handleProductChange = (key: string, productId: string) => {
    const cached = productCache.current.get(productId)
    const line = value.find((entry) => entry.key === key)
    onChange(
      value.map((entry) =>
        entry.key === key
          ? {
              ...entry,
              catalogProductId: productId,
              // Prefill only when the user has not typed a unit of their own, so changing
              // the product never silently rewrites a unit taken off the delivery note.
              unit: line?.unit ? line.unit : (cached?.defaultUnit ?? ''),
              // A purchase order position is for one product, so changing the product
              // invalidates the reference rather than quietly keeping a mismatched one.
              purchaseOrderId: '',
              purchaseOrderLineId: '',
              purchaseOrderLabel: '',
            }
          : entry,
      ),
    )
  }

  return (
    <div className="space-y-3">
      {/*
        The line editor needs more width than a phone has: a product picker, a quantity, a
        unit and a remove control per row. It scrolls inside its own box so the PAGE never
        gains a horizontal scrollbar, which is what makes the rest of the form unusable at
        that width. `relative` is what makes the clipping hold: the screen-reader labels
        below are absolutely positioned, and without a positioned ancestor they resolve
        against the viewport, escape the box and put the page back off-screen.
      */}
      <div className="relative w-full overflow-x-auto">
        <Table>
          <TableCaption className="sr-only">{t('pz.goodsReceipts.form.lines.caption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="w-16">{t('pz.goodsReceipts.form.lines.column.position')}</TableHead>
              <TableHead scope="col">{t('pz.goodsReceipts.form.lines.column.product')}</TableHead>
              <TableHead scope="col" className="w-40">{t('pz.goodsReceipts.form.lines.column.quantity')}</TableHead>
              <TableHead scope="col" className="w-32">{t('pz.goodsReceipts.form.lines.column.unit')}</TableHead>
              <TableHead scope="col" className="w-64">
                {t('pz.goodsReceipts.form.lines.column.purchaseOrder')}
              </TableHead>
              <TableHead scope="col" className="w-12">
                <span className="sr-only">{t('pz.goodsReceipts.form.lines.column.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {value.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-sm text-muted-foreground">
                  {t('pz.goodsReceipts.form.lines.empty')}
                </TableCell>
              </TableRow>
            ) : (
              value.map((line, index) => {
                const position = index + 1
                return (
                  <TableRow key={line.key}>
                    <TableCell>{position}</TableCell>
                    <TableCell>
                      {/*
                        `ComboboxInput` takes no `aria-label`, and a shared placeholder cannot
                        tell two lines apart for a screen reader. A wrapping label names the
                        control it contains, so each row announces its own position.
                      */}
                      <label>
                        <span className="sr-only">
                          {t('pz.goodsReceipts.form.lines.product.label', undefined, { position })}
                        </span>
                        <ComboboxInput
                          value={line.catalogProductId}
                          onChange={(next) => handleProductChange(line.key, next)}
                          placeholder={t('pz.goodsReceipts.form.lines.product.placeholder')}
                          loadSuggestions={loadProducts}
                          resolveLabel={resolveProductLabel}
                          allowCustomValues={false}
                          clearable={false}
                          disabled={disabled}
                        />
                      </label>
                    </TableCell>
                    <TableCell>
                      <Input
                        value={line.quantity}
                        inputMode="decimal"
                        aria-label={t('pz.goodsReceipts.form.lines.quantity.label', undefined, { position })}
                        placeholder={t('pz.goodsReceipts.form.lines.quantity.placeholder')}
                        onChange={(event) => patchLine(line.key, { quantity: event.target.value })}
                        disabled={disabled}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={line.unit}
                        aria-label={t('pz.goodsReceipts.form.lines.unit.label', undefined, { position })}
                        placeholder={t('pz.goodsReceipts.form.lines.unit.placeholder')}
                        onChange={(event) => patchLine(line.key, { unit: event.target.value })}
                        disabled={disabled}
                      />
                    </TableCell>
                    <TableCell>
                      {/*
                        Optional by design: a sample, a warranty replacement or a supplier's
                        own correction arrives without an order, and forcing a reference
                        would make those deliveries unrecordable.
                      */}
                      <label>
                        <span className="sr-only">
                          {t('pz.goodsReceipts.form.lines.purchaseOrder.label', undefined, { position })}
                        </span>
                        <ComboboxInput
                          value={line.purchaseOrderLineId}
                          onChange={(next) => handlePurchaseOrderChange(line.key, next)}
                          placeholder={
                            line.catalogProductId
                              ? t('pz.goodsReceipts.form.lines.purchaseOrder.placeholder')
                              : t('pz.goodsReceipts.form.lines.purchaseOrder.chooseProductFirst')
                          }
                          loadSuggestions={(query) => loadPurchaseOrderLines(line.catalogProductId, query)}
                          resolveLabel={resolvePurchaseOrderLabel}
                          allowCustomValues={false}
                          clearable
                          disabled={disabled || !line.catalogProductId}
                        />
                      </label>
                    </TableCell>
                    <TableCell>
                      <IconButton
                        variant="ghost"
                        aria-label={t('pz.goodsReceipts.form.lines.remove', undefined, { position })}
                        onClick={() => onChange(value.filter((entry) => entry.key !== line.key))}
                        disabled={disabled}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={() => onChange([...value, createEmptyLineDraft()])}
        disabled={disabled}
      >
        <Plus className="size-4" aria-hidden="true" />
        {t('pz.goodsReceipts.form.lines.add')}
      </Button>

      {error ? <Alert status="error">{error}</Alert> : null}
    </div>
  )
}

export default GoodsReceiptLinesEditor
