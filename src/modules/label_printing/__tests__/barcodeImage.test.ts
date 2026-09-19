/**
 * The contract that matters: whatever comes out of here must survive
 * `rasterizeImage` unchanged. So these assert the properties the printer's
 * rasterizer depends on — pure 1-bit, correct geometry, a sane ink ratio —
 * rather than pixel-exact output, which would just pin bwip-js's font metrics.
 */
import { afterEach, describe, expect, it } from '@jest/globals'
import { BarcodeRenderError, renderBarcodeLabel } from '../lib/barcodeImage'
import { DEFAULT_LABEL_GEOMETRY } from '../lib/labelGeometry'
import { countRowPixels, rasterizeImage } from '../lib/rasterize'

const geometry = DEFAULT_LABEL_GEOMETRY

async function analyse(png: Buffer) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const image = await loadImage(png)
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const { data } = ctx.getImageData(0, 0, image.width, image.height)
  let black = 0
  let white = 0
  let grey = 0
  let translucent = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 255) translucent += 1
    if (data[i] === 0) black += 1
    else if (data[i] === 255) white += 1
    else grey += 1
  }
  return { width: image.width, height: image.height, black, white, grey, translucent }
}

/**
 * Peak black dots in a single row, counted the way the print head counts them:
 * through the real rasterizer, so this is literally the number the `0x85`
 * payload carries for the densest row of the job.
 */
async function peakRowDots(png: Buffer): Promise<number> {
  const raster = await rasterizeImage(png)
  return raster.rows.reduce((peak, row) => Math.max(peak, countRowPixels(row)), 0)
}

/** The same measurement taken straight off the pixels (`red === 0` is ink). */
async function peakRowDotsByPixel(png: Buffer): Promise<number> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const image = await loadImage(png)
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const { data } = ctx.getImageData(0, 0, image.width, image.height)
  let peak = 0
  for (let y = 0; y < image.height; y += 1) {
    let row = 0
    for (let x = 0; x < image.width; x += 1) {
      if (data[(y * image.width + x) * 4] === 0) row += 1
    }
    if (row > peak) peak = row
  }
  return peak
}

/**
 * The per-row ink ceiling the B1's print head enforces, pinned here from the
 * hardware bisection rather than read from the implementation: 172 dots printed,
 * 210 dots aborted the job with `error 3`, so the module must refuse anything
 * above its conservative 180-dot limit.
 */
const MAX_ROW_DOTS = 180

/** A 10-character pallet code — the payload that half-printed on the device. */
const PALLET_CODE = 'PAL-000123'

