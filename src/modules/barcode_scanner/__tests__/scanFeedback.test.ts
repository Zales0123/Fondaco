/**
 * The warehouseman is looking at the pallet, not at the screen, so the blip and
 * the buzz are the only confirmation a carton was counted. They must also be
 * completely optional: a desktop with no vibration motor, a browser with the
 * audio graph locked, or a `jsdom`-less test run must all survive untouched.
 * These tests pin "never throws" as hard as they pin "actually beeps".
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { playScanFeedback, resetScanFeedback } from '../lib/scanFeedback'

type ScheduledRamp = { value: number; at: number }

function fakeAudioContext() {
  const started: number[] = []
  const stopped: number[] = []
  const frequencies: ScheduledRamp[] = []
  const gainRamps: ScheduledRamp[] = []
  const connections: string[] = []
  const destination = { id: 'destination' }

  const oscillator = {
    type: '',
    frequency: {
      setValueAtTime: (value: number, at: number) => {
        frequencies.push({ value, at })
      },
    },
    connect: () => {
      connections.push('oscillator->gain')
    },
    start: (at: number) => {
      started.push(at)
    },
    stop: (at: number) => {
      stopped.push(at)
    },
  }

  const gain = {
    gain: {
      setValueAtTime: (value: number, at: number) => {
        gainRamps.push({ value, at })
      },
      linearRampToValueAtTime: (value: number, at: number) => {
        gainRamps.push({ value, at })
      },
      exponentialRampToValueAtTime: (value: number, at: number) => {
        gainRamps.push({ value, at })
      },
    },
    connect: () => {
      connections.push('gain->destination')
    },
  }

  const context = {
    currentTime: 10,
    state: 'running',
    destination,
    createOscillator: () => oscillator,
    createGain: () => gain,
    resume: () => Promise.resolve(),
  }

  return { context, oscillator, started, stopped, frequencies, gainRamps, connections }
}

function withNavigator<T>(value: unknown, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
  try {
    return run()
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
}

afterEach(() => {
  resetScanFeedback()
})

describe('playScanFeedback', () => {
  it('does nothing and throws nothing when the browser offers neither audio nor vibration', () => {
    withNavigator(undefined, () => {
      expect(() => playScanFeedback()).not.toThrow()
    })
  })

  it('plays a short blip through the injected audio context', () => {
    const fake = fakeAudioContext()

    withNavigator(undefined, () => {
      playScanFeedback(() => fake.context)
    })

    expect(fake.oscillator.type).toBe('sine')
    expect(fake.frequencies).toEqual([{ value: 880, at: 10 }])
    expect(fake.started).toEqual([10])
    expect(fake.stopped).toHaveLength(1)
    expect(fake.stopped[0]).toBeCloseTo(10.06, 5)
    expect(fake.connections).toEqual(['oscillator->gain', 'gain->destination'])
  })

  it('ramps the gain instead of switching it on, so the blip does not click', () => {
    const fake = fakeAudioContext()

    withNavigator(undefined, () => {
      playScanFeedback(() => fake.context)
    })

    expect(fake.gainRamps.length).toBeGreaterThanOrEqual(3)
    expect(fake.gainRamps[0]).toEqual({ value: 0, at: 10 })
    // The peak is reached after the start, and the tail decays back down.
    expect(fake.gainRamps[1].value).toBeGreaterThan(0)
    expect(fake.gainRamps[1].at).toBeGreaterThan(10)
    expect(fake.gainRamps[fake.gainRamps.length - 1].value).toBeLessThan(fake.gainRamps[1].value)
  })

  it('reuses one audio context across scans, because browsers cap how many exist', () => {
    const fake = fakeAudioContext()
    const factory = jest.fn(() => fake.context)

    withNavigator(undefined, () => {
      playScanFeedback(factory)
      playScanFeedback(factory)
      playScanFeedback(factory)
    })

    expect(factory).toHaveBeenCalledTimes(1)
    expect(fake.started).toHaveLength(3)
  })

  it('vibrates for 40ms when the device supports it', () => {
    const vibrate = jest.fn((pattern: number) => Boolean(pattern))
    const fake = fakeAudioContext()

    withNavigator({ vibrate }, () => {
      playScanFeedback(() => fake.context)
    })

    expect(vibrate).toHaveBeenCalledWith(40)
  })

  it('still beeps when vibration throws', () => {
    const fake = fakeAudioContext()

    withNavigator(
      {
        vibrate: () => {
          throw new Error('vibration is disabled')
        },
      },
      () => {
        expect(() => playScanFeedback(() => fake.context)).not.toThrow()
      },
    )

    expect(fake.started).toHaveLength(1)
  })

  it('still vibrates when the audio context cannot be created', () => {
    const vibrate = jest.fn((pattern: number) => Boolean(pattern))

    withNavigator({ vibrate }, () => {
      expect(() =>
        playScanFeedback(() => {
          throw new Error('AudioContext is not allowed here')
        }),
      ).not.toThrow()
    })

    expect(vibrate).toHaveBeenCalledWith(40)
  })

  it('survives a factory that reports no audio support at all', () => {
    const vibrate = jest.fn((pattern: number) => Boolean(pattern))

    withNavigator({ vibrate }, () => {
      expect(() => playScanFeedback(() => null)).not.toThrow()
    })

    expect(vibrate).toHaveBeenCalledWith(40)
  })

  it('survives an audio context that fails half way through building the graph', () => {
    const broken = {
      currentTime: 0,
      state: 'running',
      destination: {},
      createOscillator: () => {
        throw new Error('too many nodes')
      },
      createGain: () => ({}),
    }

    withNavigator(undefined, () => {
      expect(() => playScanFeedback(() => broken as never)).not.toThrow()
    })
  })

  it('resumes a context the browser suspended before the first user gesture', () => {
    const fake = fakeAudioContext()
    const resume = jest.fn(() => Promise.resolve())
    const suspended = { ...fake.context, state: 'suspended', resume }

    withNavigator(undefined, () => {
      playScanFeedback(() => suspended)
    })

    expect(resume).toHaveBeenCalled()
    expect(fake.started).toHaveLength(1)
  })
})
