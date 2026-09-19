import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { GoodsReceiptCreateForm } from '../../../../components/GoodsReceiptForm'

export default function CreateGoodsReceiptPage() {
  return (
    <Page>
      <PageBody>
        <GoodsReceiptCreateForm />
      </PageBody>
    </Page>
  )
}
