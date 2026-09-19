import { hash } from 'bcryptjs'
import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { ensureRoles } from '@open-mercato/core/modules/auth/lib/setup-app'
import { Role, User, UserRole } from '@open-mercato/core/modules/auth/data/entities'
import { computeEmailHash } from '@open-mercato/core/modules/auth/lib/emailHash'
import { Warehouse, WarehouseLocation } from '@open-mercato/core/modules/wms/data/entities'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { setCustomFieldsIfAny } from '@open-mercato/shared/lib/commands/helpers'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { E } from '#generated/entities.ids.generated'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { DEFAULT_DESTINATION_FIELD_KEY } from '@/modules/pz/lib/customFields'
import { readDefaultDestinationId } from '@/modules/pz/lib/destinations'
import { resolveSeedWarehouseman } from './lib/demoCredentials'
import { ASSIGNED_WAREHOUSE_FIELD_KEY } from './lib/customFields'
import { DEMO_DEFAULT_DESTINATION_CODE, seedDemoLocations } from './lib/demoWarehouseLocations'

const DEMO_WAREHOUSE_CODE = 'DEMO-WH'
const DEMO_WAREHOUSE_NAME = 'Magazyn Demonstracyjny'

const logger = createLogger('warehouseman:setup')
const BCRYPT_COST = 10

export const WAREHOUSEMAN_ROLE = 'warehouseman'

/**
 * `ensureCustomRoleAcls` grants a custom role's features but never creates the role —
 * a missing role is skipped in silence. Tenant provisioning runs `onTenantCreated` and
 * then that ACL pass, without calling `seedDefaults` in between, so the role has to be
 * created here or a freshly provisioned tenant ends up with the grant and no role to
 * hold it.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    // Administrators hold the feature so they can assign the warehouseman role at all:
    // the installed role-assignment guard refuses to grant a feature the granter does
    // not hold, so without this nobody but a superadmin could create a warehouseman.
    // Holding it also admits them to the panel, which ADR-0003 states as the rule.
    // `entities.definitions.view` gates the relation-options endpoint that fills the
    // warehouse picker on the user form. Without it the picker renders empty and
    // reports nothing, so whoever assigns warehouses must hold it explicitly rather
    // than by accident of another module's wildcard.
    superadmin: ['warehouseman.panel.access', 'entities.definitions.view'],
    admin: ['warehouseman.panel.access', 'entities.definitions.view'],
    // Receiving lives in `pz`, so the floor's grants are `pz.*` features: read the released
    // documents, count onto their pallets, and finish the delivery once it is counted.
    // Deliberately not `pz.goodsReceipts.manage` — the floor counts a delivery, it does not
    // edit the paperwork it is counted against — and deliberately not
    // `pz.goodsReceipts.confirm`, which is the office's word for the same transition and
    // carries every office confirm surface with it (ADR-0011).
    //
    // The two read-only grants that follow are what the counting screens actually resolve
    // their pickers against, and `pz/acl.ts` already declares both as dependencies of the
    // features above. Without `wms.view` the control that widens to another Warehouse has no
    // option source; without `catalog.products.view` the fallback for an unrecognised barcode
    // opens a picker with nothing in it, which is the one recovery path a Warehouseman has
    // when the catalog does not know the code in front of them. Both degrade to an empty list
    // rather than an error, so the failure would be silent.
    //
    // `label_printing.print` is what puts a sticker on the physical pallet: creating a pallet
    // prints its label, and the pallet screen can print it again for a torn one. Without the
    // grant every print answers 403, so the floor would be told the printer refused when in
    // fact they were never allowed to ask — and a pallet with no sticker cannot be scanned
    // back open, which is the whole point of printing it.
    [WAREHOUSEMAN_ROLE]: [
      'warehouseman.panel.access',
      'pz.goodsReceipts.view',
      'pz.receiving.count',
      'pz.receiving.confirm',
      'wms.view',
      'catalog.products.view',
      'label_printing.print',
    ],
  },

  async onTenantCreated({ em, tenantId }) {
    await ensureRoles(em, { roleNames: [WAREHOUSEMAN_ROLE], tenantId })
  },

  /**
   * A demo warehouseman and a warehouse they can actually receive into, so a fresh
   * environment can walk the panel end to end without anyone hand-building an account
   * or a location tree first. This hook is skipped by `--no-examples`, and the
   * credentials resolver refuses to invent a well-known password in production — an
   * operator there has to choose one explicitly via OM_INIT_WAREHOUSEMAN_PASSWORD.
   */
  async seedExamples({ em, container, tenantId, organizationId }) {
    const credentials = resolveSeedWarehouseman()
    if (!credentials) {
      logger.info('Skipping the demo warehouseman: no password configured for this environment')
      return
    }

    const scope = { tenantId, organizationId }
    const dataEngine = container.resolve('dataEngine') as DataEngine

    // The warehouse and its shape are ensured before the account and regardless of it.
    // They are structure rather than somebody's decision, so every run converges on
    // them — including a run over a database that already holds the demo account from
    // before this module seeded any locations, which would otherwise keep a warehouse
    // the floor can count into but never confirm (ADR-0011).
    const warehouseId = await ensureDemoWarehouse(em, scope)
    if (warehouseId) {
      const locations = await ensureDemoWarehouseLocations(em, container, scope, warehouseId)
      await ensureDefaultDestination(em, dataEngine, scope, warehouseId, locations)
    }

    const userId = await ensureDemoWarehouseman(em, { ...scope, ...credentials })
    if (!userId || !warehouseId) return

    // Only a freshly seeded account is given a warehouse. Re-running the seed must
    // never overwrite an assignment somebody made on purpose.
    await setCustomFieldsIfAny({
      dataEngine,
      entityId: E.auth.user,
      recordId: userId,
      tenantId,
      organizationId,
      values: { [ASSIGNED_WAREHOUSE_FIELD_KEY]: warehouseId },
    })
    logger.info('Assigned the demo warehouse to the demo warehouseman', { warehouseId })
  },
}

