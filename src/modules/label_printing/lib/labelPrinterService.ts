/**
 * Application-facing label printing service.
 *
 * Owns the parts the API route should not care about: reading configuration,
 * holding the printer lock, opening and — importantly — always closing the
 * serial port, and turning low-level failures into codes the route can map to
 * HTTP statuses.
 */
import { printRasterizedImage, PrinterError } from './niimbotPrinter'
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

      return runExclusive(async () => {
        let transport
        try {
          transport = await openTransport(portPath)
        } catch (error) {
          throw new PrinterUnavailableError(
            `Could not open label printer at ${portPath}: ${(error as Error).message}`,
          )
        }

        try {
          await printRasterizedImage({
            transport,
            image,
            density: config.density,
            labelType: config.labelType,
            jobTimeoutMs: config.jobTimeoutMs,
          })
        } finally {
          // Leaving the port open would block every later job.
          await transport.close().catch(() => undefined)
        }
      })
    },
  }
}

export { PrinterBusyError, PrinterError, RasterizeError }
