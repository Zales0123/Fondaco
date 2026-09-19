import { PanelShell } from '../../../../../components/PanelShell'
import { ReceivingSummaryScreen } from '../../../../../components/ReceivingSummaryScreen'
import { loadPanelContext } from '../../../../../lib/panelContext'

export default async function ReceivingSummaryPage({ params }: { params: { receiptId: string } }) {
  const { userLabel, warehouse } = await loadPanelContext()
  return (
    <PanelShell userLabel={userLabel} warehouseName={warehouse?.name ?? null}>
      <ReceivingSummaryScreen receiptId={String(params.receiptId)} />
    </PanelShell>
  )
}
