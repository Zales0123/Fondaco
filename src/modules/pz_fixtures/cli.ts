import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { seedGoodsReceipts } from './lib/seed'
import { FIXTURE_DOCUMENT_PREFIX } from './lib/receipts'

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

/** Mirrors the catalog_fixtures scope resolution: flags win, else the single active scope. */
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

async function withContainer<T>(run: (container: Awaited<ReturnType<typeof createRequestContainer>>) => Promise<T>): Promise<T> {
  const container = await createRequestContainer()
  try {
    return await run(container)
  } finally {
    const disposable = container as unknown as { dispose?: () => Promise<void> }
    if (typeof disposable.dispose === 'function') await disposable.dispose()
  }
}

const seedCommand: ModuleCli = {
  command: 'seed',
  async run(rest) {
    const args = parseArgs(rest)
    await withContainer(async (container) => {
      const em = container.resolve<EntityManager>('em')
      let scope: { tenantId: string; organizationId: string; inferred: boolean }
      try {
        scope = await resolveScope(em, {
          tenantId: args.tenant ?? args.tenantId,
          organizationId: args.org ?? args.orgId ?? args.organizationId,
        })
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        console.error('Usage: mercato pz_fixtures seed [--tenant <id>] [--org <id>] [--release <n>]')
        process.exitCode = 1
        return
      }
      if (scope.inferred) {
        console.log(`Auto-detected scope: tenant=${scope.tenantId}, org=${scope.organizationId}`)
      }

      const release = Number.parseInt(args.release ?? '0', 10)
      let summary
      try {
        summary = await seedGoodsReceipts(em, container, scope, {
          release: Number.isFinite(release) ? release : 0,
        })
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
        return
      }

      console.log('📦 Goods receipt fixtures:')
      console.log(`   ${summary.planned} planned`)
      console.log(`   ${summary.created} created, ${summary.alreadyPresent} already present`)
      if (summary.released) console.log(`   ${summary.released} released to receiving`)
      for (const failure of summary.failed) {
        console.log(`   ⚠️  ${failure.documentNumber}: ${failure.reason}`)
      }
      if (summary.failed.length) process.exitCode = 1
    })
  },
}

const statusCommand: ModuleCli = {
  command: 'status',
  async run(rest) {
    const args = parseArgs(rest)
    await withContainer(async (container) => {
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

      const rows = (await em.getConnection().execute(
        `select status, count(*)::int as total
           from pz_goods_receipts
          where tenant_id = ? and organization_id = ? and deleted_at is null
            and document_number like ?
          group by status
          order by status`,
        [scope.tenantId, scope.organizationId, `${FIXTURE_DOCUMENT_PREFIX}%`],
      )) as Array<{ status: string; total: number }>

      console.log(`Demo goods receipts (${FIXTURE_DOCUMENT_PREFIX}*) for tenant=${scope.tenantId} org=${scope.organizationId}`)
      if (rows.length === 0) {
        console.log('   none — run `mercato pz_fixtures seed`')
        return
      }
      for (const row of rows) console.log(`   ${row.status}: ${row.total}`)
    })
  },
}

const commands = [seedCommand, statusCommand]

export default commands
