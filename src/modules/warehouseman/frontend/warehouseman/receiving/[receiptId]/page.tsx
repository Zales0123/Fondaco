import { PanelShell } from '../../../../components/PanelShell'
import { ReceivingPallets } from '../../../../components/ReceivingPallets'
import { loadPanelContext } from '../../../../lib/panelContext'
import { RECEIVING_LIST_HREF } from '../../../../lib/receivingPanel'

export default async function ReceivingPalletsPage({ params }: { params: { receiptId: string } }) {
  const { userLabel, warehouse } = await loadPanelContext()
  return (
    <PanelShell
      userLabel={userLabel}
      warehouseName={warehouse?.name ?? null}
      titleKey="warehouseman.receiving.pallets.screenTitle"
      backHref={RECEIVING_LIST_HREF}
      backLabelKey="warehouseman.panel.backToDocuments"
    >
      <ReceivingPallets receiptId={String(params.receiptId)} />
    </PanelShell>
  )
}
