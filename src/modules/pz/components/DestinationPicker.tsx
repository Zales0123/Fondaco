"use client"
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'

export type Destination = {
  id: string
  code: string
  type: string
}

export type DestinationOptions = {
  items: Destination[]
  /** The warehouse's Default Destination, reported only when it is itself eligible. */
  defaultLocationId: string | null
}

const NO_DESTINATIONS: DestinationOptions = { items: [], defaultLocationId: null }

/**
 * The locations one document's counted goods may be put into. Asked for per document rather
 * than per warehouse, so neither surface has to know which warehouse it is looking at, and
 * the server decides what "eligible" means (ADR-0011).
 */
export function useDestinations(goodsReceiptId: string, enabled: boolean) {
  const { data, isLoading } = useQuery<DestinationOptions>({
    queryKey: ['pz.receivingDestinations', goodsReceiptId],
    enabled: enabled && goodsReceiptId.length > 0,
    queryFn: async () =>
      (await readApiResultOrThrow<DestinationOptions>(
        `/api/pz/receiving/destinations?goodsReceiptId=${encodeURIComponent(goodsReceiptId)}`,
      )) ?? NO_DESTINATIONS,
  })
  return { options: data ?? NO_DESTINATIONS, isLoading }
}

/**
 * Where the goods go. A real warehouse has hundreds of bins, so the control searches rather
 * than lists; the filtering is local because the whole eligible set arrived in one request.
 */
export function DestinationPicker({
  options,
  value,
  onChange,
  className,
  labelClassName,
}: {
  options: Destination[]
  value: string | null
  onChange: (next: string | null) => void
  className?: string
  /** The panel writes its own label scale; the office takes the form default. */
  labelClassName?: string
}) {
  const t = useT()
  const labels = React.useMemo(() => new Map(options.map((option) => [option.id, option.code])), [options])
  const suggest = React.useCallback(
    async (query?: string) => {
      const term = query?.trim().toLowerCase() ?? ''
      return options
        .filter((option) => !term || option.code.toLowerCase().includes(term))
        .slice(0, 50)
        .map((option) => ({ value: option.id, label: option.code }))
    },
    [options],
  )

  return (
    <label className={className ?? 'flex flex-col gap-2'}>
      {/* `ComboboxInput` takes no id and no `aria-label`, so the label has to contain it. */}
      <span className={labelClassName}>{t('pz.receiving.destination.label')}</span>
      <ComboboxInput
        value={value ?? ''}
        onChange={(next) => onChange(next || null)}
        placeholder={t('pz.receiving.destination.placeholder')}
        loadSuggestions={suggest}
        resolveLabel={async (id: string) => labels.get(id) ?? id}
        allowCustomValues={false}
      />
    </label>
  )
}
