import { describe, expect, it } from '@jest/globals'
import {
  buildReceivingListQuery,
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
