# Fondaco

Fondaco is an Open Mercato application. This glossary covers the vocabulary the app
itself owns; terms defined by installed Open Mercato modules (User, Role, Tenant,
Organization, Warehouse) keep their upstream meaning and are not redefined here.

## Warehouseman Panel

**Panel**:
The warehouse-floor surface, separate from the admin backend, that a Warehouseman
works in.
_Avoid_: Space, warehouseman app, WMS panel

**Warehouseman**:
A User who works on the warehouse floor and is permitted into the Panel.
_Avoid_: Group member, warehouse worker, operator

**Panel Access**:
The permission that admits a User to the Panel, held as an ACL feature on a Role.
Holding it is the only thing that grants entry.
_Avoid_: Warehouseman role check, group membership

**Assigned Warehouse**:
The single Warehouse prefilled for a Warehouseman so they do not re-pick it on every
action. It is a convenience, never a permission.
_Avoid_: Default warehouse, home warehouse, warehouse membership

**Stub Action**:
A Panel screen that names an operation the Panel will eventually perform and performs
none of it.
_Avoid_: Placeholder, mock, dummy page

## Goods Receipts

**Goods Receipt**:
A warehouse document recording a delivery that arrived from outside the organization.
Users know it as a _Zlecenie Przyjęcia Zewnętrznego_ (ZPZ) — an order to receive, not the
receiving itself — and its numbers carry that prefix. Code and identifiers keep the English
term and the `pz` module id.
_Avoid_: Delivery, intake, GRN, inbound, receipt (bare), Przyjęcie Zewnętrzne (PZ)

**Line**:
A single product and quantity on a Goods Receipt. Two Lines may name the same product;
a Line is a line on a document, not a per-product total.
_Avoid_: Position, pozycja, item, row

**Supplier**:
The external party a delivery came from. A name, not a record — the app holds no
supplier entity.
_Avoid_: Vendor, seller, counterparty, source

**Document Number**:
The identifier a Goods Receipt is known by, supplied by the person entering it rather
than generated. Unique within an Organization.
_Avoid_: Reference, code, ID

**Document Date**:
The day a Goods Receipt is dated, which is the day the delivery was received. A single
date; the app does not distinguish paperwork date from arrival date.
_Avoid_: Receipt date, delivery date, entry date

**Confirm**:
The one-way act of finalizing a Goods Receipt, after which it can no longer be changed.
Confirming records that the floor counted the delivery and the count is final, and it starts
the Stock Posting. It is one act whoever performs it: the floor confirms from the Panel and the
office from the document, and both are refused by the same rules.
_Avoid_: Post, approve, submit, finalize, close, complete

**Draft**:
A Goods Receipt that has been entered but not yet confirmed. The only state in which it
can be edited or deleted.
_Avoid_: Pending, open, unposted, new

## Receiving

**Receiving**:
The floor act of counting what physically arrived against a Goods Receipt. A phase of that
document, not a document of its own.
_Avoid_: Intake, goods-in, unloading, delivery check

**Release**:
The act by which the office hands a Goods Receipt to the floor, freezing it so the expected
quantities cannot move while they are being counted against.
_Avoid_: Start receiving, publish, send to warehouse, dispatch

**Pallet**:
A carrier the goods of one Goods Receipt are counted onto, identified by its own barcode.
It belongs to that document and cannot outlive it.
_Avoid_: Palette, unit, handling unit, container, LPN

**Pallet Line**:
A single product and its counted quantity on one Pallet. One per product per Pallet: a
running total, never a record of an individual scan.
_Avoid_: Scan, count line, position, entry

**Close**:
The act by which a Warehouseman declares a Pallet counted. Reversible, unlike Confirm.
_Avoid_: Finish, complete, seal, lock

**Surplus**:
A product counted on a Pallet that no Line of the Goods Receipt expected.
_Avoid_: Extra, overdelivery, unexpected item, nadwyzka

## Stock

**Stock Posting**:
Putting a confirmed Goods Receipt's counted goods into warehouse stock. It is an effect of
Confirm, not an act of its own: it happens afterwards and can still be pending or have failed
while the document is already final. One posting per product, whatever number of Pallets it
arrived on.
_Avoid_: Posting to stock, booking, goods-in posting, receipt posting

**Destination**:
The single Warehouse Location a Goods Receipt's counted goods are posted into. Chosen when the
document is confirmed and fixed from then on, because moving it afterwards would post the same
goods twice.
_Avoid_: Target, putaway location, receiving location, bin

**Default Destination**:
The Destination preselected for a Warehouse. A convenience, never a constraint: whoever confirms
may pick another Location, and a Warehouse without one asks for a choice rather than refusing the
document.
_Avoid_: Receiving location, staging location, home bin
