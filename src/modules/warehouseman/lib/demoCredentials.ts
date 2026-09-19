export type DemoCredentials = { email: string; password: string }

export type DemoCredentialsEnv = {
  NODE_ENV?: string
  OM_SHOW_DEMO_CREDENTIALS?: string
  OM_INIT_WAREHOUSEMAN_EMAIL?: string
  OM_INIT_WAREHOUSEMAN_PASSWORD?: string
}

/**
 * Each value is read as a literal `process.env.X` expression on purpose. The bundler
 * substitutes that exact pattern and replaces `process.env` itself with a shim holding
 * only the vars it saw referenced, so a dynamic lookup such as `env[name]` or a
 * `process.env` passed around as an object comes back undefined at runtime — the gate
 * then silently denies with the variable plainly set in the container.
 */
function readEnv(): DemoCredentialsEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    OM_SHOW_DEMO_CREDENTIALS: process.env.OM_SHOW_DEMO_CREDENTIALS,
    OM_INIT_WAREHOUSEMAN_EMAIL: process.env.OM_INIT_WAREHOUSEMAN_EMAIL,
    OM_INIT_WAREHOUSEMAN_PASSWORD: process.env.OM_INIT_WAREHOUSEMAN_PASSWORD,
  }
}

export const DEMO_WAREHOUSEMAN_EMAIL = 'warehouseman@acme.com'
// Must satisfy the deployment's password policy (length, digit, uppercase,
// special character), or the account cannot be recreated through the API or the
// `auth add-user` CLI later.
const DEMO_WAREHOUSEMAN_PASSWORD = 'Warehouse123!'

/** The seeded demo account, or nothing when this deployment must not have one. */
export function resolveDemoWarehouseman(env: DemoCredentialsEnv = readEnv()): DemoCredentials | null {
  // Two independent conditions, because printing credentials on a public login page
  // is only ever acceptable in a throwaway environment. A production build refuses
  // even if someone sets the flag, and a non-production build stays quiet unless the
  // flag is set deliberately.
  if (env.NODE_ENV === 'production') return null
  if (!isTruthy(env.OM_SHOW_DEMO_CREDENTIALS)) return null

  const email = env.OM_INIT_WAREHOUSEMAN_EMAIL?.trim() || DEMO_WAREHOUSEMAN_EMAIL
  const password = env.OM_INIT_WAREHOUSEMAN_PASSWORD?.trim() || DEMO_WAREHOUSEMAN_PASSWORD
  return { email, password }
}

/**
 * The credentials the fixture seeds. Unlike the function above this does not gate on
 * the display flag — seeding and advertising are separate decisions — but it still
 * refuses to invent a well-known password in production.
 */
export function resolveSeedWarehouseman(env: DemoCredentialsEnv = readEnv()): DemoCredentials | null {
  const email = env.OM_INIT_WAREHOUSEMAN_EMAIL?.trim() || DEMO_WAREHOUSEMAN_EMAIL
  const configured = env.OM_INIT_WAREHOUSEMAN_PASSWORD?.trim()
  if (configured) return { email, password: configured }
  if (env.NODE_ENV === 'production') return null
  return { email, password: DEMO_WAREHOUSEMAN_PASSWORD }
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}
