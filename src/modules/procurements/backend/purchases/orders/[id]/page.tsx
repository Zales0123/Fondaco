import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { PurchaseOrderDetail } from '../../../../components/PurchaseOrderDetail'

export default function PurchaseOrderPage({ params }: { params?: { id?: string } }) {
  const id = params?.id
  if (!id) return null

  return (
    <Page>
      <PageBody>
        <PurchaseOrderDetail id={id} />
      </PageBody>
    </Page>
  )
}
