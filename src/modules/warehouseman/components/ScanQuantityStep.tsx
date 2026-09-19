"use client"
import * as React from 'react'
import { Minus, Plus } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { adjustScanQuantity, MIN_SCAN_QUANTITY } from '../lib/receivingPanel'

/** The coarse step. A pallet of 48 is five taps, not 47. */
const COARSE_STEP = 10

export type ScanQuantityStepProps = {
  /** What the scanned code resolved to, already fallen back to the unknown-product label. */
  productName: string
  /** The code as scanned, so the person can check it against the label in their hand. */
  code: string
  /** A count is posting. Disables everything and spins the confirm button. */
  busy: boolean
  /** Already-localized refusal from a confirm that failed. The step stays open showing it. */
  error: string | null
  onConfirm: (quantity: number) => void
  onCancel: () => void
}

/**
 * The question between a scan and a count: *how many of these?*
 *
 * The whole reason it exists is that one scan should be able to mean a whole carton. A
 * scan-means-one camera is only faster than typing while every item is presented to the
 * lens; a pallet of forty-eight identical boxes is one scan and a number, and that is the
 * ordinary case on a delivery.
 *
 * Everything here is sized for a warehouse glove. The steppers are the primary controls
 * because they are the ones that work without fine motor control or a keyboard, and the
 * field is there for the odd exact number that would otherwise be a lot of tapping. There
 * is no way to scan past this: `BarcodeScannerDialog` accepts nothing while it is up.
 */
export function ScanQuantityStep({
  productName,
  code,
  busy,
  error,
  onConfirm,
  onCancel,
}: ScanQuantityStepProps) {
  const t = useT()
  // A scan asserts one of something is there, so that is where the count starts: a single
  // item is scan then confirm, and nothing has to be typed to record the common case.
  const [quantity, setQuantity] = React.useState(MIN_SCAN_QUANTITY)
  const [typing, setTyping] = React.useState<string | null>(null)
  const confirmRef = React.useRef<HTMLButtonElement>(null)

  // The step replaces the preview the operator was looking at, so focus follows it there
  // rather than staying on a control that is no longer rendered.
  React.useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  const step = (delta: number) => {
    setTyping(null)
    setQuantity((current) => adjustScanQuantity(current, delta))
  }

  /**
   * Typed entry is held as a string while it is being edited, because the intermediate
   * states of typing "12" include the empty field — snapping that back to 1 mid-keystroke
   * would fight the person doing it.
   */
  const commitTyped = (raw: string) => {
    setTyping(null)
    const parsed = Number.parseInt(raw.trim(), 10)
    if (!Number.isFinite(parsed)) return
    setQuantity(Math.max(MIN_SCAN_QUANTITY, parsed))
  }

  const shown = typing ?? String(quantity)
  // What the confirm button both promises and sends. Reading it once keeps the label and
  // the count from ever disagreeing about what is being added.
  const effective = typing !== null ? resolveTyped(typing, quantity) : quantity

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-xl font-semibold">{productName}</span>
        <span className="text-muted-foreground">{code}</span>
      </div>

      {/* A refused count leaves the step up rather than throwing the operator back to the
          camera: the number they chose survives, so confirming again is one tap. */}
      {error ? (
        <p role="alert" className="text-status-error-text">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-20 w-20 shrink-0 text-lg"
          disabled={busy || quantity <= MIN_SCAN_QUANTITY}
          aria-label={t('warehouseman.receiving.count.step.decreaseBy', undefined, { step: COARSE_STEP })}
          onClick={() => step(-COARSE_STEP)}
        >
          −{COARSE_STEP}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-20 w-20 shrink-0"
          disabled={busy || quantity <= MIN_SCAN_QUANTITY}
          aria-label={t('warehouseman.receiving.count.step.decrease')}
          onClick={() => step(-1)}
        >
          <Minus className="size-8" aria-hidden="true" />
        </Button>
        {/* Announced as it changes: the number is the only thing that distinguishes this
            confirmation from the last one, and it is read by someone not looking at it. */}
        <Input
          value={shown}
          inputMode="numeric"
          disabled={busy}
          className="h-20 flex-1"
          inputClassName="h-full text-center text-3xl font-semibold"
          aria-label={t('warehouseman.receiving.count.step.quantityLabel')}
          aria-live="polite"
          onChange={(event) => setTyping(event.target.value)}
          onBlur={(event) => commitTyped(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          className="h-20 w-20 shrink-0"
          disabled={busy}
          aria-label={t('warehouseman.receiving.count.step.increase')}
          onClick={() => step(1)}
        >
          <Plus className="size-8" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-20 w-20 shrink-0 text-lg"
          disabled={busy}
          aria-label={t('warehouseman.receiving.count.step.increaseBy', undefined, { step: COARSE_STEP })}
          onClick={() => step(COARSE_STEP)}
        >
          +{COARSE_STEP}
        </Button>
      </div>

      <Button
        ref={confirmRef}
        type="button"
        size="lg"
        className="h-20 w-full text-xl"
        disabled={busy}
        onClick={() => onConfirm(effective)}
      >
        {busy ? <Spinner size="sm" /> : null}
        {t('warehouseman.receiving.count.step.confirm', undefined, { quantity: effective })}
      </Button>
      <Button
        type="button"
        size="lg"
        variant="outline"
        className="h-16 w-full text-lg"
        disabled={busy}
        onClick={onCancel}
      >
        {t('warehouseman.receiving.count.step.cancel')}
      </Button>
    </div>
  )
}

/**
 * Confirming straight out of the field has to read what is in it. Falling back to the
 * stepper's value rather than to 1 keeps a half-typed entry from silently counting one:
 * the number on screen is what the button promised.
 */
function resolveTyped(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(MIN_SCAN_QUANTITY, parsed)
}

export default ScanQuantityStep
