import type { AwilixContainer } from 'awilix'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'

export type CatalogFixtureScope = {
  tenantId: string
  organizationId: string
  userId?: string | null
}

/**
 * Commands, not direct ORM writes.
 *
 * The catalog commands re-validate against the merged record (zod alone cannot
 * see the stored half of a pair such as gtinType/barcode), enforce tenant and
 * organization scope, and emit the lifecycle events that keep audit, undo and
 * the search index in step. An `em.persist` loop here would write the columns
 * and silently skip every one of those.
 */
export function buildCommandContext(
  scope: CatalogFixtureScope,
  container: AwilixContainer,
): CommandRuntimeContext {
  return {
    container,
    auth: {
      sub: scope.userId ?? undefined,
      tenantId: scope.tenantId,
      orgId: scope.organizationId,
    },
    organizationScope: {
      selectedId: scope.organizationId,
      filterIds: [scope.organizationId],
      allowedIds: [scope.organizationId],
      tenantId: scope.tenantId,
    },
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  } as CommandRuntimeContext
}
