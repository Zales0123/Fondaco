import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'

/** FROZEN once shipped (BACKWARD_COMPATIBILITY.md §11): stored rows reference it by string. */
export const STOCK_POSTED_NOTIFICATION_TYPE = 'pz.goods_receipt.stock_posted'

/**
 * What a finished delivery tells the office: one bell per SKU that reached stock.
 *
 * In-app only. This is desk news read next to the document it links to, and a phone buzz per
 * SKU would make a fifty-line delivery unusable.
 */
export const stockPostedNotificationType: NotificationTypeDefinition = {
  type: STOCK_POSTED_NOTIFICATION_TYPE,
  module: 'pz',
  channels: ['in_app'],
  titleKey: 'pz.notifications.stockPosted.title',
  bodyKey: 'pz.notifications.stockPosted.body',
  labelKey: 'pz.notifications.stockPosted.label',
  descriptionKey: 'pz.notifications.stockPosted.description',
  icon: 'package-check',
  severity: 'success',
  category: 'pz',
  // No action buttons: the bell item already navigates to its `linkHref`, and an "Open"
  // button that ran a server action to reach the same href would be a slower second route
  // to the one place this notification can send anybody.
  actions: [],
}

export const notificationTypes: NotificationTypeDefinition[] = [stockPostedNotificationType]

export default notificationTypes
