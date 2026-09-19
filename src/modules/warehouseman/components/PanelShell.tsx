"use client"
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { LogOut } from 'lucide-react'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PanelBody, PanelSurface, PanelTopBar } from './PanelUI'

export const PANEL_LOGIN_PATH = '/warehouseman/login'

export type PanelShellProps = {
  userLabel?: string
  warehouseName?: string | null
  /** Omitted on the panel home, where the warehouse itself is the title. */
  titleKey?: string
  backHref?: string
  backLabelKey?: string
  children?: React.ReactNode
}

/**
 * Chrome shared by every panel screen: one column, large targets, and a top bar that names
 * the warehouse and the signed-in person everywhere. On a shared tablet, "who is this logged
 * in as" is the question that causes wrong-user actions later.
 */
export function PanelShell({ userLabel, warehouseName, titleKey, backHref, backLabelKey, children }: PanelShellProps) {
  const t = useT()
  const router = useRouter()
  const [signingOut, setSigningOut] = React.useState(false)
  const [signOutFailed, setSignOutFailed] = React.useState(false)

  const warehouse = warehouseName || t('warehouseman.panel.noWarehouse')
  const title = titleKey ? t(titleKey) : null

  async function onSignOut() {
    if (signingOut) return
    setSigningOut(true)
    setSignOutFailed(false)
    try {
      const { ok } = await apiCall('/api/auth/logout', {
        method: 'POST',
        headers: { 'x-om-unauthorized-redirect': '0' },
      })
      if (!ok) {
        // Showing the login page while the session is still valid is worse than
        // staying put: on a shared tablet the next person inherits the session.
        setSignOutFailed(true)
        return
      }
      router.replace(PANEL_LOGIN_PATH)
    } catch {
      setSignOutFailed(true)
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <PanelSurface>
      <PanelTopBar
        title={title ?? warehouse}
        subtitle={title ? warehouse : userLabel || null}
        backHref={backHref}
        backLabel={backLabelKey ? t(backLabelKey) : undefined}
        actions={
          <IconButton
            type="button"
            variant="outline"
            className="size-14 border-2"
            aria-label={t('warehouseman.panel.signOut')}
            disabled={signingOut}
            onClick={onSignOut}
          >
            <LogOut className="size-7" aria-hidden="true" />
          </IconButton>
        }
      />
      <PanelBody>
        {signOutFailed ? (
          <Alert status="error" className="border-2 border-status-error-border bg-status-error-bg">
            <AlertDescription className="text-lg">{t('warehouseman.panel.signOutFailed')}</AlertDescription>
          </Alert>
        ) : null}
        {children}
      </PanelBody>
    </PanelSurface>
  )
}

export default PanelShell
