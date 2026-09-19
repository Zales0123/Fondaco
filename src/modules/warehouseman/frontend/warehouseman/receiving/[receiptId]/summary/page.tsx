import { PanelShell } from '../../../../../components/PanelShell'
import { ReceivingSummaryScreen } from '../../../../../components/ReceivingSummaryScreen'
import { loadPanelContext } from '../../../../../lib/panelContext'
import { receivingReceiptHref } from '../../../../../lib/receivingPanel'

export default async function ReceivingSummaryPage({ params }: { params: { receiptId: string } }) {
  const { userLabel, warehouse } = await loadPanelContext()
  const receiptId = String(params.receiptId)
  return (
    <PanelShell
      userLabel={userLabel}
      warehouseName={warehouse?.name ?? null}
      titleKey="warehouseman.receiving.summary.screenTitle"
      backHref={receivingReceiptHref(receiptId)}
      backLabelKey="warehouseman.panel.backToPallets"
    >
      <ReceivingSummaryScreen receiptId={receiptId} />
    </PanelShell>
  )
}
