import { hash } from 'bcryptjs'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { ensureRoles } from '@open-mercato/core/modules/auth/lib/setup-app'
import { Role, User, UserRole } from '@open-mercato/core/modules/auth/data/entities'
import { computeEmailHash } from '@open-mercato/core/modules/auth/lib/emailHash'
import { Warehouse } from '@open-mercato/core/modules/wms/data/entities'
import { setCustomFieldsIfAny } from '@open-mercato/shared/lib/commands/helpers'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { E } from '#generated/entities.ids.generated'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { resolveSeedWarehouseman } from './lib/demoCredentials'
import { ASSIGNED_WAREHOUSE_FIELD_KEY } from './lib/customFields'
import { ensureDemoWarehouseLocations } from './lib/demoLocations'

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
   * A demo warehouseman, so a fresh environment can open the panel without anyone
   * hand-building an account first. This hook is skipped by `--no-examples`, and the
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
    // The warehouse, and the Locations inside it, are ensured before the account is
    // considered. `ensureDemoWarehouseman` answers `null` for an account that already
    // exists, so gating this on a *fresh* account would mean an environment seeded
    // before the Locations fixture existed could never gain them: the hook would return
    // above and leave `DEMO-WH` a warehouse the floor can never post stock into. Both
    // calls are idempotent, so running them on every seed costs nothing and lets an
    // older environment heal itself.
    const warehouseId = await ensureDemoWarehouse(em, scope)

    const userId = await ensureDemoWarehouseman(em, { ...scope, ...credentials })
    if (!userId || !warehouseId) return

    // Only a freshly seeded account is given a warehouse. Re-running the seed must
    // never overwrite an assignment somebody made on purpose — which is why the
    // assignment, unlike the warehouse above, stays behind the fresh-account guard.
    const dataEngine = container.resolve('dataEngine') as DataEngine
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
 * The demo warehouse, and the Locations inside it. `wms` is an optional peer: if it is
 * not installed its table does not exist, and a demo account with no warehouse is a
 * perfectly good panel demo, so the failure is logged and swallowed rather than breaking
 * `mercato init`.
 *
 * The Locations are seeded here rather than in `wms_fixtures` because this hook is what
 * creates `DEMO-WH` in the first place, and `wms_fixtures`'s own `seedExamples` has
 * already run by then — see `lib/demoLocations.ts` for the long version. They are seeded
 * on both branches below, so a warehouse that predates this fixture still gains them on
 * the next seed rather than staying a warehouse nobody can post stock into.
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
    if (existing) {
      await ensureDemoWarehouseLocations(em, existing, scope)
      return String(existing.id)
    }

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
    // Deliberately after the flush, and deliberately not inside this try's failure path:
    // the helper never throws, so a Location problem can neither lose the warehouse id
    // nor cost the demo account its warehouse assignment.
    await ensureDemoWarehouseLocations(em, warehouse, scope)
    return String(warehouse.id)
  } catch (error) {
    logger.warn('Skipping the demo warehouse: the wms module is unavailable', { err: error })
    return null
  }
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
