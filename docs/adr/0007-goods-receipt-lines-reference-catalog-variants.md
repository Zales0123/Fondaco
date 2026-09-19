# Goods receipt lines reference catalog variants, plus an immutable snapshot

A line stores `catalogVariantId` (required) rather than `catalogProductId` alone, matching every
`wms` entity, which keys on the variant. Users think in products, so the picker shows products and
resolves to the product's default variant; `catalogProductId` is stored alongside for querying.

Because the document must stay readable after the catalog changes underneath it, each line also
carries a `catalogSnapshot` (name, SKU) and a `uomSnapshot`, and the header carries a
`warehouseSnapshot` (name, code) taken at confirmation. A confirmed receipt pointing at a renamed,
soft-deleted or reworked product still says what was received. Confirming into a warehouse that has
since been deleted is blocked rather than snapshotted through — that is a data error worth surfacing.

## Consequences

- Unit of measure is prefilled from `CatalogProduct.defaultUnit` but remains free text, so products
  with no configured unit conversions do not hard-fail. The snapshot is what the document means.
