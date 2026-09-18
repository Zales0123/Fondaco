// Static shape of the WMS demo dataset.
//
// Kept free of ids and of any runtime lookups so the layout can be read (and
// tweaked) on its own. `seedWmsFixtures` resolves codes/SKUs to ids at load
// time; nothing here is environment specific.
//
// Reference ids are fixed UUID literals rather than generated ones on purpose:
// `wms.inventory.*` derives a movement idempotency key from
// (referenceType, referenceId, type, warehouse, location, variant, lot, serial,
// quantity), so stable references make a re-run replay instead of double-post.

export type WarehouseFixture = {
  code: string
  name: string
  isPrimary: boolean
  addressLine1: string
  city: string
  postalCode: string
  country: string
  timezone: string
}

export type ZoneFixture = {
  warehouseCode: string
  code: string
  name: string
  priority: number
}

export type LocationFixture = {
  warehouseCode: string
  code: string
  type: 'zone' | 'aisle' | 'rack' | 'bin' | 'slot' | 'dock' | 'staging'
  parentCode?: string
  capacityUnits?: number
}

export type ProfileFixture = {
  sku: string
  defaultUom: string
  defaultStrategy: 'fifo' | 'lifo' | 'fefo'
  trackLot: boolean
  trackExpiration: boolean
  reorderPoint: number
  safetyStock: number
}

export type LotFixture = {
  sku: string
  lotNumber: string
  batchNumber?: string
  manufacturedAtDays: number
  bestBeforeAtDays?: number
  /** Relative to today. Negative = already past due. */
  expiresAtDays?: number
}

export type ReceiptFixture = {
  warehouseCode: string
  locationCode: string
  sku: string
  lotNumber?: string
  quantity: number
  referenceType: 'po' | 'so' | 'transfer' | 'manual' | 'qc' | 'rma'
  referenceId: string
  daysAgo: number
  reason: string
}

export type MoveFixture = {
  warehouseCode: string
  fromLocationCode: string
  toLocationCode: string
  sku: string
  lotNumber?: string
  quantity: number
  type: 'putaway' | 'transfer' | 'pick'
  referenceId: string
  daysAgo: number
  reason: string
}

export type ReservationFixture = {
  warehouseCode: string
  sku: string
  quantity: number
  orderNumber: string
  /** What happens to the reservation after it is created. */
  outcome: 'active' | 'allocated' | 'released'
  releaseReason?: string
}

export type CycleCountFixture = {
  warehouseCode: string
  locationCode: string
  sku: string
  lotNumber?: string
  countedQuantity: number
  referenceId: string
  reason: string
}

export type AssignmentFixture = {
  orderNumber: string
  warehouseCode: string
  notes: string
}

export const WAREHOUSES: WarehouseFixture[] = [
  {
    code: 'WH-MAIN',
    name: 'Fondaco Central DC',
    isPrimary: true,
    addressLine1: 'ul. Piotrkowska 148',
    city: 'Łódź',
    postalCode: '90-062',
    country: 'PL',
    timezone: 'Europe/Warsaw',
  },
  {
    code: 'WH-RET',
    name: 'Fondaco Returns & Overflow',
    isPrimary: false,
    addressLine1: 'ul. Bułgarska 17',
    city: 'Poznań',
    postalCode: '60-320',
    country: 'PL',
    timezone: 'Europe/Warsaw',
  },
]

export const ZONES: ZoneFixture[] = [
  { warehouseCode: 'WH-MAIN', code: 'RECV', name: 'Receiving', priority: 10 },
  { warehouseCode: 'WH-MAIN', code: 'BULK', name: 'Bulk Storage', priority: 20 },
  { warehouseCode: 'WH-MAIN', code: 'PICK', name: 'Pick Face', priority: 30 },
  { warehouseCode: 'WH-MAIN', code: 'SHIP', name: 'Shipping', priority: 40 },
  { warehouseCode: 'WH-RET', code: 'RET-IN', name: 'Returns Intake', priority: 10 },
  { warehouseCode: 'WH-RET', code: 'QC', name: 'Quarantine & QC', priority: 20 },
  { warehouseCode: 'WH-RET', code: 'OVF', name: 'Overflow', priority: 30 },
]

