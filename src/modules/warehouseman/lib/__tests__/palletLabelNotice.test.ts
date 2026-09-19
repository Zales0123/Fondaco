import { beforeEach, describe, expect, it } from '@jest/globals'
import {
  clearPalletLabelNotices,
  startPalletLabelPrint,
  takePalletLabelNotice,
} from '../palletLabelNotice'

const wording = {
  success: 'Etykieta palety jest drukowana.',
  failure: (reason: string) => `Paleta powstała, etykieta nie: ${reason}`,
  unknownReason: 'drukarka nie podała powodu',
  timedOutReason: 'drukarka nie odpowiedziała na czas',
}

/** A print the test decides the outcome of, after asserting the caller moved on. */
function deferredPrint() {
  let settle: { ok: () => void; fail: (error: unknown) => void }
  const promise = new Promise<void>((resolve, reject) => {
    settle = { ok: resolve, fail: reject }
  })
  return { print: () => promise, settle: settle! }
}

/** Shorthand for the common case: a print whose outcome the test does not care about. */
function startSettled(palletId: string, error?: unknown): void {
  startPalletLabelPrint(
    palletId,
    () => (error ? Promise.reject(error) : Promise.resolve()),
    wording,
  )
}

describe('pallet label print handoff', () => {
  beforeEach(() => clearPalletLabelNotices())

  it('carries what the printer answered into the pallet the screen navigates to', async () => {
    startSettled('pal-1')
    await expect(takePalletLabelNotice('pal-1')!).resolves.toEqual({
      kind: 'success',
      message: wording.success,
    })
  })

  it('reads a notice once: it is about one print, not about the screen', () => {
    startSettled('pal-1')
    expect(takePalletLabelNotice('pal-1')).not.toBeNull()
    expect(takePalletLabelNotice('pal-1')).toBeNull()
  })

  it('never hands one pallet the notice of another', () => {
    startSettled('pal-1')
    expect(takePalletLabelNotice('pal-2')).toBeNull()
    expect(takePalletLabelNotice('pal-1')).not.toBeNull()
  })

  it('answers nothing when no print preceded the navigation', () => {
    expect(takePalletLabelNotice('pal-1')).toBeNull()
  })

  it('keeps only the latest print for a pallet', async () => {
    startSettled('pal-1', new Error('Drukarka jest niedostępna.'))
    startSettled('pal-1')
    await expect(takePalletLabelNotice('pal-1')!).resolves.toEqual({
      kind: 'success',
      message: wording.success,
    })
  })
})

/**
 * A label takes tens of seconds to come out of a B1 over Bluetooth. Waiting for it
 * before opening the pallet means the warehouseman stands still for that whole time
 * holding a pallet that already exists — and for a printer that is off, stands still
 * until the request's own bound gives up.
 */
describe('startPalletLabelPrint', () => {
  beforeEach(() => clearPalletLabelNotices())

  it('hands over a print that is still running rather than waiting for it', async () => {
    const { print, settle } = deferredPrint()
    let printed = false

    startPalletLabelPrint('pal-1', print, wording)

    // The caller is already past the print: nothing awaited it.
    const carried = takePalletLabelNotice('pal-1')
    expect(carried).not.toBeNull()
    void carried!.then(() => {
      printed = true
    })
    expect(printed).toBe(false)

    settle.ok()
    await expect(carried!).resolves.toEqual({ kind: 'success', message: wording.success })
  })

  it('settles into the printer refusal without ever rejecting', async () => {
    const { print, settle } = deferredPrint()
    startPalletLabelPrint('pal-1', print, wording)
    const carried = takePalletLabelNotice('pal-1')

    settle.fail(new Error('Drukarka etykiet jest zajęta.'))

    // A rejection here would surface as an unhandled rejection whenever nobody
    // navigates into the pallet, so the outcome is always a resolved notice.
    await expect(carried!).resolves.toEqual({
      kind: 'warning',
      message: 'Paleta powstała, etykieta nie: Drukarka etykiet jest zajęta.',
    })
  })

  it('words a silent printer from the panel translations', async () => {
    const { print, settle } = deferredPrint()
    startPalletLabelPrint('pal-1', print, wording)
    const carried = takePalletLabelNotice('pal-1')

    settle.fail(new DOMException('The operation timed out.', 'TimeoutError'))

    await expect(carried!).resolves.toEqual({
      kind: 'warning',
      message: `Paleta powstała, etykieta nie: ${wording.timedOutReason}`,
    })
  })

  it('settles even when nobody navigates into the pallet', async () => {
    const { print, settle } = deferredPrint()
    startPalletLabelPrint('pal-1', print, wording)

    settle.fail(new Error('Drukarka jest niedostępna.'))

    // Nothing took the notice; the print must still settle quietly rather than
    // leaving a rejected promise nobody ever attached a handler to.
    await Promise.resolve()
    await expect(takePalletLabelNotice('pal-1')!).resolves.toMatchObject({ kind: 'warning' })
  })
})
