// Central place to enable modules and their source.
// - id: module id (plural snake_case; special cases: 'auth')
// - from: '@open-mercato/core' | '@app' | custom alias/path in future
import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'

export type ModuleEntry = { id: string; from?: '@open-mercato/core' | '@app' | string }

export const enabledModules: ModuleEntry[] = [
  { id: 'auth', from: '@open-mercato/core' },
  { id: 'directory', from: '@open-mercato/core' },
  { id: 'configs', from: '@open-mercato/core' },
  { id: 'entities', from: '@open-mercato/core' },
  { id: 'query_index', from: '@open-mercato/core' },
  { id: 'api_docs', from: '@open-mercato/core' },
  { id: 'audit_logs', from: '@open-mercato/core' },
  { id: 'notifications', from: '@open-mercato/core' },
  { id: 'dashboards', from: '@open-mercato/core' },
  { id: 'events', from: '@open-mercato/events' },
  { id: 'search', from: '@open-mercato/search' },
  { id: 'attachments', from: '@open-mercato/core' },
  { id: 'customers', from: '@open-mercato/core' },
  { id: 'dictionaries', from: '@open-mercato/core' },
  { id: 'feature_toggles', from: '@open-mercato/core' },
  { id: 'catalog', from: '@open-mercato/core' },
  { id: 'sales', from: '@open-mercato/core' },
  { id: 'wms', from: '@open-mercato/core' },
  { id: 'currencies', from: '@open-mercato/core' },
  { id: 'label_printing', from: '@app' },
  // Backfills demo GTINs onto the variants catalog's own seedExamples creates
  // (it sets none). Must come after `catalog` so the variants exist.
  { id: 'catalog_fixtures', from: '@app' },
  { id: 'barcode_scanner', from: '@app' },
  // Demo goods receipts for the pz receiving flow. CLI-only on purpose: `pz` declares no
  // seedExamples so a demo delivery never lands in the real document series, and this
  // module keeps that property rather than overriding the decision.
  { id: 'pz_fixtures', from: '@app' },
  // Demo warehouse/inventory data for the installed wms module (see
  // src/modules/wms_fixtures). Seeds on `mercato init` unless --no-examples.
  // Keep last: setup hooks run in this list's order, and the fixtures depend on
  // the catalog and sales example data seeded above them.
  { id: 'wms_fixtures', from: '@app' },
]

const enterpriseModulesEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES, false)
const enterpriseSsoEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES_SSO, false)
const enterpriseSecurityEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES_SECURITY, false)
const enterpriseAgentsEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES_AGENTS, false)

if (enterpriseModulesEnabled) {
  enabledModules.push(
    { id: 'record_locks', from: '@open-mercato/enterprise' },
    { id: 'system_status_overlays', from: '@open-mercato/enterprise' },
  )
}

if (enterpriseModulesEnabled && enterpriseSsoEnabled) {
  enabledModules.push({ id: 'sso', from: '@open-mercato/enterprise' })
}

if (enterpriseModulesEnabled && enterpriseSecurityEnabled) {
  enabledModules.push({ id: 'security', from: '@open-mercato/enterprise' })
}

if (enterpriseModulesEnabled && enterpriseAgentsEnabled) {
  enabledModules.push({ id: 'agent_orchestrator', from: '@open-mercato/enterprise' })
}

enabledModules.push({ id: 'pz', from: '@app' })
enabledModules.push({ id: 'warehouseman', from: '@app' })
