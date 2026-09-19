import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/**
 * Mounts the print action on the installed catalog product grid.
 *
 * `data-table:catalog.products.list:row-actions` is an exact, frozen host
 * declared by the catalog module, so no installed file is touched. The entry is
 * inert when catalog is absent, and the widget additionally declares
 * `requiredModules` / `features` — never branch this exported value, as the
 * fact extractor can only fold a statically known object.
 */
export const injectionTable: ModuleInjectionTable = {
  'data-table:catalog.products.list:row-actions': {
    widgetId: 'label_printing.injection.print-label-row-action',
    priority: 40,
  },
}
