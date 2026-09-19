import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'pz_fixtures',
  title: 'Goods Receipt Fixtures',
  version: '0.1.0',
  description:
    'Demo goods receipts for the pz receiving flow. Deliberately opt-in: `pz` ships no '
    + 'seedExamples because a demo delivery is indistinguishable from a real one in a '
    + 'document series users reconcile against paper, so this seeds only when asked, via '
    + '`mercato pz_fixtures seed`.',
  author: 'Commerce Weavers',
  license: 'MIT',
  requires: ['pz', 'catalog', 'wms'],
}
