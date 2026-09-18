import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { seedWmsFixtures } from './lib/seed'

function parseArgs(rest: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 1) {
    const part = rest[i]
    if (!part?.startsWith('--')) continue
    const [rawKey, rawValue] = part.slice(2).split('=')
    if (!rawKey) continue
    if (rawValue !== undefined) args[rawKey] = rawValue
    else if (rest[i + 1] && !rest[i + 1]!.startsWith('--')) {
      args[rawKey] = rest[i + 1]!
      i += 1
    } else args[rawKey] = 'true'
  }
  return args
}

type ScopeRow = { id: string; tenant_id?: string | null }

/**
 * Mirrors `seeds load` scope resolution: explicit flags win, otherwise fall back
 * to the single active tenant/organization and fail loudly when ambiguous.
 */
async function resolveScope(
  em: EntityManager,
  input: { tenantId?: string; organizationId?: string },
): Promise<{ tenantId: string; organizationId: string; inferred: boolean }> {
  const tenantId = input.tenantId?.trim() || ''
  const organizationId = input.organizationId?.trim() || ''
  if (tenantId && organizationId) return { tenantId, organizationId, inferred: false }

  const conn = em.getConnection()
  const requireSingle = (rows: ScopeRow[], label: string, flag: string): ScopeRow => {
    if (rows.length === 1) return rows[0]
    if (rows.length === 0) throw new Error(`Cannot auto-detect ${label}: none is active. Pass ${flag}.`)
    throw new Error(`Cannot auto-detect ${label}: several are active. Pass ${flag}.`)
  }

  const resolvedTenantId = tenantId || requireSingle(
    (await conn.execute(
      'select id from tenants where deleted_at is null and is_active = true order by created_at asc, id asc limit 2',
    )) as ScopeRow[],
    'tenant',
    '--tenant',
  ).id

  const resolvedOrganizationId = organizationId || requireSingle(
    (await conn.execute(
      'select id from organizations where tenant_id = ? and deleted_at is null and is_active = true order by created_at asc, id asc limit 2',
      [resolvedTenantId],
    )) as ScopeRow[],
    'organization',
    '--org',
  ).id

  return { tenantId: resolvedTenantId, organizationId: resolvedOrganizationId, inferred: true }
}

const seedCommand: ModuleCli = {
  command: 'seed',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    try {
      const em = container.resolve<EntityManager>('em')
      let scope: { tenantId: string; organizationId: string; inferred: boolean }
      try {
        scope = await resolveScope(em, {
          tenantId: args.tenant ?? args.tenantId,
          organizationId: args.org ?? args.orgId ?? args.organizationId,
        })
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        console.error('Usage: mercato wms_fixtures seed [--tenant <tenantId>] [--org <organizationId>]')
        process.exitCode = 1
        return
      }
      if (scope.inferred) {
        console.log(`Auto-detected scope: tenant=${scope.tenantId}, org=${scope.organizationId}`)
      }

      const summary = await seedWmsFixtures(em, container, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      })

      if (summary.skipped) {
        console.log(`⏭️  WMS fixtures already loaded — ${summary.reason}. Nothing to do.`)
        return
      }
      console.log('📦 WMS fixtures loaded:')
      console.log(`   ${summary.warehouses} warehouses, ${summary.zones} zones, ${summary.locations} locations`)
      console.log(`   ${summary.profiles} inventory profiles, ${summary.lots} lots`)
      console.log(`   ${summary.receipts} receipts, ${summary.moves} moves, ${summary.cycleCounts} cycle counts`)
      console.log(`   ${summary.reservations} reservations, ${summary.assignments} sales-order assignments`)
      for (const warning of summary.warnings) console.log(`   ⚠️  ${warning}`)
      console.log('   Verify the ledger with: yarn mercato wms verify-balances --tenant <t> --org <o>')
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      if (typeof disposable.dispose === 'function') await disposable.dispose()
    }
  },
}

const statusCommand: ModuleCli = {
  command: 'status',
  async run(rest) {
    const args = parseArgs(rest)
    const container = await createRequestContainer()
    try {
      const em = container.resolve<EntityManager>('em')
      let scope: { tenantId: string; organizationId: string; inferred: boolean }
      try {
        scope = await resolveScope(em, {
          tenantId: args.tenant ?? args.tenantId,
          organizationId: args.org ?? args.orgId ?? args.organizationId,
        })
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        console.error('Usage: mercato wms_fixtures status [--tenant <tenantId>] [--org <organizationId>]')
        process.exitCode = 1
        return
      }

      const conn = em.getConnection()
      const tables: Array<[string, string]> = [
        ['warehouses', 'wms_warehouses'],
        ['zones', 'wms_warehouse_zones'],
        ['locations', 'wms_warehouse_locations'],
        ['inventory profiles', 'wms_product_inventory_profiles'],
        ['lots', 'wms_inventory_lots'],
        ['balances', 'wms_inventory_balances'],
        ['movements', 'wms_inventory_movements'],
        ['reservations', 'wms_inventory_reservations'],
      ]
      console.log(`WMS data for tenant=${scope.tenantId} org=${scope.organizationId}`)
      for (const [label, table] of tables) {
        const rows = (await conn.execute(
          `select count(*)::int as count from ${table} where organization_id = ? and tenant_id = ? and deleted_at is null`,
          [scope.organizationId, scope.tenantId],
        )) as Array<{ count: number }>
        console.log(`  ${String(rows[0]?.count ?? 0).padStart(5)}  ${label}`)
      }
      const assignments = (await conn.execute(
        'select count(*)::int as count from wms_sales_order_warehouse_assignments where organization_id = ? and tenant_id = ?',
        [scope.organizationId, scope.tenantId],
      )) as Array<{ count: number }>
      console.log(`  ${String(assignments[0]?.count ?? 0).padStart(5)}  sales-order warehouse assignments`)
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      if (typeof disposable.dispose === 'function') await disposable.dispose()
    }
  },
}

const cliCommands: ModuleCli[] = [seedCommand, statusCommand]

export default cliCommands
