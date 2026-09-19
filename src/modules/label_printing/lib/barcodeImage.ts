/**
 * Renders a barcode onto the label canvas as a strictly 1-bit image.
 *
 * Three behaviours here are not stylistic — each one was measured against the
 * printer's rasterizer and fixes a way the label comes out wrong:
 *
 *  1. `backgroundcolor` is always set. bwip-js defaults to a TRANSPARENT
 *     background, and a transparent pixel reports red = 0, which is exactly the
 *     rasterizer's "this pixel is ink" test. Without it every pixel is ink and
 *     the printer emits a solid black label.
 *  2. The barcode is drawn 1:1 with smoothing off. Scaling would blur the bar
 *     edges into greys that the rasterizer's hard threshold then drops.
 *  3. The result is binarized before it leaves this module. bwip-js antialiases
 *     the human-readable text (measured: 885 grey pixels on a stock EAN-13), and
 *     the rasterizer would silently discard them, thinning the digits.
 *     Binarizing HERE keeps `rasterize.ts` byte-identical to the reference
 *     implementation, so its differential fixture stays valid.
 */
import type { LabelGeometry } from './labelGeometry'

/** Values `bwip-js` understands; narrowed to what this module emits. */
export type BarcodeSymbology = 'ean13' | 'ean8' | 'upca' | 'code128' | 'gs1-128'

export class BarcodeRenderError extends Error {
  readonly code = 'barcode-render-failed' as const
  constructor(message: string) {
    super(message)
    this.name = 'BarcodeRenderError'
  }
}

export type BarcodeRenderRequest = {
  symbology: BarcodeSymbology
  /** The value to encode; must already be valid for the symbology. */
  value: string
  geometry: LabelGeometry
  /** Print the human-readable line that the symbology conventionally carries. */
  includeText?: boolean
}

/** Largest scale first: use the biggest rendering the label and the head accept. */
const SCALE_CANDIDATES = [4, 3, 2, 1] as const
const BAR_HEIGHT_BY_SCALE: Record<number, number> = { 4: 20, 3: 18, 2: 16, 1: 12 }

/**
 * Most black dots allowed in a single printed row.
 *
 * Fitting the label is not the only constraint: the B1's print head refuses a
 * row carrying too much ink. When it hits one it aborts the job mid-label,
 * leaving a half-printed label and reporting `error 3`. Bisected against the
 * physical printer at 384x230:
 *
 *   - ean13 "2053301404433" at scale 4 — 172 dots, 380px wide — prints;
 *   - code128 "PAL-000123" at scale 3 — 210 dots, 369px wide — fails.
 *
 * Width is not the variable (380px printed while 369px failed) and neither is
 * density (the failure reproduces identically at `NIIMBOT_DENSITY` 1 and 3);
 * the peak row is. The true firmware threshold therefore lies somewhere in
 * (172, 210]. 180 sits conservatively inside that bracket: a warehouse label
 * that silently half-prints is worse than one rendered a step smaller.
 */
const DEFAULT_MAX_ROW_DOTS = 180

/** Same idiom as `labelGeometry.ts`: ignore a missing or non-positive value. */
function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readMaxRowDots(): number {
  return readIntEnv('NIIMBOT_MAX_ROW_DOTS', DEFAULT_MAX_ROW_DOTS)
}

type Canvas = import('@napi-rs/canvas').Canvas

/**
 * Renders at the largest scale the label and the print head both accept.
 *
 * Two constraints, and a candidate has to clear both. Geometry, because a
 * Code128 payload's width grows with its content: a 15-character order number
 * is 356px at scale 2 but 178px at scale 1, so a fixed scale would either waste
 * the label or overflow it depending on the value. And ink, because a rendering
 * that fits can still peak above what the head will print in one row — see
 * `DEFAULT_MAX_ROW_DOTS`.
 */
export async function renderBarcodeLabel(request: BarcodeRenderRequest): Promise<Buffer> {
  const { symbology, value, geometry, includeText = true } = request
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const bwipjs = (await import('bwip-js/node')).default
  const maxRowDots = readMaxRowDots()

  let lastError: unknown = null

  for (const scale of SCALE_CANDIDATES) {
    let png: Buffer
    try {
      png = await bwipjs.toBuffer({
        bcid: symbology,
        text: value,
        scale,
        height: BAR_HEIGHT_BY_SCALE[scale] ?? 12,
        includetext: includeText,
        textxalign: 'center',
        // See note 1 above: never omit this.
        backgroundcolor: 'FFFFFF',
      })
    } catch (error) {
      // A value the symbology rejects fails at every scale; stop early.
      lastError = error
      break
    }
    const image = await loadImage(png)
    if (image.width > geometry.width || image.height > geometry.height) {
      lastError = new Error(
        `${symbology} "${value}" is ${image.width}x${image.height} at scale ${scale}, `
        + `larger than the ${geometry.width}x${geometry.height} label`,
      )
      continue
    }

    // Composed and binarized once per candidate: the ink measurement has to be
    // taken on the finished label, and the finished label is what we return.
    const canvas = createCanvas(geometry.width, geometry.height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, geometry.width, geometry.height)
    // See note 2 above.
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(
      image,
      Math.floor((geometry.width - image.width) / 2),
      Math.floor((geometry.height - image.height) / 2),
    )

    const peakRowDots = binarize(canvas, geometry)
    if (peakRowDots > maxRowDots) {
      lastError = new Error(
        `${symbology} "${value}" peaks at ${peakRowDots} black dots in one row at scale ${scale}, `
        + `above the ${maxRowDots} the print head accepts`,
      )
      continue
    }

    return canvas.toBuffer('image/png')
  }

  throw new BarcodeRenderError(
    lastError instanceof Error
      ? lastError.message
      : `Could not render ${symbology} "${value}" onto the label`,
  )
}

/**
 * See note 3 above: collapse every pixel to pure black or pure white.
 *
 * Returns the peak number of black dots in a row while it is already holding
 * the pixels, so the ink check costs no extra read-back. It applies the same
 * "red channel is 0" ink test as `rasterize.ts`, on a canvas exactly as wide as
 * the label, so the number it reports is the one `countRowPixels` will report
 * for the row the printer actually receives.
 */
function binarize(canvas: Canvas, geometry: LabelGeometry): number {
  const ctx = canvas.getContext('2d')
  const imageData = ctx.getImageData(0, 0, geometry.width, geometry.height)
  const data = imageData.data
  let peakRowDots = 0
  for (let y = 0; y < geometry.height; y += 1) {
    let rowDots = 0
    for (let x = 0; x < geometry.width; x += 1) {
      const i = (y * geometry.width + x) * 4
      const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      const value = luminance < 128 ? 0 : 255
      data[i] = value
      data[i + 1] = value
      data[i + 2] = value
      data[i + 3] = 255
      if (value === 0) rowDots += 1
    }
    if (rowDots > peakRowDots) peakRowDots = rowDots
  }
  ctx.putImageData(imageData, 0, 0)
  return peakRowDots
}
