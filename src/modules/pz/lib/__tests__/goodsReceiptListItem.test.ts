import { describe, expect, it } from '@jest/globals'
import {
  toGoodsReceiptListItem,
  toIsoDay,
  type GoodsReceiptListRow,
} from '../goodsReceiptListItem'

function row(overrides: Partial<GoodsReceiptListRow> = {}): GoodsReceiptListRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    document_number: 'PZ/1/2026',
    document_date: '2026-01-31',
    supplier_name: 'Hurtownia Kowalski',
    warehouse_id: '22222222-2222-4222-8222-222222222222',
    warehouse_snapshot: null,
    status: 'draft',
    stock_posting_status: null,
    stock_posted_at: null,
    stock_posting_error: null,
    stock_posting_location_id: null,
    updated_at: '2026-01-31T10:15:00.000Z',
    ...overrides,
  }
}

describe('toIsoDay', () => {
  it('keeps a calendar day exactly as stored', () => {
    expect(toIsoDay('2026-01-31')).toBe('2026-01-31')
  })

  it('returns null rather than a fabricated day for unusable input', () => {
    expect(toIsoDay(null)).toBeNull()
    expect(toIsoDay('not a date')).toBeNull()
  })
})

describe('toGoodsReceiptListItem', () => {
  it('serialises the row the index renders', () => {
    expect(toGoodsReceiptListItem(row())).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      documentNumber: 'PZ/1/2026',
      documentDate: '2026-01-31',
      supplierName: 'Hurtownia Kowalski',
      warehouseId: '22222222-2222-4222-8222-222222222222',
      warehouseSnapshot: null,
      status: 'draft',
      stockPosting: { status: 'not_applicable', postedAt: null, reason: null, locationId: null },
      lineCount: 0,
      palletCount: 0,
      lines: null,
      updatedAt: '2026-01-31T10:15:00.000Z',
    })
  })

  it('reports lines as not loaded on a grid row, which is not the same as having none', () => {
    expect(toGoodsReceiptListItem(row()).lines).toBeNull()
  })

  it('projects updatedAt, because dropping it silently disables optimistic locking', () => {
    expect(toGoodsReceiptListItem(row()).updatedAt).toBe('2026-01-31T10:15:00.000Z')
  })

  it('preserves receiving and narrows an unexpected status to draft', () => {
    expect(toGoodsReceiptListItem(row({ status: 'whatever' })).status).toBe('draft')
    expect(toGoodsReceiptListItem(row({ status: 'receiving' })).status).toBe('receiving')
    expect(toGoodsReceiptListItem(row({ status: 'confirmed' })).status).toBe('confirmed')
  })

  it('starts the pallet count at zero for the route to fill from its grouped query', () => {
    expect(toGoodsReceiptListItem(row()).palletCount).toBe(0)
  })

  it('reports the stock posting, narrowing a status or reason it does not know to a safe one', () => {
    expect(
      toGoodsReceiptListItem(
        row({
          stock_posting_status: 'failed',
          stock_posting_error: 'destination_unusable',
          stock_posting_location_id: '33333333-3333-4333-8333-333333333333',
          stock_posted_at: null,
        }),
      ).stockPosting,
    ).toEqual({
      status: 'failed',
      postedAt: null,
      reason: 'destination_unusable',
      locationId: '33333333-3333-4333-8333-333333333333',
    })
    const unknown = toGoodsReceiptListItem(
      row({ stock_posting_status: 'whatever', stock_posting_error: 'whatever' }),
    ).stockPosting
    expect(unknown.status).toBe('not_applicable')
    expect(unknown.reason).toBeNull()
  })

  it('drops a warehouse snapshot that does not carry both name and code', () => {
    const partial = { name: 'Main' } as unknown as GoodsReceiptListRow['warehouse_snapshot']
    expect(toGoodsReceiptListItem(row({ warehouse_snapshot: partial })).warehouseSnapshot).toBeNull()
    expect(
      toGoodsReceiptListItem(row({ warehouse_snapshot: { name: 'Main', code: 'MAIN' } })).warehouseSnapshot,
    ).toEqual({ name: 'Main', code: 'MAIN' })
  })
})
