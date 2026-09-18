import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { seedWmsFixtures } from './lib/seed'

export const setup: ModuleSetupConfig = {
  // The installed wms module ships `seedDefaults` only (integration toggles +
  // WMS roles) and declares no `seedExamples`, so there is no upstream hook to
  // override — the demo warehouse data is contributed from here instead.
  // `mercato init` calls this for every enabled module unless --no-examples.
  seedExamples: async (ctx) => {
    const summary = await seedWmsFixtures(ctx.em, ctx.container, {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    })
    if (summary.skipped) {
      console.log(`    ↪ WMS fixtures skipped (${summary.reason}).`)
      return
    }
    console.log(
      `    ↪ WMS fixtures: ${summary.warehouses} warehouses, ${summary.zones} zones, `
      + `${summary.locations} locations, ${summary.profiles} profiles, ${summary.lots} lots, `
      + `${summary.receipts} receipts, ${summary.moves} moves, ${summary.reservations} reservations, `
      + `${summary.cycleCounts} cycle counts, ${summary.assignments} order assignments.`,
    )
    for (const warning of summary.warnings) console.log(`    ⚠️  ${warning}`)
  },
}

export default setup
