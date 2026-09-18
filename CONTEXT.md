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
