import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'catalog_fixtures',
  title: 'Catalog Fixtures',
  version: '0.1.0',
  description:
    'Backfills demo GTINs onto catalog variants seeded by the installed catalog module. '
    + 'The catalog example seed ships no barcodes, so label printing has nothing to encode '
    + 'until this runs. Re-runnable via `mercato catalog_fixtures assign-barcodes`.',
  author: 'Commerce Weavers',
  license: 'MIT',
  requires: ['catalog'],
}
