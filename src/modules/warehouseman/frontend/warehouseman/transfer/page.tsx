import { PanelShell } from '../../../components/PanelShell'
import { StubAction } from '../../../components/StubAction'
import { loadPanelContext } from '../../../lib/panelContext'

export default async function TransferPage() {
  const { userLabel, warehouse } = await loadPanelContext()
  return (
    <PanelShell
      userLabel={userLabel}
      warehouseName={warehouse?.name ?? null}
      titleKey="warehouseman.actions.transfer"
      backHref="/warehouseman"
      backLabelKey="warehouseman.panel.backToHome"
    >
      <StubAction titleKey="warehouseman.actions.transfer" />
    </PanelShell>
  )
}
