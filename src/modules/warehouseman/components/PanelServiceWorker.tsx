"use client"
import * as React from 'react'
import { SERVICE_WORKER_SCOPE, SERVICE_WORKER_URL } from '../lib/pwa'

/**
 * Registers the panel's service worker. Renders nothing.
 *
 * Mounted from `PanelSurface`, so the worker is registered by every panel screen and
 * by no other part of the app. Registering the same worker repeatedly is free — the
 * browser resolves it to the existing registration.
 */
export function PanelServiceWorker() {
  React.useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    // Workers need a secure context. Over plain http on a LAN address — which is how
    // a warehouse tablet often reaches a staging box — registration throws rather
    // than no-ops, so this is a guard and not a nicety.
    if (!window.isSecureContext) return

    navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE }).catch(() => {
      // An uninstallable panel is a working panel. Nothing here is load-bearing for
      // receiving, so a failed registration must not surface as an error on the floor.
    })
  }, [])

  return null
}

export default PanelServiceWorker
