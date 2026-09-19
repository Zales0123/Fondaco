import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import PurchaseOrderLinesTable from '../../../components/PurchaseOrderLinesTable'

export default function PurchaseOrderLinesPage() {
  return (
    <Page>
      <PageBody>
        <PurchaseOrderLinesTable />
      </PageBody>
    </Page>
  )
}
