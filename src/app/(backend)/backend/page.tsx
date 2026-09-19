import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { redirect } from 'next/navigation'
import { DashboardScreen } from '@open-mercato/ui/backend/dashboard'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolvePageMiddlewareRedirect } from '@open-mercato/shared/lib/middleware/page-executor'
import { backendMiddlewareEntries } from '@/.mercato/generated/backend-middleware.generated'
import { enforceSurfaceHost } from '@/lib/surfaceHostGuard'
import { BACKEND_PATH_PREFIX, type SearchParamsInput } from '@/lib/surfaceHosts'

export default async function BackendIndex({
  searchParams,
}: {
  searchParams?: Promise<SearchParamsInput>
}) {
  // The backend is served on APP_URL's host and nowhere else (ADR-0013). Reaching it on
  // the Panel host would sign the user in against the Panel's cookie jar and collapse the
  // split back to one shared session, so this runs before the session is resolved.
  await enforceSurfaceHost(BACKEND_PATH_PREFIX, await searchParams)

  const auth = await getAuthFromCookies()
  if (!auth) redirect('/api/auth/session/refresh?redirect=/backend')
  let container: Awaited<ReturnType<typeof createRequestContainer>> | null = null
  const ensureContainer = async () => {
    if (!container) {
      container = await createRequestContainer()
    }
    return container
  }
  const middlewareRedirect = await resolvePageMiddlewareRedirect({
    entries: backendMiddlewareEntries,
    context: {
      pathname: '/backend',
      mode: 'backend',
      routeMeta: { requireAuth: true },
      auth,
      ensureContainer,
    },
  })
  if (middlewareRedirect) redirect(middlewareRedirect)
  return (
    <div className="p-6 space-y-6">
      <DashboardScreen />
    </div>
  )
}
