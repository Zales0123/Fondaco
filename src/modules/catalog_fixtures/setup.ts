import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { assignFixtureBarcodes } from './lib/seed'
import { seedBeverageProducts } from './lib/seedProducts'

export const setup: ModuleSetupConfig = {
  // Two passes, in this order:
  //  1. the beverage products, whose variants carry the real EAN-13 printed on
  //     the packaging — those are the ones a warehouse scan has to resolve;
  //  2. a backfill of demo GTINs onto everything else, because the installed
  //     catalog module's own `seedExamples` sets no barcode or gtinType and a
  //     label would have nothing to encode.
  // Both are idempotent, so re-running leaves existing records alone.
  // Runs for every enabled module on `mercato init` unless --no-examples.
  seedExamples: async (ctx) => {
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }

    const products = await seedBeverageProducts(ctx.em, ctx.container, scope)
    console.log(
      `    ↪ Catalog fixture products: ${products.created} created `
      + `(${products.images} with an image), ${products.skipped} already present.`,
    )
    for (const failure of products.failed) {
      console.log(`    ⚠️  ${failure.handle}: ${failure.reason}`)
    }

    const barcodes = await assignFixtureBarcodes(ctx.em, ctx.container, scope)
    console.log(
      `    ↪ Catalog fixture barcodes: ${barcodes.assigned} assigned, `
      + `${barcodes.alreadyPresent} already present, of ${barcodes.total} variants.`,
    )
    for (const failure of barcodes.failed) {
      console.log(`    ⚠️  ${failure.sku}: ${failure.reason}`)
    }
  },
}

export default setup
