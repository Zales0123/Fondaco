import { describe, expect, it } from '@jest/globals'
import {
  toIsoDay,
  toPurchaseOrderLineItem,
  toPurchaseOrderListItem,
  toPurchaseOrderStatus,
  type PurchaseOrderLineRow,
  type PurchaseOrderListRow,
} from '../purchaseOrderListItem'

const ORDER_ID = '44444444-4444-4444-8444-444444444444'

function listRow(overrides: Partial<PurchaseOrderListRow> = {}): PurchaseOrderListRow {
  return {
    id: ORDER_ID,
    document_number: 'ZZ/1/2026',
    order_date: '2026-09-19',
    expected_date: null,
    supplier_id: null,
    supplier_name: 'Hurtownia Kowalski',
    supplier_snapshot: null,
    warehouse_id: '33333333-3333-4333-8333-333333333333',
    warehouse_snapshot: null,
    currency_code: 'PLN',
    status: 'draft',
    notes: null,
    updated_at: '2026-09-19T08:00:00.000Z',
    ...overrides,
  }
}

function lineRow(overrides: Partial<PurchaseOrderLineRow> = {}): PurchaseOrderLineRow {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    purchase_order_id: ORDER_ID,
    line_number: 1,
    catalog_product_id: '11111111-1111-4111-8111-111111111111',
    catalog_variant_id: '66666666-6666-4666-8666-666666666666',
    catalog_snapshot: { name: 'Śruba M8', sku: 'SRU-M8' },
    quantity_ordered: '12.5000',
    unit: 'szt.',
    uom_snapshot: { code: 'szt.', productDefaultUnit: 'szt.' },
    unit_price_net: '3.3300',
    expected_date: '2026-10-01',
    ...overrides,
  }
}

describe('toIsoDay', () => {
  it('passes a calendar day through untouched', () => {
    expect(toIsoDay('2026-09-19')).toBe('2026-09-19')
  })

  it('reduces a timestamp to its day rather than dropping it', () => {
    expect(toIsoDay(new Date('2026-09-19T22:30:00.000Z'))).toBe('2026-09-19')
  })

  it('reports an unreadable value as absent', () => {
    expect(toIsoDay('not a date')).toBeNull()
    expect(toIsoDay(null)).toBeNull()
  })
})

describe('toPurchaseOrderStatus', () => {
  it('maps the known statuses', () => {
    expect(toPurchaseOrderStatus('released')).toBe('released')
    expect(toPurchaseOrderStatus('cancelled')).toBe('cancelled')
  })

  it('treats anything unknown as a draft rather than inventing a status', () => {
    expect(toPurchaseOrderStatus('received')).toBe('draft')
    expect(toPurchaseOrderStatus(null)).toBe('draft')
  })
})

describe('toPurchaseOrderLineItem', () => {
  it('computes the line value exactly', () => {
    expect(toPurchaseOrderLineItem(lineRow()).netValue).toBe('41.63')
  })

  it('keeps quantities and prices as strings', () => {
    const item = toPurchaseOrderLineItem(lineRow({ quantity_ordered: 12.5, unit_price_net: 3.33 }))
    expect(item.quantityOrdered).toBe('12.5')
    expect(item.unitPriceNet).toBe('3.33')
  })

  it('reports an unreadable value rather than a plausible zero', () => {
    expect(toPurchaseOrderLineItem(lineRow({ unit_price_net: 'n/a' })).netValue).toBeNull()
  })
})

describe('toPurchaseOrderListItem', () => {
  it('leaves the aggregates unresolved so a missing one cannot read as an empty order', () => {
    const item = toPurchaseOrderListItem(listRow())
    expect(item.lineCount).toBe(0)
    expect(item.netTotal).toBeNull()
    expect(item.lines).toBeNull()
  })

  it('keeps a snapshot only when it is complete', () => {
    expect(toPurchaseOrderListItem(listRow({ warehouse_snapshot: { name: 'Main', code: 'MAIN' } })).warehouseSnapshot)
      .toEqual({ name: 'Main', code: 'MAIN' })
    expect(
      toPurchaseOrderListItem(listRow({ warehouse_snapshot: { name: 'Main' } as never })).warehouseSnapshot,
    ).toBeNull()
  })

  it('accepts a supplier snapshot without a code, which is all stage 1 can capture', () => {
    expect(toPurchaseOrderListItem(listRow({ supplier_snapshot: { name: 'Kowalski', code: null } })).supplierSnapshot)
      .toEqual({ name: 'Kowalski', code: null })
  })
})
