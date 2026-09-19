import { PanelShell } from '../../../../../../components/PanelShell'
import { ReceivingCount } from '../../../../../../components/ReceivingCount'
import { loadPanelContext } from '../../../../../../lib/panelContext'

export default async function ReceivingCountPage({
  params,
}: {
  params: { receiptId: string; palletId: string }
}) {
  const { userLabel, warehouse } = await loadPanelContext()
  return (
    <PanelShell userLabel={userLabel} warehouseName={warehouse?.name ?? null}>
      <ReceivingCount receiptId={String(params.receiptId)} palletId={String(params.palletId)} />
    </PanelShell>
  )
}
