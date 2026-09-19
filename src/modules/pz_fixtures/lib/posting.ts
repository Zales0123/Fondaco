/**
 * Turning a freshly seeded environment into one where a counted delivery can actually be
 * posted onto stock.
 *
 * Why fixtures flip an integration toggle at all. Confirming a Goods Receipt posts its
 * counted quantities into `wms` only when `wms_integration_procurement_goods_receipt` is on,
 * and `wms` ships it off by default (ADR-0005) — rightly, since an installation that never
 * asked for the bridge must not have stock moved under it. But a demo environment that seeds
 * eight deliveries and then silently refuses to post any of them demonstrates the wrong
 * thing, and the alternative is a reviewer hand-editing a platform-wide toggle table before
 * the fixtures mean anything. So the flip lives here, where it is opt-out (`--no-posting`),
 * scoped to the seeded tenant as an override rather than changed globally, and reported in
 * the summary — an environment-shaping decision stated out loud, not a default changed
 * behind anyone's back.
 *
 * Why a Default Destination is seeded too. Confirmation needs a Location to post into, and a
 * Warehouse with no preselection asks whoever confirms to pick one — which is correct
 * behaviour and a poor first demo. What is written is only a preselection: the confirmation
 * re-validates it against the eligible Locations exactly as it validates a hand-picked one,
 * so a value that later goes stale prefills nothing instead of quietly posting stock
 * somewhere else (ADR-0011).
 */
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { setCustomFieldsIfAny } from '@open-mercato/shared/lib/commands/helpers'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { FeatureToggle } from '@open-mercato/core/modules/feature_toggles/data/entities'
import { seedWmsIntegrationToggles } from '@open-mercato/core/modules/wms/lib/wmsIntegrationToggles'
import { isStockPostingEnabled, STOCK_POSTING_TOGGLE } from '@/modules/pz/lib/destinations'
import { DEFAULT_DESTINATION_FIELD_KEY } from '@/modules/pz/lib/customFields'
import { E } from '#generated/entities.ids.generated'
import type { PzFixtureScope } from './scope'
import { planDefaultDestinations, type DefaultDestinationPlan } from './postingPlan'
import { readWarehouseDefaultStates, readWarehouses, type WarehouseRow } from './warehouses'

export type StockPostingToggleOutcome =
  /** Already on for this tenant — by default, by an earlier run, or by hand. */
  | { outcome: 'alreadyEnabled' }
  /** A tenant override was written. */
  | { outcome: 'enabled' }
  /** Nothing was changed, and why. */
  | { outcome: 'unavailable'; reason: string }

export type StockPostingSetupSummary = {
  toggle: StockPostingToggleOutcome
  /** One entry per active Warehouse in scope, in the order they were read. */
  destinations: DefaultDestinationPlan[]
  /** Warehouses whose Default Destination could not be written, and why. */
  failures: { warehouseId: string; warehouseName: string; reason: string }[]
}

export type StockPostingState = {
  enabled: boolean
  destinations: DefaultDestinationPlan[]
}

/**
 * The toggle table is platform-wide and its writes are restricted to super admins, so the
 * installed `feature_toggles` CLI marks its own invocations as a trusted system caller rather
 * than inventing an actor. This is the same kind of invocation and does the same, and the
 * tenant is carried in the command input, so the override it writes stays per-tenant however
 * the caller was scoped.
 */
function buildToggleCommandContext(container: AwilixContainer): CommandRuntimeContext {
  return {
    container,
    auth: null,
    organizationScope: null,
    selectedOrganizationId: null,
    organizationIds: null,
    request: undefined,
    systemActor: true,
  } as unknown as CommandRuntimeContext
}

/**
 * Enable stock posting for one tenant.
 *
 * The global definition may simply not be in this database: `wms` seeds its toggles lazily,
 * so an environment where nothing has yet asked whether the bridge is on has no row to
 * override. Reading through `pz`'s own helper is what triggers that lazy seed, and the
 * explicit seed afterwards covers the case where the read failed for another reason — a
 * missing definition must degrade to a reported "unavailable", never to an override row
 * pointing at a toggle that does not exist.
 */
