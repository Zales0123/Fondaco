/**
 * Accept/reject rule for a scanner that stays on, feeding one decode per poll
 * tick instead of firing once and stopping.
 *
 * The obvious rule — "ignore the same value for N milliseconds" — is wrong
 * here. Counting a delivery onto a pallet means scanning twenty identical
 * cartons in a row, and every one of them has to count, so a time-based
 * de-duplication would quietly drop most of the pallet.
 *
 * The rule below mirrors the physical motion instead: the operator swings the
 * camera to the next carton, which means the previous code leaves the frame.
 * A decode of a *different* value is therefore always a new item, while the
 * *same* value only counts again once the camera has actually seen an empty
 * frame and enough time has passed for a human hand to have moved.
 *
 * "An empty frame" has to mean a *sustained* one. A single tick that decodes
 * nothing is indistinguishable from blur, glare or a hand crossing the lens,
 * and treating one of those as departure would count a carton that never left
 * — receiving stock that never arrived, silently. So the frame only counts as
 * clear after several consecutive empty ticks, and any decode in between
 * resets that run: an intermittently readable label never adds up to a gap.
 *
 * Deliberately free of React and the DOM: this is where the behaviour is
 * tested, and the dialog only threads ticks through it.
 */

/**
 * Minimum time between two accepted scans of the same value. Roughly the
 * fastest a hand moves one carton out and the next one in; shorter than that
 * and a single flickering decode would count twice.
 */
export const SCAN_REPEAT_COOLDOWN_MS = 900

/**
 * Consecutive ticks that must decode nothing before the frame counts as clear.
 * Tuned against the dialog's 100ms poll, so this is roughly a third of a second
 * of genuinely seeing nothing — longer than any single blurred frame, shorter
 * than the time it takes to bring the next carton up.
 *
 * The two guards protect against opposite mistakes and are both needed: this
 * one stops one carton counting twice, the cooldown stops a flickering decode
 * counting twice, and neither slows down an operator working at a human pace.
 */
export const EMPTY_TICKS_TO_CLEAR = 3

export type ScanStreamState = {
  /** Last value that was accepted, or `null` before the first scan. */
  lastValue: string | null
  /** Timestamp of the last acceptance, on the caller's clock. */
  lastAcceptedAt: number
  /** Whether the frame has been observed genuinely clear since that acceptance. */
  sawGap: boolean
  /** How many ticks in a row have decoded nothing, reset by any decode. */
  emptyTicks: number
}

export function createScanStreamState(): ScanStreamState {
  // `sawGap` starts true because nothing has been accepted yet, so there is no
  // previous code that could still be sitting in the frame.
  return { lastValue: null, lastAcceptedAt: 0, sawGap: true, emptyTicks: 0 }
}

/**
 * A poll tick that decoded nothing. Only a run of these means the code left the
 * frame; one on its own is far more likely to be a bad look at a label that is
 * still there.
 *
 * Once the run is long enough the flag is sticky until the next acceptance —
 * the gap happened whether or not the operator brought the label back before
 * the cooldown ran out, and forgetting it would strand a genuine
 * re-presentation.
 */
export function observeEmptyFrame(state: ScanStreamState): ScanStreamState {
  if (state.sawGap) return state
  const emptyTicks = state.emptyTicks + 1
  return { ...state, emptyTicks, sawGap: emptyTicks >= EMPTY_TICKS_TO_CLEAR }
}

/**
 * A poll tick that decoded `value`. Returns whether it counts as a scan, plus
 * the state the caller should keep. A rejected tick leaves the state alone.
 */
export function observeScan(
  state: ScanStreamState,
  value: string,
  now: number,
): { accepted: boolean; state: ScanStreamState } {
  // Something was decoded, so whatever run of empty ticks was building up was
  // not the code leaving the frame. A rejected repeat still clears it.
  const seen = state.emptyTicks === 0 ? state : { ...state, emptyTicks: 0 }
  const isRepeat = seen.lastValue === value
  if (isRepeat) {
    const leftTheFrame = seen.sawGap
    const cooledDown = now - seen.lastAcceptedAt >= SCAN_REPEAT_COOLDOWN_MS
    if (!leftTheFrame || !cooledDown) return { accepted: false, state: seen }
  }
  return {
    accepted: true,
    state: { lastValue: value, lastAcceptedAt: now, sawGap: false, emptyTicks: 0 },
  }
}