// Locations carry no zone FK upstream — the hierarchy is parent/child only, and
// `type: 'zone'` roots mirror the zone codes above. Parents must precede
// children: the seeder resolves `parentCode` against already-created rows.
export const LOCATIONS: LocationFixture[] = [
  // WH-MAIN
  { warehouseCode: 'WH-MAIN', code: 'RECV', type: 'zone' },
  { warehouseCode: 'WH-MAIN', code: 'DOCK-IN', type: 'dock', parentCode: 'RECV' },
  { warehouseCode: 'WH-MAIN', code: 'STG-RECV', type: 'staging', parentCode: 'RECV', capacityUnits: 400 },
  { warehouseCode: 'WH-MAIN', code: 'BULK', type: 'zone' },
  { warehouseCode: 'WH-MAIN', code: 'A', type: 'aisle', parentCode: 'BULK' },
  { warehouseCode: 'WH-MAIN', code: 'A-01', type: 'rack', parentCode: 'A' },
  { warehouseCode: 'WH-MAIN', code: 'A-01-01', type: 'bin', parentCode: 'A-01', capacityUnits: 120 },
  { warehouseCode: 'WH-MAIN', code: 'A-01-02', type: 'bin', parentCode: 'A-01', capacityUnits: 120 },
  { warehouseCode: 'WH-MAIN', code: 'A-02', type: 'rack', parentCode: 'A' },
  { warehouseCode: 'WH-MAIN', code: 'A-02-01', type: 'bin', parentCode: 'A-02', capacityUnits: 120 },
  { warehouseCode: 'WH-MAIN', code: 'B', type: 'aisle', parentCode: 'BULK' },
  { warehouseCode: 'WH-MAIN', code: 'B-01', type: 'rack', parentCode: 'B' },
  { warehouseCode: 'WH-MAIN', code: 'B-01-01', type: 'bin', parentCode: 'B-01', capacityUnits: 80 },
  { warehouseCode: 'WH-MAIN', code: 'B-01-02', type: 'bin', parentCode: 'B-01', capacityUnits: 80 },
  { warehouseCode: 'WH-MAIN', code: 'PICK', type: 'zone' },
  { warehouseCode: 'WH-MAIN', code: 'PICK-01', type: 'slot', parentCode: 'PICK', capacityUnits: 40 },
  { warehouseCode: 'WH-MAIN', code: 'PICK-02', type: 'slot', parentCode: 'PICK', capacityUnits: 40 },
  { warehouseCode: 'WH-MAIN', code: 'SHIP', type: 'zone' },
  { warehouseCode: 'WH-MAIN', code: 'STG-SHIP', type: 'staging', parentCode: 'SHIP', capacityUnits: 300 },
  { warehouseCode: 'WH-MAIN', code: 'DOCK-OUT', type: 'dock', parentCode: 'SHIP' },
  // WH-RET
  { warehouseCode: 'WH-RET', code: 'RET-IN', type: 'zone' },
  { warehouseCode: 'WH-RET', code: 'RET-DOCK', type: 'dock', parentCode: 'RET-IN' },
  { warehouseCode: 'WH-RET', code: 'QC', type: 'zone' },
  { warehouseCode: 'WH-RET', code: 'QC-BIN-01', type: 'bin', parentCode: 'QC', capacityUnits: 60 },
  { warehouseCode: 'WH-RET', code: 'OVF', type: 'zone' },
  { warehouseCode: 'WH-RET', code: 'OVF-01', type: 'bin', parentCode: 'OVF', capacityUnits: 200 },
]

// SKUs come from the catalog module's own seedExamples. Service variants
// (SERV-*) are deliberately left unprofiled — they hold no stock.
export const PROFILES: ProfileFixture[] = [
  {
    sku: 'ATLAS-RUN-NAVY-8',
    defaultUom: 'pcs',
    defaultStrategy: 'fifo',
    trackLot: false,
    trackExpiration: false,
    reorderPoint: 25,
    safetyStock: 12,
  },
  {
    // Deliberately under-stocked so the low-stock / reorder KPIs have something
    // to report on the operational dashboard.
    sku: 'ATLAS-RUN-GLACIER-10',
    defaultUom: 'pcs',
    defaultStrategy: 'fifo',
    trackLot: false,
    trackExpiration: false,
    reorderPoint: 40,
    safetyStock: 20,
  },
  {
    sku: 'AURORA-CELESTIAL-L',
    defaultUom: 'pcs',
    defaultStrategy: 'fifo',
    trackLot: true,
    trackExpiration: false,
    reorderPoint: 30,
    safetyStock: 15,
  },
  {
    // Expiration tracking forces FEFO upstream (validators reject anything else).
    sku: 'AURORA-ROSE-M',
    defaultUom: 'pcs',
    defaultStrategy: 'fefo',
    trackLot: true,
    trackExpiration: true,
    reorderPoint: 20,
    safetyStock: 10,
  },
]

