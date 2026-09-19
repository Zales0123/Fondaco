# The Warehouseman Panel is its own route namespace, not a backend variant

The Panel serves warehouse staff wearing gloves on a phone or tablet, with a
deliberately narrow set of actions, while `/backend` serves office staff on a desktop
with the full admin surface. We considered reusing `/backend` with a sidebar variant and
trimmed ACL — cheaper to build — but it leaks admin chrome and navigation onto the
warehouse floor and leaves the Panel fighting the host layout for every glove-sized
target. The Panel therefore lives at `/warehouseman/*` as frontend routes contributed by
the `warehouseman` app module, with its own shell, its own login page, and its own
layout rules.

## Consequences

- Entry is `/warehouseman/login`; `/login` remains the admin entry and always lands on
  `/backend`. There is no role-precedence logic deciding where a dual-role User goes.
- A cold, unauthenticated deep-link to a Panel page is redirected by installed core to
  `/api/auth/session/refresh`, which falls back to the admin `/login` and then returns
  the User to the Panel. We accept this rather than hand-roll the auth gate; see
  ADR-0003.
