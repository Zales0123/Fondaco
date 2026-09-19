/**
 * The page joins the installed WMS sidebar group by declaring the same group key the
 * `wms` pages declare — grouping is by key, so no UMES override is involved (ADR-0004).
 * Order 105 places it directly after Inventory (100) and ahead of Warehouses (110) and
 * the rest of the warehouse configuration entries.
 *
 * `package-plus` is a name the installed Lucide registry lists. An unlisted name renders
 * no icon at all and reports nothing, so this one is verified rather than guessed.
 */
export const metadata = {
  requireAuth: true,
  requireFeatures: ['pz.goodsReceipts.view'],
  pageTitle: 'Goods Receipts',
  pageTitleKey: 'pz.goodsReceipts.page.title',
  pageGroup: 'WMS',
  pageGroupKey: 'wms.nav.group',
  pageOrder: 105,
  icon: 'package-plus',
  breadcrumb: [
    { label: 'WMS', labelKey: 'wms.backend.nav.title', href: '/backend/wms' },
    { label: 'Goods Receipts', labelKey: 'pz.goodsReceipts.page.title' },
  ],
} as const
