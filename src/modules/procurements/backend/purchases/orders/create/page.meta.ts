export const metadata = {
  requireAuth: true,
  requireFeatures: ['procurements.purchaseOrders.manage'],
  pageTitle: 'New Purchase Order',
  pageTitleKey: 'procurements.purchaseOrders.create.title',
  pageGroup: 'Purchasing',
  pageGroupKey: 'procurements.nav.group',
  navHidden: true,
  breadcrumb: [
    {
      label: 'Purchase Orders',
      labelKey: 'procurements.purchaseOrders.page.title',
      href: '/backend/purchases/orders',
    },
    { label: 'New', labelKey: 'procurements.purchaseOrders.create.title' },
  ],
} as const
