import { describe, expect, it } from '@jest/globals'
import {
  buildExpectedContents,
  formatExpectedQuantity,
  resolveExpectedContents,
  type ReceivingExpectedLine,
} from '../expectedContents'

function line(overrides: Partial<ReceivingExpectedLine> = {}): ReceivingExpectedLine {
  return {
    id: 'line-1',
    lineNumber: 1,
    catalogVariantId: 'var-1',
    catalogSnapshot: { name: 'Śruba M8', sku: 'SRU-M8' },
    quantity: '12.0000',
    unit: 'szt',
    uomSnapshot: { code: 'szt', productDefaultUnit: 'szt' },
    ...overrides,
  }
}

describe('expected delivery contents', () => {
  it('reads the document in its own order, whatever order the rows arrive in', () => {
    const rows = buildExpectedContents([
      line({ id: 'line-3', lineNumber: 3, catalogSnapshot: { name: 'Nakrętka', sku: 'NAK' } }),
      line({ id: 'line-1', lineNumber: 1 }),
      line({ id: 'line-2', lineNumber: 2, catalogSnapshot: { name: 'Podkładka', sku: null } }),
    ])
    expect(rows.map((row) => row.id)).toEqual(['line-1', 'line-2', 'line-3'])
  })

  it('shows the quantity the document stores, without its storage precision', () => {
    const rows = buildExpectedContents([
      line({ id: 'a', lineNumber: 1, quantity: '12.0000' }),
      line({ id: 'b', lineNumber: 2, quantity: '1.5000' }),
      line({ id: 'c', lineNumber: 3, quantity: '0.2500' }),
    ])
    expect(rows.map((row) => row.quantity)).toEqual(['12', '1.5', '0.25'])
  })

  it('keeps every digit a numeric(18,4) can carry', () => {
    expect(formatExpectedQuantity('99999999999999.1234')).toBe('99999999999999.1234')
  })

  it('reads a bare decimal back with its leading zero', () => {
    expect(formatExpectedQuantity('.5000')).toBe('0.5')
  })

  it('answers an absent quantity with zero rather than an empty line', () => {
    expect(formatExpectedQuantity(null)).toBe('0')
    expect(formatExpectedQuantity('   ')).toBe('0')
  })

  it('falls back to the unit the product had when the line was saved', () => {
    const [withoutUnit] = buildExpectedContents([
      line({ unit: null, uomSnapshot: { code: 'kart', productDefaultUnit: 'szt' } }),
    ])
    expect(withoutUnit.unit).toBe('kart')

    const [withoutCode] = buildExpectedContents([
      line({ unit: '  ', uomSnapshot: { code: null, productDefaultUnit: 'szt' } }),
    ])
    expect(withoutCode.unit).toBe('szt')

    const [withNothing] = buildExpectedContents([line({ unit: null, uomSnapshot: null })])
    expect(withNothing.unit).toBeNull()
  })

  it('says a product is unnamed rather than showing a blank row', () => {
    const [unnamed] = buildExpectedContents([line({ catalogSnapshot: { name: '   ', sku: '' } })])
    expect(unnamed.name).toBeNull()
    expect(unnamed.sku).toBeNull()
  })

  it('keeps one product written on two lines as two lines', () => {
    const rows = buildExpectedContents([
      line({ id: 'a', lineNumber: 1, quantity: '4.0000' }),
      line({ id: 'b', lineNumber: 2, quantity: '6.0000' }),
    ])
    expect(rows.map((row) => row.quantity)).toEqual(['4', '6'])
  })
})

describe('what the screen is allowed to claim', () => {
  it('waits while the document is still loading', () => {
    expect(resolveExpectedContents({ loading: true, error: null, document: null })).toEqual({ kind: 'loading' })
  })

  it('never reports a delivery it could not read as an empty one', () => {
    expect(resolveExpectedContents({ loading: false, error: new Error('boom'), document: null }).kind).toBe('error')
    expect(resolveExpectedContents({ loading: false, error: null, document: null }).kind).toBe('error')
    expect(resolveExpectedContents({ loading: false, error: null, document: { lines: null } }).kind).toBe('error')
  })

  it('reports a document that really lists nothing as an empty list', () => {
    expect(resolveExpectedContents({ loading: false, error: null, document: { lines: [] } })).toEqual({
      kind: 'rows',
      rows: [],
    })
  })

  it('hands the screen the document lines once it has them', () => {
    const state = resolveExpectedContents({ loading: false, error: null, document: { lines: [line()] } })
    expect(state).toEqual({
      kind: 'rows',
      rows: [{ id: 'line-1', name: 'Śruba M8', sku: 'SRU-M8', quantity: '12', unit: 'szt' }],
    })
  })
})
