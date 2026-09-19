"use client"
import * as React from 'react'
import { WifiOff } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Says the panel is offline, and nothing at all while it is online — a permanent
 * "connected" badge is one more thing to read on a screen that is deliberately sparse.
 *
 * It explains the failures rather than causing them: every screen already has its own
 * error state for a call that did not land, and none of them can tell "the server
 * refused" from "there is no Wi-Fi in this aisle". This can.
 *
 * Deliberately not sticky. The panel's top bar and footer are already sticky at either
 * edge, and a third competing layer is how a redesigned screen ends up with its primary
 * action covered.
 */
export function PanelOfflineBanner() {
  const t = useT()
  // Starts as online on both sides of hydration: the server cannot know, and guessing
  // offline would flash the banner on every first paint.
  const [offline, setOffline] = React.useState(false)

  React.useEffect(() => {
    const sync = () => setOffline(!navigator.onLine)
    sync()
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  if (!offline) return null

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b-2 border-status-warning-border bg-status-warning-bg px-4 py-3 text-status-warning-text"
    >
      <WifiOff className="size-7 shrink-0 text-status-warning-icon" aria-hidden="true" />
      <p className="text-lg font-semibold leading-tight">{t('warehouseman.panel.offline')}</p>
    </div>
  )
}

export default PanelOfflineBanner
