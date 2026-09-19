# `warehouseman` — warehouseman panel

The panel warehouse staff work in, at `/warehouseman`, separate from the admin
backend. See `CONTEXT.md` for the vocabulary and `docs/adr/0001`–`0003` and `0012` for the
decisions that shape it.

## Screens

| Route | What it is |
| --- | --- |
| `/warehouseman/login` | The panel's own sign-in page. Public, glove-sized. |
| `/warehouseman` | Panel home: header plus the four action buttons. |
| `/warehouseman/receiving` | Goods receipt — a stub action. |
| `/warehouseman/scan` | Scan product — a scan opens the camera and answers what the code is and how much of it is in stock. |
| `/warehouseman/transfer` | Transfer — a stub action. |
| `/warehouseman/stocktake` | Stocktake — a stub action. |

Every stub action states that the operation is not available yet and offers one tap
back to the home screen. None of them changes any data. Building one for real means
replacing that screen's body: the route, the access gate and the shell are already in
place.

`/warehouseman/scan` is read-only — it looks a barcode up and shows the answer. Because
it writes nothing, the camera opens as the screen does: the warehouseman is already
holding the item, and a second tap to start the camera buys nothing. The barcode lookup
is the receiving screen's own, so a code that names a product while counting a delivery
names the same product here; stock comes from the installed WMS balances endpoint, which
the Warehouseman role already reads through `wms.view`.

The stock read is filtered to the warehouseman's **assigned warehouse**, which comes from
the trusted session context and never from the client — the panel works one warehouse at
a time, and an unfiltered read would put every warehouse's total under a header that names
one. Somebody with no assignment is told the figure needs one rather than being shown a
number that answers a different question. Within that warehouse the buckets are summed
into the two figures, and the fullest location is named beside them: a quantity alone
answers "is it here" and leaves the warehouseman to find out where on their own, which is
the walk they scanned to avoid. Only one location is named — the one that can fill the
most of what they came for — with a count of the others beneath it so the figure is not
read as one shelf's worth. The full bin-by-bin listing stays off the screen; somebody
holding a scanner reads a line, not a table.

Typing the code stays the path that always works: over plain http a phone has no secure
context and therefore no camera at all.

The header names the assigned warehouse and the signed-in person on every screen, and
carries the sign-out control. A warehouseman with no assigned warehouse is told so and
is still admitted — assignment is a convenience, authorization is the feature.

## Reaching it from the backend

Office staff reach the panel from **Backend → WMS → Warehouseman panel**, which the
module injects into the installed WMS sidebar group
(`widgets/injection/panel-link-menu/widget.ts`). The entry is gated on the same
`warehouseman.panel.access` the panel routes require, and it opens in a new tab so the
backend the office is working in is not replaced by a floor screen. The new tab comes
from the app shell rather than the entry itself — the installed sidebar contracts carry
no `target`; see `docs/adr/0012` and `src/components/menuItemNewTab.ts`.

## Access

Entry is governed by one ACL feature, `warehouseman.panel.access`, enforced through
each panel route's `requireAuth` + `requireFeatures` metadata. There is no app-written
guard, and role names are never consulted — a user is a warehouseman because they hold
the feature.

Administrators and superadmins hold it too. That is not decoration: the installed
role-assignment guard refuses to grant a feature the granter does not hold, so without
it no administrator could create a warehouseman at all. It also means an administrator
can open the panel, which ADR-0003 states as the rule.

## The demo fixture

`mercato init` (without `--no-examples`) seeds a demo warehouseman, a demo warehouse
`DEMO-WH` and the assignment between them, so a fresh environment can open the panel
immediately. Setting `OM_SHOW_DEMO_CREDENTIALS=1` prints those credentials on the
panel login page; it is refused outright when `NODE_ENV` is production, so it can
only ever advertise a throwaway environment.

`DEMO-WH` is seeded with a location tree as well, through `wms.locations.create`:

| Code | Type | Under |
|---|---|---|
| `RECV` | zone | — |
| `DOCK-IN` | dock | `RECV` |
| `STG-RECV` | staging | `RECV` |
| `PICK` | zone | — |
| `PICK-01`, `PICK-02` | slot | `PICK` |
| `BULK` | zone | — |
| `BULK-01` | bin | `BULK` |

