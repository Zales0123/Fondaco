/**
 * The handful of URLs that make the panel installable, in one place because they are
 * spread across three kinds of file that cannot import each other: React components,
 * a static manifest, and a service worker that is plain JS served from `public/`.
 *
 * Everything the browser fetches for the PWA lives under `/pwa/warehouseman/` rather
 * than under `/warehouseman/`, so no static file ever races the `[...slug]` catch-all
 * that resolves the panel's real routes.
 */

/** The worker itself is the exception: a worker can only claim a scope at or below its
 *  own directory, so claiming `/warehouseman` requires it to sit at the site root. */
export const SERVICE_WORKER_URL = '/warehouseman-sw.js'

/** Deliberately without a trailing slash: `start_url` is `/warehouseman` exactly, and a
 *  scope of `/warehouseman/` would not contain it. */
export const SERVICE_WORKER_SCOPE = '/warehouseman'

export const MANIFEST_URL = '/pwa/warehouseman/manifest.webmanifest'

/** Served by the worker when a navigation cannot reach the server. Static HTML, because
 *  the one moment it is needed is the moment the server is unreachable. */
export const OFFLINE_PAGE_URL = '/pwa/warehouseman/offline.html'

export const APPLE_TOUCH_ICON_URL = '/pwa/warehouseman/apple-touch-icon.png'

/** Matches `--background`/`--foreground` in `globals.css`: the address bar and the
 *  splash screen should not be a different app from the panel underneath them. */
export const THEME_COLOR_LIGHT = '#ffffff'
export const THEME_COLOR_DARK = '#1a1a1a'

/** Where a dismissal of the install card is remembered. Per device, which is the unit
 *  that matters: the same warehouseman on a second tablet still needs the offer. */
export const INSTALL_DISMISSED_STORAGE_KEY = 'warehouseman.pwa.installDismissed'
