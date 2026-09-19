import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'catalog_fixtures',
  title: 'Catalog Fixtures',
  version: '0.2.0',
  description:
    'Seeds real beverage products — Polish copy, packaging photos and the genuine EAN-13 on '
    + 'each default variant — and backfills demo GTINs onto the variants the installed catalog '
    + 'module seeds without one, so label printing has something to encode. Re-runnable via '
    + '`mercato catalog_fixtures seed-products` and `mercato catalog_fixtures assign-barcodes`.',
  author: 'Commerce Weavers',
  license: 'MIT',
  requires: ['catalog', 'attachments'],
}
