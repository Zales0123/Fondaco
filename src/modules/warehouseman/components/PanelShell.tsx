"use client"
import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Chrome shared by every panel screen. The layout is phone-first and deliberately
 * single-column: the panel is used on a handheld device by someone wearing gloves,
 * so targets stay large and generously separated at every width.
 */
export function PanelShell({ children }: { children?: React.ReactNode }) {
  const t = useT()
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-4 py-4">
        <h1 className="text-xl font-semibold">{t('warehouseman.panel.title')}</h1>
      </header>
      <main className="flex flex-col gap-4 px-4 py-6 text-lg">{children}</main>
    </div>
  )
}

export default PanelShell
