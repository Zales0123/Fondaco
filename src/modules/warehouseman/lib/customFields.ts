import type { CustomFieldDefinition } from '@open-mercato/shared/modules/entities'
import { E } from '#generated/entities.ids.generated'

export const ASSIGNED_WAREHOUSE_FIELD_KEY = 'assigned_warehouse'

/**
 * The form renderer attaches an option loader only when `optionsUrl` is present; it
 * does not derive one from `relatedEntityId`. Both are declared for that reason —
 * `relatedEntityId` carries the relation's meaning, `optionsUrl` is what actually
 * fills the picker.
 *
 * That endpoint requires the installed `entities.definitions.view` feature. An
 * administrator without it sees an empty picker and no error, which is why setup
 * grants it alongside this field.
 *
 * `labelField` is passed explicitly. `wms:warehouse` is a system entity with no
 * `custom_entities` row to read a label field from, and the endpoint's fallback sniffs
 * columns on a table name derived from the entity id, which does not match the real
 * `wms_warehouses` table. Without this the picker lists warehouse UUIDs.
 */
export const ASSIGNED_WAREHOUSE_FIELDS: CustomFieldDefinition[] = [
  {
    key: ASSIGNED_WAREHOUSE_FIELD_KEY,
    kind: 'relation',
    label: 'Assigned warehouse',
    description: 'Prefilled for this user in the warehouseman panel.',
    relatedEntityId: E.wms.warehouse,
    optionsUrl: `/api/entities/relations/options?entityId=${encodeURIComponent(E.wms.warehouse)}&labelField=name`,
    // Assignment is a convenience, never a permission: a warehouseman without one is
    // still admitted to the panel and simply sees an empty state.
    required: false,
    formEditable: true,
    listVisible: false,
    filterable: true,
  },
]
