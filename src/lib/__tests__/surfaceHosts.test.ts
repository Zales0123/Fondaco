import { describe, expect, it } from '@jest/globals'
import {
  SurfaceHostConfigurationError,
  formatSearch,
  readRequestHostname,
  readSurfaceHostConfig,
  resolveSurfaceRedirect,
  type SurfaceHostConfig,
} from '../surfaceHosts'

const ADMIN = 'http://admin.fondaco.local:3000'
const PANEL = 'http://panel.fondaco.local:3000'

const splitEnv = {
  APP_URL: ADMIN,
  WAREHOUSEMAN_PANEL_URL: PANEL,
  APP_ALLOWED_ORIGINS: `${PANEL},**.orb.local`,
}

const config = readSurfaceHostConfig(splitEnv) as SurfaceHostConfig

function headers(values: Record<string, string>) {
  return { get: (name: string) => values[name.toLowerCase()] ?? null }
}

describe('readSurfaceHostConfig', () => {
  it('reads both surfaces when the split is configured', () => {
    expect(readSurfaceHostConfig(splitEnv)).toEqual({
      adminOrigin: ADMIN,
      adminHostname: 'admin.fondaco.local',
      panelOrigin: PANEL,
      panelHostname: 'panel.fondaco.local',
    })
  })

  it('is single-host mode when the panel URL is unset or blank', () => {
    expect(readSurfaceHostConfig({ APP_URL: ADMIN })).toBeNull()
    expect(readSurfaceHostConfig({ APP_URL: ADMIN, WAREHOUSEMAN_PANEL_URL: '  ' })).toBeNull()
  })

  it('accepts the panel origin listed among other allowed origins', () => {
    const env = { ...splitEnv, APP_ALLOWED_ORIGINS: `**.orb.local,${PANEL},https://other.example.com` }
    expect(readSurfaceHostConfig(env)?.panelHostname).toBe('panel.fondaco.local')
  })

  it('accepts the panel origin supplied through NEXT_PUBLIC_APP_URL', () => {
    const env = {
      APP_URL: ADMIN,
      WAREHOUSEMAN_PANEL_URL: PANEL,
      NEXT_PUBLIC_APP_URL: PANEL,
    }
    expect(readSurfaceHostConfig(env)?.panelOrigin).toBe(PANEL)
  })

  // Every case below fails open if it were allowed through: the operator believes the two
  // surfaces have separate sessions, and they do not.
  it('rejects a panel URL that is not an absolute URL', () => {
    const env = { ...splitEnv, WAREHOUSEMAN_PANEL_URL: 'panel.fondaco.local:3000' }
    expect(() => readSurfaceHostConfig(env)).toThrow(SurfaceHostConfigurationError)
  })

  it('rejects a split with no APP_URL to identify the backend host', () => {
    const env = { WAREHOUSEMAN_PANEL_URL: PANEL, APP_ALLOWED_ORIGINS: PANEL }
    expect(() => readSurfaceHostConfig(env)).toThrow(/APP_URL/)
  })

  it('rejects both surfaces sharing one hostname', () => {
    const env = {
      APP_URL: 'http://same.fondaco.local:3000',
      WAREHOUSEMAN_PANEL_URL: 'http://same.fondaco.local:3001',
      APP_ALLOWED_ORIGINS: 'http://same.fondaco.local:3001',
    }
    expect(() => readSurfaceHostConfig(env)).toThrow(/different hostnames/)
  })

  it('rejects a panel origin missing from APP_ALLOWED_ORIGINS', () => {
    const env = { APP_URL: ADMIN, WAREHOUSEMAN_PANEL_URL: PANEL }
    expect(() => readSurfaceHostConfig(env)).toThrow(/APP_ALLOWED_ORIGINS/)
  })

  it('does not accept a wildcard in place of the exact panel origin', () => {
    // `**.fondaco.local` is meaningful to `resolveAllowedDevOrigins` and invisible to
    // `readAllowedOrigins`, so it must not be mistaken for coverage here.
    const env = { ...splitEnv, APP_ALLOWED_ORIGINS: '**.fondaco.local' }
    expect(() => readSurfaceHostConfig(env)).toThrow(/APP_ALLOWED_ORIGINS/)
  })

  it('does not accept a panel entry whose port differs from the panel URL', () => {
    const env = { ...splitEnv, APP_ALLOWED_ORIGINS: 'http://panel.fondaco.local:9999' }
    expect(() => readSurfaceHostConfig(env)).toThrow(/APP_ALLOWED_ORIGINS/)
  })
})

