import * as React from 'react'
import {
  APPLE_TOUCH_ICON_URL,
  MANIFEST_URL,
  THEME_COLOR_DARK,
  THEME_COLOR_LIGHT,
} from '../lib/pwa'

/**
 * The tags that make the panel installable. Rendered from inside `PanelSurface` and
 * hoisted into `<head>` by React, which is what keeps this module self-contained:
 * the alternative was teaching the shared `(frontend)/[...slug]` catch-all which
 * module it is rendering, and the app shell has no business knowing that.
 *
 * Only the panel mounts it, so only the panel is installable — the backend and the
 * customer portal are unaffected.
 */
export function PanelPwaHead() {
  return (
    <>
      <link rel="manifest" href={MANIFEST_URL} />
      <link rel="apple-touch-icon" href={APPLE_TOUCH_ICON_URL} />
      {/* Both spellings: the unprefixed one is the standard, the prefixed one is what
          iOS still reads to drop the Safari chrome on a home-screen launch. */}
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-title" content="Fondaco" />
      {/* `default` keeps the iOS status bar legible over the panel's own top bar;
          `black-translucent` would slide the bar under it. */}
      <meta name="apple-mobile-web-app-status-bar-style" content="default" />
      {/* The manifest carries one theme colour and cannot follow the theme. These can,
          so the system chrome tracks the panel into dark mode. */}
      <meta name="theme-color" content={THEME_COLOR_LIGHT} media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content={THEME_COLOR_DARK} media="(prefers-color-scheme: dark)" />
    </>
  )
}

export default PanelPwaHead
