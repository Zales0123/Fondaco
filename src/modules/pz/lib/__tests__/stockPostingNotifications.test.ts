import { describe, expect, it } from '@jest/globals'
import {
  buildStockPostedNotification,
  buildStockPostingFailedNotification,
  notifyStockPosted,
  notifyStockPostingFailed,
  STOCK_POSTED_NOTIFICATION_TYPE,
  STOCK_POSTING_FAILED_NOTIFICATION_TYPE,
  STOCK_POSTING_NOTIFICATION_ENTITY_TYPE,
  STOCK_POSTING_NOTIFICATION_FEATURE,
  type FeatureNotificationCreator,
} from '../stockPostingNotifications'
import type { TranslateFn } from '../goodsReceiptInput'

const RECEIPT_ID = '44444444-4444-4444-8444-444444444444'
const TENANT_ID = '55555555-5555-4555-8555-555555555555'
const ORGANIZATION_ID = '66666666-6666-4666-8666-666666666666'

const translate: TranslateFn = (key, fallback) => `translated:${key}|${fallback ?? ''}`

function posted(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT_ID,
    documentNumber: 'PZ/2026/01',
    tenantId: TENANT_ID,
    organizationId: ORGANIZATION_ID,
    postedQuantity: '12.5000',
    postedVariants: 3,
    ...overrides,
  }
}

function failed(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT_ID,
    documentNumber: 'PZ/2026/01',
    tenantId: TENANT_ID,
    organizationId: ORGANIZATION_ID,
    reason: 'destination_unusable' as const,
    ...overrides,
  }
}

function recorder(): FeatureNotificationCreator & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    createForFeature: async (...args: unknown[]) => {
      calls.push(args)
      return []
    },
  } as FeatureNotificationCreator & { calls: unknown[][] }
}

describe('buildStockPostedNotification', () => {
  it('announces the success to whoever may look at the document, in its own organization', () => {
    const built = buildStockPostedNotification(posted())

    expect(built).not.toBeNull()
    expect(built?.input.type).toBe(STOCK_POSTED_NOTIFICATION_TYPE)
    expect(built?.input.severity).toBe('success')
    expect(built?.input.requiredFeature).toBe(STOCK_POSTING_NOTIFICATION_FEATURE)
    expect(built?.input.restrictRecipientsToOrganization).toBe(true)
    expect(built?.ctx).toEqual({ tenantId: TENANT_ID, organizationId: ORGANIZATION_ID })
  })

  it('points at the document it is about, so the bell and a later cleanup both find it', () => {
    const built = buildStockPostedNotification(posted())

    expect(built?.input.sourceModule).toBe('pz')
    expect(built?.input.sourceEntityType).toBe(STOCK_POSTING_NOTIFICATION_ENTITY_TYPE)
    expect(built?.input.sourceEntityId).toBe(RECEIPT_ID)
    expect(built?.input.linkHref).toBe(`/backend/wms/goods-receipts/${RECEIPT_ID}`)
  })

  it('groups per document and outcome, so a redelivered event does not stack a second copy', () => {
    expect(buildStockPostedNotification(posted())?.input.groupKey).toBe(
      `${STOCK_POSTED_NOTIFICATION_TYPE}:${RECEIPT_ID}`,
    )
    expect(buildStockPostingFailedNotification(failed(), translate)?.input.groupKey).toBe(
      `${STOCK_POSTING_FAILED_NOTIFICATION_TYPE}:${RECEIPT_ID}`,
    )
  })

  it('reads what landed as a count rather than a measurement', () => {
    expect(buildStockPostedNotification(posted())?.input.bodyVariables).toEqual({
      documentNumber: 'PZ/2026/01',
      quantity: '12.5',
      variants: '3',
    })
    expect(buildStockPostedNotification(posted({ postedQuantity: '12.0000' }))?.input.bodyVariables?.quantity).toBe(
      '12',
    )
  })
})

describe('buildStockPostingFailedNotification', () => {
  it('carries the stable reason code and the sentence the office already sees', () => {
    const built = buildStockPostingFailedNotification(failed(), translate)

    expect(built?.input.type).toBe(STOCK_POSTING_FAILED_NOTIFICATION_TYPE)
    expect(built?.input.severity).toBe('error')
    expect(built?.input.data).toMatchObject({ reason: 'destination_unusable' })
    expect(built?.input.bodyVariables?.reason).toBe(
      'translated:pz.receiving.posting.reason.destination_unusable|The warehouse refused the posting.',
    )
  })

  it('falls back to the generic refusal when the event named no reason', () => {
    const built = buildStockPostingFailedNotification(failed({ reason: null }), translate)

    expect(built?.input.data).toMatchObject({ reason: 'posting_rejected' })
  })
})

describe('scope', () => {
  it.each([
    ['tenant', { tenantId: null }],
    ['organization', { organizationId: null }],
    ['document id', { id: null }],
  ])('builds nothing when the event names no %s', (_label, overrides) => {
    expect(buildStockPostedNotification(posted(overrides))).toBeNull()
    expect(buildStockPostingFailedNotification(failed(overrides), translate)).toBeNull()
  })

  it('never fans out a notification the event could not scope', async () => {
    const service = recorder()

    await notifyStockPosted(posted({ organizationId: null }), { resolveService: () => service })
    await notifyStockPostingFailed(failed({ tenantId: null }), {
      resolveService: () => service,
      translate,
    })

    expect(service.calls).toHaveLength(0)
  })
})

describe('delivery', () => {
  it('hands the built notification to the service under the document scope', async () => {
    const service = recorder()

    await notifyStockPosted(posted(), { resolveService: () => service })

    expect(service.calls).toHaveLength(1)
    expect(service.calls[0][1]).toEqual({ tenantId: TENANT_ID, organizationId: ORGANIZATION_ID })
  })

  it('swallows a failing notification service, because the stock is already posted', async () => {
    const explode = (): FeatureNotificationCreator => ({
      createForFeature: async () => {
        throw new Error('notifications are down')
      },
    })

    await expect(notifyStockPosted(posted(), { resolveService: explode })).resolves.toBeUndefined()
    await expect(
      notifyStockPostingFailed(failed(), { resolveService: explode, translate }),
    ).resolves.toBeUndefined()
  })

  it('swallows a notification service that cannot even be resolved', async () => {
    const missing = () => {
      throw new Error('notificationService is not registered')
    }

    await expect(
      notifyStockPosted(posted(), { resolveService: missing as unknown as () => FeatureNotificationCreator }),
    ).resolves.toBeUndefined()
  })
})
