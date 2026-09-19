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
  /**
   * The Purchase Order position this line announces against, empty when the delivery has no
   * order behind it. Both ids are held together because the server refuses a half-filled
   * reference, and the label is kept so a reloaded draft can render the chosen order
   * without another lookup.
   */
  purchaseOrderId: string
  purchaseOrderLineId: string
  purchaseOrderLabel: string
}

export type GoodsReceiptLinePayload = {
  catalogProductId: string
  quantity: string
  unit: string | null
  purchaseOrderId: string | null
  purchaseOrderLineId: string | null
}

let draftCounter = 0

export function createEmptyLineDraft(): GoodsReceiptLineDraft {
  draftCounter += 1
  return {
    key: `line-${draftCounter}`,
    catalogProductId: '',
    quantity: '',
    unit: '',
    purchaseOrderId: '',
    purchaseOrderLineId: '',
    purchaseOrderLabel: '',
  }
}

/** Drops the local key and normalises blanks; line numbers are assigned server-side by order. */
export function toLinePayloads(drafts: readonly GoodsReceiptLineDraft[]): GoodsReceiptLinePayload[] {
  return drafts.map((draft) => {
    const purchaseOrderId = draft.purchaseOrderId.trim()
    const purchaseOrderLineId = draft.purchaseOrderLineId.trim()
    // Half a reference is never sent: the server would refuse it, and dropping it here
    // silently would file the delivery against nothing without telling anyone.
    const hasReference = purchaseOrderId.length > 0 && purchaseOrderLineId.length > 0
    return {
      catalogProductId: draft.catalogProductId.trim(),
      quantity: draft.quantity.trim(),
      unit: draft.unit.trim() || null,
      purchaseOrderId: hasReference ? purchaseOrderId : (purchaseOrderId || null),
      purchaseOrderLineId: hasReference ? purchaseOrderLineId : (purchaseOrderLineId || null),
    }
  })
}
