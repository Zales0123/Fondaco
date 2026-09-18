# Confirmed goods receipts are immutable, and confirmation is one-way

A goods receipt is editable and deletable while it is a draft. Confirming it is a distinct action
with its own command, permission and event — not a status field on the edit form — and it cannot be
undone. There is no un-confirm, and a confirmed receipt cannot be edited or deleted; opening one
shows a read-only view, and the edit route refuses it outright rather than rendering a disabled form.

Warehouse documents are accounting-adjacent: freely editing what a past delivery contained is how
records stop being evidence of anything. Making confirmation a separate command also gives the
"a receipt must have at least one line" rule somewhere to live, and makes an irreversible transition
look irreversible instead of looking like any other save.

## Consequences

- Correcting a confirmed receipt has no answer today. When one is needed it should be a correcting
  document, not a reversal — deliberately a larger decision than un-checking a box.
- Deletion is soft (`deleted_at`) and drafts-only. The unique index on document number ignores
  soft-deleted rows, so deleting a draft frees its number for reuse.
