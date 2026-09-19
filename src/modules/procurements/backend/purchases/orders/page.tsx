import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import PurchaseOrdersTable from '../../../components/PurchaseOrdersTable'

export default function PurchaseOrdersPage() {
  return (
    <Page>
      <PageBody>
        <PurchaseOrdersTable />
      </PageBody>
    </Page>
  )
}
