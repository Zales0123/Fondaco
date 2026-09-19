/**
 * The contract that matters: whatever comes out of here must survive
 * `rasterizeImage` unchanged. So these assert the properties the printer's
 * rasterizer depends on — pure 1-bit, correct geometry, a sane ink ratio —
 * rather than pixel-exact output, which would just pin bwip-js's font metrics.
 */
import { describe, expect, it } from '@jest/globals'
import { BarcodeRenderError, renderBarcodeLabel } from '../lib/barcodeImage'
import { DEFAULT_LABEL_GEOMETRY } from '../lib/labelGeometry'
import { rasterizeImage } from '../lib/rasterize'

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
})
