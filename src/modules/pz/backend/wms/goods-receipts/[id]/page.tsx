import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { GoodsReceiptDetail } from '../../../../components/GoodsReceiptDetail'

export default function GoodsReceiptDetailPage({ params }: { params?: { id?: string } }) {
  const id = params?.id
  if (!id) return null

  return (
    <Page>
      <PageBody>
        <GoodsReceiptDetail id={id} />
      </PageBody>
    </Page>
  )
}
