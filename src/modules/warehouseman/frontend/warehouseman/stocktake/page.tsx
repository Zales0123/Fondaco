import { PanelShell } from '../../../components/PanelShell'
import { StubAction } from '../../../components/StubAction'
import { loadPanelContext } from '../../../lib/panelContext'

export default async function StocktakePage() {
  const { userLabel, warehouse } = await loadPanelContext()
  return (
    <PanelShell
      userLabel={userLabel}
      warehouseName={warehouse?.name ?? null}
      titleKey="warehouseman.actions.stocktake"
      backHref="/warehouseman"
      backLabelKey="warehouseman.panel.backToHome"
    >
      <StubAction titleKey="warehouseman.actions.stocktake" />
    </PanelShell>
  )
}