// EXPIRING_SOON_DAYS upstream is 30, so +12d lands in the "expiring soon"
// bucket and -5d in "past due".
export const LOTS: LotFixture[] = [
  { sku: 'AURORA-CELESTIAL-L', lotNumber: 'LOT-CELE-A17', batchNumber: 'B-A17', manufacturedAtDays: -120 },
  { sku: 'AURORA-CELESTIAL-L', lotNumber: 'LOT-CELE-B22', batchNumber: 'B-B22', manufacturedAtDays: -40 },
  {
    sku: 'AURORA-ROSE-M',
    lotNumber: 'LOT-ROSE-2401',
    batchNumber: 'B-2401',
    manufacturedAtDays: -60,
    bestBeforeAtDays: 30,
    expiresAtDays: 45,
  },
  {
    sku: 'AURORA-ROSE-M',
    lotNumber: 'LOT-ROSE-2402',
    batchNumber: 'B-2402',
    manufacturedAtDays: -90,
    bestBeforeAtDays: 2,
    expiresAtDays: 12,
  },
  {
    sku: 'AURORA-ROSE-M',
    lotNumber: 'LOT-ROSE-2403',
    batchNumber: 'B-2403',
    manufacturedAtDays: -150,
    bestBeforeAtDays: -20,
    expiresAtDays: -5,
  },
]

const PO_2401 = '2a1f4c60-0001-4f00-9a00-000000000001'
const PO_2402 = '2a1f4c60-0001-4f00-9a00-000000000002'
const PO_2403 = '2a1f4c60-0001-4f00-9a00-000000000003'
const PO_2404 = '2a1f4c60-0001-4f00-9a00-000000000004'
const RMA_5501 = '2a1f4c60-0002-4f00-9a00-000000000001'
const PUTAWAY_REF = '2a1f4c60-0003-4f00-9a00-000000000001'
const COUNT_REF = '2a1f4c60-0004-4f00-9a00-000000000001'

export const RECEIPTS: ReceiptFixture[] = [
  // Bulk storage — put away and settled.
  { warehouseCode: 'WH-MAIN', locationCode: 'A-01-01', sku: 'ATLAS-RUN-NAVY-8', quantity: 40, referenceType: 'po', referenceId: PO_2401, daysAgo: 30, reason: 'PO-2401 inbound' },
  { warehouseCode: 'WH-MAIN', locationCode: 'A-01-02', sku: 'ATLAS-RUN-NAVY-8', quantity: 25, referenceType: 'po', referenceId: PO_2402, daysAgo: 18, reason: 'PO-2402 inbound' },
  { warehouseCode: 'WH-MAIN', locationCode: 'A-02-01', sku: 'ATLAS-RUN-GLACIER-10', quantity: 18, referenceType: 'po', referenceId: PO_2401, daysAgo: 25, reason: 'PO-2401 inbound' },
  { warehouseCode: 'WH-MAIN', locationCode: 'PICK-02', sku: 'ATLAS-RUN-GLACIER-10', quantity: 12, referenceType: 'po', referenceId: PO_2403, daysAgo: 10, reason: 'PO-2403 inbound' },
  { warehouseCode: 'WH-MAIN', locationCode: 'B-01-01', sku: 'AURORA-CELESTIAL-L', lotNumber: 'LOT-CELE-A17', quantity: 22, referenceType: 'po', referenceId: PO_2401, daysAgo: 20, reason: 'PO-2401 inbound' },
  { warehouseCode: 'WH-MAIN', locationCode: 'B-01-02', sku: 'AURORA-CELESTIAL-L', lotNumber: 'LOT-CELE-B22', quantity: 16, referenceType: 'po', referenceId: PO_2403, daysAgo: 6, reason: 'PO-2403 inbound' },
  { warehouseCode: 'WH-MAIN', locationCode: 'A-02-01', sku: 'AURORA-CELESTIAL-L', lotNumber: 'LOT-CELE-B22', quantity: 4, referenceType: 'po', referenceId: PO_2404, daysAgo: 4, reason: 'PO-2404 inbound' },
  { warehouseCode: 'WH-MAIN', locationCode: 'B-01-01', sku: 'AURORA-ROSE-M', lotNumber: 'LOT-ROSE-2401', quantity: 30, referenceType: 'po', referenceId: PO_2402, daysAgo: 15, reason: 'PO-2402 inbound' },
  { warehouseCode: 'WH-MAIN', locationCode: 'B-01-02', sku: 'AURORA-ROSE-M', lotNumber: 'LOT-ROSE-2402', quantity: 14, referenceType: 'po', referenceId: PO_2403, daysAgo: 8, reason: 'PO-2403 inbound' },
  // Still on the inbound dock / receiving staging — gives the putaway moves below
  // something to consume and leaves visible work-in-progress.
  { warehouseCode: 'WH-MAIN', locationCode: 'STG-RECV', sku: 'ATLAS-RUN-NAVY-8', quantity: 10, referenceType: 'po', referenceId: PO_2404, daysAgo: 3, reason: 'PO-2404 inbound' },
  { warehouseCode: 'WH-MAIN', locationCode: 'STG-RECV', sku: 'AURORA-CELESTIAL-L', lotNumber: 'LOT-CELE-A17', quantity: 8, referenceType: 'po', referenceId: PO_2404, daysAgo: 3, reason: 'PO-2404 inbound' },
  { warehouseCode: 'WH-MAIN', locationCode: 'STG-RECV', sku: 'AURORA-ROSE-M', lotNumber: 'LOT-ROSE-2401', quantity: 6, referenceType: 'po', referenceId: PO_2404, daysAgo: 3, reason: 'PO-2404 inbound' },
  { warehouseCode: 'WH-MAIN', locationCode: 'DOCK-IN', sku: 'ATLAS-RUN-GLACIER-10', quantity: 5, referenceType: 'po', referenceId: PO_2404, daysAgo: 1, reason: 'PO-2404 inbound, awaiting putaway' },
  // Returns warehouse.
  { warehouseCode: 'WH-RET', locationCode: 'RET-DOCK', sku: 'ATLAS-RUN-NAVY-8', quantity: 6, referenceType: 'rma', referenceId: RMA_5501, daysAgo: 5, reason: 'RMA-5501 customer return' },
  { warehouseCode: 'WH-RET', locationCode: 'QC-BIN-01', sku: 'AURORA-ROSE-M', lotNumber: 'LOT-ROSE-2403', quantity: 9, referenceType: 'qc', referenceId: RMA_5501, daysAgo: 12, reason: 'Quarantined — lot past best-before' },
]

