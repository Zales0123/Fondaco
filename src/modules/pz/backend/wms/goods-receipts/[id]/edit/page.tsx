import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { GoodsReceiptEditForm } from '../../../../../components/GoodsReceiptForm'

export default function EditGoodsReceiptPage({ params }: { params?: { id?: string } }) {
  const id = params?.id
  if (!id) return null

  return (
    <Page>
      <PageBody>
        <GoodsReceiptEditForm id={id} />
      </PageBody>
    </Page>
  )
}
