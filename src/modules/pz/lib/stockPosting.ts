/**
 * What confirming a Goods Receipt has to decide before it becomes irreversible, and what the
 * Stock Posting then posts. Pure, so the rules that stop a delivery being finished can be
 * read and tested without a warehouse behind them (ADR-0011).
 */

import { fromScaledQuantity, toScaledQuantity } from './quantity'

/**
 * Where counted goods may land. `zone`, `aisle` and `rack` are containers in the Location
 * tree, and a balance held "in aisle A" is one nobody can go and pick from. A Location with
 * children is excluded for the same reason, whatever its type: the goods are somewhere more
 * specific and the tree already says where.
 *
 * `wms` imposes no such rule — `wms.inventory.receive` accepts any Location of the Warehouse
 * — so this is our restriction and it is enforced on the server, never only in the picker.
 */
export const ELIGIBLE_DESTINATION_TYPES = ['bin', 'slot', 'staging', 'dock'] as const

export type DestinationCandidate = {
  id: string
  code: string
  type: string
  warehouseId: string
  isActive: boolean
  hasChildren: boolean
}

export function isEligibleDestination(
  candidate: DestinationCandidate,
  warehouseId: string,
): boolean {
  if (candidate.warehouseId !== warehouseId) return false
  if (!candidate.isActive || candidate.hasChildren) return false
  return (ELIGIBLE_DESTINATION_TYPES as readonly string[]).includes(candidate.type)
}

/**
 * Why a delivery cannot be finished right now. The floor reads these, so each one names what
 * to do about it rather than what went wrong internally; the confirm command evaluates them
 * again at write time, because the screen's copy can be minutes old.
 */
export type ConfirmationBlocker =
  | { kind: 'notReceiving' }
  | { kind: 'palletsOpen'; count: number }
  | { kind: 'noLines' }
  | { kind: 'noEligibleDestination' }
  | { kind: 'destinationRequired' }
  | { kind: 'destinationInvalid' }
  | { kind: 'trackedVariants'; products: string[] }

export type ConfirmationCheck = {
  status: string
  palletsOpen: number
  lineCount: number
  /** Skipped entirely when the Stock Posting toggle is off: nothing will be posted. */
  postingEnabled: boolean
  eligibleDestinationCount: number
  /** The Location chosen or preselected, already looked up among the eligible ones. */
  selectedDestinationId: string | null
  selectedDestinationEligible: boolean
  /** Product names of the counted variants `wms` tracks by lot or serial number. */
  trackedProducts: string[]
}

/**
 * Worst first, and only the blockers that are true: a screen listing "no destination chosen"
 * above "3 pallets are still open" sends somebody to the wrong end of the delivery.
 */
export function resolveConfirmationBlockers(check: ConfirmationCheck): ConfirmationBlocker[] {
  const blockers: ConfirmationBlocker[] = []
  if (check.status !== 'receiving') blockers.push({ kind: 'notReceiving' })
  if (check.palletsOpen > 0) blockers.push({ kind: 'palletsOpen', count: check.palletsOpen })
  if (check.lineCount === 0) blockers.push({ kind: 'noLines' })
  if (!check.postingEnabled) return blockers

  if (check.trackedProducts.length > 0) {
    blockers.push({ kind: 'trackedVariants', products: [...check.trackedProducts].sort() })
  }
  if (check.eligibleDestinationCount === 0) blockers.push({ kind: 'noEligibleDestination' })
  else if (!check.selectedDestinationId) blockers.push({ kind: 'destinationRequired' })
  else if (!check.selectedDestinationEligible) blockers.push({ kind: 'destinationInvalid' })
  return blockers
}

export type CountedPalletLine = {
  catalogVariantId: string
  quantity: string
}

export type PostableQuantity = {
  catalogVariantId: string
  /** Decimal string at storage precision; the `wms` boundary converts it once. */
  quantity: string
}

/**
 * One posting per variant, summed across every Pallet of the document.
 *
 * Posting pallet by pallet would lose stock silently: the `wms` movement idempotency key
 * includes the quantity, so two Pallets each carrying 5 of one variant produce the same key
 * twice and the second is treated as a replay of the first. Summing first makes each key
 * unique per variant, and makes a retry send exactly the key it sent before — which is what
 * lets a failed posting be retried without double-stocking anything (ADR-0011).
 *
 * A variant whose counts cancel out to zero or less is dropped rather than posted: `wms`
 * refuses a non-positive quantity, and there is nothing to put on a shelf.
 */
export function aggregatePostableQuantities(lines: readonly CountedPalletLine[]): PostableQuantity[] {
  const totals = new Map<string, bigint>()
  for (const line of lines) {
    totals.set(line.catalogVariantId, (totals.get(line.catalogVariantId) ?? 0n) + toScaledQuantity(line.quantity))
  }
  return Array.from(totals.entries())
    .filter(([, quantity]) => quantity > 0n)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([catalogVariantId, quantity]) => ({ catalogVariantId, quantity: fromScaledQuantity(quantity) }))
}
