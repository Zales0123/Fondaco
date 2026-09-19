'use client'

import * as React from 'react'
import { markMenuItemsAsNewTab } from '@/components/menuItemNewTab'

export type NewTabMenuItemsProps = {
  /** Stable menu item ids that must open outside the backend tab. */
  menuItemIds: readonly string[]
  /** Localized, parenthesized hint appended to each marked entry's accessible name. */
  newTabHint?: string
}

/**
 * Renders nothing; it only teaches the sidebar that a few entries leave the backend.
 * See `menuItemNewTab.ts` for why this is done against the DOM rather than declared.
 *
 * The observer is not optional: the sidebar is filled from `/api/auth/admin/nav` after
 * hydration, and the same entry is re-rendered by the mobile drawer and by collapsing the
 * sidebar, so the anchors this marks appear and are replaced long after mount.
 */
export function NewTabMenuItems({ menuItemIds, newTabHint }: NewTabMenuItemsProps) {
  // Primitive deps: the parent passes a fresh array on every render, and re-subscribing a
  // document-wide observer on each of those renders would be wasteful.
  const menuItemIdsKey = menuItemIds.join('\u0000')

  React.useEffect(() => {
    const ids = menuItemIdsKey.length > 0 ? menuItemIdsKey.split('\u0000') : []
    if (ids.length === 0) return

    let frame = 0
    const flush = () => {
      frame = 0
      markMenuItemsAsNewTab(document, ids, newTabHint)
    }
    // A backend page mutates the DOM constantly; coalesce to at most one scan per frame.
    const schedule = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(flush)
    }

    flush()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [menuItemIdsKey, newTabHint])

  return null
}

export default NewTabMenuItems
