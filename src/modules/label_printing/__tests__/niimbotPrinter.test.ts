import { describe, expect, it } from '@jest/globals'
import { NiimbotCommand, PRINT_PROGRESS_COMPLETE } from '../lib/niimbotProtocol'
import { printRasterizedImage, PrinterError } from '../lib/niimbotPrinter'
import { ROW_BYTE_LENGTH, type RasterizedImage } from '../lib/rasterize'
import { createFakePrinter } from '../testing/fakeSerialTransport'

/** Build a synthetic bitmap: `pattern[y]` true means the row has ink. */
function makeImage(pattern: boolean[], width = 8): RasterizedImage {
  return {
    width,
    height: pattern.length,
    rows: pattern.map((inked) => {
      const row = Buffer.alloc(ROW_BYTE_LENGTH)
      if (inked) row[0] = 0xff
      return row
    }),
  }
}

const noSleep = async () => {}

describe('printRasterizedImage', () => {
  it('sends the reference command sequence for a simple page', async () => {
    const printer = createFakePrinter()
    await printRasterizedImage({
      transport: printer.transport,
      image: makeImage([true, false, true]),
      sleep: noSleep,
    })

    expect(printer.commandSequence()).toEqual([
      NiimbotCommand.SetDensity,
      NiimbotCommand.SetLabelType,
      NiimbotCommand.PrintStart,
      NiimbotCommand.PageStart,
      NiimbotCommand.SetPageSize,
      NiimbotCommand.PrintRow, // row 0
      NiimbotCommand.BlankRows, // row 1, flushed before row 2
      NiimbotCommand.PrintRow, // row 2
      NiimbotCommand.PageEnd,
      NiimbotCommand.PrintStatus,
      NiimbotCommand.PrintEnd,
    ])
  })

  it('encodes density, label type and page size as the printer expects', async () => {
    const printer = createFakePrinter()
    await printRasterizedImage({
      transport: printer.transport,
      image: makeImage([true], 312),
      density: 5,
      labelType: 2,
      sleep: noSleep,
    })

    const sent = (cmd: number) => printer.received.find((p) => p.cmd === cmd)!.payload
    expect(sent(NiimbotCommand.SetDensity)).toEqual(Buffer.from([5]))
    expect(sent(NiimbotCommand.SetLabelType)).toEqual(Buffer.from([2]))

    const printStart = sent(NiimbotCommand.PrintStart)
    expect(printStart).toHaveLength(7)
    expect(printStart.readUInt16BE(0)).toBe(1)

    const pageSize = sent(NiimbotCommand.SetPageSize)
    expect(pageSize.readUInt16BE(0)).toBe(1) // height
    expect(pageSize.readUInt16BE(2)).toBe(312) // width
    expect(pageSize.readUInt16BE(4)).toBe(1) // copies
  })

  it('carries the row number, ink count and row bytes in each row packet', async () => {
    const printer = createFakePrinter()
    await printRasterizedImage({
      transport: printer.transport,
      image: makeImage([false, true]),
      sleep: noSleep,
    })

    const row = printer.received.find((p) => p.cmd === NiimbotCommand.PrintRow)!.payload
    expect(row).toHaveLength(6 + ROW_BYTE_LENGTH)
    expect(row.readUInt16BE(0)).toBe(1) // row index
    expect(row.readUInt16BE(2)).toBe(8) // set bits in 0xff
    expect(row.readUInt16BE(4)).toBe(1) // repeat
  })

  it('emits a trailing blank run after the last inked row', async () => {
    const printer = createFakePrinter()
    await printRasterizedImage({
      transport: printer.transport,
      image: makeImage([true, false, false]),
      sleep: noSleep,
    })

    const blank = printer.received.find((p) => p.cmd === NiimbotCommand.BlankRows)!.payload
    expect(blank.readUInt16BE(0)).toBe(1) // starts at row 1
    expect(blank.readUInt8(2)).toBe(2) // two blank rows
  })

  it('splits a blank run longer than one length byte can hold', async () => {
    const printer = createFakePrinter()
    const pattern = [true, ...Array<boolean>(300).fill(false)]
    await printRasterizedImage({
      transport: printer.transport,
      image: makeImage(pattern),
      sleep: noSleep,
    })

    const blanks = printer.received.filter((p) => p.cmd === NiimbotCommand.BlankRows)
    expect(blanks).toHaveLength(2)
    expect(blanks[0].payload.readUInt16BE(0)).toBe(1)
    expect(blanks[0].payload.readUInt8(2)).toBe(255)
    expect(blanks[1].payload.readUInt16BE(0)).toBe(256)
    expect(blanks[1].payload.readUInt8(2)).toBe(45)
  })

  it('polls status until the printer reports the page finished', async () => {
    const printer = createFakePrinter({
      statusSequence: [
        { pagesDone: 0, progress: 0x3200, busy: 1, error: 0 },
        { pagesDone: 1, progress: 0x6400, busy: 1, error: 0 },
        { pagesDone: 1, progress: PRINT_PROGRESS_COMPLETE, busy: 0, error: 0 },
      ],
    })
    await printRasterizedImage({
      transport: printer.transport,
      image: makeImage([true]),
      sleep: noSleep,
    })

    expect(printer.received.filter((p) => p.cmd === NiimbotCommand.PrintStatus)).toHaveLength(3)
    expect(printer.commandSequence().at(-1)).toBe(NiimbotCommand.PrintEnd)
  })

  it('throws when the printer reports an error, without sending print-end', async () => {
    const printer = createFakePrinter({
      statusSequence: [{ pagesDone: 0, progress: 0, busy: 1, error: 5 }],
    })

    await expect(
      printRasterizedImage({
        transport: printer.transport,
        image: makeImage([true]),
        sleep: noSleep,
      }),
    ).rejects.toThrow(/Printer reported error 5/)

    expect(printer.commandSequence()).not.toContain(NiimbotCommand.PrintEnd)
  })

  it('gives up when the printer never reports completion', async () => {
    const printer = createFakePrinter({
      statusSequence: [{ pagesDone: 0, progress: 0, busy: 1, error: 0 }],
    })

    await expect(
      printRasterizedImage({
        transport: printer.transport,
        image: makeImage([true]),
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: 'printer-timeout' })
  })

  it('aborts once the whole-job deadline passes', async () => {
    const printer = createFakePrinter({ emitPageDone: false })

    await expect(
      printRasterizedImage({
        transport: printer.transport,
        image: makeImage([true]),
        responseTimeoutMs: 5,
        jobTimeoutMs: 1,
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(PrinterError)
  })
})
