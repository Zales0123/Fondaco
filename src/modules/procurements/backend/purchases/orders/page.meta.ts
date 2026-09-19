/**
 * Purchasing is its own sidebar group rather than a guest in WMS or Sales: an order is a
 * commercial document the buying office owns, and it exists before any warehouse is involved.
 *
 * Both destinations in the group live under `/backend/purchases/...`. Nesting in the sidebar
 * is decided by walking each entry's href upwards within its group, not by the group key, so
 * sharing the URL prefix is what keeps them siblings — see the lesson
 * `.ai/lessons/sidebar-depth-follows-the-url-not-the-group-key.md`.
 *
 * `shopping-cart` is a name the installed Lucide registry lists. An unlisted name renders no
 * icon at all and reports nothing, so this one is verified rather than guessed.
 */
export const metadata = {
  requireAuth: true,
  requireFeatures: ['procurements.purchaseOrders.view'],
  pageTitle: 'Purchase Orders',
  pageTitleKey: 'procurements.purchaseOrders.page.title',
  pageGroup: 'Purchasing',
  pageGroupKey: 'procurements.nav.group',
  // After Sales (40) and before the warehouse groups: an order is written first and received
  // later, which is the order the sidebar should read in.
  pagePriority: 45,
  pageOrder: 10,
  icon: 'shopping-cart',
  breadcrumb: [{ label: 'Purchase Orders', labelKey: 'procurements.purchaseOrders.page.title' }],
} as const
