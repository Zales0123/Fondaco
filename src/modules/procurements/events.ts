import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Purchase Order events.
 *
 * The CRUD trio is what the commands emit through the shared side-effect helper after the
 * write commits. Release and cancel have their own events because they are lifecycle
 * transitions rather than another save, and because they are the seams stage 2 attaches to:
 * an arrival notice may only draw on a released order, and cancelling one has to reach
 * whatever was planned against it. Both carry the whole document, header and lines, so a
 * subscriber never has to read the record back to learn what was ordered.
 */
const events = [
  { id: 'procurements.purchase_order.created', label: 'Purchase Order Created', entity: 'purchase_order', category: 'crud' },
  { id: 'procurements.purchase_order.updated', label: 'Purchase Order Updated', entity: 'purchase_order', category: 'crud' },
  { id: 'procurements.purchase_order.deleted', label: 'Purchase Order Deleted', entity: 'purchase_order', category: 'crud' },
  {
    id: 'procurements.purchase_order.released',
    label: 'Purchase Order Released',
    entity: 'purchase_order',
    category: 'lifecycle',
  },
  {
    id: 'procurements.purchase_order.cancelled',
    label: 'Purchase Order Cancelled',
    entity: 'purchase_order',
    category: 'lifecycle',
  },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'procurements', events })

export type ProcurementsEventId = typeof events[number]['id']

export default eventsConfig