/**
 * The demo warehouse. `wms` is an optional peer: if it is not installed its table
 * does not exist, and a demo account with no warehouse is a perfectly good panel
 * demo, so the failure is logged and swallowed rather than breaking `mercato init`.
 */
async function ensureDemoWarehouse(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
): Promise<string | null> {
  try {
    const existing = await em.findOne(Warehouse, {
      code: DEMO_WAREHOUSE_CODE,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    })
    if (existing) return String(existing.id)

    const warehouse = em.create(Warehouse, {
      name: DEMO_WAREHOUSE_NAME,
      code: DEMO_WAREHOUSE_CODE,
      isActive: true,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    } as unknown as Warehouse)
    em.persist(warehouse)
    await em.flush()
    logger.info('Seeded the demo warehouse', { code: DEMO_WAREHOUSE_CODE })
    return String(warehouse.id)
  } catch (error) {
    logger.warn('Skipping the demo warehouse: the wms module is unavailable', { err: error })
    return null
  }
}

/**
 * Trusted, non-interactive command context, exactly as `wms_fixtures` builds one:
 * `organizationScope` stays null so `ensureOrganizationScope` takes its system/worker
 * branch and validates against `selectedOrganizationId`, while `auth` carries a real
 * actor so the wms commands' audit rows and `resolveScope(ctx)` lookups resolve.
 */
function buildCommandContext(
  container: AwilixContainer,
  scope: { tenantId: string; organizationId: string },
  actorUserId: string,
): CommandRuntimeContext {
  return {
    container,
    auth: { sub: actorUserId, tenantId: scope.tenantId, orgId: scope.organizationId, roles: ['admin'] },
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    request: undefined,
    systemActor: true,
  }
}

/**
 * The demo warehouse's locations, so the delivery the floor counts there can also be
 * confirmed: posting names one eligible Warehouse Location and confirmation is refused
 * outright when the warehouse offers none (ADR-0011).
 *
 * Written through `wms.locations.create` rather than the ORM, for the reason
 * `wms_fixtures` gives: the location tree is `wms`'s to maintain, code uniqueness and
 * parent resolution live inside that command, and a row written past it is exactly the
 * drift the wms verifiers exist to catch. Failures are logged and swallowed — `wms` is
 * an optional peer, and a demo without a location tree is worse than `mercato init`
 * falling over.
 */
