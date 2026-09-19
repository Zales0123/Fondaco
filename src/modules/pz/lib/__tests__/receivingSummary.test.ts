import { describe, expect, it } from '@jest/globals'
import {
  buildReceivingSummary,
  type ReceivingSummaryExpectedLine,
  type ReceivingSummaryPallet,
  type ReceivingSummaryPalletLine,
} from '../receivingSummary'

const CABLE = '11111111-1111-4111-8111-111111111111'
const CHARGER = '22222222-2222-4222-8222-222222222222'
const TAPE = '33333333-3333-4333-8333-333333333333'

const PALLET_A: ReceivingSummaryPallet = { id: 'pallet-a', code: 'PAL-000042', status: 'closed' }
const PALLET_B: ReceivingSummaryPallet = { id: 'pallet-b', code: 'PAL-000043', status: 'open' }

function expected(
  catalogVariantId: string,
  quantity: string,
  overrides: Partial<ReceivingSummaryExpectedLine> = {},
): ReceivingSummaryExpectedLine {
  return { catalogVariantId, quantity, unit: 'szt', name: catalogVariantId, sku: null, ...overrides }
}

function counted(
  pallet: ReceivingSummaryPallet,
  catalogVariantId: string,
  quantity: string,
  overrides: Partial<ReceivingSummaryPalletLine> = {},
): ReceivingSummaryPalletLine {
  return {
    palletId: pallet.id,
    palletCode: pallet.code,
    catalogVariantId,
    quantity,
    name: catalogVariantId,
    sku: null,
    ...overrides,
  }
}

function rowFor(summary: ReturnType<typeof buildReceivingSummary>, catalogVariantId: string) {
  const row = summary.items.find((item) => item.catalogVariantId === catalogVariantId)
  if (!row) throw new Error(`no row for ${catalogVariantId}`)
  return row
}

describe('buildReceivingSummary', () => {
  it('combines what was counted for one product across several pallets', () => {
    const summary = buildReceivingSummary({
      expectedLines: [expected(CABLE, '20.0000')],
      palletLines: [counted(PALLET_A, CABLE, '8.0000'), counted(PALLET_B, CABLE, '4.0000')],
      pallets: [PALLET_A, PALLET_B],
    })

    const row = rowFor(summary, CABLE)
    expect(row.counted).toBe('12.0000')
    expect(row.difference).toBe('-8.0000')
    expect(row.pallets).toEqual([
      { palletId: 'pallet-a', code: 'PAL-000042', quantity: '8.0000' },
      { palletId: 'pallet-b', code: 'PAL-000043', quantity: '4.0000' },
    ])
  })

  it('sums the expected side too, because one product may sit on two lines', () => {
    const summary = buildReceivingSummary({
      expectedLines: [expected(CABLE, '12.0000'), expected(CABLE, '8.0000')],
      palletLines: [counted(PALLET_A, CABLE, '20.0000')],
      pallets: [PALLET_A],
    })

    expect(rowFor(summary, CABLE).expected).toBe('20.0000')
    expect(rowFor(summary, CABLE).difference).toBe('0.0000')
  })

  it('reports a shortage as a negative difference and an over-count as a positive one', () => {
    const summary = buildReceivingSummary({
      expectedLines: [expected(CABLE, '20.0000'), expected(CHARGER, '10.0000')],
      palletLines: [counted(PALLET_A, CABLE, '12.0000'), counted(PALLET_A, CHARGER, '12.0000')],
      pallets: [PALLET_A],
    })

    expect(rowFor(summary, CABLE).difference).toBe('-8.0000')
    expect(rowFor(summary, CHARGER).difference).toBe('2.0000')
  })

  it('flags a counted product that no line expected as surplus', () => {
    const summary = buildReceivingSummary({
      expectedLines: [expected(CABLE, '20.0000')],
      palletLines: [counted(PALLET_A, TAPE, '6.0000')],
      pallets: [PALLET_A],
    })

    const row = rowFor(summary, TAPE)
    expect(row.surplus).toBe(true)
    expect(row.expected).toBeNull()
    expect(row.counted).toBe('6.0000')
    expect(row.difference).toBe('6.0000')
    expect(row.unit).toBeNull()
    expect(rowFor(summary, CABLE).surplus).toBe(false)
  })

  it('reports an expected product nobody counted as a full shortage', () => {
    const summary = buildReceivingSummary({
      expectedLines: [expected(CABLE, '20.0000')],
      palletLines: [],
      pallets: [],
    })

    expect(rowFor(summary, CABLE).counted).toBe('0.0000')
    expect(rowFor(summary, CABLE).difference).toBe('-20.0000')
  })

  it('orders shortages worst first, then surplus, then over-counts, then matching rows', () => {
    const summary = buildReceivingSummary({
      expectedLines: [
        expected(CABLE, '20.0000', { name: 'Cable' }),
        expected(CHARGER, '10.0000', { name: 'Charger' }),
        expected('44444444-4444-4444-8444-444444444444', '5.0000', { name: 'Match' }),
        expected('55555555-5555-4555-8555-555555555555', '30.0000', { name: 'Missing' }),
      ],
      palletLines: [
        counted(PALLET_A, CABLE, '12.0000', { name: 'Cable' }),
        counted(PALLET_A, CHARGER, '12.0000', { name: 'Charger' }),
        counted(PALLET_A, '44444444-4444-4444-8444-444444444444', '5.0000', { name: 'Match' }),
        counted(PALLET_A, '55555555-5555-4555-8555-555555555555', '5.0000', { name: 'Missing' }),
        counted(PALLET_A, TAPE, '6.0000', { name: 'Tape' }),
      ],
      pallets: [PALLET_A],
    })

    expect(summary.items.map((item) => item.name)).toEqual(['Missing', 'Cable', 'Tape', 'Charger', 'Match'])
  })

  it('breaks an equal difference by name so the order never depends on row arrival', () => {
    const summary = buildReceivingSummary({
      expectedLines: [expected(CHARGER, '10.0000', { name: 'Zeta' }), expected(CABLE, '10.0000', { name: 'Alpha' })],
      palletLines: [counted(PALLET_A, CHARGER, '8.0000', { name: 'Zeta' }), counted(PALLET_A, CABLE, '8.0000', { name: 'Alpha' })],
      pallets: [PALLET_A],
    })

    expect(summary.items.map((item) => item.name)).toEqual(['Alpha', 'Zeta'])
  })

  it('adds fractional quantities exactly, without a float round trip', () => {
    const summary = buildReceivingSummary({
      expectedLines: [expected(CABLE, '0.3000')],
      palletLines: [counted(PALLET_A, CABLE, '0.1000'), counted(PALLET_B, CABLE, '0.2000')],
      pallets: [PALLET_A, PALLET_B],
    })

    expect(rowFor(summary, CABLE).counted).toBe('0.3000')
    expect(rowFor(summary, CABLE).difference).toBe('0.0000')
  })

  it('takes the unit and the product naming from the document, falling back to the count', () => {
    const summary = buildReceivingSummary({
      expectedLines: [expected(CABLE, '20.0000', { name: 'Cable on the document', sku: '4411', unit: 'kart' })],
      palletLines: [counted(PALLET_A, CABLE, '12.0000', { name: 'Cable as counted', sku: '9999' })],
      pallets: [PALLET_A],
    })

    const row = rowFor(summary, CABLE)
    expect(row.name).toBe('Cable on the document')
    expect(row.sku).toBe('4411')
    expect(row.unit).toBe('kart')
  })

  it('totals both sides and counts the pallets by state', () => {
    const summary = buildReceivingSummary({
      expectedLines: [expected(CABLE, '20.0000'), expected(CHARGER, '10.0000')],
      palletLines: [counted(PALLET_A, CABLE, '12.0000'), counted(PALLET_B, CHARGER, '12.0000')],
      pallets: [PALLET_A, PALLET_B],
    })

    expect(summary.totals).toEqual({ expected: '30.0000', counted: '24.0000' })
    expect(summary.palletCount).toBe(2)
    expect(summary.palletsClosed).toBe(1)
    expect(summary.palletsOpen).toBe(1)
  })

  it('returns an empty summary when nothing has been counted against nothing', () => {
    const summary = buildReceivingSummary({ expectedLines: [], palletLines: [], pallets: [] })

    expect(summary.items).toEqual([])
    expect(summary.totals).toEqual({ expected: '0.0000', counted: '0.0000' })
    expect(summary.palletCount).toBe(0)
  })
})

