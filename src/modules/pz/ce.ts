import type { CustomEntitySpec } from '@open-mercato/shared/modules/entities'
import { E } from '#generated/entities.ids.generated'
import { DEFAULT_DESTINATION_FIELDS } from './lib/customFields'

/**
 * `wms:warehouse` is an installed entity, so this declaration seeds field definitions onto it
 * and never creates a `custom_entities` row of its own. Declaring the field here rather than
 * in an app-owned table follows ADR-0002: one setting per installed record belongs on that
 * record, edited where a Warehouse is already edited.
 */
export const entities: CustomEntitySpec[] = [
  {
    id: E.wms.warehouse,
    label: 'Warehouse',
    description: 'Warehouse receiving settings owned by the goods receipts module.',
    showInSidebar: false,
    fields: DEFAULT_DESTINATION_FIELDS,
  },
]

export default entities
