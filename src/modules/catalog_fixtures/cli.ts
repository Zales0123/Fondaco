import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { assignFixtureBarcodes } from './lib/seed'
import { seedBeverageProducts } from './lib/seedProducts'

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

type ScopeRow = { id: string }

/** Mirrors the wms_fixtures scope resolution: flags win, else the single active scope. */
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

const assignBarcodes: ModuleCli = {
  command: 'assign-barcodes',
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
        console.error(
          'Usage: mercato catalog_fixtures assign-barcodes [--tenant <id>] [--org <id>] [--force]',
        )
        process.exitCode = 1
        return
      }
      if (scope.inferred) {
        console.log(`Auto-detected scope: tenant=${scope.tenantId}, org=${scope.organizationId}`)
      }

      const summary = await assignFixtureBarcodes(em, container, scope, {
        force: args.force === 'true',
      })

      console.log('🏷️  Catalog fixture barcodes:')
      console.log(`   ${summary.total} variants in scope`)
      console.log(`   ${summary.assigned} assigned, ${summary.alreadyPresent} already had one`)
      for (const failure of summary.failed) {
        console.log(`   ⚠️  ${failure.sku}: ${failure.reason}`)
      }
      if (summary.failed.length) process.exitCode = 1
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      if (typeof disposable.dispose === 'function') await disposable.dispose()
    }
  },
}

const seedProducts: ModuleCli = {
  command: 'seed-products',
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
        console.error('Usage: mercato catalog_fixtures seed-products [--tenant <id>] [--org <id>]')
        console.error('Run it where the app reads its storage (docker compose exec app ...).')
        process.exitCode = 1
        return
      }
      if (scope.inferred) {
        console.log(`Auto-detected scope: tenant=${scope.tenantId}, org=${scope.organizationId}`)
      }

      const summary = await seedBeverageProducts(em, container, scope)

      console.log('🥤 Catalog fixture products:')
      console.log(`   ${summary.created} created, ${summary.skipped} already present`)
      console.log(`   ${summary.images} images attached`)
      if (summary.images) {
        console.log('   Image bytes went to this process\'s attachment storage — under the')
        console.log('   docker dev stack that must be the app container, not the host.')
      }
      for (const failure of summary.failed) {
        console.log(`   ⚠️  ${failure.handle}: ${failure.reason}`)
      }
      if (summary.failed.length) process.exitCode = 1
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
        process.exitCode = 1
        return
      }

      const conn = em.getConnection()
      const rows = (await conn.execute(
        `select count(*)::int as total,
                count(barcode)::int as with_barcode,
                count(gtin_type)::int as with_gtin_type
           from catalog_product_variants
          where tenant_id = ? and organization_id = ? and deleted_at is null`,
        [scope.tenantId, scope.organizationId],
      )) as Array<{ total: number; with_barcode: number; with_gtin_type: number }>

      const row = rows[0]
      console.log(`Catalog variants for tenant=${scope.tenantId} org=${scope.organizationId}`)
      console.log(`   total: ${row.total}`)
      console.log(`   with barcode: ${row.with_barcode}`)
      console.log(`   with gtin type: ${row.with_gtin_type}`)
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      if (typeof disposable.dispose === 'function') await disposable.dispose()
    }
  },
}

const commands = [seedProducts, assignBarcodes, statusCommand]

export default commands
