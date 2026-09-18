"use client"
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'

export const PANEL_LOGIN_PATH = '/warehouseman/login'

export type PanelShellProps = {
  userLabel?: string
  warehouseName?: string | null
  children?: React.ReactNode
}

/**
 * Chrome shared by every panel screen. The layout is phone-first and deliberately
 * single-column: the panel is used on a handheld device by someone wearing gloves,
 * so targets stay large and generously separated at every width.
 *
 * The header names the warehouse and the signed-in person on every screen. On a
 * shared tablet, "who is this logged in as" is the question that causes wrong-user
 * actions later.
 */
export function PanelShell({ userLabel, warehouseName, children }: PanelShellProps) {
  const t = useT()
  const router = useRouter()
  const [signingOut, setSigningOut] = React.useState(false)

  async function onSignOut() {
    if (signingOut) return
    setSigningOut(true)
    try {
      await apiCall('/api/auth/logout', {
        method: 'POST',
        headers: { 'x-om-unauthorized-redirect': '0' },
      })
    } finally {
      router.replace(PANEL_LOGIN_PATH)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex flex-col gap-4 border-b border-border px-4 py-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">
            {warehouseName || t('warehouseman.panel.noWarehouse')}
          </h1>
          {userLabel ? <p className="text-lg text-muted-foreground">{userLabel}</p> : null}
        </div>
        <Button
          type="button"
          size="lg"
          variant="outline"
          className="h-16 w-full text-lg"
          onClick={onSignOut}
          disabled={signingOut}
        >
          {t('warehouseman.panel.signOut')}
        </Button>
      </header>
      <main className="flex flex-col gap-4 px-4 py-6 text-lg">{children}</main>
    </div>
  )
}

export default PanelShell
