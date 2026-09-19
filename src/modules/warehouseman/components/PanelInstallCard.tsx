"use client"
import * as React from 'react'
import { Download, Share, X } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  readInstallDismissed,
  resolveInstallAffordance,
  writeInstallDismissed,
  type InstallAffordance,
} from '../lib/installPrompt'
import { INSTALL_DISMISSED_STORAGE_KEY } from '../lib/pwa'
import { PANEL_ACTION, PanelCard } from './PanelUI'

/** Chromium's install event, which TypeScript's DOM library does not describe. */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/**
 * Offers to put the panel on the home screen. Rendered on the panel home and nowhere
 * else: the offer is worth one card on the screen somebody starts their shift at, and
 * is an interruption on the screen where they are counting a pallet.
 *
 * Two shapes, because the platforms differ in kind and not in degree. Chromium hands
 * us an event we can replay into a real install dialog. iOS hands us nothing, so the
 * only honest offer there is telling them which button to press.
 */
export function PanelInstallCard() {
  const t = useT()
  const promptEvent = React.useRef<BeforeInstallPromptEvent | null>(null)
  const [affordance, setAffordance] = React.useState<InstallAffordance>('none')

  React.useEffect(() => {
    const resolve = () => {
      setAffordance(
        resolveInstallAffordance({
          userAgent: navigator.userAgent,
          maxTouchPoints: navigator.maxTouchPoints ?? 0,
          displayStandalone:
            window.matchMedia('(display-mode: standalone)').matches ||
            // iOS does not report the display mode and sets this instead.
            (navigator as { standalone?: boolean }).standalone === true,
          promptAvailable: promptEvent.current !== null,
          dismissed: readInstallDismissed(window.localStorage, INSTALL_DISMISSED_STORAGE_KEY),
        }),
      )
    }

    const onBeforeInstallPrompt = (event: Event) => {
      // Without this the browser shows its own mini-infobar, which on a kiosk-ish
      // tablet is a banner nobody can dismiss for good.
      event.preventDefault()
      promptEvent.current = event as BeforeInstallPromptEvent
      resolve()
    }
    const onInstalled = () => {
      promptEvent.current = null
      setAffordance('none')
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)
    resolve()
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  function dismiss() {
    writeInstallDismissed(window.localStorage, INSTALL_DISMISSED_STORAGE_KEY)
    setAffordance('none')
  }

  async function install() {
    const event = promptEvent.current
    if (!event) return
    // Single-use: the browser refuses a second `prompt()` on the same event.
    promptEvent.current = null
    try {
      await event.prompt()
      const { outcome } = await event.userChoice
      // A refusal is remembered, so the card does not reappear on the next shift.
      if (outcome === 'dismissed') dismiss()
      else setAffordance('none')
    } catch {
      setAffordance('none')
    }
  }

  if (affordance === 'none') return null

  return (
    <PanelCard className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Download className="size-8 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-xl font-bold leading-tight">{t('warehouseman.panel.install.title')}</p>
          <p className="mt-1 text-base text-muted-foreground">
            {affordance === 'ios-instructions'
              ? t('warehouseman.panel.install.iosDescription')
              : t('warehouseman.panel.install.description')}
          </p>
        </div>
        <IconButton
          type="button"
          variant="outline"
          className="size-12 shrink-0 border-2"
          aria-label={t('warehouseman.panel.install.dismiss')}
          onClick={dismiss}
        >
          <X className="size-6" aria-hidden="true" />
        </IconButton>
      </div>
      {affordance === 'prompt' ? (
        <Button type="button" className={PANEL_ACTION} onClick={install}>
          {t('warehouseman.panel.install.action')}
        </Button>
      ) : (
        <p className="flex items-center gap-2 text-base font-semibold">
          <Share className="size-6 shrink-0" aria-hidden="true" />
          {t('warehouseman.panel.install.iosHint')}
        </p>
      )}
    </PanelCard>
  )
}

export default PanelInstallCard
