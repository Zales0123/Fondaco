import type { CustomEntitySpec } from '@open-mercato/shared/modules/entities'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { BULK_CODE_FIELDS } from './lib/bulkBarcodeFields'

/**
 * `catalog:catalog_product_variant` is a system entity the installed `catalog` module
 * already declares its own `ce.ts` entry for. Custom field sets from every module that
 * declares fields for the same entity id are merged additively by the generator, so this
 * entry only needs to carry the two fields this module adds (issue #35) — it does not
 * repeat `catalog`'s label/description/labelField.
 */
export const entities: CustomEntitySpec[] = [
  {
    id: E.catalog.catalog_product_variant,
    fields: BULK_CODE_FIELDS,
  },
]

export default entities
