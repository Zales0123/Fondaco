import type { EntityManager } from '@mikro-orm/postgresql'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { announcementLimit, type AnnouncementLimit } from '../lib/announcementLimit'
import { type ProcurementsReadDatabase, resolveScopedOrganizationIds } from './readModel'

/**
 * Reading what has been announced against purchase order lines.
 *
 * Every surface that shows a free quantity goes through here, so the list column, the
 * picker and the reservation check can never disagree about what "free" means. The sum is
 * computed in the app rather than by the database, because the limit rule lives in
 * `lib/announcementLimit.ts` and has to stay one implementation.
 */

export type AnnouncedQuantities = Map<string, string[]>

/**
 * Sums the outstanding claims on each of the given order lines.
 *
 * Lines with no claim are present with an empty list rather than absent, so a caller can
 * tell "nothing announced" from "not read".
 */
export async function readAnnouncedQuantities(
  ctx: CrudCtx,
  lineIds: readonly string[],
): Promise<AnnouncedQuantities> {
  const byLine: AnnouncedQuantities = new Map()
  const unique = Array.from(new Set(lineIds.filter((id) => id.length > 0)))
  for (const lineId of unique) byLine.set(lineId, [])
  if (unique.length === 0) return byLine

  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) return byLine
  const scopedOrgIds = resolveScopedOrganizationIds(ctx)
  if (scopedOrgIds !== null && scopedOrgIds.length === 0) return byLine

  const em = ctx.container.resolve<EntityManager>('em')
  const db = em.getKysely<ProcurementsReadDatabase>()
  let claims = db
    .selectFrom('procurements_purchase_order_commitments')
    .select(['purchase_order_line_id', 'quantity'])
    .where('purchase_order_line_id', 'in', unique)
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'outstanding')
  if (scopedOrgIds !== null) claims = claims.where('organization_id', 'in', scopedOrgIds)

  for (const row of await claims.execute()) {
    const bucket = byLine.get(String(row.purchase_order_line_id))
    if (bucket) bucket.push(String(row.quantity))
  }
  return byLine
}

/** Turns the raw claims into the limit each line reports. */
export function toAnnouncementLimits(
  lines: readonly { id: string; quantityOrdered: string }[],
  announced: AnnouncedQuantities,
): Map<string, AnnouncementLimit> {
  const limits = new Map<string, AnnouncementLimit>()
  for (const line of lines) {
    limits.set(line.id, announcementLimit(line.quantityOrdered, announced.get(line.id) ?? []))
  }
  return limits
}
