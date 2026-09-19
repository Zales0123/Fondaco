import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { PurchaseOrderCreateForm } from '../../../../components/PurchaseOrderForm'

export default function CreatePurchaseOrderPage() {
  return (
    <Page>
      <PageBody>
        <PurchaseOrderCreateForm />
      </PageBody>
    </Page>
  )
}
