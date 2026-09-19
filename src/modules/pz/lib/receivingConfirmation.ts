/**
 * Everything confirmation needs to know before it happens: what was counted, where it may be
 * posted, and what stops it.
 *
 * One assessment serves two callers on purpose. The screen renders it so the floor sees why a
 * button is not offered, and the confirm command runs it again inside its own transaction
 * because the screen's copy can be minutes old (ADR-0011).
 */
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { Pallet, PalletLine, type GoodsReceiptStatus } from '../data/entities'
import {
  isStockPostingEnabled,
  loadTrackedVariantIds,
  loadWarehouseDestinations,
  readDefaultDestinationId,
  type DestinationScope,
  type EligibleDestination,
} from './destinations'
import {
  aggregatePostableQuantities,
  resolveConfirmationBlockers,
  type ConfirmationBlocker,
  type PostableQuantity,
} from './stockPosting'

export type ConfirmationReader = {
  em: EntityManager
  queryEngine: QueryEngine
  resolve: <T = unknown>(name: string) => T
}

export type ConfirmationSubject = {
  id: string
  status: GoodsReceiptStatus
  warehouseId: string
  lineCount: number
}

export type ConfirmationAssessment = {
  postingEnabled: boolean
  destinations: EligibleDestination[]
  defaultDestinationId: string | null
  /** The Location that would be pinned: what was asked for, or the default, once eligible. */
  destinationId: string | null
  blockers: ConfirmationBlocker[]
  /** One entry per counted variant, already summed across the document's Pallets. */
  postable: PostableQuantity[]
  palletsOpen: number
}

export type CountedLine = {
  catalogVariantId: string
  quantity: string
  name: string | null
  /** The SKU the variant was counted under; the notification a posting raises names it. */
  sku: string | null
}

/**
 * Counted quantities with the name each product was counted under. The scope is repeated on
 * both reads rather than trusted through the parent id: a foreign key does not constrain a
 * pallet line's scope to its document's.
 */
export async function loadCountedLines(
  em: EntityManager,
  scope: DestinationScope,
  goodsReceiptId: string,
): Promise<CountedLine[]> {
  const pallets = await em.find(Pallet, {
    goodsReceipt: goodsReceiptId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  } as FilterQuery<Pallet>)
  if (pallets.length === 0) return []

  const lines = await em.find(PalletLine, {
    pallet: { $in: pallets.map((pallet) => String(pallet.id)) },
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  } as FilterQuery<PalletLine>)

  return lines.map((line) => ({
    catalogVariantId: line.catalogVariantId,
    quantity: line.quantity,
    name: line.catalogSnapshot?.name ?? null,
    sku: line.catalogSnapshot?.sku ?? null,
  }))
}

export async function assessConfirmation(
  reader: ConfirmationReader,
  scope: DestinationScope,
  subject: ConfirmationSubject,
  requestedDestinationId: string | null,
): Promise<ConfirmationAssessment> {
  const [palletsOpen, countedLines, postingEnabled] = await Promise.all([
    reader.em.count(Pallet, {
      goodsReceipt: subject.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      status: 'open',
    } as FilterQuery<Pallet>),
    loadCountedLines(reader.em, scope, subject.id),
    isStockPostingEnabled(reader.resolve, scope.tenantId),
  ])

  const postable = aggregatePostableQuantities(countedLines)

  if (!postingEnabled) {
    return {
      postingEnabled: false,
      destinations: [],
      defaultDestinationId: null,
      destinationId: null,
      blockers: resolveConfirmationBlockers({
        status: subject.status,
        palletsOpen,
        lineCount: subject.lineCount,
        postingEnabled: false,
        eligibleDestinationCount: 0,
        selectedDestinationId: null,
        selectedDestinationEligible: false,
        trackedProducts: [],
      }),
      postable,
      palletsOpen,
    }
  }

  const [destinations, defaultDestinationId, trackedVariantIds] = await Promise.all([
    loadWarehouseDestinations(reader.queryEngine, scope, subject.warehouseId),
    readDefaultDestinationId(reader.em, scope, subject.warehouseId),
    loadTrackedVariantIds(reader.queryEngine, scope, postable.map((entry) => entry.catalogVariantId)),
  ])

  const eligibleIds = new Set(destinations.map((destination) => destination.id))
  const defaultIsEligible = Boolean(defaultDestinationId && eligibleIds.has(defaultDestinationId))
  // A requested Location always wins, even an ineligible one: silently falling back to the
  // default would post the delivery somewhere the caller did not choose. It is reported as
  // invalid instead.
  const selectedDestinationId = requestedDestinationId ?? (defaultIsEligible ? defaultDestinationId : null)

  return {
    postingEnabled: true,
    destinations,
    defaultDestinationId: defaultIsEligible ? defaultDestinationId : null,
    destinationId: selectedDestinationId && eligibleIds.has(selectedDestinationId) ? selectedDestinationId : null,
    blockers: resolveConfirmationBlockers({
      status: subject.status,
      palletsOpen,
      lineCount: subject.lineCount,
      postingEnabled: true,
      eligibleDestinationCount: destinations.length,
      selectedDestinationId,
      selectedDestinationEligible: Boolean(selectedDestinationId && eligibleIds.has(selectedDestinationId)),
      trackedProducts: trackedProductNames(countedLines, trackedVariantIds),
    }),
    postable,
    palletsOpen,
  }
}

/** The name the floor counted the product under; an unnamed variant is named by its id. */
function trackedProductNames(lines: readonly CountedLine[], trackedVariantIds: ReadonlySet<string>): string[] {
  const names = new Map<string, string>()
  for (const line of lines) {
    if (!trackedVariantIds.has(line.catalogVariantId)) continue
    if (!names.has(line.catalogVariantId)) names.set(line.catalogVariantId, line.name ?? line.catalogVariantId)
  }
  return Array.from(names.values())
}
