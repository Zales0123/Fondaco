import { hash } from 'bcryptjs'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { ensureRoles } from '@open-mercato/core/modules/auth/lib/setup-app'
import { Role, User, UserRole } from '@open-mercato/core/modules/auth/data/entities'
import { computeEmailHash } from '@open-mercato/core/modules/auth/lib/emailHash'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { resolveSeedWarehouseman } from './lib/demoCredentials'

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
    [WAREHOUSEMAN_ROLE]: ['warehouseman.panel.access'],
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
  async seedExamples({ em, tenantId, organizationId }) {
    const credentials = resolveSeedWarehouseman()
    if (!credentials) {
      logger.info('Skipping the demo warehouseman: no password configured for this environment')
      return
    }
    await ensureDemoWarehouseman(em, { tenantId, organizationId, ...credentials })
  },
}

async function ensureDemoWarehouseman(
  em: EntityManager,
  input: { tenantId: string; organizationId: string; email: string; password: string },
): Promise<void> {
  const emailHash = computeEmailHash(input.email)
  const existing = await em.findOne(User, { emailHash, tenantId: input.tenantId, deletedAt: null })
  if (existing) return

  const role = await em.findOne(Role, { name: WAREHOUSEMAN_ROLE, tenantId: input.tenantId, deletedAt: null })
  if (!role) {
    // onTenantCreated makes the role, so this only happens on a tenant that predates
    // the module. Seeding a warehouseman who cannot enter the panel would be worse
    // than seeding nobody.
    logger.warn('Skipping the demo warehouseman: the warehouseman role does not exist yet')
    return
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
}

export default setup
