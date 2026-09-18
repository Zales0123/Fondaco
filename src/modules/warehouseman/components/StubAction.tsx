"use client"
import Link from 'next/link'
import { Button } from '@open-mercato/ui/primitives/button'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PANEL_HOME_PATH } from './PanelLoginForm'

/**
 * A named operation the panel will perform later and performs none of now. Each one
 * owns its real route, so building it for real means replacing this body rather than
 * inventing navigation under deadline.
 */
export function StubAction({ titleKey }: { titleKey: string }) {
  const t = useT()
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">{t(titleKey)}</h2>
      <p>{t('warehouseman.stub.notImplemented')}</p>
      <Button asChild size="lg" variant="outline" className="h-16 text-lg">
        <Link href={PANEL_HOME_PATH}>{t('warehouseman.stub.back')}</Link>
      </Button>
    </div>
  )
}

export default StubAction
