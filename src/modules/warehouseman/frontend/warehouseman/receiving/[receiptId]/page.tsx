import { PanelShell } from '../../../../components/PanelShell'
import { ReceivingPallets } from '../../../../components/ReceivingPallets'
import { loadPanelContext } from '../../../../lib/panelContext'

export default async function ReceivingPalletsPage({ params }: { params: { receiptId: string } }) {
  const { userLabel, warehouse } = await loadPanelContext()
  return (
    <PanelShell userLabel={userLabel} warehouseName={warehouse?.name ?? null}>
      <ReceivingPallets receiptId={String(params.receiptId)} />
    </PanelShell>
  )
}