describe('resolveSurfaceRedirect', () => {
  it('sends the backend to the backend host when it is asked for on the panel host', () => {
    expect(resolveSurfaceRedirect(config, { hostname: 'panel.fondaco.local', pathname: '/backend' }))
      .toBe(`${ADMIN}/backend`)
    expect(
      resolveSurfaceRedirect(config, {
        hostname: 'panel.fondaco.local',
        pathname: '/backend/wms/warehouses',
        search: '?page=2',
      }),
    ).toBe(`${ADMIN}/backend/wms/warehouses?page=2`)
  })

  it('sends the panel to the panel host when it is asked for on the backend host', () => {
    expect(resolveSurfaceRedirect(config, { hostname: 'admin.fondaco.local', pathname: '/warehouseman' }))
      .toBe(`${PANEL}/warehouseman`)
    expect(
      resolveSurfaceRedirect(config, { hostname: 'admin.fondaco.local', pathname: '/warehouseman/receiving' }),
    ).toBe(`${PANEL}/warehouseman/receiving`)
  })

  // The loop this closes: session/refresh bounces to `/login` on whichever host it ran on.
  // Crossing hosts here would put the new cookie in the backend's jar and return the user
  // to a panel host that still has none.
  it('keeps the panel host on its own login page instead of crossing to the backend', () => {
    expect(resolveSurfaceRedirect(config, { hostname: 'panel.fondaco.local', pathname: '/login' }))
      .toBe(`${PANEL}/warehouseman/login`)
    expect(
      resolveSurfaceRedirect(config, {
        hostname: 'panel.fondaco.local',
        pathname: '/login',
        search: '?redirect=%2Fwarehouseman',
      }),
    ).toBe(`${PANEL}/warehouseman/login?redirect=%2Fwarehouseman`)
  })

  it('leaves each surface alone on its own host', () => {
    const settled = [
      { hostname: 'admin.fondaco.local', pathname: '/backend/wms' },
      { hostname: 'admin.fondaco.local', pathname: '/login' },
      { hostname: 'panel.fondaco.local', pathname: '/warehouseman' },
      { hostname: 'panel.fondaco.local', pathname: '/warehouseman/login' },
    ]
    for (const request of settled) {
      expect(resolveSurfaceRedirect(config, request)).toBeNull()
    }
  })

  it('does not mistake a lookalike path for a surface', () => {
    const lookalikes = [
      { hostname: 'panel.fondaco.local', pathname: '/backends' },
      { hostname: 'admin.fondaco.local', pathname: '/warehousemanager' },
      { hostname: 'panel.fondaco.local', pathname: '/login-help' },
    ]
    for (const request of lookalikes) {
      expect(resolveSurfaceRedirect(config, request)).toBeNull()
    }
  })

  it('ignores the case of the request hostname', () => {
    expect(resolveSurfaceRedirect(config, { hostname: 'PANEL.Fondaco.Local', pathname: '/backend' }))
      .toBe(`${ADMIN}/backend`)
  })

  it('leaves unconfigured hosts such as tunnels and the container domain untouched', () => {
    const passthrough = [
      { hostname: 'fondaco.ngrok-free.app', pathname: '/backend' },
      { hostname: 'app.fondaco.orb.local', pathname: '/warehouseman' },
    ]
    for (const request of passthrough) {
      expect(resolveSurfaceRedirect(config, request)).toBeNull()
    }
  })

  it('does nothing at all in single-host mode', () => {
    expect(resolveSurfaceRedirect(null, { hostname: 'admin.fondaco.local', pathname: '/warehouseman' }))
      .toBeNull()
  })
})

describe('formatSearch', () => {
  // The query survives the redirect only because it is rebuilt from the page's own
  // searchParams; request headers do not carry it. A regression here loses `?page=2`
  // silently, which is why it is asserted rather than assumed.
  it('rebuilds a query string with its leading question mark', () => {
    expect(formatSearch({ page: '2', q: 'pallet' })).toBe('?page=2&q=pallet')
  })

  it('keeps every value of a repeated parameter', () => {
    expect(formatSearch({ status: ['draft', 'closed'] })).toBe('?status=draft&status=closed')
  })

  it('percent-encodes values', () => {
    expect(formatSearch({ redirect: '/warehouseman/receiving' })).toBe(
      '?redirect=%2Fwarehouseman%2Freceiving',
    )
  })

  it('is empty for no params, undefined params, and undefined values', () => {
    expect(formatSearch(undefined)).toBe('')
    expect(formatSearch({})).toBe('')
    expect(formatSearch({ q: undefined })).toBe('')
  })
})

describe('readRequestHostname', () => {
  it('prefers the forwarded host a reverse proxy sets', () => {
    expect(
      readRequestHostname(headers({ 'x-forwarded-host': 'panel.example.com', host: 'app:3000' })),
    ).toBe('panel.example.com')
  })

  it('falls back to the host header and drops the port', () => {
    expect(readRequestHostname(headers({ host: 'admin.fondaco.local:3000' }))).toBe('admin.fondaco.local')
  })

  it('takes the first entry when a proxy chain appends more', () => {
    expect(readRequestHostname(headers({ 'x-forwarded-host': 'panel.example.com, inner:3000' })))
      .toBe('panel.example.com')
  })

  it('is null when no host is present', () => {
    expect(readRequestHostname(headers({}))).toBeNull()
  })
})
