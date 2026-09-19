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
      <ProductScan />
    </PanelShell>
  )
}
