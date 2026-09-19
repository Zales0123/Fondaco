/**
 * Purchase Orders own their permissions rather than borrowing anything from `wms` or
 * `sales`: ordering is a commercial act with its own audience, and a purchase price is not
 * something everyone who may see a delivery should read.
 *
 * Writing an order and releasing it are separate grants, the same way entering and
 * confirming a Goods Receipt are: a buyer's assistant may prepare an order that only the
 * buyer commits the organization to.
 *
 * `wms.view` is declared as a dependency of the view feature because an order names a
 * Warehouse: without it the Warehouse column and picker have no source to resolve a name
 * from. The dependency is advisory — the role editor surfaces it — and nothing in this
 * module gates on `wms.view` itself.
 */
export const features = [
  {
    id: 'procurements.purchaseOrders.view',
    title: 'View purchase orders',
    module: 'procurements',
    dependsOn: ['wms.view'],
  },
  {
    id: 'procurements.purchaseOrders.manage',
    title: 'Manage purchase orders',
    module: 'procurements',
    // Writing an order means picking products out of the catalog, so the product picker's
    // own endpoint is a real prerequisite rather than a nicety.
    dependsOn: ['procurements.purchaseOrders.view', 'catalog.products.view'],
  },
  {
    /**
     * Releasing commits the organization to the order, withdrawing takes that back while
     * nothing downstream depends on it, and cancelling ends it. One grant covers the three
     * because they are the same decision seen from different sides.
     */
    id: 'procurements.purchaseOrders.release',
    title: 'Release, withdraw and cancel purchase orders',
    module: 'procurements',
    dependsOn: ['procurements.purchaseOrders.view'],
  },
]

export default features
