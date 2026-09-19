"use client"
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { SectionLabel } from './PanelUI'
import { ScreenError, ScreenMessage } from './ReceivingStates'
import { resolveExpectedContents, type ReceivingExpectedLine } from '../lib/expectedContents'

export type ReceivingExpectedContentsProps = {
  /** The document's lines, exactly as the single-record read answered them. */
  lines: readonly ReceivingExpectedLine[] | null | undefined
  loading: boolean
  error: unknown
  /** `false` when the document itself could not be read; the list then says so. */
  loaded: boolean
}

/**
 * What the delivery is supposed to contain, under the pallets it is being counted onto.
 *
 * The floor used to open a delivery and see only its own work — pallets, and a scanner. This
 * is the other half of the job: the paperwork's claim, so a missing product is noticed at the
 * dock rather than at the summary screen once the truck has gone. It is read-only and carries
 * no counts on purpose — comparing the two is the summary's job, and a second comparison here
 * would be a second chance to disagree about what arrived.
 */
export function ReceivingExpectedContents({ lines, loading, error, loaded }: ReceivingExpectedContentsProps) {
  const t = useT()
  const state = resolveExpectedContents({ loading, error, document: loaded ? { lines } : null })

  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>{t('warehouseman.receiving.expected.title')}</SectionLabel>
      {state.kind === 'loading' ? <ScreenMessage>{t('warehouseman.receiving.expected.loading')}</ScreenMessage> : null}
      {state.kind === 'error' ? <ScreenError>{t('warehouseman.receiving.expected.error')}</ScreenError> : null}
      {state.kind === 'rows' && state.rows.length === 0 ? (
        <p className="text-base text-muted-foreground">{t('warehouseman.receiving.expected.empty')}</p>
      ) : null}
      {state.kind === 'rows' && state.rows.length > 0 ? (
        <ul className="flex flex-col gap-2 md:grid md:grid-cols-2">
          {state.rows.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-3 rounded-lg border-2 border-border bg-card px-3 py-2"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-lg font-semibold">
                  {row.name ?? t('warehouseman.receiving.expected.unknownProduct')}
                </span>
                {row.sku ? (
                  <span className="truncate font-mono text-sm text-muted-foreground">{row.sku}</span>
                ) : null}
              </span>
              {/* The number is what a glance is looking for, so it never wraps and never shrinks. */}
              <span className="shrink-0 whitespace-nowrap font-mono text-xl font-bold">
                {row.unit
                  ? t('warehouseman.receiving.expected.quantity', undefined, {
                      quantity: row.quantity,
                      unit: row.unit,
                    })
                  : row.quantity}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export default ReceivingExpectedContents
