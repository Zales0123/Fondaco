import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Goods Receipt events.
 *
 * The CRUD trio is what the commands emit through the shared side-effect helper after the
 * write commits. Confirmation has its own event because it is a lifecycle transition
 * rather than another save, and because it is the seam a stock posting would attach to:
 * it carries the whole document, header and lines, so a subscriber never has to read the
 * record back to learn what arrived (ADR-0005).
 */
const events = [
  { id: 'pz.goods_receipt.created', label: 'Goods Receipt Created', entity: 'goods_receipt', category: 'crud' },
  { id: 'pz.goods_receipt.updated', label: 'Goods Receipt Updated', entity: 'goods_receipt', category: 'crud' },
  { id: 'pz.goods_receipt.deleted', label: 'Goods Receipt Deleted', entity: 'goods_receipt', category: 'crud' },
  {
    id: 'pz.goods_receipt.confirmed',
    label: 'Goods Receipt Confirmed',
    entity: 'goods_receipt',
    category: 'lifecycle',
  },
  {
    /**
     * Goods really reached stock. Separate from `confirmed` because confirming only starts
     * the posting: the two are minutes and a queue apart, and a partly failed run still
     * moved part of the delivery. It carries the variants this run posted, with the SKU and
     * name they were counted under, so a subscriber never has to read the pallets back.
     */
    id: 'pz.goods_receipt.stock_posted',
    label: 'Goods Receipt Stock Posted',
    entity: 'goods_receipt',
    category: 'lifecycle',
  },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'pz', events })

export type PzEventId = typeof events[number]['id']

export default eventsConfig
