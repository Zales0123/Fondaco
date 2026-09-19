/**
 * "Test connection" for the printer's settings tab.
 *
 * Opening the serial port is the whole probe, and it is a good one: it is exactly what
 * the print route does first, so a green light here means the next label has a link to
 * travel down. It deliberately prints nothing — a health check that spat out a sticker
 * every time somebody pressed it would be a poor one.
 */
import {
  resolveLabelPrinterSettings,
  type LabelPrinterSettings,
} from './labelPrinterSettings'
import { DEFAULT_OPEN_TIMEOUT_MS, withDeadline } from './labelPrinterService'
import { openSerialTransport } from './serialTransport'
import type { SerialTransportFactory } from './types'

/** Structurally the installed module's contract; its own types are not exported. */
export type PrinterHealthResult = {
  status: 'healthy' | 'degraded' | 'unhealthy'
  message?: string
  details?: Record<string, unknown>
}

export type IntegrationScopeLike = { tenantId: string; organizationId: string }

export function createLabelPrinterHealthCheck(deps: {
  readPreset: () => LabelPrinterSettings
  openTransport?: SerialTransportFactory
}) {
  const { readPreset, openTransport = (portPath) => openSerialTransport(portPath) } = deps

  return {
    async check(
      credentials: Record<string, unknown> | null,
      _scope: IntegrationScopeLike,
    ): Promise<PrinterHealthResult> {
      const settings = resolveLabelPrinterSettings(credentials, readPreset())

      if (!settings.portPath) {
        // Configured, and configured to not print. That is an answer, not a fault.
        return {
          status: 'degraded',
          message: 'No serial port is set, so label printing is switched off.',
        }
      }

      let transport
      try {
        transport = await withDeadline(
          DEFAULT_OPEN_TIMEOUT_MS,
          () => openTransport(settings.portPath as string),
          () => new Error(`timed out after ${DEFAULT_OPEN_TIMEOUT_MS}ms`),
        )
      } catch (error) {
        return {
          status: 'unhealthy',
          message: (error as Error).message,
          details: { portPath: settings.portPath },
        }
      }

      // Holding it open would refuse every later print with `printer-busy`.
      await transport.close().catch(() => undefined)
      return {
        status: 'healthy',
        message: 'The label printer answered on its serial port.',
        details: { portPath: settings.portPath },
      }
    },
  }
}
