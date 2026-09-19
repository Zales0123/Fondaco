import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'pz_fixtures',
  title: 'Goods Receipt Fixtures',
  version: '0.1.0',
  description:
    'Demo goods receipts for the pz receiving flow, plus the environment they need to be '
    + 'worth confirming: the per-tenant stock posting toggle and a Default Destination on '
    + 'every warehouse that has nowhere preselected. Deliberately opt-in: `pz` ships no '
    + 'seedExamples because a demo delivery is indistinguishable from a real one in a '
    + 'document series users reconcile against paper, so this seeds only when asked, via '
    + '`mercato pz_fixtures seed` — or `mercato pz_fixtures enable-posting` to bring an '
    + 'already-seeded environment up to date without touching a document.',
  author: 'Commerce Weavers',
  license: 'MIT',
  requires: ['pz', 'catalog', 'wms', 'feature_toggles'],
}
