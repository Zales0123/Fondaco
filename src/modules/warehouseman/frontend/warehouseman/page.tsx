import { PanelShell } from '../../components/PanelShell'
import { PanelHome } from '../../components/PanelHome'
import { loadPanelContext } from '../../lib/panelContext'

export default async function WarehousemanPanelPage() {
  const { userLabel, warehouse } = await loadPanelContext()
  return (
    <PanelShell userLabel={userLabel} warehouseName={warehouse?.name ?? null}>
      <PanelHome />
    </PanelShell>
  )
}
