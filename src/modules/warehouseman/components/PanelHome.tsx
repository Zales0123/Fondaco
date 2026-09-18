"use client"
import Link from 'next/link'
import { Button } from '@open-mercato/ui/primitives/button'
import { useT } from '@open-mercato/shared/lib/i18n/context'

const ACTIONS = [
  { href: '/warehouseman/receiving', labelKey: 'warehouseman.actions.receiving' },
  { href: '/warehouseman/scan', labelKey: 'warehouseman.actions.scan' },
  { href: '/warehouseman/transfer', labelKey: 'warehouseman.actions.transfer' },
  { href: '/warehouseman/stocktake', labelKey: 'warehouseman.actions.stocktake' },
] as const

export function PanelHome() {
  const t = useT()
  return (
    <nav className="flex flex-col gap-4">
      {ACTIONS.map((action) => (
        <Button key={action.href} asChild size="lg" className="h-16 w-full text-lg">
          <Link href={action.href}>{t(action.labelKey)}</Link>
        </Button>
      ))}
    </nav>
  )
}

export default PanelHome
