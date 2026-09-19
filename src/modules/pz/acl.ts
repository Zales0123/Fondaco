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
    // Entering a delivery means picking products out of the catalog, so the product
    // picker's own endpoint is a real prerequisite rather than a nicety.
    dependsOn: ['pz.goodsReceipts.view', 'catalog.products.view'],
  },
  {
    /**
     * Counting is the floor's job, not the office's: a warehouseman records what physically
     * arrived without being able to edit the document it is counted against. Owned by `pz` so
     * that `pz` never gates on a `warehouseman` feature id.
     */
    id: 'pz.receiving.count',
    title: 'Count deliveries onto pallets',
    module: 'pz',
    dependsOn: ['pz.goodsReceipts.view'],
  },
  {
    /**
     * The floor's own way to finish a delivery: it confirms the document and starts the
     * Stock Posting, and it is granted separately from the office's confirm because
     * "the count is done" and "the paperwork is final" are different people's jobs
     * (ADR-0011). Counting is the prerequisite — finishing a delivery nobody was
     * permitted to count is not a job that exists.
     */
    id: 'pz.receiving.confirm',
    title: 'Confirm deliveries from the floor',
    module: 'pz',
    dependsOn: ['pz.receiving.count'],
  },
  {
    id: 'pz.goodsReceipts.confirm',
    title: 'Confirm goods receipts',
    module: 'pz',
    dependsOn: ['pz.goodsReceipts.view'],
  },
]

export default features
