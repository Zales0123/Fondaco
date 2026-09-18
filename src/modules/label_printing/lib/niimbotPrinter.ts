/**
 * The NiimBot B1 print job.
 *
 * The command sequence, the packets that are awaited, and the ones that are
 * deliberately fired without waiting are all taken from `niimctl.py`. Where the
 * reference has a quirk that works, it is mirrored rather than tidied up — most
 * notably the two unsolicited packets that must arrive before the page-end
 * command is sent.
 */
import {
  buildPacket,
  createNiimbotParser,
  isPrintComplete,
  NiimbotCommand,
  parseStatusPayload,
  type NiimbotPacket,
} from './niimbotProtocol'
import { countRowPixels, type RasterizedImage } from './rasterize'
import type { SerialTransport } from './types'

export const DEFAULT_DENSITY = 3
export const DEFAULT_LABEL_TYPE = 1
/** Matches `recv_packet`'s `port.timeout = 1.0`. */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 1000
/** The reference polls status at most 100 times, 200ms apart. */
export const STATUS_POLL_ATTEMPTS = 100
export const STATUS_POLL_INTERVAL_MS = 200
/** Whole-job ceiling, so a wedged printer cannot pin the request forever. */
export const DEFAULT_JOB_TIMEOUT_MS = 60_000

/** A blank run length is a single byte in the 0x84 payload. */
const MAX_BLANK_RUN = 0xff

export class PrinterError extends Error {
  readonly code: 'printer-error' | 'printer-timeout'
  constructor(message: string, code: PrinterError['code'] = 'printer-error') {
    super(message)
    this.name = 'PrinterError'
    this.code = code
  }
}

export type PrintOptions = {
  transport: SerialTransport
  image: RasterizedImage
  density?: number
  labelType?: number
  responseTimeoutMs?: number
  jobTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Buffers packets as they arrive so a caller can await the next one.
 *
 * The printer sends unsolicited packets mid-job, so responses have to be
 * queued rather than read synchronously in lockstep with writes.
 */
function createPacketReader(transport: SerialTransport) {
  const parser = createNiimbotParser()
  const queue: NiimbotPacket[] = []
  let notify: (() => void) | null = null

  transport.onData((chunk) => {
    const packets = parser.push(chunk)
    if (!packets.length) return
    queue.push(...packets)
    notify?.()
  })

  return {
    /** Resolves with the next packet, or null once `timeoutMs` elapses. */
    async read(timeoutMs: number): Promise<NiimbotPacket | null> {
      if (queue.length) return queue.shift()!
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          notify = null
          resolve(null)
        }, timeoutMs)
        notify = () => {
          clearTimeout(timer)
          notify = null
          resolve(queue.shift() ?? null)
        }
      })
    },
  }
}

export async function printRasterizedImage(options: PrintOptions): Promise<void> {
  const {
    transport,
    image,
    density = DEFAULT_DENSITY,
    labelType = DEFAULT_LABEL_TYPE,
    responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
    jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
    sleep = defaultSleep,
  } = options

  const deadline = Date.now() + jobTimeoutMs
  const checkDeadline = () => {
    if (Date.now() > deadline) {
      throw new PrinterError('Print job exceeded its time limit', 'printer-timeout')
    }
  }

  const reader = createPacketReader(transport)
  const send = async (cmd: number, payload?: Buffer) => {
    checkDeadline()
    await transport.write(buildPacket(cmd, payload))
  }
  /** Send and consume the acknowledgement, matching the reference's blocking read. */
  const sendAndAck = async (cmd: number, payload?: Buffer) => {
    await send(cmd, payload)
    await reader.read(responseTimeoutMs)
  }

  const pageCount = 1

  await sendAndAck(NiimbotCommand.SetDensity, Buffer.from([density]))
  await sendAndAck(NiimbotCommand.SetLabelType, Buffer.from([labelType]))

  // 7-byte print-start variant the B1 requires: page count (u16), then four
  // unknown zero bytes and a page-colour byte.
  const printStart = Buffer.alloc(7)
  printStart.writeUInt16BE(pageCount, 0)
  await sendAndAck(NiimbotCommand.PrintStart, printStart)

  await sendAndAck(NiimbotCommand.PageStart, Buffer.from([0x01]))

  const pageSize = Buffer.alloc(6)
  pageSize.writeUInt16BE(image.height, 0)
  pageSize.writeUInt16BE(image.width, 2)
  pageSize.writeUInt16BE(1, 4)
  await sendAndAck(NiimbotCommand.SetPageSize, pageSize)

  // Row packets are fired without awaiting a reply, exactly as the reference
  // does; the printer answers once at the end of the page.
  let blankRun = 0
  let blankStart = -1

  const flushBlankRun = async () => {
    while (blankRun > 0) {
      // The reference packs the run length into one byte and would silently
      // truncate past 255 rows; split long runs instead.
      const chunk = Math.min(blankRun, MAX_BLANK_RUN)
      const payload = Buffer.alloc(3)
      payload.writeUInt16BE(blankStart, 0)
      payload.writeUInt8(chunk, 2)
      await send(NiimbotCommand.BlankRows, payload)
      blankStart += chunk
      blankRun -= chunk
    }
    blankRun = 0
  }

  for (const [rowNumber, row] of image.rows.entries()) {
    const pixels = countRowPixels(row)
    if (pixels === 0) {
      if (blankRun === 0) blankStart = rowNumber
      blankRun += 1
      continue
    }
    await flushBlankRun()
    const header = Buffer.alloc(6)
    header.writeUInt16BE(rowNumber, 0)
    header.writeUInt16BE(pixels, 2)
    header.writeUInt16BE(1, 4)
    await send(NiimbotCommand.PrintRow, Buffer.concat([header, row]))
  }
  await flushBlankRun()

  // Do not send page-end until these two packets arrive. The reference calls
  // them "mysterious"; skipping the wait leaves the printer mid-page.
  await reader.read(responseTimeoutMs)
  await reader.read(responseTimeoutMs)

  await sendAndAck(NiimbotCommand.PageEnd, Buffer.from([0x01]))

  let completed = false
  for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
    checkDeadline()
    await send(NiimbotCommand.PrintStatus)
    const packet = await reader.read(responseTimeoutMs)
    if (!packet) continue

    const status = parseStatusPayload(packet.payload)
    if (!status) continue
    if (status.error) {
      throw new PrinterError(`Printer reported error ${status.error}`)
    }
    if (isPrintComplete(status, pageCount)) {
      completed = true
      break
    }
    await sleep(STATUS_POLL_INTERVAL_MS)
  }

  if (!completed) {
    throw new PrinterError('Printer never reported the job as finished', 'printer-timeout')
  }

  await send(NiimbotCommand.PrintEnd, Buffer.from([0x01]))
}
