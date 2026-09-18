import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * Panel access is enforced by installed route metadata rather than app code
 * (ADR-0003), so the only honest proof is a browser reaching the real route with a
 * real session. Both halves of the gate are exercised: the holder of
 * `warehouseman.panel.access` gets the Panel, everyone else gets refused.
 */

const ADMIN = { email: 'admin@acme.com', password: 'secret' }
const EMPLOYEE = { email: 'employee@acme.com', password: 'secret' }
const WAREHOUSEMAN_PASSWORD = 'Warehouse123!'

// The Panel defaults to Polish; the seeded environment may serve English. Match either
// rather than pinning the assertion to whichever locale the run happens to resolve.
const PANEL_TITLE = /Panel magazyniera|Warehouseman panel/
const ACCESS_DENIED = /Access Denied|Odmowa dostępu|Brak dostępu/i

async function login(request: APIRequestContext, email: string, password: string): Promise<void> {
  const response = await request.post('/api/auth/login', {
    form: { email, password },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  // A failed form login answers with a redirect back to the login page, which would
  // sail past a bare `< 400` check and leave the session anonymous for every request
  // that follows. Pin the success status and surface the body when it is not that.
  expect(response.status(), `login ${email} -> ${response.status()}: ${await response.text()}`).toBe(200)
}

async function firstOrganizationId(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/directory/organizations?pageSize=1')
  expect(response.ok(), `organizations -> ${response.status()}: ${await response.text()}`).toBeTruthy()
  const body = (await response.json()) as { items?: Array<{ id?: string }> }
  const id = body.items?.[0]?.id
  expect(id, 'no organization to attach the test warehouseman to').toBeTruthy()
  return id as string
}

async function createWarehouseman(request: APIRequestContext, email: string): Promise<void> {
  const organizationId = await firstOrganizationId(request)
  const response = await request.post('/api/auth/users', {
    data: {
      email,
      name: 'Integration Warehouseman',
      password: WAREHOUSEMAN_PASSWORD,
      organizationId,
      roles: ['warehouseman'],
    },
    failOnStatusCode: false,
  })
  expect(response.status(), `creating ${email} failed: ${await response.text()}`).toBeLessThan(400)
}

test.describe('TC-WHM-001 warehouseman panel access', () => {
  let warehousemanEmail: string

  test.beforeAll(async ({ playwright }) => {
    const admin = await playwright.request.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3000' })
    try {
      warehousemanEmail = `warehouseman-${Date.now()}@acme.com`
      await login(admin, ADMIN.email, ADMIN.password)
      await createWarehouseman(admin, warehousemanEmail)
    } finally {
      await admin.dispose()
    }
  })

  test('a warehouseman reaches the panel', async ({ context, page }) => {
    await login(context.request, warehousemanEmail, WAREHOUSEMAN_PASSWORD)
    await page.goto('/warehouseman')
    await expect(page.getByRole('heading', { name: PANEL_TITLE })).toBeVisible()
  })

  test('a user without panel access is refused', async ({ context, page }) => {
    await login(context.request, EMPLOYEE.email, EMPLOYEE.password)
    await page.goto('/warehouseman')
    await expect(page.getByRole('heading', { name: PANEL_TITLE })).toHaveCount(0)
    await expect(page.getByText(ACCESS_DENIED)).toBeVisible()
  })
})
