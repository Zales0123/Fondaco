# Panel access is enforced by installed route metadata, not app code

Every Panel page declares `requireAuth` plus the `warehouseman.panel.access` feature in
its route metadata, and the installed frontend catch-all enforces both against
`rbacService`, scoped to the session's tenant and organization. We deliberately did not
write a Panel guard: page middleware runs *after* this gate and cannot act as one, and
hand-rolling the check in a Panel layout would trade an installed, org-scoped,
fail-closed gate for app code that has to re-derive scope correctly. Role names are never
consulted — a User is a Warehouseman because they hold the feature.

## Consequences

- Granting Panel Access to any Role, including an admin one, admits that User. There is
  no second, implicit rule.
- We give up control of the unauthenticated redirect target as a result; see ADR-0001.
