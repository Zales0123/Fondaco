/**
 * Counting a pallet means scanning twenty identical cartons in a row, so a
 * plain "ignore the same code for N ms" debounce would silently swallow most of
 * a delivery. These tests pin the rule that replaces it: a repeat only counts
 * once the code has physically left the frame AND the cooldown has elapsed,
 * while a different code always counts immediately.
 */
import { describe, expect, it } from '@jest/globals'
import {
  EMPTY_TICKS_TO_CLEAR,
  SCAN_REPEAT_COOLDOWN_MS,
  createScanStreamState,
  observeEmptyFrame,
  observeScan,
} from '../lib/scanStream'

/** The operator swings the camera away: the frame stays empty long enough to count. */
function leaveTheFrame<S>(state: S, observe: (s: S) => S): S {
  let next = state
  for (let tick = 0; tick < EMPTY_TICKS_TO_CLEAR; tick += 1) next = observe(next)
  return next
}

describe('scanStream', () => {
  it('starts with nothing scanned yet', () => {
    expect(createScanStreamState()).toEqual({
      lastValue: null,
      lastAcceptedAt: 0,
      sawGap: true,
      emptyTicks: 0,
    })
  })

  it('accepts the very first scan', () => {
    const { accepted, state } = observeScan(createScanStreamState(), 'CARTON-1', 1_000)

    expect(accepted).toBe(true)
    expect(state.lastValue).toBe('CARTON-1')
    expect(state.lastAcceptedAt).toBe(1_000)
  })

  it('rejects the same value on the very next tick, while it is still in frame', () => {
    const first = observeScan(createScanStreamState(), 'CARTON-1', 1_000)
    const second = observeScan(first.state, 'CARTON-1', 1_100)

    expect(second.accepted).toBe(false)
  })

  it('keeps rejecting the same value once the cooldown passes but the code never left the frame', () => {
    const first = observeScan(createScanStreamState(), 'CARTON-1', 1_000)
    const later = observeScan(first.state, 'CARTON-1', 1_000 + SCAN_REPEAT_COOLDOWN_MS + 500)

    expect(later.accepted).toBe(false)
  })

  it('rejects the same value after a gap but before the cooldown', () => {
    const first = observeScan(createScanStreamState(), 'CARTON-1', 1_000)
    const cleared = leaveTheFrame(first.state, observeEmptyFrame)
    const tooSoon = observeScan(cleared, 'CARTON-1', 1_000 + SCAN_REPEAT_COOLDOWN_MS - 1)

    expect(tooSoon.accepted).toBe(false)
  })

  it('accepts the same value once both the gap and the cooldown have happened', () => {
    const first = observeScan(createScanStreamState(), 'CARTON-1', 1_000)
    const cleared = leaveTheFrame(first.state, observeEmptyFrame)
    const again = observeScan(cleared, 'CARTON-1', 1_000 + SCAN_REPEAT_COOLDOWN_MS)

    expect(again.accepted).toBe(true)
    expect(again.state.lastAcceptedAt).toBe(1_000 + SCAN_REPEAT_COOLDOWN_MS)
  })

  it('accepts a different value immediately, with no gap and no cooldown', () => {
    const first = observeScan(createScanStreamState(), 'CARTON-1', 1_000)
    const other = observeScan(first.state, 'CARTON-2', 1_010)

    expect(other.accepted).toBe(true)
    expect(other.state.lastValue).toBe('CARTON-2')
    expect(other.state.lastAcceptedAt).toBe(1_010)
  })

  it('rejects the previous value again right after switching to a different one', () => {
    const first = observeScan(createScanStreamState(), 'CARTON-1', 1_000)
    const other = observeScan(first.state, 'CARTON-2', 1_010)
    const back = observeScan(other.state, 'CARTON-1', 1_020)

    // Different from the last accepted value, so the operator did move the
    // camera onto another label — it counts.
    expect(back.accepted).toBe(true)
  })

  it('counts every one of twenty identical cartons scanned in a row', () => {
    let state = createScanStreamState()
    let accepted = 0
    let now = 0

    for (let carton = 0; carton < 20; carton += 1) {
      // The operator swings the camera away between cartons: the frame goes
      // properly empty first, then the next identical label comes into it.
      state = leaveTheFrame(state, observeEmptyFrame)
      now += SCAN_REPEAT_COOLDOWN_MS + 100
      const result = observeScan(state, 'CARTON-SAME', now)
      if (result.accepted) accepted += 1
      state = result.state
    }

    expect(accepted).toBe(20)
  })

  it('does not count one carton twice because a single tick failed to decode it', () => {
    // Blur, glare and a hand crossing the lens all decode to nothing, which is
    // indistinguishable from the carton having left. One such tick while the
    // operator is still holding the same carton must not re-arm the count —
    // that would silently receive stock that never arrived.
    const first = observeScan(createScanStreamState(), 'CARTON-1', 1_000)
    const blurred = observeEmptyFrame(first.state)
    const stillTheSameCarton = observeScan(blurred, 'CARTON-1', 1_000 + SCAN_REPEAT_COOLDOWN_MS + 10)

    expect(stillTheSameCarton.accepted).toBe(false)
  })

  it('never re-arms on blur that keeps being broken up by successful decodes', () => {
    // A carton held in front of a struggling camera: decode, blur, decode, blur.
    // The empty ticks never run consecutively, so the frame never counts as clear.
    let state = observeScan(createScanStreamState(), 'CARTON-1', 1_000).state
    let accepted = 0
    let now = 1_000

    for (let pass = 0; pass < 40; pass += 1) {
      state = observeEmptyFrame(state)
      now += 200
      const result = observeScan(state, 'CARTON-1', now)
      if (result.accepted) accepted += 1
      state = result.state
    }

    expect(accepted).toBe(0)
  })

  it('counts the same carton again once the frame has actually stayed empty', () => {
    const first = observeScan(createScanStreamState(), 'CARTON-1', 1_000)
    const cleared = leaveTheFrame(first.state, observeEmptyFrame)

    expect(observeScan(cleared, 'CARTON-1', 1_000 + SCAN_REPEAT_COOLDOWN_MS + 10).accepted).toBe(true)
  })

  it('clears the frame after EMPTY_TICKS_TO_CLEAR consecutive empty ticks, not before', () => {
    let state = observeScan(createScanStreamState(), 'CARTON-1', 1_000).state
    const later = 1_000 + SCAN_REPEAT_COOLDOWN_MS + 10

    for (let tick = 1; tick < EMPTY_TICKS_TO_CLEAR; tick += 1) {
      state = observeEmptyFrame(state)
      expect(observeScan(state, 'CARTON-1', later).accepted).toBe(false)
    }

    state = observeEmptyFrame(state)

    expect(observeScan(state, 'CARTON-1', later).accepted).toBe(true)
  })

  it('does not count a code that simply stays in frame across many ticks', () => {
    let state = createScanStreamState()
    let accepted = 0

    for (let tick = 0; tick < 50; tick += 1) {
      const result = observeScan(state, 'CARTON-HELD', tick * 100)
      if (result.accepted) accepted += 1
      state = result.state
    }

    expect(accepted).toBe(1)
  })

  it('remembers a gap seen while a repeat was still cooling down', () => {
    // The carton left the frame and came straight back. The gap happened, so
    // once the cooldown elapses the re-presentation must count.
    const first = observeScan(createScanStreamState(), 'CARTON-1', 1_000)
    const cleared = leaveTheFrame(first.state, observeEmptyFrame)
    const tooSoon = observeScan(cleared, 'CARTON-1', 1_100)
    const afterCooldown = observeScan(tooSoon.state, 'CARTON-1', 1_000 + SCAN_REPEAT_COOLDOWN_MS + 10)

    expect(tooSoon.accepted).toBe(false)
    expect(afterCooldown.accepted).toBe(true)
  })

  it('leaves the state untouched when a rejected repeat is observed', () => {
    const first = observeScan(createScanStreamState(), 'CARTON-1', 1_000)
    const rejected = observeScan(first.state, 'CARTON-1', 1_050)

    expect(rejected.state).toEqual(first.state)
  })

  it('treats an empty frame before anything was scanned as a no-op', () => {
    const initial = createScanStreamState()

    expect(observeEmptyFrame(initial)).toEqual(initial)
  })

  it('never mutates the state handed to it', () => {
    const initial = createScanStreamState()
    const accepted = observeScan(initial, 'CARTON-1', 1_000)

    expect(initial).toEqual({ lastValue: null, lastAcceptedAt: 0, sawGap: true, emptyTicks: 0 })

    const beforeGap = { ...accepted.state }
    observeEmptyFrame(accepted.state)

    expect(accepted.state).toEqual(beforeGap)
  })

  it('pins the two guards it is tuned around', () => {
    expect(SCAN_REPEAT_COOLDOWN_MS).toBe(900)
    expect(EMPTY_TICKS_TO_CLEAR).toBe(3)
  })
})
