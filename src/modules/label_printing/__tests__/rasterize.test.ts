/**
 * Differential test against the reference Python implementation.
 *
 * `fixtures/barcode-rows.json` was produced by running `niimctl.py`'s exact
 * rasterization loop over `fixtures/barcode.gif`. If this test passes, the port's
 * bitmap output is byte-identical to the implementation known to drive the
 * printer correctly — which is the only correctness oracle available for an
 * undocumented protocol.
 */
import { describe, expect, it } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  countRowPixels,
  rasterizeImage,
  RasterizeError,
  ROW_BYTE_LENGTH,
} from '../lib/rasterize'

type Golden = {
  width: number
  height: number
  rows: string[]
  printPx: number[]
}

const assetPath = path.join(__dirname, 'fixtures', 'barcode.gif')
const goldenPath = path.join(__dirname, 'fixtures', 'barcode-rows.json')

async function loadGolden(): Promise<Golden> {
  return JSON.parse(await readFile(goldenPath, 'utf8')) as Golden
}

describe('rasterizeImage', () => {
  it('reproduces the reference implementation byte for byte', async () => {
    const golden = await loadGolden()
    const result = await rasterizeImage(await readFile(assetPath))

    expect(result.width).toBe(golden.width)
    expect(result.height).toBe(golden.height)
    expect(result.rows).toHaveLength(golden.rows.length)

    const actual = result.rows.map((row) => row.toString('hex'))
    expect(actual).toEqual(golden.rows)
  })

  it('pads every row to the full printer head width', async () => {
    const result = await rasterizeImage(await readFile(assetPath))
    for (const row of result.rows) {
      expect(row).toHaveLength(ROW_BYTE_LENGTH)
    }
  })

  it('counts set bits the way the 0x85 payload expects', async () => {
    const golden = await loadGolden()
    const result = await rasterizeImage(await readFile(assetPath))
    expect(result.rows.map(countRowPixels)).toEqual(golden.printPx)
  })

  it('rejects an image wider than the print head', async () => {
    const { createCanvas } = await import('@napi-rs/canvas')
    const canvas = createCanvas(408, 10)
    await expect(rasterizeImage(canvas.toBuffer('image/png'))).rejects.toThrow(RasterizeError)
  })

  it('rejects a width that is not a multiple of 8', async () => {
    const { createCanvas } = await import('@napi-rs/canvas')
    const canvas = createCanvas(100, 10)
    await expect(rasterizeImage(canvas.toBuffer('image/png'))).rejects.toThrow(/multiple of 8/)
  })
})
