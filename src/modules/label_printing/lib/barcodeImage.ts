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

/** Largest scale first: use the biggest rendering that still fits the label. */
const SCALE_CANDIDATES = [4, 3, 2, 1] as const
const BAR_HEIGHT_BY_SCALE: Record<number, number> = { 4: 20, 3: 18, 2: 16, 1: 12 }

type Canvas = import('@napi-rs/canvas').Canvas

/**
 * Renders at the largest scale that fits, because a Code128 payload's width
 * grows with its content: a 15-character order number is 356px at scale 2 but
 * 178px at scale 1. Picking a fixed scale would either waste the label or
 * overflow it depending on the value.
 */
export async function renderBarcodeLabel(request: BarcodeRenderRequest): Promise<Buffer> {
  const { symbology, value, geometry, includeText = true } = request
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const bwipjs = (await import('bwip-js/node')).default

  let chosen: { image: Awaited<ReturnType<typeof loadImage>>; scale: number } | null = null
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
    if (image.width <= geometry.width && image.height <= geometry.height) {
      chosen = { image, scale }
      break
    }
    lastError = new Error(
      `${symbology} "${value}" is ${image.width}x${image.height} at scale ${scale}, `
      + `larger than the ${geometry.width}x${geometry.height} label`,
    )
  }

  if (!chosen) {
    throw new BarcodeRenderError(
      lastError instanceof Error
        ? lastError.message
        : `Could not render ${symbology} "${value}" onto the label`,
    )
  }

  const canvas = createCanvas(geometry.width, geometry.height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, geometry.width, geometry.height)
  // See note 2 above.
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(
    chosen.image,
    Math.floor((geometry.width - chosen.image.width) / 2),
    Math.floor((geometry.height - chosen.image.height) / 2),
  )

  binarize(canvas, geometry)
  return canvas.toBuffer('image/png')
}

/** See note 3 above: collapse every pixel to pure black or pure white. */
function binarize(canvas: Canvas, geometry: LabelGeometry): void {
  const ctx = canvas.getContext('2d')
  const imageData = ctx.getImageData(0, 0, geometry.width, geometry.height)
  const data = imageData.data
  for (let i = 0; i < data.length; i += 4) {
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    const value = luminance < 128 ? 0 : 255
    data[i] = value
    data[i + 1] = value
    data[i + 2] = value
    data[i + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)
}
