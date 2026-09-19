export const metadata = {
  requireAuth: true,
  requireFeatures: ['pz.goodsReceipts.manage'],
  pageTitle: 'Edit Goods Receipt',
  pageTitleKey: 'pz.goodsReceipts.edit.title',
  pageGroup: 'WMS',
  pageGroupKey: 'wms.nav.group',
  navHidden: true,
  breadcrumb: [
    { label: 'WMS', labelKey: 'wms.backend.nav.title', href: '/backend/wms' },
    { label: 'Goods Receipts', labelKey: 'pz.goodsReceipts.page.title', href: '/backend/wms/goods-receipts' },
    { label: 'Edit', labelKey: 'pz.goodsReceipts.edit.title' },
  ],
} as const
