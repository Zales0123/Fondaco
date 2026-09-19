/**
 * Application-facing label printing service.
 *
 * Owns the parts the API route should not care about: reading configuration,
 * holding the printer lock, opening and — importantly — always closing the
 * serial port, and turning low-level failures into codes the route can map to
 * HTTP statuses.
 */
import { printRasterizedImage, PrinterError, DEFAULT_JOB_TIMEOUT_MS } from './niimbotPrinter'
import { rasterizeImage, RasterizeError } from './rasterize'
import { createExclusiveRunner, PrinterBusyError, type ExclusiveRunner } from './printQueue'
import { openSerialTransport } from './serialTransport'
import type { SerialTransportFactory } from './types'

export class PrinterUnavailableError extends Error {
  readonly code = 'printer-unavailable' as const
  constructor(message: string) {
    super(message)
    this.name = 'PrinterUnavailableError'
  }
}

export type LabelPrinterConfig = {
  /** Serial device the printer is paired on, e.g. `/dev/tty.B1-XXXXXXXX`. */
  portPath: string | null
  density: number
  labelType: number
  jobTimeoutMs?: number
  /**
   * How long to wait for the serial port to open before giving up.
   *
   * Separate from `jobTimeoutMs` because it maps to a different answer: failing
   * here means the printer was never reached (503), while failing later means a
   * job that started and stalled (502).
   */
  openTimeoutMs?: number
}

/**
 * Deliberately generous. This timer exists to stop an infinite wedge, not to
 * enforce a snappy open: a measured B1 job over Bluetooth RFCOMM took 27.5s
 * end to end, so a tight bound here would refuse pairings that do work. The
 * caller's own abort is what keeps a waiting operator from staring at a spinner.
 */
export const DEFAULT_OPEN_TIMEOUT_MS = 30_000

/**
 * Races `work` against a real timer.
 *
 * `niimbotPrinter` already carries a `jobTimeoutMs`, but it enforces it with a
 * check *between* awaits. That only fires while the job is still making
 * progress. A wedged RFCOMM link neither fails nor progresses — `port.drain()`
 * simply never calls back, control never returns to JS, and the check is never
 * reached again. Only a timer running beside the work can end that.
 *
 * The losing side keeps running: a promise cannot be cancelled. Closing the
 * port in the caller's `finally` is what abandons it, because `serialport`
 * errors any pending write once the handle is gone.
 */
async function withDeadline<T>(
  timeoutMs: number,
  work: () => Promise<T>,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs)
      }),
    ])
  } finally {
    // Leaving it armed would hold the event loop open for the full timeout.
    if (timer) clearTimeout(timer)
  }
}

export type LabelPrinterService = {
  isConfigured: () => boolean
  printImage: (source: Buffer) => Promise<void>
}

export function createLabelPrinterService(deps: {
  config: LabelPrinterConfig
  openTransport?: SerialTransportFactory
  runExclusive?: ExclusiveRunner
}): LabelPrinterService {
  const {
    config,
    openTransport = (portPath) => openSerialTransport(portPath),
    runExclusive = createExclusiveRunner(),
  } = deps

  return {
    isConfigured: () => Boolean(config.portPath),

    async printImage(source) {
      const portPath = config.portPath
      if (!portPath) {
        throw new PrinterUnavailableError(
          'No label printer configured; set NIIMBOT_SERIAL_PORT',
        )
      }

      // Rasterize before claiming the printer: a bad image should fail fast
      // without locking out a concurrent, valid job.
      const image = await rasterizeImage(source)

      const openTimeoutMs = config.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
      const jobTimeoutMs = config.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS

      return runExclusive(async () => {
        let transport
        try {
          transport = await withDeadline(
            openTimeoutMs,
            () => openTransport(portPath),
            () => new Error(`timed out after ${openTimeoutMs}ms`),
          )
        } catch (error) {
          throw new PrinterUnavailableError(
            `Could not open label printer at ${portPath}: ${(error as Error).message}`,
          )
        }

        try {
          await withDeadline(
            jobTimeoutMs,
            () =>
              printRasterizedImage({
                transport,
                image,
                density: config.density,
                labelType: config.labelType,
                jobTimeoutMs,
              }),
            () =>
              new PrinterError(
                `Print job exceeded its ${jobTimeoutMs}ms time limit`,
                'printer-timeout',
              ),
          )
        } finally {
          // Leaving the port open would block every later job.
          await transport.close().catch(() => undefined)
        }
      })
    },
  }
}

export { PrinterBusyError, PrinterError, RasterizeError }
