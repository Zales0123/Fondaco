import { PanelShell } from '../../../components/PanelShell'
import { ProductScan } from '../../../components/ProductScan'
import { loadPanelContext } from '../../../lib/panelContext'

export default async function ScanPage() {
  const { userLabel, warehouse } = await loadPanelContext()
  return (
    <PanelShell
      userLabel={userLabel}
      warehouseName={warehouse?.name ?? null}
      titleKey="warehouseman.actions.scan"
      backHref="/warehouseman"
      backLabelKey="warehouseman.panel.backToHome"
    >
      {/* The warehouse comes from the trusted session context, never from the client: it is
          what the stock read is filtered by, and the panel answers for one warehouse. */}
      <ProductScan warehouseId={warehouse?.id ?? null} warehouseName={warehouse?.name ?? null} />
    </PanelShell>
  )
}
