import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/**
 * Mounts the panel entry on the framework-owned backend sidebar menu host.
 *
 * Declared as ONE static object literal: the fact extractor can only fold a statically
 * known value, so an export built by a ternary would publish zero contributions. Gate
 * behavior inside the widget (`features` / `requiredModules`) instead of branching here.
 */
export const injectionTable: ModuleInjectionTable = {
  'menu:sidebar:main': {
    widgetId: 'warehouseman.injection.panel-link-menu',
    priority: 50,
  },
}

export default injectionTable
