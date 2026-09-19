export const metadata = {
  requireAuth: true,
  requireFeatures: ['procurements.purchaseOrders.manage'],
  pageTitle: 'Edit Purchase Order',
  pageTitleKey: 'procurements.purchaseOrders.edit.title',
  pageGroup: 'Purchasing',
  pageGroupKey: 'procurements.nav.group',
  navHidden: true,
  breadcrumb: [
    {
      label: 'Purchase Orders',
      labelKey: 'procurements.purchaseOrders.page.title',
      href: '/backend/purchases/orders',
    },
    { label: 'Edit', labelKey: 'procurements.purchaseOrders.edit.title' },
  ],
} as const
