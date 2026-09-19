/**
 * Deciding whether to offer "install this panel", and in which of the two shapes the
 * offer can take. Kept free of browser globals so the decision can be unit-tested —
 * the component around it only supplies readings and renders the answer.
 */

export type InstallAffordance =
  /** Offer nothing: already installed, already declined, or nothing to offer. */
  | 'none'
  /** Chromium captured a `beforeinstallprompt` event we can replay on a tap. */
  | 'prompt'
  /** iOS fires no such event, so the only honest offer is telling them where to tap. */
  | 'ios-instructions'

export type InstallReadings = {
  userAgent: string
  /** `navigator.maxTouchPoints` — the only thing that separates an iPad from a Mac. */
  maxTouchPoints: number
  /** Running from the home screen already, by display-mode or by iOS's own flag. */
  displayStandalone: boolean
  /** A `beforeinstallprompt` event has been captured and not yet used. */
  promptAvailable: boolean
  /** This device has already said no. */
  dismissed: boolean
}

export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  const ua = userAgent.toLowerCase()
  if (/iphone|ipad|ipod/.test(ua)) return true
  // iPadOS 13+ claims to be desktop Safari. The touch points are what give it away,
  // and a Mac reports none.
  return ua.includes('macintosh') && maxTouchPoints > 1
}

export function resolveInstallAffordance(readings: InstallReadings): InstallAffordance {
  // Checked first and separately from dismissal: an installed panel has nothing to
  // offer regardless of what the device once clicked away.
  if (readings.displayStandalone) return 'none'
  if (readings.dismissed) return 'none'
  if (readings.promptAvailable) return 'prompt'
  if (isIosDevice(readings.userAgent, readings.maxTouchPoints)) return 'ios-instructions'
  // A desktop browser, or a Chromium that has decided the panel is not installable
  // yet. Silence is right: an install button that cannot install is worse than none.
  return 'none'
}

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem'>

/**
 * Both accessors swallow their errors. Storage throws outright in a locked-down
 * Safari, and an install offer is never worth taking a warehouse screen down for —
 * the cost of guessing wrong is one card shown a second time.
 */
export function readInstallDismissed(storage: ReadableStorage | null, key: string): boolean {
  if (!storage) return false
  try {
    return storage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function writeInstallDismissed(storage: WritableStorage | null, key: string): void {
  if (!storage) return
  try {
    storage.setItem(key, '1')
  } catch {
    // Declined anyway for this session: the component drops the offer from its own
    // state regardless of whether the choice could be persisted.
  }
}
