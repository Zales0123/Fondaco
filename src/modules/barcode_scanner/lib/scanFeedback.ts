/**
 * Non-visual confirmation that a scan was counted.
 *
 * In continuous mode the operator looks at the pallet, not at the screen, so a
 * blip and a buzz are what actually tells them the carton landed. Both are
 * best-effort: a laptop has no vibration motor, Safari refuses to start an
 * audio graph outside a user gesture, and a corporate policy can block either.
 * None of that may interrupt counting, so each channel is guarded on its own
 * and this module never throws.
 */

/** Well inside the range a phone speaker reproduces clearly in a noisy hall. */
const BLIP_FREQUENCY_HZ = 880

/** Long enough to hear over a warehouse, short enough to scan at speed. */
const BLIP_DURATION_SECONDS = 0.06

/** Quiet by design — it is a confirmation, not an alarm. */
const BLIP_PEAK_GAIN = 0.08

/** A square-edged gain step clicks audibly; a few milliseconds of ramp does not. */
const BLIP_ATTACK_SECONDS = 0.005

/** Short enough to feel like a tick rather than a notification buzz. */
const VIBRATION_MS = 40

/** Structural view of the slice of WebAudio this module touches. */
type AudioParamLike = {
  setValueAtTime(value: number, startTime: number): unknown
  linearRampToValueAtTime?(value: number, endTime: number): unknown
  exponentialRampToValueAtTime?(value: number, endTime: number): unknown
}

type AudioContextLike = {
  currentTime: number
  state?: string
  destination: unknown
  resume?: () => Promise<void>
  createOscillator(): {
    type: string
    frequency: AudioParamLike
    connect(destination: unknown): unknown
    start(when: number): unknown
    stop(when: number): unknown
  }
  createGain(): {
    gain: AudioParamLike
    connect(destination: unknown): unknown
  }
}

/** Returns a context, or `null` where the browser exposes no WebAudio at all. */
export type AudioContextFactory = () => AudioContextLike | null

type AudioContextCtor = new () => AudioContextLike

// Browsers cap how many AudioContexts a page may hold (Chrome stops at six),
// and a pallet run fires hundreds of scans — so one context is created lazily
// on the first blip and reused for the rest of the session.
let sharedContext: AudioContextLike | null = null

function defaultAudioContextFactory(): AudioContextLike | null {
  const scope = globalThis as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  const ctor = scope.AudioContext ?? scope.webkitAudioContext
  if (!ctor) return null
  return new ctor()
}

function blip(createAudioContext: AudioContextFactory): void {
  const context = sharedContext ?? createAudioContext()
  if (!context) return
  sharedContext = context

  // Safari and Chrome park the graph until a user gesture unlocks it. Opening
  // the scanner is that gesture, but the first blip can still land while the
  // context is catching up, so nudge it and carry on regardless.
  if (context.state === 'suspended' && typeof context.resume === 'function') {
    void Promise.resolve(context.resume()).catch(() => {})
  }

  const startedAt = context.currentTime
  const endsAt = startedAt + BLIP_DURATION_SECONDS
  const oscillator = context.createOscillator()
  const gain = context.createGain()

  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(BLIP_FREQUENCY_HZ, startedAt)

  gain.gain.setValueAtTime(0, startedAt)
  gain.gain.linearRampToValueAtTime?.(BLIP_PEAK_GAIN, startedAt + BLIP_ATTACK_SECONDS)
  // Exponential ramps cannot reach zero, hence the near-silent floor.
  gain.gain.exponentialRampToValueAtTime?.(0.0001, endsAt)

  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start(startedAt)
  oscillator.stop(endsAt)
}

function buzz(): void {
  const vibrate = (globalThis as { navigator?: { vibrate?: (pattern: number) => boolean } })
    .navigator?.vibrate
  if (typeof vibrate !== 'function') return
  vibrate.call(globalThis.navigator, VIBRATION_MS)
}

/**
 * Confirms one accepted scan. Safe to call on every scan and in any browser:
 * a missing or failing channel is skipped, never surfaced.
 *
 * The audio context factory is injectable so both the silent path and the
 * sounding path can be exercised under jest's node environment, where no
 * WebAudio implementation exists.
 */
export function playScanFeedback(
  createAudioContext: AudioContextFactory = defaultAudioContextFactory,
): void {
  try {
    blip(createAudioContext)
  } catch {
    // No audio is a degraded scan, not a failed one — the vibration and the
    // on-screen flash still confirm the count.
  }
  try {
    buzz()
  } catch {
    // Same: a device that refuses to vibrate must not break counting.
  }
}

/**
 * Drops the cached audio context. Tests start each case from nothing with it;
 * production has no reason to call it, since the context is meant to outlive
 * any single scanning session.
 */
export function resetScanFeedback(): void {
  sharedContext = null
}
