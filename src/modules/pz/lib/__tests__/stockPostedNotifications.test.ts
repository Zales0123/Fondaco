import { describe, expect, it } from '@jest/globals'
import {
  STOCK_POSTED_NOTIFICATION_FEATURE,
  STOCK_POSTED_NOTIFICATION_TYPE,
  buildStockPostedNotifications,
  describePostedLines,
  resolveVariantLabel,
  type GoodsReceiptStockPostedPayload,
  type PostedStockLine,
} from '../stockPostedNotifications'

const RECEIPT = '66666666-6666-4666-8666-666666666666'
const TENANT = '77777777-7777-4777-8777-777777777777'
const ORGANIZATION = '88888888-8888-4888-8888-888888888888'
const VARIANT = '44444444-4444-4444-8444-444444444444'
const OTHER_VARIANT = '55555555-5555-4555-8555-555555555555'

function line(overrides: Partial<PostedStockLine> = {}): PostedStockLine {
  return {
    catalogVariantId: VARIANT,
    sku: 'SKU-001',
    name: 'Blue widget',
    quantity: '10.0000',
    ...overrides,
  }
}

function payload(overrides: Partial<GoodsReceiptStockPostedPayload> = {}): GoodsReceiptStockPostedPayload {
  return {
    id: RECEIPT,
    tenantId: TENANT,
    organizationId: ORGANIZATION,
    documentNumber: 'PZ/2026/001',
    postedLines: [line()],
    ...overrides,
  }
}

describe('describePostedLines', () => {
  it('pairs each posted quantity with the sku and name it was counted under', () => {
    expect(
      describePostedLines(
        [{ catalogVariantId: VARIANT, quantity: '10.0000' }],
        [{ catalogVariantId: VARIANT, sku: 'SKU-001', name: 'Blue widget' }],
      ),
    ).toEqual([{ catalogVariantId: VARIANT, sku: 'SKU-001', name: 'Blue widget', quantity: '10.0000' }])
  })

  it('takes the first snapshot that named a variant, whatever pallet it came off', () => {
    // The same variant is counted onto several pallets, each carrying its own snapshot row.
    expect(
      describePostedLines(
        [{ catalogVariantId: VARIANT, quantity: '10.0000' }],
        [
          { catalogVariantId: VARIANT, sku: 'SKU-001', name: 'Blue widget' },
          { catalogVariantId: VARIANT, sku: 'SKU-001', name: 'Blue widget' },
        ],
      ),
    ).toHaveLength(1)
  })

  it('prefers a snapshot that names the product over an earlier empty one', () => {
    // A line counted before the catalog snapshot was filled in must not blank out the sku
    // that a later line does carry: the notification would then name nothing.
    expect(
      describePostedLines(
        [{ catalogVariantId: VARIANT, quantity: '10.0000' }],
        [
          { catalogVariantId: VARIANT, sku: null, name: null },
          { catalogVariantId: VARIANT, sku: 'SKU-001', name: 'Blue widget' },
        ],
      ),
    ).toEqual([{ catalogVariantId: VARIANT, sku: 'SKU-001', name: 'Blue widget', quantity: '10.0000' }])
  })

  it('still describes a variant no snapshot named', () => {
    expect(describePostedLines([{ catalogVariantId: VARIANT, quantity: '3.0000' }], [])).toEqual([
      { catalogVariantId: VARIANT, sku: null, name: null, quantity: '3.0000' },
    ])
  })
})

describe('resolveVariantLabel', () => {
  it('names the sku, which is what the office recognises a product by', () => {
    expect(resolveVariantLabel(line())).toBe('SKU-001')
  })

  it('falls back to the product name when the variant was counted without a sku', () => {
    expect(resolveVariantLabel(line({ sku: null }))).toBe('Blue widget')
  })

  it('falls back to the variant id rather than an unnamed notification', () => {
    expect(resolveVariantLabel(line({ sku: null, name: null }))).toBe(VARIANT)
  })

  it('ignores a blank sku the snapshot stored as an empty string', () => {
    expect(resolveVariantLabel(line({ sku: '   ' }))).toBe('Blue widget')
  })
})

describe('buildStockPostedNotifications', () => {
  it('raises one notification per posted sku', () => {
    const notifications = buildStockPostedNotifications(
      payload({
        postedLines: [
          line(),
          line({ catalogVariantId: OTHER_VARIANT, sku: 'SKU-002', name: 'Red widget', quantity: '4.0000' }),
        ],
      }),
    )
    expect(notifications).toHaveLength(2)
    expect(notifications.map((notification) => notification.titleVariables.sku)).toEqual(['SKU-001', 'SKU-002'])
  })

  it('fans out to everyone permitted to see goods receipts, inside the document’s own organization', () => {
    const [notification] = buildStockPostedNotifications(payload())
    expect(notification.requiredFeature).toBe(STOCK_POSTED_NOTIFICATION_FEATURE)
    expect(notification.restrictRecipientsToOrganization).toBe(true)
  })

  it('groups each sku under a key fixed by the document and the variant', () => {
    // A retry replays the movements it already wrote, so the posting loop reports
    // already-posted variants again. The group key is what turns that second report into a
    // refresh of the existing bell rather than a duplicate of it.
    const [first] = buildStockPostedNotifications(payload())
    const [replayed] = buildStockPostedNotifications(payload({ postedLines: [line({ quantity: '10.0000' })] }))
    expect(first.groupKey).toBe(`${STOCK_POSTED_NOTIFICATION_TYPE}:${RECEIPT}:${VARIANT}`)
    expect(replayed.groupKey).toBe(first.groupKey)
  })

  it('points the notification at the delivery it came from', () => {
    const [notification] = buildStockPostedNotifications(payload())
    expect(notification.linkHref).toBe(`/backend/wms/goods-receipts/${RECEIPT}`)
    expect(notification.sourceEntityId).toBe(RECEIPT)
  })

  it('writes the quantity the way the floor reads it, not at storage precision', () => {
    const [notification] = buildStockPostedNotifications(payload({ postedLines: [line({ quantity: '12.5000' })] }))
    expect(notification.bodyVariables.quantity).toBe('12.5')
  })

  it('carries the document number so the bell says which delivery moved the stock', () => {
    const [notification] = buildStockPostedNotifications(payload())
    expect(notification.bodyVariables.documentNumber).toBe('PZ/2026/001')
    expect(notification.bodyVariables.product).toBe('Blue widget')
  })

  it('raises nothing when the run posted nothing', () => {
    expect(buildStockPostedNotifications(payload({ postedLines: [] }))).toEqual([])
  })
})
