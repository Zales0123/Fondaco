"use client"
import * as React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Alert } from '@open-mercato/ui/primitives/alert'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@open-mercato/ui/primitives/table'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import type { PurchaseOrderLineDraft } from '../lib/purchaseOrderLineDrafts'
import { createEmptyLineDraft } from '../lib/purchaseOrderLineDrafts'
import { lineNetValue, sumDecimals } from '../lib/decimal'
import { formatMoney } from './purchaseOrdersPresentation'

type ProductOption = { value: string; label: string }

type ProductsResponse = {
  items: Array<{ id: string; title?: string | null; sku?: string | null; default_unit?: string | null }>
}

export type PurchaseOrderLinesEditorProps = {
  value: PurchaseOrderLineDraft[]
  onChange: (next: PurchaseOrderLineDraft[]) => void
  currencyCode: string
  error?: string
  disabled?: boolean
}

function formatProductLabel(item: ProductsResponse['items'][number]): string {
  const title = item.title?.trim() || item.id
  const sku = item.sku?.trim()
  return sku ? `${title} — ${sku}` : title
}

/**
 * The value shown beside a line while it is being typed.
 *
 * It uses the same exact arithmetic the server does, so the figure the buyer watches add up is
 * the figure that gets saved. A half-typed quantity or price simply has no value yet, which is
 * shown as a placeholder rather than as zero.
 */
function draftNetValue(draft: PurchaseOrderLineDraft): string | null {
  const quantity = draft.quantityOrdered.trim().replace(',', '.')
  const price = draft.unitPriceNet.trim().replace(',', '.')
  if (!quantity || !price) return null
  return lineNetValue(quantity, price)
}

export function PurchaseOrderLinesEditor({
  value,
  onChange,
  currencyCode,
  error,
  disabled,
}: PurchaseOrderLinesEditorProps) {
  const t = useT()
  const locale = useLocale()
  // Remembers what the product picker already resolved, so choosing a product can prefill its
  // default unit and an already-chosen product still renders its name on reload.
  const productCache = React.useRef(new Map<string, { label: string; defaultUnit: string | null }>())

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
      const data = await readApiResultOrThrow<ProductsResponse>(
        `/api/catalog/products?id=${encodeURIComponent(productId)}&pageSize=1`,
      )
      const item = data?.items?.[0]
      if (!item) return productId
      const label = formatProductLabel(item)
      productCache.current.set(item.id, { label, defaultUnit: item.default_unit?.trim() || null })
      return label
    } catch {
      return productId
    }
  }, [])

  const patchLine = (key: string, patch: Partial<PurchaseOrderLineDraft>) => {
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
              // Prefill only when the user has not typed a unit of their own, so changing the
              // product never silently rewrites a unit taken off a supplier's quotation.
              unit: line?.unit ? line.unit : (cached?.defaultUnit ?? ''),
            }
          : entry,
      ),
    )
  }

  const netValues = value.map(draftNetValue)
  // A line that is not a value yet leaves the running total unknown rather than understated.
  const total = netValues.some((entry) => entry === null)
    ? null
    : sumDecimals(netValues as string[])

  return (
    <div className="space-y-3">
      {/*
        The line editor needs more width than a phone has: a product picker, a quantity, a
        unit, a price, a date and a remove control per row. It scrolls inside its own box so
        the PAGE never gains a horizontal scrollbar, which is what makes the rest of the form
        unusable at that width. `relative` is what makes the clipping hold: the screen-reader
        labels below are absolutely positioned, and without a positioned ancestor they resolve
        against the viewport, escape the box and put the page back off-screen.
      */}
      <div className="relative w-full overflow-x-auto">
        <Table>
          <TableCaption className="sr-only">{t('procurements.purchaseOrders.form.lines.caption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="w-16">
                {t('procurements.purchaseOrders.form.lines.column.position')}
              </TableHead>
              <TableHead scope="col">{t('procurements.purchaseOrders.form.lines.column.product')}</TableHead>
              <TableHead scope="col" className="w-32">
                {t('procurements.purchaseOrders.form.lines.column.quantity')}
              </TableHead>
              <TableHead scope="col" className="w-24">
                {t('procurements.purchaseOrders.form.lines.column.unit')}
              </TableHead>
              <TableHead scope="col" className="w-36">
                {t('procurements.purchaseOrders.form.lines.column.unitPrice')}
              </TableHead>
              <TableHead scope="col" className="w-36">
                {t('procurements.purchaseOrders.form.lines.column.expectedDate')}
              </TableHead>
              <TableHead scope="col" className="w-32 text-right">
                {t('procurements.purchaseOrders.form.lines.column.netValue')}
              </TableHead>
              <TableHead scope="col" className="w-12">
                <span className="sr-only">{t('procurements.purchaseOrders.form.lines.column.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {value.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-sm text-muted-foreground">
                  {t('procurements.purchaseOrders.form.lines.empty')}
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
                          {t('procurements.purchaseOrders.form.lines.product.label', undefined, { position })}
                        </span>
                        <ComboboxInput
                          value={line.catalogProductId}
                          onChange={(next) => handleProductChange(line.key, next)}
                          placeholder={t('procurements.purchaseOrders.form.lines.product.placeholder')}
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
                        value={line.quantityOrdered}
                        inputMode="decimal"
                        aria-label={t('procurements.purchaseOrders.form.lines.quantity.label', undefined, { position })}
                        placeholder={t('procurements.purchaseOrders.form.lines.quantity.placeholder')}
                        onChange={(event) => patchLine(line.key, { quantityOrdered: event.target.value })}
                        disabled={disabled}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={line.unit}
                        aria-label={t('procurements.purchaseOrders.form.lines.unit.label', undefined, { position })}
                        placeholder={t('procurements.purchaseOrders.form.lines.unit.placeholder')}
                        onChange={(event) => patchLine(line.key, { unit: event.target.value })}
                        disabled={disabled}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={line.unitPriceNet}
                        inputMode="decimal"
                        aria-label={t('procurements.purchaseOrders.form.lines.unitPrice.label', undefined, { position })}
                        placeholder={t('procurements.purchaseOrders.form.lines.unitPrice.placeholder')}
                        onChange={(event) => patchLine(line.key, { unitPriceNet: event.target.value })}
                        disabled={disabled}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="date"
                        value={line.expectedDate}
                        aria-label={t('procurements.purchaseOrders.form.lines.expectedDate.label', undefined, { position })}
                        onChange={(event) => patchLine(line.key, { expectedDate: event.target.value })}
                        disabled={disabled}
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(netValues[index], currencyCode, locale)}
                    </TableCell>
                    <TableCell>
                      <IconButton
                        variant="ghost"
                        aria-label={t('procurements.purchaseOrders.form.lines.remove', undefined, { position })}
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

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => onChange([...value, createEmptyLineDraft()])}
          disabled={disabled}
        >
          <Plus className="size-4" aria-hidden="true" />
          {t('procurements.purchaseOrders.form.lines.add')}
        </Button>
        <p className="text-sm">
          <span className="text-muted-foreground">{t('procurements.purchaseOrders.form.lines.total')}</span>{' '}
          <span className="font-semibold tabular-nums">{formatMoney(total, currencyCode, locale)}</span>
        </p>
      </div>

      {error ? <Alert status="error">{error}</Alert> : null}
    </div>
  )
}

export default PurchaseOrderLinesEditor
