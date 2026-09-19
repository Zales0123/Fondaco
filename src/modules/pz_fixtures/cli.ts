import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { seedGoodsReceipts } from './lib/seed'
import { FIXTURE_DOCUMENT_PREFIX, type FixtureIntent } from './lib/receipts'
import { STOCK_POSTING_TOGGLE } from '@/modules/pz/lib/destinations'
import { enableStockPosting, readStockPostingState, type StockPostingSetupSummary } from './lib/posting'
import type { DefaultDestinationPlan } from './lib/postingPlan'

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

/** A bare `--flag` means yes; `--flag=false` is still honoured so a script can say no. */
function parseFlag(args: Record<string, string>, key: string): boolean {
  const raw = args[key]
  if (raw === undefined) return false
  return !['false', '0', 'no'].includes(raw.trim().toLowerCase())
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

const INTENT_LABELS: Record<FixtureIntent, string> = {
  postable: 'postable — confirming it posts stock',
  lotBlocked: 'lot-tracked — confirming it is refused',
  mixed: 'ordinary',
}

/**
 * The same plan reads differently depending on whether it was carried out: `status` reports
 * what would happen, the seed reports what did. Saying "set to B-01-01" after a read-only
 * command would be a plain lie about the state of the database.
 */
function describeDestination(plan: DefaultDestinationPlan, applied: boolean): string {
  if (plan.action === 'skip') return 'no eligible location — nothing to preselect'
  if (plan.action === 'set') {
    const code = plan.destination?.code ?? '?'
    return applied
      ? `default destination set to ${code}`
      : `no default destination — ${code} would be preselected`
  }
  if (!plan.currentDefaultEligible) {
    return 'default destination already set, but it is not an eligible location — left as it is'
  }
  return `default destination already set to ${plan.destination?.code ?? '?'} — left as it is`
}

function printPostingSetup(summary: StockPostingSetupSummary): void {
  console.log('🚚 Stock posting:')
  if (summary.toggle.outcome === 'alreadyEnabled') {
    console.log(`   ${STOCK_POSTING_TOGGLE}: already on for this tenant`)
  } else if (summary.toggle.outcome === 'enabled') {
    console.log(`   ${STOCK_POSTING_TOGGLE}: enabled for this tenant`)
  } else {
    console.log(`   ⚠️  ${STOCK_POSTING_TOGGLE}: not enabled — ${summary.toggle.reason}`)
  }
  for (const plan of summary.destinations) {
    console.log(`   ${plan.warehouseName}: ${describeDestination(plan, true)}`)
  }
  for (const failure of summary.failures) {
    console.log(`   ⚠️  ${failure.warehouseName}: ${failure.reason}`)
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
        console.error('Usage: mercato pz_fixtures seed [--tenant <id>] [--org <id>] [--release <n>] [--no-posting]')
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
          enablePosting: !parseFlag(args, 'no-posting'),
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
      for (const document of summary.documents) {
        if (document.intent === 'mixed') continue
        const state = document.intentSatisfied ? INTENT_LABELS[document.intent] : 'could not be shaped as planned'
        const released = document.released ? ', released' : ''
        console.log(`   ${document.documentNumber} · ${document.warehouseName} · ${state}${released}`)
      }
      for (const failure of summary.failed) {
        console.log(`   ⚠️  ${failure.documentNumber}: ${failure.reason}`)
      }

      if (summary.posting) printPostingSetup(summary.posting)
      else console.log('🚚 Stock posting: left alone (--no-posting)')

      if (summary.failed.length) process.exitCode = 1
    })
  },
}

/**
 * The reviewer setup on its own, for an environment seeded before the seed did it. It touches
 * no document, so it is safe to run against a database full of real deliveries — the only
 * writes are the tenant's toggle override and a Default Destination on a Warehouse that has
 * none.
 */
const enablePostingCommand: ModuleCli = {
  command: 'enable-posting',
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
        console.error('Usage: mercato pz_fixtures enable-posting [--tenant <id>] [--org <id>]')
        process.exitCode = 1
        return
      }
      if (scope.inferred) {
        console.log(`Auto-detected scope: tenant=${scope.tenantId}, org=${scope.organizationId}`)
      }

      let summary: StockPostingSetupSummary
      try {
        summary = await enableStockPosting(em, container, scope)
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
        return
      }

      printPostingSetup(summary)
      if (summary.toggle.outcome === 'unavailable' || summary.failures.length) process.exitCode = 1
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
      } else {
        for (const row of rows) console.log(`   ${row.status}: ${row.total}`)
      }

      // Documents are only half the story: whether confirming one posts anything depends on
      // the toggle and on the Warehouse having somewhere to post into, and a reviewer looking
      // at a seeded environment that refuses every confirmation needs to see which of the two
      // is missing.
      const state = await readStockPostingState(em, container, scope)
      console.log('🚚 Stock posting:')
      console.log(`   ${STOCK_POSTING_TOGGLE}: ${state.enabled ? 'on' : 'off — run `mercato pz_fixtures enable-posting`'}`)
      for (const plan of state.destinations) {
        console.log(`   ${plan.warehouseName}: ${describeDestination(plan, false)}`)
      }
    })
  },
}

const commands = [seedCommand, enablePostingCommand, statusCommand]

export default commands
