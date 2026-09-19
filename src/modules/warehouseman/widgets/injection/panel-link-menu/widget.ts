import { InjectionPosition } from '@open-mercato/shared/modules/widgets/injection-position'
import type { InjectionMenuItemWidget } from '@open-mercato/shared/modules/widgets/injection'
import { WAREHOUSEMAN_PANEL_HREF, WAREHOUSEMAN_PANEL_MENU_ITEM_ID } from '../../../lib/panelMenu'

/**
 * Puts the warehouse-floor panel into the installed WMS sidebar group, which otherwise
 * only lists `/backend` destinations — the panel itself is a frontend page, so nothing
 * discovers it and it was reachable only by typing the URL.
 *
 * `wms.nav.group` is the group id the installed WMS pages declare as `pageGroupKey`, and
 * `buildAdminNav` keys the sidebar group on exactly that value (`pageGroupKey ?? pageGroup`),
 * so joining the group needs no override. `requiredModules` keeps this entry from
 * conjuring an orphan "WMS" group of its own in an app that does not install `wms`.
 *
 * The feature gate mirrors the panel page's own `requireFeatures`, so the entry is never
 * offered to a user the panel would turn away.
 */
const widget: InjectionMenuItemWidget = {
  metadata: {
    id: 'warehouseman.injection.panel-link-menu',
    title: 'Warehouseman panel sidebar entry',
    features: ['warehouseman.panel.access'],
    requiredModules: ['wms'],
  },
  menuItems: [
    {
      id: WAREHOUSEMAN_PANEL_MENU_ITEM_ID,
      labelKey: 'warehouseman.nav.panelLink',
      label: 'Warehouseman panel',
      // `external-link` is a name the installed Lucide registry lists, and it reads as
      // "leaves the backend" — the entry opens the panel in a new tab.
      icon: 'external-link',
      href: WAREHOUSEMAN_PANEL_HREF,
      groupId: 'wms.nav.group',
      groupLabelKey: 'wms.nav.group',
      groupLabel: 'WMS',
      placement: { position: InjectionPosition.Last },
    },
  ],
}

export default widget
