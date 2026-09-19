import { Suspense } from 'react'
import LoginPage from '@open-mercato/core/modules/auth/frontend/login'
import { enforceSurfaceHost } from '@/lib/surfaceHostGuard'
import { ADMIN_LOGIN_PATH, type SearchParamsInput } from '@/lib/surfaceHosts'

/**
 * This route already rendered on demand before the guard below existed; the export pins
 * that rather than leaving it to depend on why.
 *
 * It matters because the guard must run on every request and must not be made conditional
 * on the split being configured. The image is built once and configured per deployment, so
 * a build without `WAREHOUSEMAN_PANEL_URL` that was allowed to prerender would emit a
 * static `/login` no later configuration could put a guard back into.
 */
export const dynamic = 'force-dynamic'

export default async function LoginRoutePage({
  searchParams,
}: {
  searchParams?: Promise<SearchParamsInput>
}) {
  // `/login` on the Panel host belongs at the Panel's own sign-in page, on that same host.
  // A cold deep link into the Panel is bounced by installed core to
  // `/api/auth/session/refresh`, which on failure redirects to `/login` on whichever host
  // it ran on. Crossing to the backend here would put the new cookie in the backend's jar
  // and return the user to a Panel host that still has none — a loop. See ADR-0013.
  await enforceSurfaceHost(ADMIN_LOGIN_PATH, await searchParams)

  return (
    // LoginPage reads query params with useSearchParams; keep this boundary so
    // static builds can prerender the route and hydrate the client-only params.
    <Suspense fallback={null}>
      <LoginPage />
    </Suspense>
  )
}
