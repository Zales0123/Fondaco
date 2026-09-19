import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { assignFixtureBarcodes } from './lib/seed'

export const setup: ModuleSetupConfig = {
  // The installed catalog module's `seedExamples` creates products and variants
  // but sets no barcode or gtinType on any of them, so a fresh install has
  // nothing for a label to encode. This hook backfills them right after, and is
  // idempotent — variants that already carry a barcode are left alone.
  // Runs for every enabled module on `mercato init` unless --no-examples.
  seedExamples: async (ctx) => {
    const summary = await assignFixtureBarcodes(ctx.em, ctx.container, {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    })
    console.log(
      `    ↪ Catalog fixture barcodes: ${summary.assigned} assigned, `
      + `${summary.alreadyPresent} already present, of ${summary.total} variants.`,
    )
    for (const failure of summary.failed) {
      console.log(`    ⚠️  ${failure.sku}: ${failure.reason}`)
    }
  },
}

export default setup
