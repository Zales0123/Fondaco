/**
 * Shared between the sidebar menu widget that declares the entry and the app shell that
 * turns it into a new-tab link: the widget writes this id, and `AppShell` renders it as
 * the anchor's `data-menu-item-id`, which is the only handle the shell has on it.
 *
 * Keep it stable — a sidebar customization (order, rename, hide) is persisted per role
 * against this exact id, and renaming it would silently drop those preferences.
 */
export const WAREHOUSEMAN_PANEL_MENU_ITEM_ID = 'warehouseman.panel-link'

/** The warehouse-floor panel lives outside `/backend`, so the entry links across surfaces. */
export const WAREHOUSEMAN_PANEL_HREF = '/warehouseman'
