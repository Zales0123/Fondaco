import { readFileSync, writeFileSync } from 'node:fs'

const [project] = process.argv.slice(2)

if (!project) {
  console.error('usage: wt-worktree-env.mjs <compose-project>')
  process.exit(1)
}

const raw = readFileSync('.env', 'utf8')

const read = (key, fallback) => {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(raw)
  return match ? match[1].trim() : fallback
}

const serviceHost = (service) => `${service}.${project}.orb.local`
const appUrl = `http://${serviceHost('app')}`

const overrides = {
  COMPOSE_PROJECT_NAME: project,
  APP_URL: appUrl,
  APP_ALLOWED_ORIGINS: appUrl,
  DATABASE_URL: `postgres://${read('POSTGRES_USER', 'postgres')}:${read('POSTGRES_PASSWORD', 'postgres')}@${serviceHost('postgres')}:5432/${read('POSTGRES_DB', 'open-mercato')}`,
  DOCUMENTS_COLLAB_REDIS_URL: `redis://${serviceHost('redis')}:6379`,
  MEILISEARCH_HOST: `http://${serviceHost('meilisearch')}:7700`,
}

const applied = new Set()
const lines = raw.split('\n').map((line) => {
  const key = /^([A-Z0-9_]+)=/.exec(line)?.[1]
  if (!key || !(key in overrides)) return line
  applied.add(key)
  return `${key}=${overrides[key]}`
})

while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()

const missing = Object.entries(overrides).filter(([key]) => !applied.has(key))
if (missing.length) {
  lines.push('', `# worktree overrides (${project})`, ...missing.map(([key, value]) => `${key}=${value}`))
}

writeFileSync('.env', `${lines.join('\n')}\n`)

console.log(`.env pinned to ${project} — app at ${appUrl}`)
