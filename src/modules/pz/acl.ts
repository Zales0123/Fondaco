/**
 * Goods Receipts own their permissions rather than borrowing `wms.receive_inventory`,
 * which would imply a stock effect this module deliberately does not have (ADR-0004,
 * ADR-0005). Manage and confirm are separate so that entering a delivery and finalising
 * it can be different people's jobs.
 *
 * `wms.view` is declared as a dependency of the view feature because a Goods Receipt
 * names a Warehouse: without it the Warehouse column and the Warehouse picker have no
 * source to resolve a name from. The dependency is advisory — the role editor surfaces
 * it — and nothing in this module gates on `wms.view` itself.
 */
export const features = [
  {
    id: 'pz.goodsReceipts.view',
    title: 'View goods receipts',
    module: 'pz',
    dependsOn: ['wms.view'],
  },
  {
    id: 'pz.goodsReceipts.manage',
    title: 'Manage goods receipts',
    module: 'pz',
    dependsOn: ['pz.goodsReceipts.view'],
  },
  {
    id: 'pz.goodsReceipts.confirm',
    title: 'Confirm goods receipts',
    module: 'pz',
    dependsOn: ['pz.goodsReceipts.view'],
  },
]

export default features