describe('renderBarcodeLabel', () => {
  it('emits a strictly 1-bit, fully opaque image', async () => {
    // Antialiased text or a transparent background would break the printer's
    // hard red===0 ink test; both must be gone by the time we return.
    const png = await renderBarcodeLabel({ symbology: 'ean13', value: '2044281856787', geometry })
    const stats = await analyse(png)

    expect(stats.grey).toBe(0)
    expect(stats.translucent).toBe(0)
    expect(stats.black).toBeGreaterThan(0)
    expect(stats.white).toBeGreaterThan(0)
  })

  it('fills exactly the configured label geometry', async () => {
    const png = await renderBarcodeLabel({ symbology: 'ean13', value: '2044281856787', geometry })
    const stats = await analyse(png)
    expect(stats.width).toBe(geometry.width)
    expect(stats.height).toBe(geometry.height)
  })

  it('produces an image the printer rasterizer accepts', async () => {
    const png = await renderBarcodeLabel({ symbology: 'ean13', value: '2044281856787', geometry })
    const raster = await rasterizeImage(png)
    expect(raster.width).toBe(geometry.width)
    expect(raster.height).toBe(geometry.height)
    expect(raster.rows.some((row) => row.some((byte) => byte !== 0))).toBe(true)
  })

  it.each(['ean13', 'ean8', 'upca', 'code128'] as const)('renders %s', async (symbology) => {
    const value = { ean13: '2044281856787', ean8: '96385074', upca: '012345678905', code128: 'SKU-1234' }[symbology]
    const stats = await analyse(await renderBarcodeLabel({ symbology, value, geometry }))
    expect(stats.grey).toBe(0)
    expect(stats.black).toBeGreaterThan(0)
  })

  it('scales down rather than overflowing a long Code128 payload', async () => {
    // At scale 2 this is wider than the label; the renderer must step down.
    const png = await renderBarcodeLabel({
      symbology: 'code128',
      value: 'ORD-2026-000123456789-LONG',
      geometry,
    })
    const stats = await analyse(png)
    expect(stats.width).toBe(geometry.width)
    expect(stats.black).toBeGreaterThan(0)
  })

  it('refuses a value the symbology cannot encode', async () => {
    // EAN-13 needs 13 digits with a valid check digit.
    await expect(
      renderBarcodeLabel({ symbology: 'ean13', value: 'not-a-gtin', geometry }),
    ).rejects.toBeInstanceOf(BarcodeRenderError)
  })

  it('refuses when even the smallest scale will not fit', async () => {
    await expect(
      renderBarcodeLabel({
        symbology: 'code128',
        value: 'X'.repeat(120),
        geometry: { width: 64, height: 32 },
      }),
    ).rejects.toBeInstanceOf(BarcodeRenderError)
  })

  describe('per-row dot ceiling', () => {
    const originalLimit = process.env.NIIMBOT_MAX_ROW_DOTS

    afterEach(() => {
      if (originalLimit === undefined) delete process.env.NIIMBOT_MAX_ROW_DOTS
      else process.env.NIIMBOT_MAX_ROW_DOTS = originalLimit
    })

    it('keeps a pallet Code128 label under the print head dot ceiling', async () => {
      // Regression: at scale 3 this renders 210 dots in its densest row, which
      // makes the B1 abort mid-label with `error 3` and eject a half-printed
      // pallet label. The renderer must step down instead.
      const png = await renderBarcodeLabel({ symbology: 'code128', value: PALLET_CODE, geometry })
      expect(await peakRowDots(png)).toBeLessThanOrEqual(MAX_ROW_DOTS)
    })

    it('still fits the label geometry after stepping down for ink', async () => {
      const png = await renderBarcodeLabel({ symbology: 'code128', value: PALLET_CODE, geometry })
      const stats = await analyse(png)
      expect(stats.width).toBe(geometry.width)
      expect(stats.height).toBe(geometry.height)
      expect(stats.grey).toBe(0)
      expect(stats.black).toBeGreaterThan(0)
    })

    it('leaves the catalog EAN-13 label on its established scale', async () => {
      // 129 dots is the scale-3 rendering that prints today; the ink ceiling
      // must not push product labels down a step.
      const png = await renderBarcodeLabel({ symbology: 'ean13', value: '2053301404433', geometry })
      expect(await peakRowDots(png)).toBe(129)
    })

    it('still selects the 172-dot EAN-13 rendering when the label is tall enough', async () => {
      // 172 dots is proven good on the device, so the ceiling must not exclude
      // it: on stock tall enough for scale 4, scale 4 is still what we print.
      const png = await renderBarcodeLabel({
        symbology: 'ean13',
        value: '2053301404433',
        geometry: { width: 384, height: 280 },
      })
      expect(await peakRowDots(png)).toBe(172)
    })

    it('honours NIIMBOT_MAX_ROW_DOTS', async () => {
      process.env.NIIMBOT_MAX_ROW_DOTS = '100'
      const png = await renderBarcodeLabel({ symbology: 'code128', value: PALLET_CODE, geometry })
      expect(await peakRowDots(png)).toBeLessThanOrEqual(100)
    })

    it.each(['not-a-number', '0', '-5', ''])(
      'falls back to the default ceiling when NIIMBOT_MAX_ROW_DOTS is %p',
      async (raw) => {
        process.env.NIIMBOT_MAX_ROW_DOTS = raw
        const png = await renderBarcodeLabel({ symbology: 'code128', value: PALLET_CODE, geometry })
        const peak = await peakRowDots(png)
        expect(peak).toBeLessThanOrEqual(MAX_ROW_DOTS)
        // Not the 100-dot override above: the invalid value must not tighten it.
        expect(peak).toBeGreaterThan(100)
      },
    )

    it('refuses a payload no scale can print within the dot ceiling', async () => {
      // Fits the label at scale 1 (365x43) but peaks at 198 dots there, so no
      // candidate satisfies both constraints. Better a loud refusal than a
      // label that silently stops halfway through.
      const render = renderBarcodeLabel({
        symbology: 'code128',
        value: 'M'.repeat(30),
        geometry,
      })
      await expect(render).rejects.toBeInstanceOf(BarcodeRenderError)
      await expect(render).rejects.toThrow(/black dots/)
    })

    it('measures peak ink exactly as the printer rasterizer counts it', async () => {
      const png = await renderBarcodeLabel({ symbology: 'code128', value: PALLET_CODE, geometry })
      expect(await peakRowDotsByPixel(png)).toBe(await peakRowDots(png))
    })
  })
})
