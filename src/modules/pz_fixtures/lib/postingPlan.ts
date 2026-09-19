/**
 * What a demo environment has to be told before a counted delivery can be posted onto stock,
 * decided as pure functions so the rules can be read and tested without a warehouse behind
 * them — the same split `pz/lib/stockPosting.ts` makes.
 *
 * Reading the state is the caller's job (`lib/posting.ts`); deciding what to do with it is
 * here, because "which Location does this Warehouse preselect" is a rule, not a query.
 */

/** An eligible Destination as `pz` reports it: a Location the floor may post into. */
export type DestinationOption = {
  id: string
  code: string
}

export type WarehouseDefaultState = {
  warehouseId: string
  warehouseName: string
  /** Already filtered to the eligible Locations of this Warehouse. */
  eligible: DestinationOption[]
  /** Whatever `pz_default_destination` currently holds, or nothing. */
  currentDefaultId: string | null
}

export type DefaultDestinationPlan = {
  warehouseId: string
  warehouseName: string
  eligibleCount: number
  currentDefaultId: string | null
  /**
   * Whether the stored value is one of the Locations the floor may actually post into. A
   * stale or foreign value is left exactly as it is and simply preselects nothing at
   * confirmation, so it is reported rather than corrected: the Default Destination is a
   * preselection, and the confirmation re-validates it against the eligible Locations like
   * any hand-picked one (ADR-0011).
   */
  currentDefaultEligible: boolean
  /**
   * `keep`  — something is set; never overwrite it.
   * `set`   — nothing is set and there is an eligible Location to preselect.
   * `skip`  — the Warehouse has nowhere to post, so there is nothing to preselect.
   */
  action: 'keep' | 'set' | 'skip'
  /** The Location to write when the action is `set`. */
  destination: DestinationOption | null
}

/**
 * The lowest `code` among the eligible Locations.
 *
 * Lowest rather than first-seen so the pick does not depend on the order the caller happened
 * to read them in, and `code` rather than id so two machines seeded from the same fixtures
 * preselect the same shelf. It is deliberately the ordering `loadWarehouseDestinations`
 * already applies to the picker: the value we preselect is then the entry the floor sees at
 * the top of the list, instead of an arbitrary one they have to go looking for.
 */
export function pickDefaultDestination(
  eligible: readonly DestinationOption[],
): DestinationOption | null {
  let best: DestinationOption | null = null
  for (const candidate of eligible) {
    if (best === null || candidate.code < best.code) best = candidate
  }
  return best
}

/**
 * What to do with each Warehouse's Default Destination.
 *
 * A value somebody set on purpose is never overwritten — the same rule the demo
 * warehouseman's Assigned Warehouse follows, and for the same reason: fixtures fill a gap in
 * a fresh environment, they do not have opinions about a configured one. That makes the plan
 * idempotent, so re-running it is a no-op, and it is the read the `status` command renders
 * as well, so the report and the write can never disagree.
 */
export function planDefaultDestinations(
  states: readonly WarehouseDefaultState[],
): DefaultDestinationPlan[] {
  return states.map((state) => {
    const currentDefaultEligible = state.currentDefaultId !== null
      && state.eligible.some((option) => option.id === state.currentDefaultId)

    if (state.eligible.length === 0) {
      return {
        warehouseId: state.warehouseId,
        warehouseName: state.warehouseName,
        eligibleCount: 0,
        currentDefaultId: state.currentDefaultId,
        currentDefaultEligible,
        action: 'skip',
        destination: null,
      }
    }

    if (state.currentDefaultId !== null) {
      return {
        warehouseId: state.warehouseId,
        warehouseName: state.warehouseName,
        eligibleCount: state.eligible.length,
        currentDefaultId: state.currentDefaultId,
        currentDefaultEligible,
        action: 'keep',
        destination: state.eligible.find((option) => option.id === state.currentDefaultId) ?? null,
      }
    }

    return {
      warehouseId: state.warehouseId,
      warehouseName: state.warehouseName,
      eligibleCount: state.eligible.length,
      currentDefaultId: null,
      currentDefaultEligible: false,
      action: 'set',
      destination: pickDefaultDestination(state.eligible),
    }
  })
}