async function ensureStockPostingToggle(
  em: EntityManager,
  container: AwilixContainer,
  tenantId: string,
): Promise<StockPostingToggleOutcome> {
  const alreadyEnabled = await isStockPostingEnabled((name: string) => container.resolve(name), tenantId)
  if (alreadyEnabled) return { outcome: 'alreadyEnabled' }

  let toggle = await em.findOne(FeatureToggle, { identifier: STOCK_POSTING_TOGGLE, deletedAt: null })
  if (!toggle) {
    try {
      await seedWmsIntegrationToggles(em)
    } catch (error) {
      return { outcome: 'unavailable', reason: describe(error) }
    }
    toggle = await em.findOne(FeatureToggle, { identifier: STOCK_POSTING_TOGGLE, deletedAt: null })
  }
  if (!toggle) {
    return {
      outcome: 'unavailable',
      reason: `the ${STOCK_POSTING_TOGGLE} toggle is not defined in this database`,
    }
  }

  try {
    // Through the command rather than an override row of our own, for the reason the seed
    // uses `commandBus` everywhere else: the command invalidates the toggle cache the
    // confirmation reads through, and writes the audit and undo trail a hand flip would.
    const commandBus = container.resolve('commandBus') as CommandBus
    await commandBus.execute('feature_toggles.overrides.changeState', {
      input: { toggleId: toggle.id, tenantId, isOverride: true, overrideValue: true },
      ctx: buildToggleCommandContext(container),
    })
  } catch (error) {
    return { outcome: 'unavailable', reason: describe(error) }
  }

  return { outcome: 'enabled' }
}

async function applyDefaultDestinations(
  container: AwilixContainer,
  scope: PzFixtureScope,
  plans: readonly DefaultDestinationPlan[],
): Promise<StockPostingSetupSummary['failures']> {
  const failures: StockPostingSetupSummary['failures'] = []
  const dataEngine = container.resolve('dataEngine') as DataEngine

  for (const plan of plans) {
    if (plan.action !== 'set' || !plan.destination) continue
    try {
      await setCustomFieldsIfAny({
        dataEngine,
        entityId: E.wms.warehouse,
        recordId: plan.warehouseId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        values: { [DEFAULT_DESTINATION_FIELD_KEY]: plan.destination.id },
      })
    } catch (error) {
      failures.push({
        warehouseId: plan.warehouseId,
        warehouseName: plan.warehouseName,
        reason: describe(error),
      })
    }
  }

  return failures
}

/**
 * Both halves of the reviewer setup, idempotently: the tenant override and every Warehouse's
 * Default Destination. Safe to run on an environment seeded before any of this existed, which
 * is the whole point of it being callable on its own.
 */
export async function enableStockPosting(
  em: EntityManager,
  container: AwilixContainer,
  scope: PzFixtureScope,
  warehouses?: readonly WarehouseRow[],
): Promise<StockPostingSetupSummary> {
  const toggle = await ensureStockPostingToggle(em, container, scope.tenantId)
  const rows = warehouses ?? (await readWarehouses(em, scope))
  const plans = planDefaultDestinations(await readWarehouseDefaultStates(em, container, scope, rows))
  const failures = await applyDefaultDestinations(container, scope, plans)
  return { toggle, destinations: plans, failures }
}

/** The same picture, read only: what `status` reports without changing anything. */
export async function readStockPostingState(
  em: EntityManager,
  container: AwilixContainer,
  scope: PzFixtureScope,
): Promise<StockPostingState> {
  const enabled = await isStockPostingEnabled((name: string) => container.resolve(name), scope.tenantId)
  const warehouses = await readWarehouses(em, scope)
  const plans = planDefaultDestinations(await readWarehouseDefaultStates(em, container, scope, warehouses))
  return { enabled, destinations: plans }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
