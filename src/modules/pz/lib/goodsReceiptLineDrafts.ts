/**
 * The Line editor's own state shape. It is deliberately all-strings: a Line being typed is
 * not yet a Line, and coercing a half-typed quantity to a number on every keystroke is how
 * a form eats what the user is writing.
 */
export type GoodsReceiptLineDraft = {
  /** Stable React key; never sent to the server. Two drafts of the same product must stay distinct. */
  key: string
  catalogProductId: string
  quantity: string
  unit: string
}

export type GoodsReceiptLinePayload = {
  catalogProductId: string
  quantity: string
  unit: string | null
}

let draftCounter = 0

export function createEmptyLineDraft(): GoodsReceiptLineDraft {
  draftCounter += 1
  return { key: `line-${draftCounter}`, catalogProductId: '', quantity: '', unit: '' }
}

/** Drops the local key and normalises blanks; line numbers are assigned server-side by order. */
export function toLinePayloads(drafts: readonly GoodsReceiptLineDraft[]): GoodsReceiptLinePayload[] {
  return drafts.map((draft) => ({
    catalogProductId: draft.catalogProductId.trim(),
    quantity: draft.quantity.trim(),
    unit: draft.unit.trim() || null,
  }))
}
