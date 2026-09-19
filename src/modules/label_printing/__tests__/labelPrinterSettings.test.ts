import { describe, expect, it } from '@jest/globals'
import {
  resolveLabelPrinterSettings,
  type LabelPrinterSettings,
} from '../lib/labelPrinterSettings'

/** What the env preset supplies when the tab has never been filled in. */
const preset: LabelPrinterSettings = {
  portPath: '/dev/tty.preset',
  density: 3,
  labelType: 1,
  jobTimeoutMs: 60_000,
  geometry: { width: 384, height: 230 },
}

describe('resolveLabelPrinterSettings', () => {
  it('falls back to the env preset when nothing has been saved', () => {
    expect(resolveLabelPrinterSettings(null, preset)).toEqual(preset)
    expect(resolveLabelPrinterSettings({}, preset)).toEqual(preset)
  })

  it('lets the settings tab replace the printer the app talks to', () => {
    const resolved = resolveLabelPrinterSettings({ portPath: '/dev/tty.B1-SAVED' }, preset)
    expect(resolved.portPath).toBe('/dev/tty.B1-SAVED')
    // Untouched fields keep the preset rather than reverting to a hard-coded default.
    expect(resolved.density).toBe(3)
  })

  /**
   * The credentials form stores every field as a string — `CredentialFieldType` has no
   * number — so the numbers arrive as text and have to be read back as numbers.
   */
  it('reads the numeric fields back out of the strings the form stores', () => {
    const resolved = resolveLabelPrinterSettings(
      { density: '5', labelType: '2', jobTimeoutMs: '90000', labelWidth: '320', labelHeight: '200' },
      preset,
    )
    expect(resolved).toEqual({
      portPath: '/dev/tty.preset',
      density: 5,
      labelType: 2,
      jobTimeoutMs: 90_000,
      geometry: { width: 320, height: 200 },
    })
  })

  /**
   * A field somebody typed nonsense into must not take the printer down: the preset is
   * a working configuration, and silently keeping it beats refusing to print at all.
   */
  it('keeps the preset for a value that is not a usable number', () => {
    const resolved = resolveLabelPrinterSettings(
      { density: 'dark', labelType: '', jobTimeoutMs: '-1', labelWidth: '0', labelHeight: 'tall' },
      preset,
    )
    expect(resolved).toEqual(preset)
  })

  it('refuses a density the print head does not have', () => {
    // The B1 accepts 1-5. An out-of-range value is a typo, not an instruction.
    expect(resolveLabelPrinterSettings({ density: '9' }, preset).density).toBe(3)
    expect(resolveLabelPrinterSettings({ density: '0' }, preset).density).toBe(3)
    expect(resolveLabelPrinterSettings({ density: '1' }, preset).density).toBe(1)
  })

  /**
   * Blanking the field in the UI is how an operator says "no printer here", which is a
   * real answer and has to survive as one rather than falling back to the env preset.
   */
  it('treats a blanked port as switching printing off, not as unset', () => {
    expect(resolveLabelPrinterSettings({ portPath: '' }, preset).portPath).toBeNull()
    expect(resolveLabelPrinterSettings({ portPath: '   ' }, preset).portPath).toBeNull()
  })

  it('trims a port path pasted with stray whitespace', () => {
    expect(resolveLabelPrinterSettings({ portPath: '  /dev/tty.B1-X  ' }, preset).portPath)
      .toBe('/dev/tty.B1-X')
  })
})
