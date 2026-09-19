import { describe, expect, it } from '@jest/globals'
import {
  resolveDemoWarehouseman,
  resolveSeedWarehouseman,
  type DemoCredentialsEnv,
} from '../demoCredentials'

describe('resolveDemoWarehouseman', () => {
  it('returns nothing in production even when the flag is set', () => {
    expect(
      resolveDemoWarehouseman({ NODE_ENV: 'production', OM_SHOW_DEMO_CREDENTIALS: '1' } as DemoCredentialsEnv),
    ).toBeNull()
  })

  it('returns nothing outside production unless the flag is set', () => {
    expect(resolveDemoWarehouseman({ NODE_ENV: 'development' } as DemoCredentialsEnv)).toBeNull()
    expect(
      resolveDemoWarehouseman({ NODE_ENV: 'development', OM_SHOW_DEMO_CREDENTIALS: '0' } as DemoCredentialsEnv),
    ).toBeNull()
  })

  it('returns the defaults when enabled', () => {
    expect(
      resolveDemoWarehouseman({ NODE_ENV: 'development', OM_SHOW_DEMO_CREDENTIALS: '1' } as DemoCredentialsEnv),
    ).toEqual({ email: 'warehouseman@acme.com', password: 'Warehouse123!' })
  })

  it('prefers configured values over the defaults', () => {
    expect(
      resolveDemoWarehouseman({
        NODE_ENV: 'development',
        OM_SHOW_DEMO_CREDENTIALS: 'true',
        OM_INIT_WAREHOUSEMAN_EMAIL: 'magazynier@example.com',
        OM_INIT_WAREHOUSEMAN_PASSWORD: 'Warehouse123!',
      } as DemoCredentialsEnv),
    ).toEqual({ email: 'magazynier@example.com', password: 'Warehouse123!' })
  })
})

describe('resolveSeedWarehouseman', () => {
  it('seeds the well-known, policy-compliant password outside production', () => {
    expect(resolveSeedWarehouseman({ NODE_ENV: 'development' } as DemoCredentialsEnv)).toEqual({
      email: 'warehouseman@acme.com',
      password: 'Warehouse123!',
    })
  })

  it('refuses to invent a password in production', () => {
    expect(resolveSeedWarehouseman({ NODE_ENV: 'production' } as DemoCredentialsEnv)).toBeNull()
  })

  it('seeds in production when a password is configured explicitly', () => {
    expect(
      resolveSeedWarehouseman({
        NODE_ENV: 'production',
        OM_INIT_WAREHOUSEMAN_PASSWORD: 'chosen-by-an-operator',
      } as DemoCredentialsEnv),
    ).toEqual({ email: 'warehouseman@acme.com', password: 'chosen-by-an-operator' })
  })
})
