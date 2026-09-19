import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Goods Receipt events.
 *
 * The CRUD trio is what the commands emit through the shared side-effect helper after the
 * write commits. Confirmation has its own event because it is a lifecycle transition
 * rather than another save, and because it is the seam a stock posting would attach to:
 * it carries the whole document, header and lines, so a subscriber never has to read the
 * record back to learn what arrived (ADR-0005).
 *
 * The two Stock Posting events are that posting settling, one way or the other. They are
 * emitted once per settle — by the confirmation's posting and by the office's retry alike —
 * and never per attempt of the durable queue, because a transient failure leaves the posting
 * pending rather than settled and is retried instead of announced (ADR-0011).
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
    id: 'pz.goods_receipt.stock_posted',
    label: 'Goods Receipt Stock Posted',
    entity: 'goods_receipt',
    category: 'lifecycle',
  },
  {
    id: 'pz.goods_receipt.stock_posting_failed',
    label: 'Goods Receipt Stock Posting Failed',
    entity: 'goods_receipt',
    category: 'lifecycle',
  },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'pz', events })

export type PzEventId = typeof events[number]['id']

export default eventsConfig