export const MOVES: MoveFixture[] = [
  { warehouseCode: 'WH-MAIN', fromLocationCode: 'A-01-01', toLocationCode: 'PICK-01', sku: 'ATLAS-RUN-NAVY-8', quantity: 15, type: 'transfer', referenceId: PUTAWAY_REF, daysAgo: 12, reason: 'Pick face replenishment' },
  { warehouseCode: 'WH-MAIN', fromLocationCode: 'STG-RECV', toLocationCode: 'A-01-02', sku: 'ATLAS-RUN-NAVY-8', quantity: 10, type: 'putaway', referenceId: PUTAWAY_REF, daysAgo: 2, reason: 'Putaway from receiving staging' },
  { warehouseCode: 'WH-MAIN', fromLocationCode: 'STG-RECV', toLocationCode: 'B-01-01', sku: 'AURORA-CELESTIAL-L', lotNumber: 'LOT-CELE-A17', quantity: 8, type: 'putaway', referenceId: PUTAWAY_REF, daysAgo: 2, reason: 'Putaway from receiving staging' },
  { warehouseCode: 'WH-MAIN', fromLocationCode: 'STG-RECV', toLocationCode: 'B-01-02', sku: 'AURORA-ROSE-M', lotNumber: 'LOT-ROSE-2401', quantity: 6, type: 'putaway', referenceId: PUTAWAY_REF, daysAgo: 2, reason: 'Putaway from receiving staging' },
]

export const RESERVATIONS: ReservationFixture[] = [
  { warehouseCode: 'WH-MAIN', sku: 'ATLAS-RUN-NAVY-8', quantity: 12, orderNumber: 'SO-DEMO-2001', outcome: 'active' },
  { warehouseCode: 'WH-MAIN', sku: 'ATLAS-RUN-GLACIER-10', quantity: 6, orderNumber: 'SO-DEMO-2002', outcome: 'allocated' },
  {
    warehouseCode: 'WH-MAIN',
    sku: 'AURORA-CELESTIAL-L',
    quantity: 5,
    orderNumber: 'SO-DEMO-2003',
    outcome: 'released',
    releaseReason: 'Customer cancelled the line',
  },
]

export const CYCLE_COUNTS: CycleCountFixture[] = [
  {
    warehouseCode: 'WH-MAIN',
    locationCode: 'A-02-01',
    sku: 'ATLAS-RUN-GLACIER-10',
    // 18 received, 16 counted → -2 drift, auto-adjusted.
    countedQuantity: 16,
    referenceId: COUNT_REF,
    reason: 'Q3 perpetual count — aisle A',
  },
]

export const ASSIGNMENTS: AssignmentFixture[] = [
  { orderNumber: 'SO-DEMO-2001', warehouseCode: 'WH-MAIN', notes: 'Default fulfilment from the central DC' },
  { orderNumber: 'SO-DEMO-2004', warehouseCode: 'WH-RET', notes: 'Exchange shipped from returns stock' },
]
