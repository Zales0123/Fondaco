# `warehouseman` — warehouseman panel

The panel warehouse staff work in, at `/warehouseman`, separate from the admin
backend. See `CONTEXT.md` for the vocabulary and `docs/adr/0001`–`0003` for the
decisions that shape it.

## Access

Entry is governed by one ACL feature, `warehouseman.panel.access`, enforced through
each panel route's `requireAuth` + `requireFeatures` metadata. There is no app-written
guard, and role names are never consulted — a user is a warehouseman because they hold
the feature.

Administrators and superadmins hold it too. That is not decoration: the installed
role-assignment guard refuses to grant a feature the granter does not hold, so without
it no administrator could create a warehouseman at all. It also means an administrator
can open the panel, which ADR-0003 states as the rule.

## Assigning a warehouse

Setup seeds no users, warehouses or assignments. For a tenant that already exists:

1. Make sure the `warehouseman` role exists. It is created during tenant provisioning;
   an older tenant may predate this module, in which case create it in
   **Backend → Roles**.
2. Run `yarn mercato auth sync-role-acls` so the role picks up
   `warehouseman.panel.access` and administrators pick up `entities.definitions.view`.
3. Run `yarn mercato entities install` so the `assigned_warehouse` custom field
   definition is seeded for the tenant.
4. In **Backend → Users**, edit the user, give them the `warehouseman` role, and pick
   their warehouse under **Custom Data**.

If the warehouse picker renders empty, the acting administrator is missing
`entities.definitions.view`; the endpoint behind the picker returns nothing and shows
no error.
