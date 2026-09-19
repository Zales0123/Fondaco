import 'server-only'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import {
  formatSearch,
  getSurfaceHostConfig,
  readRequestHostname,
  resolveSurfaceRedirect,
  type SearchParamsInput,
} from './surfaceHosts'

/**
 * Sends a request that arrived on the wrong host to the host that owns the surface,
 * and does nothing otherwise. See ADR-0013 and `./surfaceHosts` for the rules.
 *
 * Every surface entry point calls this with its own pathname, rather than the app's Edge
 * middleware (`src/proxy.ts`) covering all of them in one place. Next inlines
 * `process.env` into the Edge bundle at build time, and this app ships an image built
 * once and configured per deployment, so the guard would have read the build's
 * environment rather than the deployment's. A server component reads it per request.
 *
 * `searchParams` is the page's own, because the request headers do not carry the query.
 * Passing it is what keeps `?page=2` alive across the redirect.
 */
export async function enforceSurfaceHost(
  pathname: string,
  searchParams?: SearchParamsInput,
): Promise<void> {
  const config = getSurfaceHostConfig()
  // Single-host mode: nothing to enforce, and no reason to make the caller read headers.
  if (!config) return

  const headerStore = await headers()
  const target = resolveSurfaceRedirect(config, {
    hostname: readRequestHostname(headerStore) ?? '',
    pathname,
    search: formatSearch(searchParams),
  })
  if (target) redirect(target)
}
