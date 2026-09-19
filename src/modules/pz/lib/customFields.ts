import type { CustomFieldDefinition } from '@open-mercato/shared/modules/entities'
import { E } from '#generated/entities.ids.generated'

export const DEFAULT_DESTINATION_FIELD_KEY = 'pz_default_destination'

/**
 * The Warehouse's Default Destination: the Warehouse Location the confirmation screen
 * preselects for a delivery arriving there. It is a convenience and never a constraint —
 * whoever confirms may pick another Location, and a Warehouse without one simply asks for a
 * choice rather than refusing the document (ADR-0011).
 *
 * The relation options endpoint lists every Location of every Warehouse, because it takes no
 * per-record filter. That is acceptable for a setting an administrator fills in once, and it
 * is not the picker the floor uses: `/api/pz/receiving/destinations` answers with the
 * eligible Locations of one document's Warehouse. Whatever is stored here is re-validated at
 * confirmation exactly like a hand-picked Location, so a stale or foreign value prefills
 * nothing instead of quietly posting stock somewhere else.
 *
 * `labelField` is explicit for the same reason it is on the Assigned Warehouse (ADR-0002):
 * `wms:warehouse_location` is a system entity with no `custom_entities` row, and the
 * endpoint's fallback would list UUIDs.
 */
export const DEFAULT_DESTINATION_FIELDS: CustomFieldDefinition[] = [
  {
    key: DEFAULT_DESTINATION_FIELD_KEY,
    kind: 'relation',
    label: 'Default destination',
    description: 'Preselected when a goods receipt received here is confirmed.',
    relatedEntityId: E.wms.warehouse_location,
    optionsUrl: `/api/entities/relations/options?entityId=${encodeURIComponent(E.wms.warehouse_location)}&labelField=code`,
    required: false,
    formEditable: true,
    listVisible: false,
    filterable: false,
  },
]
