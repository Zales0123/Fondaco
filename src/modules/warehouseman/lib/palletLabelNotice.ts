import { describePalletPrintOutcome, type PalletLabelNotice } from './receivingPanel'

/**
 * A one-shot handoff from the pallets screen to the pallet it navigates into.
 *
 * Creating a pallet prints its label and then opens the pallet, so the print outcome
 * belongs on the screen where the reprint button lives rather than on the one the
 * warehouseman is leaving. Both screens live in one client bundle and the panel never
 * reloads between them, so a mailbox carries it. A hard reload simply loses the notice,
 * which is the right failure: the pallet and its reprint button are still there.
 *
 * What is carried is the print itself, not its result. A B1 label takes tens of seconds
 * over Bluetooth, and a printer that is off takes until the request's own bound gives up.
 * Holding the warehouseman on the previous screen for that — in front of a pallet that
 * already exists — is the thing this mailbox exists to avoid.
 */
const pending = new Map<string, Promise<PalletLabelNotice>>()

/** The panel's own wording for a print outcome; the caller owns it, not the mailbox. */
export type PalletLabelWording = {
  success: string
  failure: (reason: string) => string
  unknownReason: string
  timedOutReason: string
}

/**
 * Starts a label print and returns immediately, leaving the outcome to be collected by
 * whoever opens the pallet next.
 *
 * The promise is settled into a notice here rather than handed over raw, because nothing
 * is guaranteed to collect it: a warehouseman who never opens the pallet, or reloads
 * first, leaves it unread. A rejection nobody attaches a handler to is an unhandled
 * rejection, so a refusal is turned into a resolved warning at the point it happens.
 */
export function startPalletLabelPrint(
  palletId: string,
  print: (palletId: string) => Promise<void>,
  wording: PalletLabelWording,
): void {
  const settled = print(palletId).then(
    () => describePalletPrintOutcome(null, wording),
    (failure: unknown) => describePalletPrintOutcome(failure, wording),
  )
  pending.set(palletId, settled)
}

/** Reading consumes it: a notice is about one print, not about the screen showing it. */
export function takePalletLabelNotice(palletId: string): Promise<PalletLabelNotice> | null {
  const notice = pending.get(palletId) ?? null
  pending.delete(palletId)
  return notice
}

/** Test seam: the mailbox is module state, so a test has to be able to empty it. */
export function clearPalletLabelNotices(): void {
  pending.clear()
}
