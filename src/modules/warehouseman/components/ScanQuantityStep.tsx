"use client"
import * as React from 'react'
import { Minus, Plus } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  adjustScanQuantity,
  formatCountQuantity,
  MIN_SCAN_QUANTITY,
  type ScanQuantitySuggestion,
} from '../lib/receivingPanel'

/** The coarse step. A pallet of 48 is five taps, not 47. */
const COARSE_STEP = 10

export type ScanQuantityStepProps = {
  /** What the scanned code resolved to, already fallen back to the unknown-product label. */
  productName: string
  /** The code as scanned, so the person can check it against the label in their hand. */
  code: string
  /**
   * What the delivery says about this product, frozen at the moment of the scan: the number
   * the dial opens on, and the figures the line under the code explains it with. Omitted —
   * the screen could not read the document — the step behaves as it always did and opens on
   * one, with nothing claimed about the delivery.
   */
  suggestion?: ScanQuantitySuggestion | null
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
 *
 * The step is rendered *into* the scanner dialog, not onto the panel, so it inherits the
 * dialog's surface rather than re-pointing the tokens to the panel's paper palette. A
 * `data-om-panel` scope here would paint the panel's near-black ink onto the dialog's own
 * ground — invisible text and invisible outlines whenever the two disagree, which is every
 * time the backend is in dark mode. Glove-sized controls are what this step owes the
 * operator; the colours belong to whoever is hosting it.
 */
export function ScanQuantityStep({
  productName,
  code,
  suggestion,
  busy,
  error,
  onConfirm,
  onCancel,
}: ScanQuantityStepProps) {
  const t = useT()
  // Where the count starts: what the delivery still expects of this product, so the ordinary
  // pallet — one product, the whole line — is scan then confirm with nothing tapped or typed.
  // Without a document figure a scan means what it has always meant, one of this is here.
  const [quantity, setQuantity] = React.useState(suggestion?.quantity ?? MIN_SCAN_QUANTITY)
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
  const atFloor = quantity <= MIN_SCAN_QUANTITY

  return (
    <div className="flex flex-col gap-4 text-foreground">
      <div className="flex flex-col gap-1">
        {/* A product name is whatever the catalog says it is, so it wraps rather than
            running off the side of a phone. */}
        <span className="break-words text-2xl font-bold leading-tight">{productName}</span>
        <span className="break-all font-mono text-base text-muted-foreground">{code}</span>
        {/* Why the dial says what it says. A proposed number nobody can account for is a
            number that gets confirmed without being read — and the case this has to catch is
            the delivery that does not match what is actually on the floor. */}
        <DeliveryHint suggestion={suggestion ?? null} />
      </div>

      {/* A refused count leaves the step up rather than throwing the operator back to the
          camera: the number they chose survives, so confirming again is one tap. */}
      {error ? (
        <p role="alert" className="text-status-error-text">
          {error}
        </p>
      ) : null}

      {/* Two rows, not one. Five thumb-sized controls side by side need ~430px and a phone
          held in a warehouse aisle has ~280px inside the dialog's padding, which squeezed
          the number itself down to a sliver and pushed `+10` off the screen. The ±1 pair
          keeps the number between them where a stepper is read; the coarse pair, used far
          less often, takes the row below. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-20 w-20 shrink-0 border-2"
            disabled={busy || atFloor}
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
            className="h-20 min-w-0 flex-1 border-2"
            inputClassName="h-full text-center text-3xl font-bold"
            aria-label={t('warehouseman.receiving.count.step.quantityLabel')}
            aria-live="polite"
            onChange={(event) => setTyping(event.target.value)}
            onBlur={(event) => commitTyped(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            className="h-20 w-20 shrink-0 border-2"
            disabled={busy}
            aria-label={t('warehouseman.receiving.count.step.increase')}
            onClick={() => step(1)}
          >
            <Plus className="size-8" aria-hidden="true" />
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-16 w-full border-2 text-lg font-bold"
            disabled={busy || atFloor}
            aria-label={t('warehouseman.receiving.count.step.decreaseBy', undefined, { step: COARSE_STEP })}
            onClick={() => step(-COARSE_STEP)}
          >
            −{COARSE_STEP}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-16 w-full border-2 text-lg font-bold"
            disabled={busy}
            aria-label={t('warehouseman.receiving.count.step.increaseBy', undefined, { step: COARSE_STEP })}
            onClick={() => step(COARSE_STEP)}
          >
            +{COARSE_STEP}
          </Button>
        </div>
      </div>

      <Button
        ref={confirmRef}
        type="button"
        className="h-20 w-full border-2 text-xl font-bold"
        disabled={busy}
        onClick={() => onConfirm(effective)}
      >
        {busy ? <Spinner size="sm" /> : null}
        {t('warehouseman.receiving.count.step.confirm', undefined, { quantity: effective })}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="h-16 w-full border-2 text-lg font-semibold"
        disabled={busy}
        onClick={onCancel}
      >
        {t('warehouseman.receiving.count.step.cancel')}
      </Button>
    </div>
  )
}

/**
 * The one line that accounts for the proposed number.
 *
 * It names the document's own figure rather than the proposal: the proposal is on the dial
 * already, and what the operator cannot otherwise see is how much of the line somebody has
 * counted onto another pallet. A product no line of the delivery expected says so plainly —
 * on a receiving floor that is news, and the panel has no other place to break it.
 */
function DeliveryHint({ suggestion }: { suggestion: ScanQuantitySuggestion | null }) {
  const t = useT()
  if (!suggestion) return null

  if (suggestion.expected === null) {
    return <span className="text-base text-muted-foreground">{t('warehouseman.receiving.count.step.unexpected')}</span>
  }

  const expected = formatCountQuantity(suggestion.expected)
  const counted = formatCountQuantity(suggestion.counted)
  // Nothing counted yet is the first pallet of a line, which is most scans: the shorter
  // sentence is the true one there, and a "0 already counted" clause is noise to read past.
  if (counted === '0') {
    return (
      <span className="text-base text-muted-foreground">
        {t('warehouseman.receiving.count.step.expected', undefined, { expected })}
      </span>
    )
  }

  // A line already counted in full is the one case where the dial and the document disagree:
  // it proposes one because it will not propose nothing, so the line has to say why.
  const key =
    formatCountQuantity(suggestion.outstanding ?? '0') === '0'
      ? 'warehouseman.receiving.count.step.expectedComplete'
      : 'warehouseman.receiving.count.step.expectedRemaining'
  return <span className="text-base text-muted-foreground">{t(key, undefined, { expected, counted })}</span>
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
