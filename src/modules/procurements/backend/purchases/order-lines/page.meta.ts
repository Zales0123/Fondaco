export const metadata = {
  requireAuth: true,
  requireFeatures: ['procurements.purchaseOrders.view'],
  pageTitle: 'Order Lines',
  pageTitleKey: 'procurements.purchaseOrderLines.page.title',
  pageGroup: 'Purchasing',
  pageGroupKey: 'procurements.nav.group',
  pagePriority: 45,
  pageOrder: 20,
  icon: 'list-checks',
  breadcrumb: [{ label: 'Order Lines', labelKey: 'procurements.purchaseOrderLines.page.title' }],
} as const
