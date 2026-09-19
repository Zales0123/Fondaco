export const metadata = {
  requireAuth: true,
  requireFeatures: ['pz.goodsReceipts.view'],
  pageTitle: 'Goods Receipt Order',
  pageTitleKey: 'pz.goodsReceipts.view.title',
  pageGroup: 'WMS',
  pageGroupKey: 'wms.nav.group',
  navHidden: true,
  breadcrumb: [
    { label: 'WMS', labelKey: 'wms.backend.nav.title', href: '/backend/wms' },
    { label: 'Goods Receipt Orders', labelKey: 'pz.goodsReceipts.page.title', href: '/backend/wms/goods-receipts' },
    { label: 'Goods Receipt Order', labelKey: 'pz.goodsReceipts.view.title' },
  ],
} as const