That is not decoration. Since ADR-0011 a confirmation posts the counted goods into one
Warehouse Location, and it is refused outright when the warehouse offers no eligible
one — active, in this warehouse, childless and of type `bin`, `slot`, `staging` or
`dock`. A `DEMO-WH` with no locations could be counted into and never confirmed. The
warehouse's **Default Destination** (the `pz` custom field on `wms:warehouse`) is set to
`STG-RECV`, so the panel preselects it instead of asking the floor to choose. That field
belongs to `pz`: if its definition is missing the default is skipped with a log, and the
warehouse simply asks for a choice.

Nothing is seeded in production unless an operator chooses the password explicitly
through `OM_INIT_WAREHOUSEMAN_PASSWORD`. Re-running the seed never overwrites an
assignment somebody made on purpose: only a freshly created demo account is given a
warehouse, and an existing Default Destination is left alone. The warehouse and its
locations are ensured on every run — they are structure, not a decision — and converge
by code, so a second `mercato init` creates no duplicates.

## Assigning a warehouse

Beyond the demo fixture, setup seeds no users, warehouses or assignments. For a
tenant that already exists:

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

## Installing it

The panel is a PWA: it installs to a tablet's home screen and launches without browser
chrome. Only the panel is — everything hangs off `PanelSurface`, which wraps every panel
screen and nothing else, so the shared `(frontend)/[...slug]` catch-all never learns this
module exists and no other surface becomes installable.

| File | What it is |
| --- | --- |
| `public/pwa/warehouseman/manifest.webmanifest` | Name, icons, `standalone`, scope and `start_url` of `/warehouseman`. |
| `public/warehouseman-sw.js` | The service worker. At the site root because a worker cannot claim a scope above its own directory. |
| `public/pwa/warehouseman/offline.html` | The screen the worker serves when a navigation cannot reach the server. |
| `scripts/generate-warehouseman-icons.mjs` | Redraws the icons. Run it after changing the mark; the PNGs are checked in. |

Everything else lives under `/pwa/warehouseman/` rather than `/warehouseman/` so no static
file races the catch-all that resolves the panel's real routes.

### What the worker caches, and what it refuses to

**Navigation responses are never cached.** Every panel screen is server-rendered with the
signed-in warehouseman's name and warehouse in the top bar, and these tablets are handed
between shifts — a cached page is somebody else's identity shown to whoever picks the
tablet up next. `src/modules/warehouseman/__tests__/serviceWorker.test.ts` asserts this
against the shipped file and is the reason that suite exists.

`/api/*` is never cached either: a stale pallet count shown to somebody counting a pallet
is worse than an error they can see.

What is cached is what is identical for everyone — fingerprinted `/_next/static/` assets,
the icons, the offline screen, and `zxing_reader.wasm`, the 1 MB barcode-reader binary
that otherwise gets re-fetched over dock-door Wi-Fi.

The worker does not call `skipWaiting()`. A new version takes over on the next cold start
rather than swapping assets under a half-counted pallet.

### What it does not do

Reads and writes still need the network. Every mutation in `lib/receivingApi.ts` depends
on something the client cannot invent — a server-assigned pallet code, a barcode resolved
against the catalog, or the optimistic-lock version that makes a concurrent count answer
409. Queueing counts offline is a different design, not a flag on this one.

A warehouseman who walks out of range gets the offline screen on a navigation, and the
banner in `PanelOfflineBanner` on a screen they are already on. Both say so plainly, which
is the whole of the offline story today.

### Installing on a device

Chromium hands the page a `beforeinstallprompt` event, which becomes a real install button
on the panel home. iOS fires no such event, so there it becomes instructions pointing at
Share → Add to Home Screen. A device that declines is remembered in `localStorage` and not
asked again. The decision lives in `lib/installPrompt.ts` and is unit-tested; the card that
renders it is `components/PanelInstallCard.tsx`.

Note that a service worker never controls the page that registered it. The first visit on a
device installs the worker; offline protection starts from the next navigation.

## Language

The panel ships Polish and English catalogs and renders whichever locale the session
resolves; it does not force Polish. Two things cannot be localized in Open Mercato
0.8.0 and are therefore declared as literal English strings: ACL feature titles and
custom-field labels. Both are rendered verbatim by installed admin UI with no
translation-key mechanism.
