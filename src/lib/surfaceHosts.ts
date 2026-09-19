/**
 * Which surface a request's hostname is allowed to serve.
 *
 * The backend (`/backend`, `/login`) and the Warehouseman Panel (`/warehouseman/*`) are
 * served on two different hostnames so that the two can be signed in at the same time.
 * The staff session cookie `auth_token` is set at `path=/` with no `Domain`
 * (`@open-mercato/core/modules/auth/api/login.ts`), so it is scoped to a single host:
 * two hosts mean two independent cookie jars, and a Warehouseman signing in on the floor
 * no longer displaces an Administrator signed in on the backend. See ADR-0013.
 *
 * Matching is on the **hostname**, deliberately ignoring scheme and port. Cookies are not
 * isolated by port and barely by scheme, so the host is the actual boundary being
 * enforced; matching whole origins would also silently stop enforcing behind a reverse
 * proxy that forgets `x-forwarded-proto`, which is a failure open.
 */

export const BACKEND_PATH_PREFIX = '/backend'
export const PANEL_PATH_PREFIX = '/warehouseman'
export const ADMIN_LOGIN_PATH = '/login'
export const PANEL_LOGIN_PATH = '/warehouseman/login'

export type SurfaceHostConfig = {
  adminOrigin: string
  adminHostname: string
  panelOrigin: string
  panelHostname: string
}

export type SurfaceRequest = {
  hostname: string
  pathname: string
  /** Query string including the leading `?`, or an empty string. */
  search?: string
}

export class SurfaceHostConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SurfaceHostConfigurationError'
  }
}

// Shaped like `EnvLike` in `@open-mercato/shared/lib/url.ts` so `process.env` is assignable.
type EnvLike = Record<string, string | undefined> & {
  APP_URL?: string
  NEXT_PUBLIC_APP_URL?: string
  APP_ALLOWED_ORIGINS?: string
  WAREHOUSEMAN_PANEL_URL?: string
}

function parseUrl(raw: string | undefined): URL | null {
  const value = raw?.trim()
  if (!value) return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase()
}

/**
 * The exact origins `assertAllowedAppOrigin` will accept, mirroring `readAllowedOrigins`
 * in `@open-mercato/shared/lib/url.ts`. That helper drops anything that is not a parseable
 * absolute URL, which is why wildcard entries such as `**.orb.local` — valid for the
 * `allowedDevOrigins` half of the same variable — do not count here.
 */
function readAllowedOrigins(env: EnvLike): Set<string> {
  const origins = new Set<string>()
  const raws = [
    env.APP_URL,
    env.NEXT_PUBLIC_APP_URL,
    ...(env.APP_ALLOWED_ORIGINS ?? '').split(',').map((entry) => entry.trim()),
  ]
  for (const raw of raws) {
    const url = parseUrl(raw)
    if (url) origins.add(url.origin)
  }
  return origins
}

/**
 * Reads the two surface hostnames out of the environment.
 *
 * Returns `null` when `WAREHOUSEMAN_PANEL_URL` is unset, which is single-host mode: both
 * surfaces answer on `APP_URL` and share one session, exactly as they did before the split.
 * Throws when the split is configured but incoherent — a half-configured split silently
 * fails open, and failing open here means the session separation people believe they have
 * does not exist.
 */
