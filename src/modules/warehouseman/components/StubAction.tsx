"use client"
import { Hammer } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PanelCard } from './PanelUI'
import { PanelLinkButton } from './ReceivingStates'
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
      <PanelCard className="flex flex-col items-center gap-3 border-dashed py-10 text-center">
        <Hammer className="size-10 text-muted-foreground" aria-hidden="true" />
        <p className="text-xl font-bold">{t(titleKey)}</p>
        <p className="text-lg text-muted-foreground">{t('warehouseman.stub.notImplemented')}</p>
      </PanelCard>
      <PanelLinkButton href={PANEL_HOME_PATH}>{t('warehouseman.stub.back')}</PanelLinkButton>
    </div>
  )
}

export default StubAction
