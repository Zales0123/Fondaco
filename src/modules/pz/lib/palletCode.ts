/**
 * Pallet codes are generated, never typed: the label is scanned by someone who has not said
 * which document they mean, so the code is unique across the whole Organization rather than
 * per receipt (ADR-0010).
 *
 * The format is `PAL-` plus a zero-padded sequence. Padding is a display choice, not an
 * invariant — a sequence that outgrows six digits keeps counting rather than wrapping — so
 * every comparison goes through `parsePalletCode` instead of comparing the text.
 */
export const PALLET_CODE_PREFIX = 'PAL-'

const SEQUENCE_DIGITS = 6

const PALLET_CODE_PATTERN = /^PAL-(\d+)$/i

export function formatPalletCode(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`[internal] A pallet code sequence must be a positive integer, received ${sequence}`)
  }
  return `${PALLET_CODE_PREFIX}${String(sequence).padStart(SEQUENCE_DIGITS, '0')}`
}

/**
 * `null` for anything this generator did not mint. A code that does not parse must not shift
 * the sequence: deriving the next number from it would either collide or skip a whole range.
 */
export function parsePalletCode(code: string): number | null {
  const match = PALLET_CODE_PATTERN.exec(code.trim())
  if (!match) return null
  const sequence = Number(match[1])
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null
}

/** The code that follows the highest one an Organization already holds, or the first one. */
export function nextPalletCode(highestExistingCode: string | null | undefined): string {
  const highest = highestExistingCode ? parsePalletCode(highestExistingCode) : null
  return formatPalletCode((highest ?? 0) + 1)
}

/** What a scanner sent, ready to look up: trimmed, or `null` when it sent nothing. */
export function normalizePalletCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}
