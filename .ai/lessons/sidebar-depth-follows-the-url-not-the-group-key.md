---
title: "A backend page's sidebar depth follows its URL, not its page group key"
modules: ["pz", "wms"]
areas: ["backend-ui"]
topics: ["navigation", "page-metadata", "app-modules"]
---

# A backend page's sidebar depth follows its URL, not its page group key

**Context**: The `pz` module's Goods Receipts page declared `pageGroupKey: 'wms.nav.group'`
and `pageOrder: 105`, meaning to sit between Inventory (100) and Warehouses (110). It
appeared in the WMS group, but as a sibling of the group's own dashboard rather than
alongside Inventory, and no ordering change could move it. The page lived at
`/backend/pz/goods-receipts` while every `wms` page lives under `/backend/wms/...`.

**Problem**: `buildAdminNav` (`@open-mercato/ui/backend/utils/nav`) assembles the tree in two
independent passes. The group key decides which group an entry joins. Nesting is decided
afterwards, by walking each entry's href upwards for the longest matching prefix **within the
same group**: `/backend/wms/inventory` finds `/backend/wms` and becomes its child, while
`/backend/pz/goods-receipts` finds no parent and stays a root of the group. `pageOrder` only
sorts siblings, so an entry at the wrong depth can never be ordered into place. Nothing warns
about this — the item renders, just one level up from where it was meant to be.

**Rule**: When an app module contributes a page to an installed module's sidebar group,
mount it under that group's URL prefix as well as declaring its group key. Owning
`/backend/<host>/<page>` from `src/modules/<app>/backend/<host>/<page>/page.tsx` is
supported and keeps the API in the app module's own `/api/<app>/...` namespace. Verify the
rendered order in a browser: the generated route manifest looks correct either way.

**Applies to**: `src/modules/<id>/backend/**/page.meta.ts` for any page that joins another
module's `pageGroupKey`; recorded from `pz` joining `wms.nav.group`.
