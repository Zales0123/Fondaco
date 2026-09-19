export const metadata = {
  requireAuth: true,
  requireFeatures: ['catalog.products.view'],
  pageTitle: 'Scan barcode',
  pageTitleKey: 'barcodeScanner.page.title',
  pageGroup: 'Catalog',
  pageGroupKey: 'catalog.nav.group',
  pagePriority: 30,
  pageOrder: 95,
  icon: 'package-search',
  breadcrumb: [{ label: 'Scan barcode', labelKey: 'barcodeScanner.page.title' }],
}

export default metadata
