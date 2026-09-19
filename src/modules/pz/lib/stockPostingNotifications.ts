import { buildFeatureNotificationFromType } from '@open-mercato/core/modules/notifications/lib/notificationBuilder'
import type {
  CreateFeatureNotificationServiceInput,
  NotificationServiceContext,
} from '@open-mercato/core/modules/notifications/lib/notificationService'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { notificationTypes } from '../notifications'
import type { StockPostingFailureReason } from '../data/entities'
import type { TranslateFn } from './goodsReceiptInput'

const logger = createLogger('pz').child({ component: 'stock-posting-notifications' })

/**
 * Whoever may look at a goods receipt is told about its posting. The office holds it; the
 * floor does not, and a warehouseman has nothing to do about a destination the office pinned.
 */
export const STOCK_POSTING_NOTIFICATION_FEATURE = 'pz.goodsReceipts.view'

/** The entity the notification points at, so `deleteBySource` and dedupe both find it. */
export const STOCK_POSTING_NOTIFICATION_ENTITY_TYPE = 'pz:goods_receipt'

export const STOCK_POSTED_NOTIFICATION_TYPE = 'pz.goods_receipt.stock_posted'
export const STOCK_POSTING_FAILED_NOTIFICATION_TYPE = 'pz.goods_receipt.stock_posting_failed'

/** The scope every posting event carries, because a subscriber has no actor to derive one from. */
type StockPostingEventScope = {
  id?: string | null
  documentNumber?: string | null
  tenantId?: string | null
  organizationId?: string | null
}

export type StockPostedEventPayload = StockPostingEventScope & {
  /** Decimal string at storage precision, summed across every posted variant. */
  postedQuantity?: string | null
  /** Distinct catalog variants the posting moved — one `wms` movement each. */
  postedVariants?: number | null
}

export type StockPostingFailedEventPayload = StockPostingEventScope & {
  reason?: StockPostingFailureReason | null
}

/**
 * The seam that keeps this testable without a container: the subscriber news up the installed
 * service, everything else here is decided from the payload alone.
 */
export type FeatureNotificationCreator = {
  createForFeature: (
    input: CreateFeatureNotificationServiceInput,
    ctx: NotificationServiceContext,
  ) => Promise<unknown>
}

export type StockPostingNotificationDeps = {
  resolveService: () => FeatureNotificationCreator
}

export type BuiltStockPostingNotification = {
  input: CreateFeatureNotificationServiceInput
  ctx: NotificationServiceContext
}

type ResolvedScope = { id: string; tenantId: string; organizationId: string; documentNumber: string }

/**
 * Scope comes from the event and nothing else, and a payload missing either half is dropped
 * rather than widened: a notification fanned out without an organization would reach every
 * office of the tenant, which is a leak, not a broadcast.
 */
function resolveScope(payload: StockPostingEventScope): ResolvedScope | null {
  const id = typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : null
  const tenantId = typeof payload.tenantId === 'string' && payload.tenantId.length > 0 ? payload.tenantId : null
  const organizationId =
    typeof payload.organizationId === 'string' && payload.organizationId.length > 0 ? payload.organizationId : null
  if (!id || !tenantId || !organizationId) return null
  return {
    id,
    tenantId,
    organizationId,
    documentNumber: typeof payload.documentNumber === 'string' ? payload.documentNumber : '',
  }
}

function goodsReceiptHref(id: string): string {
  return `/backend/wms/goods-receipts/${encodeURIComponent(id)}`
}

/**
 * Trailing zeros are dropped as text, never by parsing: `numeric(18,4)` arrives as `12.0000`,
 * and "posted 12.0000" reads like a measurement rather than a count.
 */
function formatQuantity(value: string): string {
  if (!value.includes('.')) return value
  return value.replace(/\.?0+$/, '') || '0'
}

/**
 * One notification per receipt per outcome. The group key carries both, so a redelivered
 * event refreshes the item the office already has instead of stacking another copy of it.
 */
function groupKeyFor(type: string, id: string): string {
  return `${type}:${id}`
}

function build(
  type: string,
  scope: ResolvedScope,
  bodyVariables: Record<string, string>,
  data: Record<string, string>,
): BuiltStockPostingNotification | null {
  const typeDef = notificationTypes.find((candidate) => candidate.type === type)
  if (!typeDef) return null

  const input = buildFeatureNotificationFromType(typeDef, {
    requiredFeature: STOCK_POSTING_NOTIFICATION_FEATURE,
    titleVariables: { documentNumber: scope.documentNumber },
    bodyVariables,
    sourceEntityType: STOCK_POSTING_NOTIFICATION_ENTITY_TYPE,
    sourceEntityId: scope.id,
    // The declared `linkHref` carries a `{sourceEntityId}` placeholder that only action
    // dispatch substitutes; the bell pushes `linkHref` verbatim, so it is made concrete here.
    linkHref: goodsReceiptHref(scope.id),
    groupKey: groupKeyFor(type, scope.id),
  })

  return {
    input: { ...input, data, restrictRecipientsToOrganization: true },
    ctx: { tenantId: scope.tenantId, organizationId: scope.organizationId },
  }
}

export function buildStockPostedNotification(
  payload: StockPostedEventPayload,
): BuiltStockPostingNotification | null {
  const scope = resolveScope(payload)
  if (!scope) return null

  const quantity = formatQuantity(typeof payload.postedQuantity === 'string' ? payload.postedQuantity : '0')
  const variants = String(typeof payload.postedVariants === 'number' ? payload.postedVariants : 0)
  return build(
    STOCK_POSTED_NOTIFICATION_TYPE,
    scope,
    { documentNumber: scope.documentNumber, quantity, variants },
    { goodsReceiptId: scope.id, postedQuantity: quantity, postedVariants: variants },
  )
}

export function buildStockPostingFailedNotification(
  payload: StockPostingFailedEventPayload,
  translate: TranslateFn,
): BuiltStockPostingNotification | null {
  const scope = resolveScope(payload)
  if (!scope) return null

  const reason = payload.reason ?? 'posting_rejected'
  // The stable code travels in `data` for anything reading these back; the body gets the
  // sentence the office already sees on the document, so both say the same thing.
  const reasonLabel = translate(
    `pz.receiving.posting.reason.${reason}`,
    'The warehouse refused the posting.',
  )
  return build(
    STOCK_POSTING_FAILED_NOTIFICATION_TYPE,
    scope,
    { documentNumber: scope.documentNumber, reason: reasonLabel },
    { goodsReceiptId: scope.id, reason },
  )
}

/**
 * Delivering is best effort on purpose. The stock is already posted — or already recorded as
 * failed — by the time this runs, and rethrowing would make the durable queue replay a
 * settled posting for the sake of a bell item nobody is waiting on.
 */
async function deliver(
  built: BuiltStockPostingNotification | null,
  deps: StockPostingNotificationDeps,
): Promise<void> {
  if (!built) return
  try {
    await deps.resolveService().createForFeature(built.input, built.ctx)
  } catch (error) {
    logger.error('Goods receipt stock posting notification failed', {
      err: error,
      goodsReceiptId: built.input.sourceEntityId,
      notificationType: built.input.type,
    })
  }
}

export async function notifyStockPosted(
  payload: StockPostedEventPayload,
  deps: StockPostingNotificationDeps,
): Promise<void> {
  await deliver(buildStockPostedNotification(payload), deps)
}

export async function notifyStockPostingFailed(
  payload: StockPostingFailedEventPayload,
  deps: StockPostingNotificationDeps & { translate: TranslateFn },
): Promise<void> {
  await deliver(buildStockPostingFailedNotification(payload, deps.translate), deps)
}
