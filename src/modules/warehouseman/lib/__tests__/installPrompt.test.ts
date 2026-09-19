import { describe, expect, it } from '@jest/globals'
import {
  isIosDevice,
  readInstallDismissed,
  resolveInstallAffordance,
  writeInstallDismissed,
  type InstallReadings,
} from '../installPrompt'

const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const IPAD_DESKTOP_MODE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const MAC_DESKTOP = IPAD_DESKTOP_MODE

function readings(overrides: Partial<InstallReadings> = {}): InstallReadings {
  return {
    userAgent: ANDROID_TABLET,
    maxTouchPoints: 5,
    displayStandalone: false,
    promptAvailable: false,
    dismissed: false,
    ...overrides,
  }
}

describe('isIosDevice', () => {
  it('recognises an iPhone', () => {
    expect(isIosDevice(IPHONE, 5)).toBe(true)
  })

  it('recognises an iPad pretending to be a Mac', () => {
    // iPadOS 13+ ships the desktop user agent; the touch points are the only tell.
    expect(isIosDevice(IPAD_DESKTOP_MODE, 5)).toBe(true)
  })

  it('does not mistake a real Mac for one', () => {
    expect(isIosDevice(MAC_DESKTOP, 0)).toBe(false)
  })

  it('does not mistake an Android tablet for one', () => {
    expect(isIosDevice(ANDROID_TABLET, 5)).toBe(false)
  })
})

describe('resolveInstallAffordance', () => {
  it('offers the real install dialog when the browser handed one over', () => {
    expect(resolveInstallAffordance(readings({ promptAvailable: true }))).toBe('prompt')
  })

  it('offers instructions on iOS, which fires no install event', () => {
    expect(resolveInstallAffordance(readings({ userAgent: IPHONE }))).toBe('ios-instructions')
  })

  it('offers nothing once the panel runs from the home screen', () => {
    expect(resolveInstallAffordance(readings({ displayStandalone: true, promptAvailable: true }))).toBe('none')
    expect(resolveInstallAffordance(readings({ displayStandalone: true, userAgent: IPHONE }))).toBe('none')
  })

  it('offers nothing after this device has said no', () => {
    expect(resolveInstallAffordance(readings({ dismissed: true, promptAvailable: true }))).toBe('none')
    expect(resolveInstallAffordance(readings({ dismissed: true, userAgent: IPHONE }))).toBe('none')
  })

  it('stays silent on a browser that offers no way to install', () => {
    // A button that cannot install anything is worse than no button.
    expect(resolveInstallAffordance(readings({ userAgent: MAC_DESKTOP, maxTouchPoints: 0 }))).toBe('none')
  })

  it('treats being installed as settled even if the device once declined', () => {
    expect(resolveInstallAffordance(readings({ displayStandalone: true, dismissed: true }))).toBe('none')
  })
})

describe('install dismissal storage', () => {
  it('reads and writes the flag', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }

    expect(readInstallDismissed(storage, 'k')).toBe(false)
    writeInstallDismissed(storage, 'k')
    expect(readInstallDismissed(storage, 'k')).toBe(true)
  })

  it('treats a missing storage as "not dismissed"', () => {
    expect(readInstallDismissed(null, 'k')).toBe(false)
    expect(() => writeInstallDismissed(null, 'k')).not.toThrow()
  })

  it('survives a storage that throws, as a locked-down Safari does', () => {
    const storage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    }

    expect(readInstallDismissed(storage, 'k')).toBe(false)
    expect(() => writeInstallDismissed(storage, 'k')).not.toThrow()
  })
})
