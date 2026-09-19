export const metadata = {
  requireAuth: true,
  requireFeatures: ['procurements.purchaseOrders.view'],
  pageTitle: 'Purchase Order',
  pageTitleKey: 'procurements.purchaseOrders.view.pageTitle',
  pageGroup: 'Purchasing',
  pageGroupKey: 'procurements.nav.group',
  navHidden: true,
  breadcrumb: [
    {
      label: 'Purchase Orders',
      labelKey: 'procurements.purchaseOrders.page.title',
      href: '/backend/purchases/orders',
    },
    { label: 'Purchase Order', labelKey: 'procurements.purchaseOrders.view.pageTitle' },
  ],
} as const
