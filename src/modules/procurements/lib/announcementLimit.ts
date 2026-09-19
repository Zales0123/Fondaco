import { QUANTITY_SCALE, compareDecimal, subtractDecimal, sumDecimals } from './decimal'

/**
 * How much of a Purchase Order line may still be announced to the warehouse.
 *
 * `.ai/specs/2026-09-19-purchasing-inbound-ui-proposal.md` states the full rule as
 * `free = ordered − cancelled − postedNet − inflight − outstanding`. Three of those five
 * terms cannot be answered yet and are deliberately absent rather than hard-coded to zero:
 *
 * - `cancelled` needs a per-line cancellation quantity, which stage 1 did not introduce.
 * - `postedNet` and `inflight` need confirmed stock posting, which arrives with issues
 *   #44–#47 (`.ai/specs/2026-09-19-awizo-pz-stock-posting.md`).
 *
 * So today `free = ordered − outstanding`, and the caller is told exactly that. Adding the
 * missing terms later only ever lowers `free`, so nothing computed now can become an
 * over-announcement once they land — the opposite direction would have been unsafe.
 */
export type AnnouncementLimit = {
  /** The line's ordered quantity, as stored. */
  ordered: string
  /** Sum of the line's active commitments — announced, not yet settled. */
  announced: string
  /**
   * What a new announcement may still take. Never negative: a negative result means the
   * ledger and the order disagree, which `isConsistent` reports rather than hiding behind
   * a clamp to zero.
   */
  free: string
  /**
   * False when commitments exceed the ordered quantity, or when a quantity could not be
   * read at all. A screen shows this as a data problem; a reservation refuses outright.
   */
  isConsistent: boolean
}

const ZERO = '0.0000'

/**
 * Builds the limit for one line. `announced` is summed here rather than by the caller so
 * every surface — list column, picker, reservation check — derives it the same way.
 */
export function announcementLimit(ordered: string, commitments: readonly string[]): AnnouncementLimit {
  const announced = sumDecimals(commitments, QUANTITY_SCALE)
  if (announced === null) {
    return { ordered, announced: ZERO, free: ZERO, isConsistent: false }
  }
  const free = subtractDecimal(ordered, announced, QUANTITY_SCALE)
  if (free === null) {
    return { ordered, announced, free: ZERO, isConsistent: false }
  }
  const sign = compareDecimal(free, '0', QUANTITY_SCALE)
  // A negative free quantity is a real inconsistency — more is announced than was ever
  // ordered. It is reported as zero-free-and-inconsistent so no caller can spend it.
  if (sign === null || sign < 0) {
    return { ordered, announced, free: ZERO, isConsistent: false }
  }
  return { ordered, announced, free, isConsistent: true }
}

export type ReservationRequest = {
  purchaseOrderLineId: string
  quantity: string
}

export type ReservationRefusal =
  | { reason: 'unreadable'; purchaseOrderLineId: string }
  | { reason: 'not_positive'; purchaseOrderLineId: string }
  | { reason: 'inconsistent'; purchaseOrderLineId: string }
  | { reason: 'over_limit'; purchaseOrderLineId: string; requested: string; free: string }

/**
 * Decides whether a set of requested quantities fits inside the lines' free limits.
 *
 * Requests are grouped per line first, because one announcement may legitimately carry the
 * same order line twice; checking them separately would let two halves each pass while the
 * pair exceeds the limit.
 *
 * Returns every refusal rather than the first, so a form can mark all offending rows in one
 * round trip instead of making the user discover them one at a time.
 */
export function checkReservations(
  requests: readonly ReservationRequest[],
  limits: ReadonlyMap<string, AnnouncementLimit>,
): ReservationRefusal[] {
  const refusals: ReservationRefusal[] = []
  const requestedPerLine = new Map<string, string[]>()

  for (const request of requests) {
    const positive = compareDecimal(request.quantity, '0', QUANTITY_SCALE)
    if (positive === null) {
      refusals.push({ reason: 'unreadable', purchaseOrderLineId: request.purchaseOrderLineId })
      continue
    }
    if (positive <= 0) {
      refusals.push({ reason: 'not_positive', purchaseOrderLineId: request.purchaseOrderLineId })
      continue
    }
    const existing = requestedPerLine.get(request.purchaseOrderLineId)
    if (existing) existing.push(request.quantity)
    else requestedPerLine.set(request.purchaseOrderLineId, [request.quantity])
  }

  for (const [purchaseOrderLineId, quantities] of requestedPerLine) {
    const limit = limits.get(purchaseOrderLineId)
    if (!limit || !limit.isConsistent) {
      refusals.push({ reason: 'inconsistent', purchaseOrderLineId })
      continue
    }
    const requested = sumDecimals(quantities, QUANTITY_SCALE)
    if (requested === null) {
      refusals.push({ reason: 'unreadable', purchaseOrderLineId })
      continue
    }
    const comparison = compareDecimal(requested, limit.free, QUANTITY_SCALE)
    if (comparison === null || comparison > 0) {
      refusals.push({ reason: 'over_limit', purchaseOrderLineId, requested, free: limit.free })
    }
  }

  return refusals
}
