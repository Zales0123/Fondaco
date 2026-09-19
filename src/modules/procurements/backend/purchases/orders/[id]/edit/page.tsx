import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { PurchaseOrderEditForm } from '../../../../../components/PurchaseOrderForm'

export default function EditPurchaseOrderPage({ params }: { params?: { id?: string } }) {
  const id = params?.id
  if (!id) return null

  return (
    <Page>
      <PageBody>
        <PurchaseOrderEditForm id={id} />
      </PageBody>
    </Page>
  )
}
