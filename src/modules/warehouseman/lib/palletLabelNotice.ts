import type { PalletLabelNotice } from './receivingPanel'

/**
 * A one-shot handoff from the pallets screen to the pallet it navigates into.
 *
 * Creating a pallet prints its label and then opens the pallet, so the print outcome is
 * known on the screen the warehouseman is about to leave and has to be read on the screen
 * where the reprint button lives. Both screens live in one client bundle and the panel
 * never reloads between them, so a mailbox carries it. A hard reload simply loses the
 * notice, which is the right failure: the pallet and its reprint button are still there.
 */
const pending = new Map<string, PalletLabelNotice>()

export function stashPalletLabelNotice(palletId: string, notice: PalletLabelNotice): void {
  pending.set(palletId, notice)
}

/** Reading consumes it: a notice is about one print, not about the screen showing it. */
export function takePalletLabelNotice(palletId: string): PalletLabelNotice | null {
  const notice = pending.get(palletId) ?? null
  pending.delete(palletId)
  return notice
}

/** Test seam: the mailbox is module state, so a test has to be able to empty it. */
export function clearPalletLabelNotices(): void {
  pending.clear()
}
