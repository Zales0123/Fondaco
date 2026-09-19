/**
 * The Line editor's own state shape. It is deliberately all-strings: a Line being typed is
 * not yet a Line, and coercing a half-typed quantity or price to a number on every keystroke
 * is how a form eats what the user is writing.
 */
export type PurchaseOrderLineDraft = {
  /** Stable React key; never sent to the server. Two drafts of the same product must stay distinct. */
  key: string
  catalogProductId: string
  quantityOrdered: string
  unit: string
  unitPriceNet: string
  expectedDate: string
}

export type PurchaseOrderLinePayload = {
  catalogProductId: string
  quantityOrdered: string
  unit: string | null
  unitPriceNet: string
  expectedDate: string | null
}

let draftCounter = 0

export function createEmptyLineDraft(): PurchaseOrderLineDraft {
  draftCounter += 1
  return {
    key: `po-line-${draftCounter}`,
    catalogProductId: '',
    quantityOrdered: '',
    unit: '',
    unitPriceNet: '',
    expectedDate: '',
  }
}

/** Drops the local key and normalises blanks; line numbers are assigned server-side by order. */
export function toLinePayloads(drafts: readonly PurchaseOrderLineDraft[]): PurchaseOrderLinePayload[] {
  return drafts.map((draft) => ({
    catalogProductId: draft.catalogProductId.trim(),
    quantityOrdered: draft.quantityOrdered.trim(),
    unit: draft.unit.trim() || null,
    unitPriceNet: draft.unitPriceNet.trim(),
    expectedDate: draft.expectedDate.trim() || null,
  }))
}
