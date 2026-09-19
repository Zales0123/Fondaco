import { PanelShell } from '../../../components/PanelShell'
import { ReceivingDocuments } from '../../../components/ReceivingDocuments'
import { loadPanelContext } from '../../../lib/panelContext'

export default async function ReceivingPage() {
  const { userLabel, warehouse } = await loadPanelContext()
  return (
    <PanelShell userLabel={userLabel} warehouseName={warehouse?.name ?? null}>
      <ReceivingDocuments assignedWarehouseId={warehouse?.id ?? null} />
    </PanelShell>
  )
}
