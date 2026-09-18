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
      lineCount: 0,
      updatedAt: '2026-01-31T10:15:00.000Z',
    })
  })

  it('projects updatedAt, because dropping it silently disables optimistic locking', () => {
    expect(toGoodsReceiptListItem(row()).updatedAt).toBe('2026-01-31T10:15:00.000Z')
  })

  it('narrows an unexpected status to draft instead of trusting the column', () => {
    expect(toGoodsReceiptListItem(row({ status: 'whatever' })).status).toBe('draft')
    expect(toGoodsReceiptListItem(row({ status: 'confirmed' })).status).toBe('confirmed')
  })

  it('drops a warehouse snapshot that does not carry both name and code', () => {
    const partial = { name: 'Main' } as unknown as GoodsReceiptListRow['warehouse_snapshot']
    expect(toGoodsReceiptListItem(row({ warehouse_snapshot: partial })).warehouseSnapshot).toBeNull()
    expect(
      toGoodsReceiptListItem(row({ warehouse_snapshot: { name: 'Main', code: 'MAIN' } })).warehouseSnapshot,
    ).toEqual({ name: 'Main', code: 'MAIN' })
  })
})
