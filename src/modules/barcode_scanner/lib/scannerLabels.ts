import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'

/**
 * Wording overrides a caller may hand to `BarcodeScannerDialog`.
 *
 * Callers own their own `useT()`, so these are already-translated strings —
 * the dialog never turns them into translation keys. Every field is optional;
 * an omitted (or blank) one keeps the product-barcode copy the dialog ships.
 */
export type ScannerLabelOverrides = {
  /** Dialog heading. */
  title?: string
  /** Line under the heading. */
  description?: string
  /** Label of the manual-entry field. */
  manualLabel?: string
  /** Placeholder of the manual-entry field. */
  manualPlaceholder?: string
}

/** The wording the dialog actually renders, with every slot resolved. */
export type ScannerLabels = Required<ScannerLabelOverrides>

/**
 * A blank override is treated as "not provided" rather than "render nothing":
 * an empty heading or an unlabelled input is never what a caller means, and it
 * is what an unresolved `t('…')` or an empty state variable degrades into.
 * Whitespace inside an accepted override is preserved verbatim.
 */
function pick(override: string | undefined, fallback: string): string {
  if (typeof override !== 'string') return fallback
  return override.trim().length > 0 ? override : fallback
}

/**
 * Decides, per slot, whether the caller's wording or the dialog's own
 * translation wins. Kept free of React so it can be tested directly.
 */
export function resolveScannerLabels(
  overrides: ScannerLabelOverrides,
  t: TranslateFn,
): ScannerLabels {
  return {
    title: pick(overrides.title, t('barcodeScanner.scanner.title', 'Scan a barcode')),
    description: pick(
      overrides.description,
      t(
        'barcodeScanner.scanner.description',
        'Point the rear camera at a barcode. You can also type the code by hand.',
      ),
    ),
    manualLabel: pick(
      overrides.manualLabel,
      t('barcodeScanner.scanner.manualLabel', 'Or enter the barcode manually'),
    ),
    manualPlaceholder: pick(
      overrides.manualPlaceholder,
      t('barcodeScanner.scanner.manualPlaceholder', 'e.g. 5901234123457'),
    ),
  }
}
