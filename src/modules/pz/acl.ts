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
    id: 'pz.goodsReceipts.confirm',
    title: 'Confirm goods receipts',
    module: 'pz',
    dependsOn: ['pz.goodsReceipts.view'],
  },
  {
    /**
     * Filing a damage report is a floor action, owned by the same feature that lets a
     * Warehouseman count in the first place: they record what physically happened to a
     * product on an open pallet. `attachments.manage` is a real prerequisite, not a nicety —
     * the report's photo is uploaded through the installed attachments endpoint, which gates
     * its own write on that feature.
     */
    id: 'pz.palletDamageReports.report',
    title: 'Report damaged goods',
    module: 'pz',
    dependsOn: ['pz.receiving.count', 'attachments.manage'],
  },
  {
    /**
     * Resolving is the office's job, independent of the document's own status (ADR-0006 does
     * not apply — a damage report is its own entity, not a document line), so it rides on the
     * same grant that lets the office manage the paperwork rather than on `pz.goodsReceipts.confirm`.
     */
    id: 'pz.palletDamageReports.resolve',
    title: 'Resolve damage reports',
    module: 'pz',
    dependsOn: ['pz.goodsReceipts.manage'],
  },
]

export default features