describe('buildReceivingSummary totals per unit', () => {
  it('keeps cartons and pieces apart, because a sum of the two is true of nothing', () => {
    const summary = buildReceivingSummary({
      expectedLines: [
        { catalogVariantId: 'v1', quantity: '3', unit: 'carton', name: 'Boxed', sku: null },
        { catalogVariantId: 'v2', quantity: '5', unit: 'pcs', name: 'Loose', sku: null },
      ],
      palletLines: [
        { palletId: 'p1', palletCode: 'P-1', catalogVariantId: 'v1', quantity: '2', name: 'Boxed', sku: null },
        { palletId: 'p1', palletCode: 'P-1', catalogVariantId: 'v2', quantity: '5', name: 'Loose', sku: null },
      ],
      pallets: [{ id: 'p1', code: 'P-1', status: 'closed' }],
    })

    expect(summary.totalsByUnit).toEqual([
      { unit: 'carton', expected: '3.0000', counted: '2.0000' },
      { unit: 'pcs', expected: '5.0000', counted: '5.0000' },
    ])
  })

  it('groups the rows carrying no unit last, which is where surplus rows land', () => {
    const summary = buildReceivingSummary({
      expectedLines: [{ catalogVariantId: 'v1', quantity: '1', unit: 'pcs', name: 'Known', sku: null }],
      palletLines: [
        { palletId: 'p1', palletCode: 'P-1', catalogVariantId: 'v1', quantity: '1', name: 'Known', sku: null },
        { palletId: 'p1', palletCode: 'P-1', catalogVariantId: 'v9', quantity: '4', name: 'Surprise', sku: null },
      ],
      pallets: [{ id: 'p1', code: 'P-1', status: 'closed' }],
    })

    expect(summary.totalsByUnit.map((total) => total.unit)).toEqual(['pcs', null])
    expect(summary.totalsByUnit[1]).toEqual({ unit: null, expected: '0.0000', counted: '4.0000' })
  })
})
