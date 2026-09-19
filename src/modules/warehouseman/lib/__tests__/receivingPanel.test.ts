import { describe, expect, it } from '@jest/globals'
import {
  buildReceivingListQuery,
  describePalletLookupFailure,
  describePalletPrintOutcome,
  formatCountQuantity,
  normalizeScannedCode,
  parseCountQuantity,
  receivingPalletHref,
  receivingReceiptHref,
  productLabel,
  receivingSummaryHref,
  resolveApiMessage,
} from '../receivingPanel'

describe('receiving hrefs', () => {
  it('nests a pallet under its goods receipt', () => {
    expect(receivingReceiptHref('rec-1')).toBe('/warehouseman/receiving/rec-1')
    expect(receivingPalletHref('rec-1', 'pal-2')).toBe('/warehouseman/receiving/rec-1/pallets/pal-2')
    expect(receivingSummaryHref('rec-1')).toBe('/warehouseman/receiving/rec-1/summary')
  })

  it('escapes ids so a stray separator cannot forge a path', () => {
    expect(receivingReceiptHref('a/b')).toBe('/warehouseman/receiving/a%2Fb')
  })
})

describe('buildReceivingListQuery', () => {
  it('always asks for the released documents only', () => {
    expect(buildReceivingListQuery(null)).toEqual({ status: 'receiving', pageSize: '50' })
  })

  it('narrows to a warehouse when one is chosen', () => {
    expect(buildReceivingListQuery('wh-1')).toEqual({
      status: 'receiving',
      pageSize: '50',
      warehouseId: 'wh-1',
    })
  })
})

describe('normalizeScannedCode', () => {
  it('drops what a scanner appends', () => {
    expect(normalizeScannedCode('  PAL-000042\r\n')).toBe('PAL-000042')
  })

  it('reports an empty scan as empty', () => {
    expect(normalizeScannedCode('   ')).toBe('')
  })

  it('cleans a camera decode the same way it cleans a typed code', () => {
    // The camera hands back the raw decoded value, padding and all, and the scan path
    // feeds it through here before the lookup — so both paths ask for the same code.
    expect(normalizeScannedCode(' PAL-000042 ')).toBe('PAL-000042')
    expect(normalizeScannedCode('PAL\n000042')).toBe('PAL 000042')
    expect(normalizeScannedCode('\t\n')).toBe('')
  })
})

describe('parseCountQuantity', () => {
  it('canonicalises to the stored scale', () => {
    expect(parseCountQuantity('12')).toBe('12.0000')
    expect(parseCountQuantity('2.5')).toBe('2.5000')
    expect(parseCountQuantity('007')).toBe('7.0000')
  })

  it('accepts the decimal comma a Polish keyboard produces', () => {
    expect(parseCountQuantity('2,5')).toBe('2.5000')
  })

  it('refuses anything that is not a positive quantity', () => {
    expect(parseCountQuantity('')).toBeNull()
    expect(parseCountQuantity('0')).toBeNull()
    expect(parseCountQuantity('0,0')).toBeNull()
    expect(parseCountQuantity('-3')).toBeNull()
    expect(parseCountQuantity('1e3')).toBeNull()
    expect(parseCountQuantity('abc')).toBeNull()
  })

  it('refuses more precision than the column carries', () => {
    expect(parseCountQuantity('1.00001')).toBeNull()
  })
})

describe('formatCountQuantity', () => {
  it('hides storage precision from the floor', () => {
    expect(formatCountQuantity('12.0000')).toBe('12')
    expect(formatCountQuantity('2.5000')).toBe('2.5')
  })

  it('leaves a value it does not recognise alone', () => {
    expect(formatCountQuantity('12')).toBe('12')
  })
})

describe('resolveApiMessage', () => {
  it('prefers the server message, which is already localized', () => {
    expect(resolveApiMessage({ error: 'Paleta należy do PZ/13/2026.' }, 'fallback'))
      .toBe('Paleta należy do PZ/13/2026.')
  })

  it('falls back when the response says nothing', () => {
    expect(resolveApiMessage({ error: '  ' }, 'fallback')).toBe('fallback')
    expect(resolveApiMessage(null, 'fallback')).toBe('fallback')
    expect(resolveApiMessage({}, 'fallback')).toBe('fallback')
  })
})

describe('productLabel', () => {
  it('treats an empty name the same as a missing one', () => {
    expect(productLabel('', 'unknown')).toBe('unknown')
    expect(productLabel('   ', 'unknown')).toBe('unknown')
    expect(productLabel(null, 'unknown')).toBe('unknown')
  })

  it('keeps a real name', () => {
    expect(productLabel('Kabel USB-C 2m', 'unknown')).toBe('Kabel USB-C 2m')
  })
})

describe('describePalletPrintOutcome', () => {
  const messages = {
    success: 'The pallet label is printing.',
    failure: (reason: string) => `The pallet is there, the label is not: ${reason}`,
    unknownReason: 'The printer did not say why.',
  }

  it('reports a printed label as a success', () => {
    expect(describePalletPrintOutcome(null, messages)).toEqual({
      kind: 'success',
      message: 'The pallet label is printing.',
    })
  })

  it('frames the printer refusal, which the server already localized', () => {
    const busy = Object.assign(new Error('Drukarka etykiet jest zajęta.'), { status: 409 })
    expect(describePalletPrintOutcome(busy, messages)).toEqual({
      kind: 'warning',
      message: 'The pallet is there, the label is not: Drukarka etykiet jest zajęta.',
    })
  })

  it('falls back when the refusal says nothing', () => {
    expect(describePalletPrintOutcome(Object.assign(new Error(''), { status: 503 }), messages)).toEqual({
      kind: 'warning',
      message: 'The pallet is there, the label is not: The printer did not say why.',
    })
    expect(describePalletPrintOutcome('printer exploded', messages)).toEqual({
      kind: 'warning',
      message: 'The pallet is there, the label is not: The printer did not say why.',
    })
  })

  it('never reports the pallet itself as failed', () => {
    // A printer that is off, busy, faulty or has nothing to print is still only ever a
    // warning about the sticker: the pallet was committed before the print was attempted.
    for (const status of [409, 422, 500, 502, 503]) {
      const outcome = describePalletPrintOutcome(
        Object.assign(new Error('Printer is off.'), { status }),
        messages,
      )
      expect(outcome.kind).toBe('warning')
      expect(outcome.message).toBe('The pallet is there, the label is not: Printer is off.')
    }
  })
})

describe('describePalletLookupFailure', () => {
  const messages = { notFound: 'No pallet has code PAL-000042.', failed: 'Could not open the pallet.' }

  it('names the code nobody has', () => {
    expect(describePalletLookupFailure(Object.assign(new Error(''), { status: 404 }), messages))
      .toBe('No pallet has code PAL-000042.')
  })

  it('keeps refusing a pallet that belongs to another document, by name', () => {
    const other = Object.assign(new Error('Paleta należy do PZ/13/2026.'), { status: 409 })
    expect(describePalletLookupFailure(other, messages)).toBe('Paleta należy do PZ/13/2026.')
  })

  it('prefers the server text over the caller fallback whenever there is one', () => {
    const denied = Object.assign(new Error('Brak uprawnień.'), { status: 403 })
    expect(describePalletLookupFailure(denied, messages)).toBe('Brak uprawnień.')
  })

  it('falls back when the failure says nothing at all', () => {
    expect(describePalletLookupFailure(new Error(''), messages)).toBe('Could not open the pallet.')
    expect(describePalletLookupFailure(undefined, messages)).toBe('Could not open the pallet.')
  })
})