async function ensureDemoWarehouseLocations(
  em: EntityManager,
  container: AwilixContainer,
  scope: { tenantId: string; organizationId: string },
  warehouseId: string,
): Promise<Map<string, string>> {
  // Hoisted so a run that dies halfway still answers with what the warehouse already
  // had. The rest is picked up by the next run, which converges by code.
  let existing = new Map<string, string>()
  try {
    const existingRows = await em.find(WarehouseLocation, {
      warehouse: warehouseId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    })
    existing = new Map(existingRows.map((row) => [row.code, String(row.id)]))

    const actorUserId = await resolveActorUserId(em, scope.tenantId)
    if (!actorUserId) {
      logger.warn('Skipping the demo warehouse locations: this tenant has no user to attribute them to')
      return existing
    }

    const commandBus = container.resolve<CommandBus>('commandBus')
    const ctx = buildCommandContext(container, scope, actorUserId)
    let created = 0

    const locations = await seedDemoLocations({
      existing,
      createLocation: async ({ code, type, parentId, capacityUnits }) => {
        const { result } = await commandBus.execute<unknown, { locationId: string }>('wms.locations.create', {
          input: {
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            warehouseId,
            code,
            type,
            parentId,
            isActive: true,
            capacityUnits,
          },
          ctx,
        })
        created += 1
        return result.locationId
      },
    })

    if (created > 0) logger.info('Seeded the demo warehouse locations', { code: DEMO_WAREHOUSE_CODE, created })
    return locations
  } catch (error) {
    logger.warn('Skipping the demo warehouse locations: the wms module is unavailable', { err: error })
    return existing
  }
}

/**
 * The warehouse's Default Destination, so the panel's destination picker preselects the
 * receiving staging instead of asking the floor to choose on every delivery.
 *
 * The field is declared by `pz` (its `ce.ts`), not by this module, so the definition may
 * legitimately be missing — on a tenant that predates `pz`, or if the definitions pass
 * has not reached it. Setting a value that has no definition is a skip with a log, never
 * a crash: a warehouse without a default still confirms, it just asks for a choice.
 *
 * An existing value is left alone for the same reason an existing warehouse assignment
 * is: it may be somebody's deliberate choice.
 */
async function ensureDefaultDestination(
  em: EntityManager,
  dataEngine: DataEngine,
  scope: { tenantId: string; organizationId: string },
  warehouseId: string,
  locations: ReadonlyMap<string, string>,
): Promise<void> {
  const destinationId = locations.get(DEMO_DEFAULT_DESTINATION_CODE)
  if (!destinationId) return

  try {
    const current = await readDefaultDestinationId(em, scope, warehouseId)
    if (current) return

    await setCustomFieldsIfAny({
      dataEngine,
      entityId: E.wms.warehouse,
      recordId: warehouseId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      values: { [DEFAULT_DESTINATION_FIELD_KEY]: destinationId },
    })
    logger.info('Preselected the demo warehouse default destination', {
      code: DEMO_DEFAULT_DESTINATION_CODE,
    })
  } catch (error) {
    logger.warn('Skipping the demo warehouse default destination: the pz custom field is unavailable', {
      err: error,
    })
  }
}

/**
 * Somebody to attribute the seeded locations to. The tenant's oldest account is the one
 * `mercato init` created first, which is the same actor `wms_fixtures` picks.
 */
async function resolveActorUserId(em: EntityManager, tenantId: string): Promise<string | null> {
  const user = await em.findOne(
    User,
    { tenantId, deletedAt: null },
    { orderBy: { createdAt: 'asc', id: 'asc' } },
  )
  return user ? String(user.id) : null
}

async function ensureDemoWarehouseman(
  em: EntityManager,
  input: { tenantId: string; organizationId: string; email: string; password: string },
): Promise<string | null> {
  const emailHash = computeEmailHash(input.email)
  const existing = await em.findOne(User, { emailHash, tenantId: input.tenantId, deletedAt: null })
  // Already seeded: leave the account, and its assignment, exactly as it is.
  if (existing) return null

  const role = await em.findOne(Role, { name: WAREHOUSEMAN_ROLE, tenantId: input.tenantId, deletedAt: null })
  if (!role) {
    // onTenantCreated makes the role, so this only happens on a tenant that predates
    // the module. Seeding a warehouseman who cannot enter the panel would be worse
    // than seeding nobody.
    logger.warn('Skipping the demo warehouseman: the warehouseman role does not exist yet')
    return null
  }

  const user = em.create(User, {
    email: input.email,
    emailHash,
    passwordHash: await hash(input.password, BCRYPT_COST),
    name: 'Demo Warehouseman',
    isConfirmed: true,
    organizationId: input.organizationId,
    tenantId: input.tenantId,
  } as unknown as User)
  em.persist(user)
  em.persist(em.create(UserRole, { user, role, createdAt: new Date() } as unknown as UserRole))
  await em.flush()
  logger.info('Seeded the demo warehouseman', { email: input.email })
  return String(user.id)
}

export default setup
