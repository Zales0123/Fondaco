/**
 * The installed backend sidebar has no new-tab affordance: `InjectionMenuItem`, the nav
 * payload's `NavItem`, and `SidebarItem` all carry `href` and nothing else, and `AppShell`
 * renders every entry as a plain `next/link`. Those contracts are FROZEN and ship inside
 * `node_modules`, so an entry that must leave the backend for a separate surface cannot
 * declare that anywhere.
 *
 * What `AppShell` does expose is `data-menu-item-id` on each rendered anchor, which is a
 * deliberate handle for exactly this kind of app-owned customization. Stamping `target`
 * onto the matching anchors is enough: `next/link` bails out of client-side navigation as
 * soon as an anchor carries a `target` other than `_self`, so the browser opens the real
 * new tab, and middle-click / Ctrl-click keep working as they already did.
 *
 * Worst case — the attribute never lands — the entry still navigates to the same page in
 * the same tab, so a failure here costs the new tab and nothing else.
 */
const MENU_ITEM_ANCHOR_SELECTOR = 'a[data-menu-item-id]'

/**
 * Marks every anchor whose menu item id is listed as opening in a new tab.
 *
 * @param root the subtree to scan — the whole document in the app
 * @param menuItemIds stable menu item ids, as declared by the widget that injected them
 * @param newTabHint localized, parenthesized hint appended to the accessible name
 */
export function markMenuItemsAsNewTab(
  root: ParentNode,
  menuItemIds: readonly string[],
  newTabHint?: string,
): void {
  if (menuItemIds.length === 0) return
  const wanted = new Set(menuItemIds)
  for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>(MENU_ITEM_ANCHOR_SELECTOR))) {
    const id = anchor.dataset.menuItemId
    if (!id || !wanted.has(id)) continue
    if (anchor.target !== '_blank') {
      anchor.target = '_blank'
      anchor.rel = 'noopener noreferrer'
    }
    // `target` is silent to a screen reader, so the hint has to reach the accessible name.
    // A collapsed sidebar renders the icon alone and moves the label into `title`, and a
    // rename or a locale switch rewrites the label under an anchor already marked — so the
    // name is reconciled on every pass rather than only on the one that set `target`.
    const label = (anchor.textContent ?? '').trim() || anchor.title
    if (!newTabHint || !label) continue
    const accessibleName = `${label} ${newTabHint}`
    if (anchor.getAttribute('aria-label') !== accessibleName) {
      anchor.setAttribute('aria-label', accessibleName)
    }
  }
}
