"use client"
import * as React from 'react'
import Link from 'next/link'
import { Camera, ChevronLeft, Minus, Plus, ScanLine } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { cn } from '@open-mercato/shared/lib/utils'

/**
 * The panel's own layout vocabulary. Everything here is shadcn underneath — the panel
 * only changes size and weight, because a gloved thumb and a dock door's daylight are
 * what the office primitives are not sized for.
 */

/** Every tappable control on the panel is at least this tall. */
export const PANEL_ACTION = 'h-16 w-full text-lg font-semibold md:w-auto md:px-6'
/** The one action a screen exists for, always the last thing on the screen. */
export const PANEL_PRIMARY = 'h-20 w-full border-2 text-xl font-bold md:w-auto md:px-10'

export function PanelSurface({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      data-om-panel="warehouseman"
      className={cn('flex min-h-screen flex-col bg-background text-foreground', className)}
    >
      {children}
    </div>
  )
}

export type PanelTopBarProps = {
  title: string
  subtitle?: string | null
  backHref?: string
  backLabel?: string
  actions?: React.ReactNode
}

export function PanelTopBar({ title, subtitle, backHref, backLabel, actions }: PanelTopBarProps) {
  return (
    <header className="sticky top-0 z-20 border-b-2 border-border bg-card">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-3">
        {backHref ? (
          <IconButton asChild variant="outline" className="size-14 shrink-0 border-2">
            <Link href={backHref} aria-label={backLabel ?? title}>
              <ChevronLeft className="size-7" aria-hidden="true" />
            </Link>
          </IconButton>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle ? <p className="truncate text-base text-muted-foreground">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  )
}

export function PanelBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <main className={cn('mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 px-4 py-4', className)}>
      {children}
    </main>
  )
}

/**
 * The primary action sits against the bottom edge on a handheld and stays in the flow on a
 * tablet, where the screen is not thumb-reachable anyway and a floating bar just eats rows.
 */
export function PanelFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-auto border-t-2 border-border bg-background px-4 py-3 md:static md:mx-0 md:border-t-0 md:bg-transparent md:px-0 md:py-0">
      <div className="flex flex-col gap-2 md:flex-row-reverse md:gap-3">{children}</div>
    </div>
  )
}

export function PanelCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('rounded-lg border-2 border-border bg-card p-4', className)}>{children}</div>
}

export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span className="text-sm font-bold uppercase tracking-widest text-muted-foreground">{children}</span>
      <span className="h-0.5 flex-1 bg-muted" aria-hidden="true" />
    </div>
  )
}

export type ScanFieldProps = {
  label: string
  placeholder?: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  submitLabel: string
  disabled?: boolean
  emphasis?: boolean
  inputRef?: React.Ref<HTMLInputElement>
  /** Opens the camera. Given one, the icon beside the field is the camera and the submit
   *  becomes an explicit button: typing stays the path that works without a secure context. */
  onCamera?: () => void
  cameraLabel?: string
}

/**
 * A handheld scanner types the code and ends with Enter, so the field is a form of its own
 * and the button beside it is for the times the scanner is on its charger.
 */
export function ScanField({
  label,
  placeholder,
  value,
  onChange,
  onSubmit,
  submitLabel,
  disabled,
  emphasis,
  inputRef,
  onCamera,
  cameraLabel,
}: ScanFieldProps) {
  const id = React.useId()
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <label
        htmlFor={id}
        className={cn(
          'text-sm font-bold uppercase tracking-widest',
          emphasis ? 'text-primary' : 'text-muted-foreground',
        )}
      >
        {label}
      </label>
      <div className="flex items-stretch gap-2">
        <Input
          id={id}
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={cn('h-20 min-w-0 flex-1 border-2 px-4', emphasis && 'border-primary')}
          inputClassName="h-full font-mono text-xl"
        />
        <Button
          type={onCamera ? 'button' : 'submit'}
          variant={emphasis ? 'default' : 'outline'}
          disabled={disabled}
          aria-label={onCamera ? cameraLabel ?? submitLabel : submitLabel}
          className="size-20 shrink-0 border-2 p-0"
          onClick={onCamera}
        >
          {onCamera ? <Camera className="size-8" aria-hidden="true" /> : <ScanLine className="size-8" aria-hidden="true" />}
        </Button>
      </div>
      {onCamera ? (
        <Button type="submit" variant="outline" className={`${PANEL_ACTION} border-2`} disabled={disabled}>
          {submitLabel}
        </Button>
      ) : null}
    </form>
  )
}

export type QtyStepperProps = {
  label: string
  value: string
  onChange: (value: string) => void
  decrementLabel: string
  incrementLabel: string
  disabled?: boolean
}

/**
 * Counting is mostly "one more of these", so the two big keys do the work and the field is
 * there for the pallet that arrives with forty. Stepping a typed decimal rounds it down to
 * whole units on purpose: a half-unit plus one is a typo, not a count.
 */
export function QtyStepper({
  label,
  value,
  onChange,
  decrementLabel,
  incrementLabel,
  disabled,
}: QtyStepperProps) {
  const id = React.useId()
  const step = (delta: number) => {
    const current = Number.parseFloat(value.replace(',', '.'))
    const base = Number.isFinite(current) ? Math.floor(current) : 0
    onChange(String(Math.max(1, base + delta)))
  }
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </label>
      <div className="flex items-stretch gap-2">
        <Button
          type="button"
          variant="outline"
          className="size-20 shrink-0 border-2 p-0"
          aria-label={decrementLabel}
          disabled={disabled}
          onClick={() => step(-1)}
        >
          <Minus className="size-8" aria-hidden="true" />
        </Button>
        <Input
          id={id}
          value={value}
          inputMode="decimal"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-20 min-w-0 flex-1 border-2 px-4"
          inputClassName="h-full text-center text-3xl font-bold"
        />
        <Button
          type="button"
          className="size-20 shrink-0 border-2 p-0"
          aria-label={incrementLabel}
          disabled={disabled}
          onClick={() => step(1)}
        >
          <Plus className="size-8" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}

/** The running total of the screen's work, in the one place a glance always lands. */
export function ProgressStrip({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border-2 border-border bg-foreground px-4 py-3 text-background">
      <span className="flex-1 text-lg font-bold">{label}</span>
      {detail ? <span className="font-mono text-base whitespace-nowrap">{detail}</span> : null}
    </div>
  )
}

export function StatTile({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'error' | 'success'
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-lg border-2 p-3',
        tone === 'error' && 'border-status-error-border bg-status-error-bg text-status-error-text',
        tone === 'success' && 'border-status-success-border bg-status-success-bg text-status-success-text',
        tone === 'neutral' && 'border-border bg-card',
      )}
    >
      <span className={cn('text-sm', tone === 'neutral' && 'text-muted-foreground')}>{label}</span>
      <span className="text-3xl font-bold leading-none">{value}</span>
    </div>
  )
}
