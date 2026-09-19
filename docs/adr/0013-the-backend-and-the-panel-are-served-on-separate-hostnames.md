# The backend and the Panel are served on separate hostnames

A Warehouseman signing in on the Panel logged the Administrator out of `/backend`, and the
other way round. Both surfaces are staff users of the same installed auth stack: `/api/auth/login`
issues one `auth_token` cookie at `path=/` with no `Domain`, and every reader of it —
`getAuthFromCookies`, `resolveAuthFromRequestDetailed` — looks up that one hard-coded name in
`@open-mercato/shared/lib/auth/server.ts`. One browser therefore held one staff session, and the
second sign-in replaced the first. Nothing was broken; there was simply one session slot.

A cookie is scoped to a host and is not isolated by port or scheme. So the cheapest place to get
a second session slot is the hostname: serve the backend on `APP_URL`'s host and the Panel on
`WAREHOUSEMAN_PANEL_URL`'s, and the browser keeps two independent cookie jars with no change to
how authentication works. The installed auth stack stays untouched, which is the whole point —
every alternative we considered ended up reimplementing part of it.

We rejected issuing a second, Panel-scoped cookie on one host. It means an app-owned login route
minting its own JWT, Panel-aware resolution in the frontend catch-all, and a shim that swaps the
cookie for API calls — because the Panel calls `/api/wms/*`, `/api/pz/*` and `/api/catalog/*`, the
same endpoints the backend calls, so no path can tell the two sessions apart. MFA gating, session
revocation, refresh and logout all live in the installed path and would each have to be mirrored
or silently diverge. We also rejected relying on browser profiles, which answers a developer's
problem and not a deployment's.

## Consequences

- `/etc/hosts` is now a setup step. `admin.fondaco.local` and `panel.fondaco.local` are not real
  DNS, so a fresh clone resolves neither until the developer adds them. `.env.example` carries the
  one-line command. We took this over `*.localhost`, which needs no `/etc/hosts` in Chrome and
  Firefox but not in Safari, and over `localhost` vs `127.0.0.1`, which needs nothing anywhere and
  teaches a deployment nothing about the shape it has to reproduce.
- The Panel origin must be listed in `APP_ALLOWED_ORIGINS` in full. That variable feeds two
  consumers with different syntax: `resolveAllowedDevOrigins` (`src/lib/dev-origins.ts`, which
  accepts bare hostnames and wildcards) and `readAllowedOrigins` in
  `@open-mercato/shared/lib/url.ts` (exact origins, wildcards dropped). Only the exact origin
  satisfies both. `readSurfaceHostConfig` throws when it is missing, because the failure it
  prevents — a split everyone believes in that does not exist — is invisible from the outside.
- Enforcement lives at the surface entry points — `src/app/(backend)/backend/page.tsx`,
  `src/app/(backend)/backend/[...slug]/page.tsx`, `src/app/(frontend)/[...slug]/page.tsx` and
  `src/app/login/page.tsx` — each one line calling `enforceSurfaceHost`. The app does have an Edge
  middleware, `src/proxy.ts` (Next 16's rename of `middleware.ts`), and it is deliberately not the
  place for this: Next inlines `process.env` into the Edge bundle at build time, while this app
  ships an image built once and configured per deployment, so the guard would have read the
  build's environment rather than the deployment's. `src/proxy.ts` keeps itself free of anything
  needing runtime configuration for the same family of reasons. Server components read the
  environment per request.
- The guards sit on the page components rather than on `backend/layout.tsx`, which would have been
  one site instead of two. Only a page is handed `searchParams`, and the request headers do not
  carry the query: `src/proxy.ts` sets `x-next-url` to `req.nextUrl.pathname`, dropping the query
  before any layout can see it. A layout-level guard therefore dropped `?page=2` from every
  redirect it issued. Preserving the request the user actually made was worth the second call
  site. Widening `x-next-url` to carry the query was rejected as changing a header other code
  already reads for its own purposes.
- `/login` pins `dynamic = 'force-dynamic'`. It already rendered on demand, so this costs nothing;
  it states the requirement instead of inheriting it. The guard must run on every request and must
  not be made conditional on the split being configured, because the image is built once and
  configured per deployment: a build without `WAREHOUSEMAN_PANEL_URL` that was allowed to
  prerender would emit a static `/login` no later configuration could put a guard back into.
- On the Panel host, `/login` redirects to `/warehouseman/login` rather than to the backend host.
  This closes the loop ADR-0001 left implicit: a cold deep link into the Panel is bounced to
  `/api/auth/session/refresh`, which on failure redirects to `/login` **on the host it ran on**.
  Crossing hosts there would land the new cookie in the backend's jar and return the user to a
  Panel host that still has none.
- Requests on a hostname that is neither configured surface pass through untouched. The ngrok
  tunnels and the OrbStack container domain (`**.orb.local`) this repo relies on cannot be
  enumerated in advance, and refusing them would brick the Docker dev stack and every preview URL.
  The split is enforced where it is configured, and absent where it is not.
- Leaving `WAREHOUSEMAN_PANEL_URL` unset keeps the old single-host behaviour, one shared session
  included. Existing deployments are unaffected until they opt in.
- The WMS sidebar entry (ADR-0012) keeps its relative `/warehouseman` href. On the backend host
  the guard now redirects it to the Panel host, and it already opens in a new tab, so it costs one
  hop and needs no change. Anything else that links between the two surfaces can stay relative for
  the same reason.
- `/api/*` is deliberately not guarded. The Panel and the backend share those endpoints, and a
  host rule over them would break the Panel on its first request.
