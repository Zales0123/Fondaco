/**
 * Image -> 1bpp row bitmap for the NiimBot B1.
 *
 * Mirrors `niimctl.py` exactly, including two rules that look like bugs but are
 * load-bearing:
 *
 *  - A pixel counts as black only when its RED channel is 0 (`xim[x, y][0] == 0`).
 *    This is a hard threshold, not a luminance conversion — an anti-aliased or
 *    greyscale source will print very differently than it looks on screen.
 *  - Every row is padded to a fixed 50 bytes (400px), regardless of the image's
 *    real width. The B1 expects the full head width per row.
 */

/** Printer head width in bytes; 50 * 8 = 400 pixels. */
export const ROW_BYTE_LENGTH = 50
export const MAX_IMAGE_WIDTH = ROW_BYTE_LENGTH * 8

export type RasterizedImage = {
  width: number
  height: number
  /** One fixed-length `ROW_BYTE_LENGTH` buffer per image row, MSB-first. */
  rows: Buffer[]
}

export class RasterizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RasterizeError'
  }
}

/**
 * Number of set bits in a row — the `0x85` payload carries this as its
 * "black pixel count" field.
 */
export function countRowPixels(row: Buffer): number {
  let total = 0
  for (const byte of row) {
    for (let bit = 0; bit < 8; bit += 1) {
      if (byte & (1 << bit)) total += 1
    }
  }
  return total
}

export async function rasterizeImage(source: Buffer | Uint8Array): Promise<RasterizedImage> {
  // Imported lazily: this is a native Skia binding, and the DI registrar that
  // reaches this file is itself imported by server components. A top-level
  // import drags the .node addon into every one of those module graphs.
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const image = await loadImage(Buffer.from(source))
  const width = image.width
  const height = image.height

  if (width > MAX_IMAGE_WIDTH) {
    throw new RasterizeError(`Image must be at most ${MAX_IMAGE_WIDTH} pixels wide, got ${width}`)
  }
  if (width % 8 !== 0) {
    throw new RasterizeError(`Image width must be a multiple of 8 pixels, got ${width}`)
  }
  if (height <= 0) {
    throw new RasterizeError('Image must have a non-zero height')
  }

  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const { data } = ctx.getImageData(0, 0, width, height)

  const rows: Buffer[] = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(ROW_BYTE_LENGTH)
    for (let x = 0; x < width; x += 1) {
      // Red channel only, matching the reference implementation.
      if (data[(y * width + x) * 4] === 0) {
        row[x >> 3] |= 1 << (7 - (x % 8))
      }
    }
    rows.push(row)
  }

  return { width, height, rows }
}
