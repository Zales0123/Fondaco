import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'wms_fixtures',
  title: 'WMS Fixtures',
  version: '0.1.0',
  description:
    'Demo warehouse/zone/location/inventory data for the installed wms module. '
    + 'Seeds on `mercato init` (unless --no-examples) and can be re-run via `mercato wms_fixtures seed`.',
  author: 'Commerce Weavers',
  license: 'MIT',
  // Declares the hard dependency only. Note that `mercato init` runs setup hooks
  // in *registry* order (the order of `src/modules.ts`), not in `requires` order —
  // the ModuleSetupConfig doc comment claims otherwise, but mercato.ts never reads
  // `requires` when iterating. The fixtures reference catalog variants and sales
  // orders produced by those modules' own seedExamples, so this entry must stay
  // last in `src/modules.ts`.
  requires: ['wms', 'catalog', 'sales'],
}