export function readSurfaceHostConfig(env: EnvLike): SurfaceHostConfig | null {
  const panelUrlRaw = env.WAREHOUSEMAN_PANEL_URL?.trim()
  if (!panelUrlRaw) return null

  const panelUrl = parseUrl(panelUrlRaw)
  if (!panelUrl) {
    throw new SurfaceHostConfigurationError(
      `WAREHOUSEMAN_PANEL_URL must be an absolute URL such as https://panel.example.com, got "${panelUrlRaw}".`,
    )
  }

  const adminUrl = parseUrl(env.APP_URL)
  if (!adminUrl) {
    throw new SurfaceHostConfigurationError(
      'APP_URL must be an absolute URL naming the backend origin whenever WAREHOUSEMAN_PANEL_URL is set, ' +
        'because it is what tells the two surfaces apart.',
    )
  }

  const adminHostname = normalizeHostname(adminUrl.hostname)
  const panelHostname = normalizeHostname(panelUrl.hostname)
  if (adminHostname === panelHostname) {
    throw new SurfaceHostConfigurationError(
      `APP_URL and WAREHOUSEMAN_PANEL_URL must use different hostnames — both name "${adminHostname}", ` +
        'so the two surfaces would share one cookie jar and one session. Unset WAREHOUSEMAN_PANEL_URL ' +
        'to run both surfaces on one host on purpose.',
    )
  }

  if (!readAllowedOrigins(env).has(panelUrl.origin)) {
    throw new SurfaceHostConfigurationError(
      `APP_ALLOWED_ORIGINS must list ${panelUrl.origin} exactly. Without it Next rejects the panel host as a ` +
        'cross-origin dev request and security emails sent from it fail the origin check. ' +
        'Wildcard entries do not satisfy this — the origin has to be spelled out.',
    )
  }

  return {
    adminOrigin: adminUrl.origin,
    adminHostname,
    panelOrigin: panelUrl.origin,
    panelHostname,
  }
}

let cached: { config: SurfaceHostConfig | null } | null = null

/** Process-wide memoized read of {@link readSurfaceHostConfig} over `process.env`. */
export function getSurfaceHostConfig(): SurfaceHostConfig | null {
  if (!cached) cached = { config: readSurfaceHostConfig(process.env) }
  return cached.config
}

/** Test seam: drops the memoized config so a changed environment is read again. */
export function resetSurfaceHostConfigCache(): void {
  cached = null
}

function isWithin(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/**
 * The absolute URL this request belongs at, or `null` when it is already on the right host.
 *
 * The `/login` rule is the one that earns this module. A cold deep link into the Panel is
 * bounced by installed core to `/api/auth/session/refresh`, which on failure redirects to
 * `/login?redirect=…` **on the host it was called on**
 * (`@open-mercato/core/modules/auth/api/session/refresh.ts`). Sending that to the backend
 * host would land the new cookie on the backend's jar and send the user back to a Panel
 * host that still has none — a loop. Keeping it on the Panel host, at the Panel's own login
 * page, closes it.
 */
export function resolveSurfaceRedirect(
  config: SurfaceHostConfig | null,
  request: SurfaceRequest,
): string | null {
  if (!config) return null
  const hostname = normalizeHostname(request.hostname)
  const { pathname } = request
  const search = request.search ?? ''

  if (hostname === config.panelHostname) {
    if (pathname === ADMIN_LOGIN_PATH) return `${config.panelOrigin}${PANEL_LOGIN_PATH}${search}`
    if (isWithin(pathname, BACKEND_PATH_PREFIX)) return `${config.adminOrigin}${pathname}${search}`
    return null
  }

  if (hostname === config.adminHostname) {
    if (isWithin(pathname, PANEL_PATH_PREFIX)) return `${config.panelOrigin}${pathname}${search}`
    return null
  }

  // Neither configured host. Tunnels (ngrok) and the OrbStack container domain reach the
  // app on hostnames nobody can enumerate up front; refusing them would brick the Docker
  // dev stack and every preview URL. The split is enforced where it is configured.
  return null
}

export type SearchParamsInput = Record<string, string | string[] | undefined>

/**
 * Renders a page's `searchParams` back into a query string, leading `?` included.
 *
 * A page's own `searchParams` is the only way a server component can see the query: the
 * request headers do not carry it (`x-next-url` is the pathname alone), so a guard that
 * read headers would quietly drop `?page=2` from every redirect it issued.
 */
export function formatSearch(searchParams: SearchParamsInput | undefined): string {
  if (!searchParams) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const entry of value) params.append(key, entry)
    else params.append(key, value)
  }
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

/** Reads the request hostname the way `resolveRequestOrigin` does, proxy headers first. */
export function readRequestHostname(headerStore: {
  get(name: string): string | null | undefined
}): string | null {
  const raw = headerStore.get('x-forwarded-host') || headerStore.get('host')
  const first = raw?.split(',')[0]?.trim()
  if (!first) return null
  // `host` carries `name:port`; IPv6 literals arrive bracketed.
  try {
    return normalizeHostname(new URL(`http://${first}`).hostname)
  } catch {
    return null
  }
}
