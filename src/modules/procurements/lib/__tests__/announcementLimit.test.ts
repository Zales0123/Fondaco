import { describe, expect, it } from '@jest/globals'
import { announcementLimit, checkReservations, type AnnouncementLimit } from '../announcementLimit'

describe('announcementLimit', () => {
  it('reports the whole ordered quantity as free when nothing is announced', () => {
    const limit = announcementLimit('100.0000', [])
    expect(limit.announced).toBe('0.0000')
    expect(limit.free).toBe('100.0000')
    expect(limit.isConsistent).toBe(true)
  })

  it('subtracts every outstanding claim', () => {
    // The worked example from the spec: ordered 100, announced 60, free 40.
    const limit = announcementLimit('100.0000', ['40.0000', '20.0000'])
    expect(limit.announced).toBe('60.0000')
    expect(limit.free).toBe('40.0000')
    expect(limit.isConsistent).toBe(true)
  })

  it('keeps all four decimal places', () => {
    const limit = announcementLimit('10.5000', ['0.2500'])
    expect(limit.free).toBe('10.2500')
  })

  it('reports a fully announced line as consistent with nothing free', () => {
    const limit = announcementLimit('100.0000', ['100.0000'])
    expect(limit.free).toBe('0.0000')
    expect(limit.isConsistent).toBe(true)
  })

  it('refuses to invent a free quantity when more is announced than ordered', () => {
    // Over-announcement is a ledger inconsistency, not a negative allowance. Reporting it
    // as free: 0 and inconsistent stops anyone spending it while keeping it visible.
    const limit = announcementLimit('100.0000', ['140.0000'])
    expect(limit.announced).toBe('140.0000')
    expect(limit.free).toBe('0.0000')
    expect(limit.isConsistent).toBe(false)
  })

  it('treats an unreadable quantity as inconsistent rather than as zero', () => {
    expect(announcementLimit('100.0000', ['abc']).isConsistent).toBe(false)
    expect(announcementLimit('not a number', []).isConsistent).toBe(false)
  })
})

function limitsOf(entries: Record<string, AnnouncementLimit>): Map<string, AnnouncementLimit> {
  return new Map(Object.entries(entries))
}

describe('checkReservations', () => {
  const line = 'line-1'
  const free40 = limitsOf({ [line]: announcementLimit('100.0000', ['60.0000']) })

  it('accepts a request inside the free quantity', () => {
    expect(checkReservations([{ purchaseOrderLineId: line, quantity: '40.0000' }], free40)).toEqual([])
  })

  it('accepts a request exactly at the free quantity', () => {
    expect(checkReservations([{ purchaseOrderLineId: line, quantity: '40' }], free40)).toEqual([])
  })

  it('refuses a request over the free quantity', () => {
    const refusals = checkReservations([{ purchaseOrderLineId: line, quantity: '40.0001' }], free40)
    expect(refusals).toEqual([
      { reason: 'over_limit', purchaseOrderLineId: line, requested: '40.0001', free: '40.0000' },
    ])
  })

  it('sums several requests against the same line before comparing', () => {
    // Two halves that each fit but together do not: checking them separately would let the
    // pair through and over-announce the order.
    const refusals = checkReservations(
      [
        { purchaseOrderLineId: line, quantity: '25.0000' },
        { purchaseOrderLineId: line, quantity: '20.0000' },
      ],
      free40,
    )
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject({ reason: 'over_limit', requested: '45.0000', free: '40.0000' })
  })

  it('reports every offending line, not just the first', () => {
    const limits = limitsOf({
      'line-a': announcementLimit('10.0000', []),
      'line-b': announcementLimit('5.0000', []),
    })
    const refusals = checkReservations(
      [
        { purchaseOrderLineId: 'line-a', quantity: '11.0000' },
        { purchaseOrderLineId: 'line-b', quantity: '6.0000' },
      ],
      limits,
    )
    expect(refusals.map((refusal) => refusal.purchaseOrderLineId).sort()).toEqual(['line-a', 'line-b'])
  })

  it('refuses a zero or negative quantity', () => {
    expect(checkReservations([{ purchaseOrderLineId: line, quantity: '0' }], free40)).toEqual([
      { reason: 'not_positive', purchaseOrderLineId: line },
    ])
    expect(checkReservations([{ purchaseOrderLineId: line, quantity: '-5' }], free40)).toEqual([
      { reason: 'not_positive', purchaseOrderLineId: line },
    ])
  })

  it('refuses an unreadable quantity', () => {
    expect(checkReservations([{ purchaseOrderLineId: line, quantity: 'ten' }], free40)).toEqual([
      { reason: 'unreadable', purchaseOrderLineId: line },
    ])
  })

  it('refuses a line whose limit was never read', () => {
    expect(checkReservations([{ purchaseOrderLineId: 'unknown', quantity: '1' }], free40)).toEqual([
      { reason: 'inconsistent', purchaseOrderLineId: 'unknown' },
    ])
  })

  it('refuses a line whose ledger does not add up, whatever is requested', () => {
    const broken = limitsOf({ [line]: announcementLimit('100.0000', ['140.0000']) })
    expect(checkReservations([{ purchaseOrderLineId: line, quantity: '1' }], broken)).toEqual([
      { reason: 'inconsistent', purchaseOrderLineId: line },
    ])
  })
})
