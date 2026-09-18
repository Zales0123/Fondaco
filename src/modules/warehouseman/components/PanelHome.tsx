"use client"
import { useT } from '@open-mercato/shared/lib/i18n/context'

export function PanelHome() {
  const t = useT()
  return <p>{t('warehouseman.panel.greeting')}</p>
}

export default PanelHome
