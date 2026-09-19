import { describe, expect, it } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createLabelPrinterService,
  PrinterUnavailableError,
} from '../lib/labelPrinterService'
import { PrinterBusyError } from '../lib/printQueue'
import { RasterizeError } from '../lib/rasterize'
import { createFakePrinter } from '../testing/fakeSerialTransport'
import type { SerialTransport } from '../lib/types'

const assetPath = path.join(__dirname, 'fixtures', 'barcode.gif')
const config = { portPath: '/dev/tty.fake', density: 3, labelType: 1, jobTimeoutMs: 10_000 }

function serviceWith(openTransport: (portPath: string) => Promise<SerialTransport>) {
  return createLabelPrinterService({ config, openTransport })
}

describe('createLabelPrinterService', () => {
  it('reports whether a printer is configured', () => {
    expect(serviceWith(async () => createFakePrinter().transport).isConfigured()).toBe(true)
    expect(
      createLabelPrinterService({ config: { ...config, portPath: null } }).isConfigured(),
    ).toBe(false)
  })

  it('prints the label and always closes the port', async () => {
    const printer = createFakePrinter()
    const service = serviceWith(async () => printer.transport)

    await service.printImage(await readFile(assetPath))

    expect(printer.received.length).toBeGreaterThan(0)
    expect(printer.closed).toBe(true)
  })

  it('closes the port even when the job fails', async () => {
    const printer = createFakePrinter({
      statusSequence: [{ pagesDone: 0, progress: 0, busy: 1, error: 9 }],
    })
    const service = serviceWith(async () => printer.transport)

    await expect(service.printImage(await readFile(assetPath))).rejects.toThrow(/error 9/)
    expect(printer.closed).toBe(true)
  })

  it('refuses to print when no port is configured', async () => {
    const service = createLabelPrinterService({ config: { ...config, portPath: null } })
    await expect(service.printImage(await readFile(assetPath))).rejects.toBeInstanceOf(
      PrinterUnavailableError,
    )
  })

  it('maps a failure to open the port to printer-unavailable', async () => {
    const service = serviceWith(async () => {
      throw new Error('Resource busy, cannot open /dev/tty.fake')
    })
    await expect(service.printImage(await readFile(assetPath))).rejects.toMatchObject({
      code: 'printer-unavailable',
    })
  })

  it('rejects a second concurrent job instead of interleaving packets', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const printer = createFakePrinter()
    const service = serviceWith(async () => {
      await gate
      return printer.transport
    })

    const image = await readFile(assetPath)
    const first = service.printImage(image)
    // Let the first job reach the lock before the second one arrives.
    await Promise.resolve()
    const second = service.printImage(image)

    await expect(second).rejects.toBeInstanceOf(PrinterBusyError)
    release!()
    await expect(first).resolves.toBeUndefined()
  })

  it('releases the lock after a job finishes', async () => {
    const service = serviceWith(async () => createFakePrinter().transport)
    const image = await readFile(assetPath)

    await service.printImage(image)
    await expect(service.printImage(image)).resolves.toBeUndefined()
  })

  it('rejects a bad image without ever opening the port', async () => {
    const { createCanvas } = await import('@napi-rs/canvas')
    const tooWide = createCanvas(408, 4).toBuffer('image/png')
    let opened = false
    const service = serviceWith(async () => {
      opened = true
      return createFakePrinter().transport
    })

    await expect(service.printImage(tooWide)).rejects.toBeInstanceOf(RasterizeError)
    expect(opened).toBe(false)
  })
})
