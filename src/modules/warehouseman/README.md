# `warehouseman` — warehouseman panel

The panel warehouse staff work in, at `/warehouseman`, separate from the admin
backend. See `CONTEXT.md` for the vocabulary and `docs/adr/0001`–`0003` for the
decisions that shape it.

## Screens

| Route | What it is |
| --- | --- |
| `/warehouseman/login` | The panel's own sign-in page. Public, glove-sized. |
| `/warehouseman` | Panel home: header plus the four action buttons. |
| `/warehouseman/receiving` | Goods receipt — a stub action. |
| `/warehouseman/scan` | Scan product — a stub action. |
| `/warehouseman/transfer` | Transfer — a stub action. |
| `/warehouseman/stocktake` | Stocktake — a stub action. |

Every stub action states that the operation is not available yet and offers one tap
back to the home screen. None of them changes any data. Building one for real means
replacing that screen's body: the route, the access gate and the shell are already in
place.

The header names the assigned warehouse and the signed-in person on every screen, and
carries the sign-out control. A warehouseman with no assigned warehouse is told so and
is still admitted — assignment is a convenience, authorization is the feature.

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

## The one seam

`lib/assignedWarehouse.ts` exports `resolveAssignedWarehouse`, the single place that
answers "which warehouse is this person working in". Later panel operations should
call it rather than reading the custom field themselves. It takes its two reads as
dependencies, so it is unit-tested directly, and it returns nothing — rather than
guessing — when the user has no assignment, when the assigned warehouse lies outside
the session's tenant and organization, or when the session carries no usable scope.

## Language

The panel ships Polish and English catalogs and renders whichever locale the session
resolves; it does not force Polish. Two things cannot be localized in Open Mercato
0.8.0 and are therefore declared as literal English strings: ACL feature titles and
custom-field labels. Both are rendered verbatim by installed admin UI with no
translation-key mechanism.
