import type { CustomFieldDefinition } from '@open-mercato/shared/modules/entities'

/**
 * The optional collective (carton) barcode a supplier prints alongside the piece barcode,
 * plus the number of base units it represents. Attached to `catalog:catalog_product_variant`
 * from `../ce.ts` — backoffice/catalog is the only place either is edited; the Warehouseman
 * panel only reads them through `barcodeResolution.ts` (issue #35).
 */
export const BULK_BARCODE_FIELD_KEY = 'bulk_barcode'
export const BULK_QUANTITY_FIELD_KEY = 'bulk_quantity'

export const BULK_CODE_FIELDS: CustomFieldDefinition[] = [
  {
    key: BULK_BARCODE_FIELD_KEY,
    kind: 'text',
    label: 'Bulk (carton) barcode',
    description:
      'Barcode printed on the collective package. Scanning it during receiving counts the multiplier below instead of one piece.',
    required: false,
    filterable: true,
    formEditable: true,
    listVisible: false,
  },
  {
    key: BULK_QUANTITY_FIELD_KEY,
    kind: 'integer',
    label: 'Bulk (carton) quantity',
    description: 'Number of base units the bulk barcode represents.',
    required: false,
    filterable: false,
    formEditable: true,
    listVisible: false,
    validation: [
      { rule: 'integer', message: 'Enter a whole number of base units.' },
      { rule: 'gte', param: 1, message: 'Enter at least 1 base unit.' },
    ],
  },
]
