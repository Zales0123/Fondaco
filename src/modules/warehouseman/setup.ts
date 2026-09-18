import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { ensureRoles } from '@open-mercato/core/modules/auth/lib/setup-app'

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
    superadmin: ['warehouseman.panel.access'],
    admin: ['warehouseman.panel.access'],
    [WAREHOUSEMAN_ROLE]: ['warehouseman.panel.access'],
  },

  async onTenantCreated({ em, tenantId }) {
    await ensureRoles(em, { roleNames: [WAREHOUSEMAN_ROLE], tenantId })
  },
}

export default setup
