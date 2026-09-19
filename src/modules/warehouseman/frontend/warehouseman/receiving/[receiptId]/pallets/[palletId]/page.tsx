import { PanelShell } from '../../../../../../components/PanelShell'
import { ReceivingCount } from '../../../../../../components/ReceivingCount'
import { loadPanelContext } from '../../../../../../lib/panelContext'
import { receivingReceiptHref } from '../../../../../../lib/receivingPanel'

export default async function ReceivingCountPage({
  params,
}: {
  params: { receiptId: string; palletId: string }
}) {
  const { userLabel, warehouse } = await loadPanelContext()
  const receiptId = String(params.receiptId)
  return (
    <PanelShell
      userLabel={userLabel}
      warehouseName={warehouse?.name ?? null}
      titleKey="warehouseman.receiving.count.screenTitle"
      backHref={receivingReceiptHref(receiptId)}
      backLabelKey="warehouseman.panel.backToPallets"
    >
      <ReceivingCount receiptId={receiptId} palletId={String(params.palletId)} />
    </PanelShell>
  )
}
