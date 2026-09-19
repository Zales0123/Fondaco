export const metadata = {
  requireAuth: true,
  requireFeatures: ['pz.goodsReceipts.manage'],
  pageTitle: 'New Goods Receipt Order',
  pageTitleKey: 'pz.goodsReceipts.create.title',
  pageGroup: 'WMS',
  pageGroupKey: 'wms.nav.group',
  navHidden: true,
  breadcrumb: [
    { label: 'WMS', labelKey: 'wms.backend.nav.title', href: '/backend/wms' },
    { label: 'Goods Receipt Orders', labelKey: 'pz.goodsReceipts.page.title', href: '/backend/wms/goods-receipts' },
    { label: 'New', labelKey: 'pz.goodsReceipts.create.title' },
  ],
} as const
