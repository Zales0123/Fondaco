/**
 * The scanner dialog is shared by callers that scan different things (catalog
 * barcodes, pallet labels), so the wording it renders is a caller decision.
 * These tests pin which string wins — the caller's prop or the translation —
 * because a silent fallback would show a warehouseman "e.g. 5901234123457".
 */
import { describe, expect, it } from '@jest/globals'
import { resolveScannerLabels } from '../lib/scannerLabels'

type TranslatorCall = { key: string; fallback?: string }

function translator(dict: Record<string, string> = {}) {
  const calls: TranslatorCall[] = []
  const t = (key: string, fallbackOrParams?: string | Record<string, string | number>) => {
    const fallback = typeof fallbackOrParams === 'string' ? fallbackOrParams : undefined
    calls.push({ key, fallback })
    return dict[key] ?? fallback ?? key
  }
  return { t, calls }
}

const DEFAULT_DICT = {
  'barcodeScanner.scanner.title': 'Scan a barcode',
  'barcodeScanner.scanner.description':
    'Point the rear camera at a barcode. You can also type the code by hand.',
  'barcodeScanner.scanner.manualLabel': 'Or enter the barcode manually',
  'barcodeScanner.scanner.manualPlaceholder': 'e.g. 5901234123457',
}

describe('resolveScannerLabels', () => {
  it('falls back to the translated copy for every label when nothing is overridden', () => {
    const { t } = translator(DEFAULT_DICT)

    expect(resolveScannerLabels({}, t)).toEqual({
      title: 'Scan a barcode',
      description: 'Point the rear camera at a barcode. You can also type the code by hand.',
      manualLabel: 'Or enter the barcode manually',
      manualPlaceholder: 'e.g. 5901234123457',
    })
  })

  it('keeps the shipped English copy as the translator fallback for every key', () => {
    const { t, calls } = translator()

    expect(resolveScannerLabels({}, t)).toEqual({
      title: 'Scan a barcode',
      description: 'Point the rear camera at a barcode. You can also type the code by hand.',
      manualLabel: 'Or enter the barcode manually',
      manualPlaceholder: 'e.g. 5901234123457',
    })
    expect(calls).toEqual([
      { key: 'barcodeScanner.scanner.title', fallback: 'Scan a barcode' },
      {
        key: 'barcodeScanner.scanner.description',
        fallback: 'Point the rear camera at a barcode. You can also type the code by hand.',
      },
      { key: 'barcodeScanner.scanner.manualLabel', fallback: 'Or enter the barcode manually' },
      { key: 'barcodeScanner.scanner.manualPlaceholder', fallback: 'e.g. 5901234123457' },
    ])
  })

  it('uses the caller title and leaves the other labels translated', () => {
    const { t } = translator(DEFAULT_DICT)

    expect(resolveScannerLabels({ title: 'Scan a pallet label' }, t)).toEqual({
      title: 'Scan a pallet label',
      description: 'Point the rear camera at a barcode. You can also type the code by hand.',
      manualLabel: 'Or enter the barcode manually',
      manualPlaceholder: 'e.g. 5901234123457',
    })
  })

  it('uses the caller description and leaves the other labels translated', () => {
    const { t } = translator(DEFAULT_DICT)

    expect(resolveScannerLabels({ description: 'Point the camera at the pallet label.' }, t)).toEqual({
      title: 'Scan a barcode',
      description: 'Point the camera at the pallet label.',
      manualLabel: 'Or enter the barcode manually',
      manualPlaceholder: 'e.g. 5901234123457',
    })
  })

  it('uses the caller manual label and leaves the other labels translated', () => {
    const { t } = translator(DEFAULT_DICT)

    expect(resolveScannerLabels({ manualLabel: 'Or enter the pallet code manually' }, t)).toEqual({
      title: 'Scan a barcode',
      description: 'Point the rear camera at a barcode. You can also type the code by hand.',
      manualLabel: 'Or enter the pallet code manually',
      manualPlaceholder: 'e.g. 5901234123457',
    })
  })

  it('uses the caller manual placeholder and leaves the other labels translated', () => {
    const { t } = translator(DEFAULT_DICT)

    expect(resolveScannerLabels({ manualPlaceholder: 'e.g. PAL-000123' }, t)).toEqual({
      title: 'Scan a barcode',
      description: 'Point the rear camera at a barcode. You can also type the code by hand.',
      manualLabel: 'Or enter the barcode manually',
      manualPlaceholder: 'e.g. PAL-000123',
    })
  })

  it('applies every override at once', () => {
    const { t } = translator(DEFAULT_DICT)

    expect(
      resolveScannerLabels(
        {
          title: 'Scan a pallet label',
          description: 'Point the camera at the pallet label.',
          manualLabel: 'Or enter the pallet code manually',
          manualPlaceholder: 'e.g. PAL-000123',
        },
        t,
      ),
    ).toEqual({
      title: 'Scan a pallet label',
      description: 'Point the camera at the pallet label.',
      manualLabel: 'Or enter the pallet code manually',
      manualPlaceholder: 'e.g. PAL-000123',
    })
  })

  it('treats an empty override as absent rather than blanking the dialog', () => {
    const { t } = translator(DEFAULT_DICT)

    expect(
      resolveScannerLabels(
        { title: '', description: '', manualLabel: '', manualPlaceholder: '' },
        t,
      ),
    ).toEqual({
      title: 'Scan a barcode',
      description: 'Point the rear camera at a barcode. You can also type the code by hand.',
      manualLabel: 'Or enter the barcode manually',
      manualPlaceholder: 'e.g. 5901234123457',
    })
  })

  it('treats a whitespace-only override as absent too', () => {
    const { t } = translator(DEFAULT_DICT)

    expect(resolveScannerLabels({ title: '   ', manualPlaceholder: '\n\t' }, t)).toEqual({
      title: 'Scan a barcode',
      description: 'Point the rear camera at a barcode. You can also type the code by hand.',
      manualLabel: 'Or enter the barcode manually',
      manualPlaceholder: 'e.g. 5901234123457',
    })
  })

  it('preserves surrounding whitespace inside an override it accepts', () => {
    const { t } = translator(DEFAULT_DICT)

    expect(resolveScannerLabels({ title: ' Scan a pallet label ' }, t).title).toBe(
      ' Scan a pallet label ',
    )
  })
})
