import { asFunction, asValue } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { createCredentialsService } from '@open-mercato/core/modules/integrations/lib/credentials-service'
import { createLabelPrinterService } from './lib/labelPrinterService'
import { createLabelPrinterHealthCheck } from './lib/labelPrinterHealthCheck'
import {
  readLabelPrinterPreset,
  resolveLabelPrinterSettings,
  type LabelPrinterSettings,
} from './lib/labelPrinterSettings'
import { LABEL_PRINTER_INTEGRATION_ID } from './integration'
import { createExclusiveRunner } from './lib/printQueue'

/** DI tokens this module owns. Exported so callers and tests name them once. */
export const LABEL_PRINTER_SERVICE = 'labelPrinterService' as const
export const LABEL_PRINTER_SETTINGS = 'labelPrinterSettings' as const
/** Named by `integration.ts`'s `healthCheck.service`; the two must agree. */
export const LABEL_PRINTER_HEALTH_CHECK = 'labelPrinterHealthCheck' as const

export type LabelPrinterSettingsResolver = {
  resolve: (scope: { tenantId: string; organizationId: string }) => Promise<LabelPrinterSettings>
}

/**
 * The printer lock is process-wide, not per request or per tenant: it guards one
 * physical device, so it is created once here and closed over by the singleton service.
 */
const runExclusive = createExclusiveRunner()

export function register(container: AppContainer) {
  container.register({
    [LABEL_PRINTER_SERVICE]: asFunction(() =>
      createLabelPrinterService({ runExclusive }),
    ).singleton(),

    /**
     * Settings are read per request, not per container: what an operator saved lives in
     * the tenant-scoped credentials store and is decrypted on read, while the service
     * above is shared by every tenant in the process.
     */
    [LABEL_PRINTER_SETTINGS]: asFunction((cradle: { em: EntityManager }) => ({
      async resolve(scope) {
        const credentials = createCredentialsService(cradle.em)
        // A tenant that never opened the tab has no row; the env preset is what keeps
        // the printer working exactly as it did before the tab existed.
        const stored = await credentials
          .resolve(LABEL_PRINTER_INTEGRATION_ID, scope)
          .catch(() => null)
        return resolveLabelPrinterSettings(stored, readLabelPrinterPreset())
      },
    } satisfies LabelPrinterSettingsResolver)).scoped(),

    [LABEL_PRINTER_HEALTH_CHECK]: asValue(
      createLabelPrinterHealthCheck({ readPreset: readLabelPrinterPreset }),
    ),
  })
}
