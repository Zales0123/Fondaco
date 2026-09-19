import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const PURCHASE_ORDER_FEATURES = [
  'procurements.purchaseOrders.view',
  'procurements.purchaseOrders.manage',
  'procurements.purchaseOrders.release',
] as const

/**
 * Declarative grants only: the ACL sync applies the same set on every run, so repeated
 * initialisation converges instead of accumulating. There is deliberately no `seedExamples`
 * — a demo order would be indistinguishable from a real one in a document series buyers
 * reconcile against supplier confirmations.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: [...PURCHASE_ORDER_FEATURES],
    admin: [...PURCHASE_ORDER_FEATURES],
  },
}

export default setup
