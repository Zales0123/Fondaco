# The WMS menu reaches the Panel, and the app shell is what opens it in a new tab

The Panel is its own route namespace (ADR-0001), so nothing in `/backend` discovered it: the
sidebar is built from backend page metadata, `/warehouseman` is a frontend page, and the only way
in was typing the URL. The entry belongs in the WMS group, next to the warehouse work it serves.

The entry itself is an ordinary menu injection: a headless `InjectionMenuItem` widget on the
framework-owned `menu:sidebar:main` host, declaring `groupId: 'wms.nav.group'` — the same key the
installed WMS pages declare as `pageGroupKey` and the key `buildAdminNav` groups on — so it joins
the existing group with no override, exactly as the `pz` pages do (ADR-0004). It is gated on
`warehouseman.panel.access`, mirroring the Panel's own `requireFeatures`, so the entry is never
offered to someone the Panel would turn away; Administrators hold that feature already (ADR-0003).

Opening it in a new tab is the part with no supported declaration. `InjectionMenuItem`, the nav
payload's `NavItem` and `SidebarItem` all carry `href` and nothing else, and `AppShell` renders
every entry as a plain `next/link`. Those contracts are FROZEN and ship inside `node_modules`.
The office should not lose the backend they are working in to a glove-sized floor screen they
opened to check something, so we take the one handle the host does expose: `AppShell` stamps
`data-menu-item-id` on each rendered anchor, and the app shell adds `target`/`rel` to the entries
it lists by id (`src/components/menuItemNewTab.ts`). `next/link` steps aside once an anchor carries
a `target`, so the browser opens the tab itself.

We rejected a `/backend/wms/warehouseman` launcher page, which stays inside documented contracts
but costs a click and still navigates the backend away, and rejected opening the Panel in place,
which does not meet the requirement at all.

## Consequences

- The new tab is a DOM enhancement, not a declaration: if it ever stops matching, the entry still
  navigates to the Panel, in the same tab. The failure costs the tab and nothing else.
- `WAREHOUSEMAN_PANEL_MENU_ITEM_ID` is a stable contract between the widget and the shell. Sidebar
  customizations (order, rename, hide) are persisted per role against that exact id.
- The hint `(opens in a new tab)` is appended to the entry's accessible name, because `target` on
  its own tells a screen-reader user nothing.
- Anything else that must leave `/backend` for another surface is added to `NEW_TAB_MENU_ITEM_IDS`
  in the backend layout rather than growing a second mechanism.
