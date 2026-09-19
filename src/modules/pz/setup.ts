import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { InitSetupContext, ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import {
  FeatureToggle,
  FeatureToggleOverride,
} from '@open-mercato/core/modules/feature_toggles/data/entities'
import { seedWmsIntegrationToggles } from '@open-mercato/core/modules/wms/lib/wmsIntegrationToggles'
import { STOCK_POSTING_TOGGLE } from './lib/destinations'

export const GOODS_RECEIPT_FEATURES = [
  'pz.goodsReceipts.view',
  'pz.goodsReceipts.manage',
  'pz.goodsReceipts.confirm',
  'pz.receiving.count',
  'pz.receiving.confirm',
] as const

/**
 * The scope an init-time write runs under. There is no actor during `mercato init`, so the
 * tenant the setup was called for is the whole of it — exactly as the subscriber that posts
 * stock builds its own context (`lib/stockPostingAutomation.ts`).
 */
function buildCommandContext(ctx: InitSetupContext): CommandRuntimeContext {
  return {
    container: ctx.container as CommandRuntimeContext['container'],
    auth: null,
    organizationScope: null,
    selectedOrganizationId: ctx.organizationId,
    organizationIds: [ctx.organizationId],
  }
}

/**
 * Turns stock posting on for this tenant (ADR-0013).
 *
 * `wms` ships `wms_integration_procurement_goods_receipt` default-off, which is right for a
 * general installation and wrong for Fondaco: posting counted goods onto stock is what this
 * app is for, so a fresh install must adjust inventory without anybody hunting for a switch.
 *
 * The toggle row itself is platform-wide and owned by `wms`. Three things follow:
 *
 *  - We seed it through `wms`'s own idempotent seeder rather than writing the row. `pz`
 *    declares no `requires` on `wms`, so `seedDefaults` order between the two is not
 *    guaranteed, and relying on `wms` having gone first would be a coin toss.
 *  - The default cannot be moved on the toggle itself — that is one global definition shared
 *    by every tenant of the installation. What is per-tenant is the *override*, so that is
 *    what this writes, under `ctx.tenantId` and nothing else.
 *  - An override that already exists is left exactly as it is. Repeated `mercato init` runs
 *    therefore converge instead of fighting: an operator who turned posting off for their
 *    tenant stays off, and only a tenant that has never expressed a preference gets ours.
 *    That, not a rewrite on every run, is what idempotent means here.
 *
 * The write goes through `feature_toggles.overrides.changeState` rather than `em.create`,
 * because the command is what invalidates the resolution cache the toggle is read back from
 * and what records the change where a later operator can see who set it.
 */
async function enableStockPostingByDefault(ctx: InitSetupContext): Promise<void> {
  await seedWmsIntegrationToggles(ctx.em)

  const toggle = await ctx.em.findOne(FeatureToggle, {
    identifier: STOCK_POSTING_TOGGLE,
    deletedAt: null,
  })
  if (!toggle) {
    console.log(`    ⚠️  Stock posting toggle ${STOCK_POSTING_TOGGLE} is not installed; left as is.`)
    return
  }

  const existing = await ctx.em.findOne(FeatureToggleOverride, {
    toggle: toggle.id,
    tenantId: ctx.tenantId,
  })
  if (existing) {
    console.log(
      `    ↪ Stock posting: tenant override already set to ${JSON.stringify(existing.value)}; left as is.`,
    )
    return
  }

  const commandBus = ctx.container.resolve('commandBus') as CommandBus
  await commandBus.execute('feature_toggles.overrides.changeState', {
    input: {
      toggleId: toggle.id,
      tenantId: ctx.tenantId,
      isOverride: true,
      overrideValue: true,
    },
    ctx: buildCommandContext(ctx),
  })
  console.log('    ↪ Stock posting: enabled for this tenant.')
}

/**
 * Grants are declarative: the ACL sync applies the same set on every run, so repeated
 * initialisation converges instead of accumulating. There is deliberately no `seedExamples`
 * — a demo delivery would be indistinguishable from a real one in a document series users
 * reconcile against paper.
 *
 * `seedDefaults` is structural rather than demo data, so it also runs under `--no-examples`:
 * an installation that wants no fixtures still wants its deliveries to move stock.
 */
export const setup: ModuleSetupConfig = {
  seedDefaults: enableStockPostingByDefault,
  defaultRoleFeatures: {
    superadmin: [...GOODS_RECEIPT_FEATURES],
    admin: [...GOODS_RECEIPT_FEATURES],
  },
}

export default setup
