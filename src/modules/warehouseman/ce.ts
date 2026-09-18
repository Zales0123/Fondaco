import type { CustomEntitySpec } from '@open-mercato/shared/modules/entities'
import { E } from '#generated/entities.ids.generated'
import { ASSIGNED_WAREHOUSE_FIELDS } from './lib/customFields'

/**
 * `auth:user` is a system entity: installing this declaration seeds only the field
 * definitions and never writes a `custom_entities` row. The generated fact sheet
 * reporting "CustomFields: no" for auth records that core's auth module ships no
 * `ce.ts`; it is not a restriction on declaring fields here. See ADR-0002.
 */
export const entities: CustomEntitySpec[] = [
  {
    id: E.auth.user,
    label: 'User',
    description: 'Staff user account.',
    showInSidebar: false,
    fields: ASSIGNED_WAREHOUSE_FIELDS,
  },
]

export default entities
