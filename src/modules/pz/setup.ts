import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const GOODS_RECEIPT_FEATURES = [
  'pz.goodsReceipts.view',
  'pz.goodsReceipts.manage',
  'pz.goodsReceipts.confirm',
  'pz.receiving.count',
  'pz.receiving.confirm',
] as const

/**
 * Declarative grants only: the ACL sync applies the same set on every run, so repeated
 * initialisation converges instead of accumulating. There is deliberately no
 * `seedExamples` — a demo delivery would be indistinguishable from a real one in a
 * document series users reconcile against paper.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: [...GOODS_RECEIPT_FEATURES],
    admin: [...GOODS_RECEIPT_FEATURES],
  },
}

export default setup
