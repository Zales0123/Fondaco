import type { MutationGuard } from '@open-mercato/shared/lib/crud/mutation-guard-registry'
import { BULK_BARCODE_FIELD_KEY, BULK_QUANTITY_FIELD_KEY } from '../lib/bulkBarcodeFields'

/**
 * `catalog.variant` is the resource kind the installed `catalog` module's variant route
 * derives from its `catalog.variants.create`/`catalog.variants.update` command ids
 * (`deriveResourceFromCommandId` singularizes `variants` to `variant`), not the
 * `catalog:catalog_product_variant` entity id used by enrichers and `ce.ts`.
 */
const CATALOG_VARIANT_RESOURCE = 'catalog.variant'

function readCustomFieldValue(
  mutationPayload: Record<string, unknown> | null | undefined,
  key: string,
): unknown {
  const customFields = mutationPayload?.customFields
  if (customFields && typeof customFields === 'object') {
    const value = (customFields as Record<string, unknown>)[key]
    if (value !== undefined) return value
  }
  return mutationPayload?.[key]
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim().length === 0)
}

/**
 * A bulk quantity with no bulk barcode is a multiplier nobody can ever scan into — an
 * incomplete configuration, not a partial one worth saving (issue #35, AC4).
 */
const bulkCodeConfigGuard: MutationGuard = {
  id: 'pz.catalog-variant.bulk-code-config',
  targetEntity: CATALOG_VARIANT_RESOURCE,
  operations: ['create', 'update'],

  async validate(input) {
    const barcode = readCustomFieldValue(input.mutationPayload, BULK_BARCODE_FIELD_KEY)
    const quantity = readCustomFieldValue(input.mutationPayload, BULK_QUANTITY_FIELD_KEY)
    if (isBlank(barcode) && !isBlank(quantity)) {
      return {
        ok: false,
        status: 422,
        message: 'A bulk quantity requires a bulk barcode. Set both or neither.',
      }
    }
    return { ok: true, shouldRunAfterSuccess: false }
  },
}

export const guards: MutationGuard[] = [bulkCodeConfigGuard]
export default guards
