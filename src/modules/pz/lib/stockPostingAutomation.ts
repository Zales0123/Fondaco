import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('pz').child({ component: 'stock-posting-automation' })

export type StockPostingEventContext = {
  resolve: <T = unknown>(name: string) => T
}

export type GoodsReceiptConfirmedPayload = {
  id?: string | null
  tenantId?: string | null
  organizationId?: string | null
  documentNumber?: string | null
}

/**
 * The scope comes from the event, which this module emitted about its own record, because a
 * subscriber has no actor to derive one from. The command re-reads the document under that
 * scope before writing anything, so an event naming a scope that does not own the document
 * finds nothing rather than acting on it.
 */
function buildCommandContext(ctx: StockPostingEventContext, organizationId: string): CommandRuntimeContext {
  return {
    container: { resolve: ctx.resolve } as CommandRuntimeContext['container'],
    auth: null,
    organizationScope: null,
    selectedOrganizationId: organizationId,
    organizationIds: [organizationId],
  }
}

/**
 * Puts a confirmed delivery's counted goods into `wms` stock.
 *
 * The posting command is the one place the work lives; this only hands it the document. A
 * document whose posting is already settled — because the toggle was off when it was
 * confirmed, because it posted already, or because this event was delivered twice — makes
 * the command refuse with a conflict, which is the expected answer here and not a failure to
 * retry. Anything else is rethrown so the durable queue tries again.
 */
export async function postStockForConfirmedReceipt(
  payload: GoodsReceiptConfirmedPayload,
  ctx: StockPostingEventContext,
): Promise<void> {
  const id = typeof payload.id === 'string' ? payload.id : null
  const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId : null
  const organizationId = typeof payload.organizationId === 'string' ? payload.organizationId : null
  if (!id || !tenantId || !organizationId) return

  try {
    await ctx.resolve<CommandBus>('commandBus').execute('pz.goodsReceipts.postStock', {
      input: { id, tenantId, organizationId },
      ctx: buildCommandContext(ctx, organizationId),
    })
  } catch (error) {
    if (isCrudHttpError(error) && error.status === 409) {
      logger.info('Goods receipt has no stock posting to run', { goodsReceiptId: id })
      return
    }
    throw error
  }
}
