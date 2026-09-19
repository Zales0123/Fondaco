/**
 * A scripted stand-in for the B1 over serial.
 *
 * It answers the commands the real printer answers, stays silent for the row
 * packets it does not answer, and emits the two unsolicited "page consumed"
 * packets shortly after the last row lands — which is what lets the print job
 * be tested end to end without the printer.
 */
import {
  buildPacket,
  createNiimbotParser,
  NiimbotCommand,
  PRINT_PROGRESS_COMPLETE,
  type NiimbotPacket,
} from '../lib/niimbotProtocol'
import type { SerialTransport } from '../lib/types'

const ACK = 0x31

export type FakePrinterOptions = {
  /** Status payloads handed out in order; the last one repeats. */
  statusSequence?: { pagesDone: number; progress: number; busy: number; error: number }[]
  /** Suppress the two packets that gate page-end, to exercise the timeout path. */
  emitPageDone?: boolean
  /** Delay after the final row packet before the page-done packets appear. */
  pageDoneDelayMs?: number
}

function statusPacket(status: { pagesDone: number; progress: number; busy: number; error: number }) {
  const payload = Buffer.alloc(10)
  payload.writeUInt16BE(status.pagesDone, 0)
  payload.writeUInt16BE(status.progress, 2)
  payload.writeUInt16BE(status.busy, 6)
  payload.writeUInt16BE(status.error, 8)
  return buildPacket(NiimbotCommand.PrintStatus, payload)
}

export function createFakePrinter(options: FakePrinterOptions = {}) {
  const {
    statusSequence = [{ pagesDone: 1, progress: PRINT_PROGRESS_COMPLETE, busy: 0, error: 0 }],
    emitPageDone = true,
    pageDoneDelayMs = 1,
  } = options

  const received: NiimbotPacket[] = []
  const parser = createNiimbotParser()
  const listeners: ((chunk: Buffer) => void)[] = []
  let closed = false
  let statusIndex = 0
  let pageDoneTimer: NodeJS.Timeout | null = null
  let pageDoneSent = false

  const emit = (data: Buffer) => {
    for (const listener of listeners) listener(data)
  }

  const schedulePageDone = () => {
    if (!emitPageDone || pageDoneSent) return
    if (pageDoneTimer) clearTimeout(pageDoneTimer)
    pageDoneTimer = setTimeout(() => {
      pageDoneSent = true
      emit(buildPacket(ACK, Buffer.from([0x01])))
      emit(buildPacket(ACK, Buffer.from([0x02])))
    }, pageDoneDelayMs)
    // Do not hold the event loop open if the job aborts first.
    pageDoneTimer.unref?.()
  }

  const transport: SerialTransport = {
    async write(data) {
      if (closed) throw new Error('write after close')
      for (const packet of parser.push(data)) {
        received.push(packet)
        switch (packet.cmd) {
          case NiimbotCommand.PrintRow:
          case NiimbotCommand.BlankRows:
            schedulePageDone()
            break
          case NiimbotCommand.PrintStatus: {
            const status = statusSequence[Math.min(statusIndex, statusSequence.length - 1)]
            statusIndex += 1
            emit(statusPacket(status))
            break
          }
          case NiimbotCommand.PrintEnd:
            break
          default:
            emit(buildPacket(ACK, Buffer.from([0x01])))
            break
        }
      }
    },
    onData(listener) {
      listeners.push(listener)
    },
    async close() {
      closed = true
      if (pageDoneTimer) clearTimeout(pageDoneTimer)
    },
  }

  return {
    transport,
    received,
    get closed() {
      return closed
    },
    /** Command bytes in the order the driver sent them. */
    commandSequence: () => received.map((packet) => packet.cmd),
  }
}
