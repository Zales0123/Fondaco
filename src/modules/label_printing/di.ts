import { asFunction } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import {
  createLabelPrinterService,
  type LabelPrinterConfig,
} from './lib/labelPrinterService'
import { createExclusiveRunner } from './lib/printQueue'

/** DI token this module owns. Exported so callers and tests name it once. */
export const LABEL_PRINTER_SERVICE = 'labelPrinterService' as const

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function readLabelPrinterConfig(): LabelPrinterConfig {
  const portPath = process.env.NIIMBOT_SERIAL_PORT?.trim()
  return {
    portPath: portPath && portPath.length > 0 ? portPath : null,
    density: readIntEnv('NIIMBOT_DENSITY', 3),
    labelType: readIntEnv('NIIMBOT_LABEL_TYPE', 1),
    jobTimeoutMs: readIntEnv('NIIMBOT_JOB_TIMEOUT_MS', 60_000),
  }
}

/**
 * The printer lock is process-wide, not per request: it guards one physical
 * device, so it is created once here and closed over by the singleton service.
 */
const runExclusive = createExclusiveRunner()

export function register(container: AppContainer) {
  container.register({
    [LABEL_PRINTER_SERVICE]: asFunction(() =>
      createLabelPrinterService({ config: readLabelPrinterConfig(), runExclusive }),
    ).singleton(),
  })
}
