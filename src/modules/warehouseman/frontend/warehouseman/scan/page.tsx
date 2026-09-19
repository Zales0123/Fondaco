import { PanelShell } from '../../../components/PanelShell'
import { StubAction } from '../../../components/StubAction'
import { loadPanelContext } from '../../../lib/panelContext'

export default async function ScanPage() {
  const { userLabel, warehouse } = await loadPanelContext()
  return (
    <PanelShell userLabel={userLabel} warehouseName={warehouse?.name ?? null}>
      <StubAction titleKey="warehouseman.actions.scan" />
    </PanelShell>
  )
}
