import { describe, expect, it } from '@jest/globals'
import {
  buildFailedPostingsQuery,
  buildReceivingListQuery,
  describePalletLookupFailure,
  adjustScanQuantity,
  describePalletPrintOutcome,
  formatCountQuantity,
  normalizeScannedCode,
  parseCountQuantity,
  receivingPalletHref,
  receivingReceiptHref,
  productLabel,
  receivingSummaryHref,
  resolveApiMessage,
  resolveCountQuantity,
  suggestScanQuantity,
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

describe('buildFailedPostingsQuery', () => {
  it('asks only for the confirmed documents whose stock posting failed', () => {
    expect(buildFailedPostingsQuery(null)).toEqual({
      status: 'confirmed',
      stockPostingStatus: 'failed',
      pageSize: '20',
    })
  })

  it('narrows to a warehouse when one is chosen, like the document list does', () => {
    expect(buildFailedPostingsQuery('wh-1')).toEqual({
      status: 'confirmed',
      stockPostingStatus: 'failed',
      pageSize: '20',
      warehouseId: 'wh-1',
    })
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

describe('resolveCountQuantity', () => {
  it('reads a blank field as one unit, because the scan itself is the count', () => {
    // The camera adds a unit per scan and the quantity field is only a multiplier, so an
    // untouched field must not be the validation error `parseCountQuantity` makes of it.
    expect(resolveCountQuantity('')).toBe('1.0000')
    expect(resolveCountQuantity('   ')).toBe('1.0000')
    expect(resolveCountQuantity('\t\n')).toBe('1.0000')
  })

  it('keeps a typed multiplier exactly as the quantity parser reads it', () => {
    expect(resolveCountQuantity('1')).toBe('1.0000')
    expect(resolveCountQuantity('12')).toBe('12.0000')
    expect(resolveCountQuantity('2,5')).toBe('2.5000')
  })

  it('still refuses what is typed but is not a quantity', () => {
    expect(resolveCountQuantity('0')).toBeNull()
    expect(resolveCountQuantity('abc')).toBeNull()
    expect(resolveCountQuantity('-3')).toBeNull()
    expect(resolveCountQuantity('1.00001')).toBeNull()
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
    timedOutReason: 'The printer did not answer in time.',
  }

  /**
   * A timeout is the one failure the server never worded, so its message is the
   * browser's own untranslated English. Printing that to the floor would put
   * "The operation timed out." in front of a Polish warehouseman.
   */
  it('words a silent printer itself rather than leaking the abort message', () => {
    const timedOut = new DOMException('The operation timed out.', 'TimeoutError')
    expect(describePalletPrintOutcome(timedOut, messages)).toEqual({
      kind: 'warning',
      message: 'The pallet is there, the label is not: The printer did not answer in time.',
    })
  })

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

describe('adjustScanQuantity', () => {
  it('steps by one in both directions', () => {
    expect(adjustScanQuantity(1, 1)).toBe(2)
    expect(adjustScanQuantity(12, -1)).toBe(11)
  })

  it('steps by ten, so a pallet of forty-eight is not forty-seven taps', () => {
    expect(adjustScanQuantity(1, 10)).toBe(11)
    expect(adjustScanQuantity(48, -10)).toBe(38)
  })

  it('never goes below one, because a scan asserts the product is on the pallet', () => {
    // −10 from 3 is the ordinary way to reach this: the floor overshot and is coming back
    // down. Landing on 0 or −7 would offer a count the server is bound to refuse.
    expect(adjustScanQuantity(3, -10)).toBe(1)
    expect(adjustScanQuantity(1, -1)).toBe(1)
    expect(adjustScanQuantity(1, -10)).toBe(1)
  })
})

describe('suggestScanQuantity', () => {
  const line = {
    expected: '48.0000',
    countedAcrossDelivery: '0.0000',
    countedOnThisPalletThen: '0.0000',
    countedOnThisPalletNow: '0.0000',
  }

  it('opens on what the delivery ordered, so the ordinary pallet is scan then confirm', () => {
    expect(suggestScanQuantity(line)).toEqual({
      quantity: 48,
      expected: '48.0000',
      counted: '0.0000',
      outstanding: '48.0000',
    })
  })

  it('proposes only what is still missing once another pallet holds part of the line', () => {
    // 30 counted onto a pallet that is not this one. Re-proposing 48 here is how a delivery
    // gets confirmed at 78.
    const suggestion = suggestScanQuantity({ ...line, countedAcrossDelivery: '30.0000' })
    expect(suggestion.quantity).toBe(18)
    expect(suggestion.counted).toBe('30.0000')
    expect(suggestion.outstanding).toBe('18.0000')
  })

  it('reads this pallet live rather than from the snapshot it is already in', () => {
    // The comparison was read when 10 were on this pallet; 25 are on it now. Counting both
    // would propose 13 instead of 23 and quietly lose ten items.
    const suggestion = suggestScanQuantity({
      expected: '48.0000',
      countedAcrossDelivery: '10.0000',
      countedOnThisPalletThen: '10.0000',
      countedOnThisPalletNow: '25.0000',
    })
    expect(suggestion.quantity).toBe(23)
    expect(suggestion.counted).toBe('25.0000')
  })

  it('keeps the other pallets when this one has been emptied since the snapshot', () => {
    const suggestion = suggestScanQuantity({
      expected: '48.0000',
      countedAcrossDelivery: '30.0000',
      countedOnThisPalletThen: '12.0000',
      countedOnThisPalletNow: '0.0000',
    })
    expect(suggestion.quantity).toBe(30)
    expect(suggestion.counted).toBe('18.0000')
  })

  it('falls back to one once the line is counted in full, and says it is', () => {
    const suggestion = suggestScanQuantity({ ...line, countedOnThisPalletNow: '48.0000' })
    expect(suggestion.quantity).toBe(1)
    expect(suggestion.outstanding).toBe('0.0000')
    expect(suggestion.counted).toBe('48.0000')
  })

  it('never proposes a negative or zero count when the delivery is already over-counted', () => {
    const suggestion = suggestScanQuantity({ ...line, countedOnThisPalletNow: '60.0000' })
    expect(suggestion.quantity).toBe(1)
    expect(suggestion.outstanding).toBe('0.0000')
  })

  it('proposes one for a product no line of the delivery expected', () => {
    expect(suggestScanQuantity(null)).toEqual({
      quantity: 1,
      expected: null,
      counted: '0.0000',
      outstanding: null,
    })
    const surplus = suggestScanQuantity({ ...line, expected: null, countedOnThisPalletNow: '4.0000' })
    expect(surplus.quantity).toBe(1)
    expect(surplus.expected).toBeNull()
    expect(surplus.outstanding).toBeNull()
  })

  it('floors a fractional shortfall rather than proposing a count the stepper cannot show', () => {
    // The dial is whole items. 2.5 outstanding proposes 2 and reports the real figure beside
    // it, so a delivery written in a unit this screen cannot count stays visible.
    const fractional = suggestScanQuantity({ ...line, expected: '2.5000' })
    expect(fractional.quantity).toBe(2)
    expect(fractional.outstanding).toBe('2.5000')
    expect(suggestScanQuantity({ ...line, expected: '0.5000' }).quantity).toBe(1)
  })

  it('adds decimals without going through floats', () => {
    // 0.1 + 0.2 as JS numbers is 0.30000000000000004, which would make a matching delivery
    // short by a rounding error.
    const suggestion = suggestScanQuantity({
      expected: '0.3000',
      countedAcrossDelivery: '0.1000',
      countedOnThisPalletThen: '0.0000',
      countedOnThisPalletNow: '0.2000',
    })
    expect(suggestion.counted).toBe('0.3000')
    expect(suggestion.outstanding).toBe('0.0000')
  })
})
