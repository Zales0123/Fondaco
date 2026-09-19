import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Goods Receipt events.
 *
 * The CRUD trio is what the commands emit through the shared side-effect helper after the
 * write commits. Confirmation gets its own event when that command lands, because it is a
 * lifecycle transition rather than another save.
 */
const events = [
  { id: 'pz.goods_receipt.created', label: 'Goods Receipt Created', entity: 'goods_receipt', category: 'crud' },
  { id: 'pz.goods_receipt.updated', label: 'Goods Receipt Updated', entity: 'goods_receipt', category: 'crud' },
  { id: 'pz.goods_receipt.deleted', label: 'Goods Receipt Deleted', entity: 'goods_receipt', category: 'crud' },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'pz', events })

export type PzEventId = typeof events[number]['id']

export default eventsConfig
