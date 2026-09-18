# Assigned Warehouse is a custom field on the installed User, not an app-owned entity

A Warehouseman's Assigned Warehouse could live in an app-owned `warehouse_assignment`
entity keyed by user id, which would keep the app's data fully under its own contract.
We chose instead to declare it as a `relation` custom field on the installed `auth:user`
entity, because Open Mercato already round-trips custom fields through the installed
user create/edit forms and the `auth.users.*` commands: the app gets an admin UI for
assignment, per-tenant definitions and a scoped options lookup without writing or owning
any of it. The generated fact sheet marks `auth:user` as having no custom fields, which
reads like a prohibition but only records that core's `auth` module declares none.

## Consequences

- The field is declared in the app module's `ce.ts` against `auth:user` and installed
  per tenant; there is no `custom_entities` row, because the target is a system entity.
- Assignment is optional by construction. A Warehouseman without one sees an empty state
  rather than being denied the Panel — authorization is Panel Access, never data.
- Admins who assign warehouses need the installed `entities.definitions.view` feature,
  because the warehouse picker's option list is served by the installed relation-options
  endpoint.
- Moving this to an app-owned entity later means a data migration, not a refactor.
