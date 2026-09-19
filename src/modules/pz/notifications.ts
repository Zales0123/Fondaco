import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'

/**
 * What the office is told when a delivery's Stock Posting settles.
 *
 * Only `in_app`: this is a bell item somebody acts on from the panel, next to the retry
 * button, and mailing every settled delivery would bury the one that failed. The failure is
 * an `error` because somebody has to go and fix it — an unusable destination, a product
 * `wms` will not receive — and the success is a `success` because the delivery is done and
 * the item is a receipt, not a task (ADR-0011).
 *
 * `{sourceEntityId}` in an action `href` is substituted when the action runs; `linkHref` is
 * not substituted anywhere, so every notification is built with the concrete document path.
 */
export const notificationTypes: NotificationTypeDefinition[] = [
  {
    type: 'pz.goods_receipt.stock_posted',
    module: 'pz',
    channels: ['in_app'],
    titleKey: 'pz.notifications.stockPosted.title',
    bodyKey: 'pz.notifications.stockPosted.body',
    icon: 'package-check',
    severity: 'success',
    actions: [
      {
        id: 'open',
        labelKey: 'pz.notifications.actions.openGoodsReceipt',
        variant: 'outline',
        href: '/backend/wms/goods-receipts/{sourceEntityId}',
        icon: 'external-link',
      },
    ],
    primaryActionId: 'open',
    linkHref: '/backend/wms/goods-receipts/{sourceEntityId}',
    // A posted delivery is news for a day; a failed one below is not given an expiry,
    // because it stays true until somebody retries it.
    expiresAfterHours: 24,
  },
  {
    type: 'pz.goods_receipt.stock_posting_failed',
    module: 'pz',
    channels: ['in_app'],
    titleKey: 'pz.notifications.stockPostingFailed.title',
    bodyKey: 'pz.notifications.stockPostingFailed.body',
    icon: 'alert-triangle',
    severity: 'error',
    actions: [
      {
        id: 'open',
        labelKey: 'pz.notifications.actions.openGoodsReceipt',
        variant: 'outline',
        href: '/backend/wms/goods-receipts/{sourceEntityId}',
        icon: 'external-link',
      },
    ],
    primaryActionId: 'open',
    linkHref: '/backend/wms/goods-receipts/{sourceEntityId}',
  },
]

export default notificationTypes
