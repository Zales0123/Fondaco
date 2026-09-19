import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * Panel access is enforced by installed route metadata rather than app code
 * (ADR-0003), so the only honest proof is a browser reaching the real routes with a
 * real session. Two warehousemen are provisioned: one with an assigned warehouse and
 * one without, because "assignment is a convenience, authorization is the feature"
 * only holds if the unassigned one still gets in.
 */

const ADMIN = { email: 'admin@acme.com', password: 'secret' }
const EMPLOYEE = { email: 'employee@acme.com', password: 'secret' }
const WAREHOUSEMAN_PASSWORD = 'Warehouse123!'
const ASSIGNED_NAME = 'Assigned Warehouseman'
const UNASSIGNED_NAME = 'Unassigned Warehouseman'

// The panel follows the session locale, so either catalog may be what renders.
const PANEL_TITLE_EMPTY = /Brak przypisanego magazynu|No warehouse assigned/
const ACCESS_DENIED = /Access Denied|Odmowa dostępu|Brak dostępu/i
const EMAIL_FIELD = /E-mail|Email/
const PASSWORD_FIELD = /Hasło|Password/
const SIGN_IN = /Zaloguj się|Sign in/
const SIGN_OUT = /Wyloguj się|Sign out/

/**
 * Signs in and returns a bearer token rather than relying on the session cookie.
 * The ephemeral stack runs with NODE_ENV=production, where the auth cookies are set
 * `Secure`; Playwright's API context will not send those back over plain http, so a
 * cookie-based fixture logs in successfully and is anonymous on the very next call.
 */
async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const response = await request.post('/api/auth/login', {
    form: { email, password },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  // A failed form login answers with a redirect back to the login page, which would
  // sail past a bare `< 400` check and leave every later request anonymous.
  expect(response.status(), `login ${email} -> ${response.status()}: ${await response.text()}`).toBe(200)
  const body = (await response.json()) as { token?: string }
  expect(body.token, `login ${email} returned no token`).toBeTruthy()
  return body.token as string
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

async function firstOrganizationId(request: APIRequestContext, token: string): Promise<string> {
  const response = await request.get('/api/directory/organizations?pageSize=1', {
    headers: bearer(token),
  })
  expect(response.ok(), `organizations -> ${response.status()}: ${await response.text()}`).toBeTruthy()
  const body = (await response.json()) as { items?: Array<{ id?: string }> }
  const id = body.items?.[0]?.id
  expect(id, 'no organization to attach the test fixtures to').toBeTruthy()
  return id as string
}

async function createWarehouse(
  request: APIRequestContext,
  token: string,
  name: string,
  code: string,
): Promise<string> {
  const response = await request.post('/api/wms/warehouses', {
    data: { name, code, isActive: true },
    headers: bearer(token),
    failOnStatusCode: false,
  })
  expect(response.status(), `creating warehouse ${code} failed: ${await response.text()}`).toBeLessThan(400)
  const body = (await response.json()) as { id?: string }
  expect(body.id, 'warehouse was created without an id').toBeTruthy()
  return body.id as string
}

async function createWarehouseman(
  request: APIRequestContext,
  token: string,
  email: string,
  name: string,
  organizationId: string,
): Promise<string> {
  const response = await request.post('/api/auth/users', {
    data: { email, name, password: WAREHOUSEMAN_PASSWORD, organizationId, roles: ['warehouseman'] },
    headers: bearer(token),
    failOnStatusCode: false,
  })
  expect(response.status(), `creating ${email} failed: ${await response.text()}`).toBeLessThan(400)
  const body = (await response.json()) as { id?: string }
  return body.id as string
}

async function assignWarehouse(
  request: APIRequestContext,
  token: string,
  userId: string,
  warehouseId: string,
): Promise<void> {
  const response = await request.put('/api/auth/users', {
    data: { id: userId, customFields: { assigned_warehouse: warehouseId } },
    headers: bearer(token),
    failOnStatusCode: false,
  })
  expect(response.status(), `assigning the warehouse failed: ${await response.text()}`).toBeLessThan(400)
}

async function signIn(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.goto('/warehouseman/login')
  await page.getByLabel(EMAIL_FIELD).fill(email)
  await page.getByLabel(PASSWORD_FIELD).fill(WAREHOUSEMAN_PASSWORD)
  await page.getByRole('button', { name: SIGN_IN }).click()
}

test.describe('TC-WHM-001 warehouseman panel access', () => {
  let assignedEmail: string
  let unassignedEmail: string
  let warehouseName: string

  test.beforeAll(async ({ playwright }) => {
    const admin = await playwright.request.newContext({
      baseURL: process.env.BASE_URL || 'http://localhost:3000',
    })
    try {
      const stamp = Date.now()
      assignedEmail = `warehouseman-assigned-${stamp}@acme.com`
      unassignedEmail = `warehouseman-unassigned-${stamp}@acme.com`
      warehouseName = `Magazyn Integracyjny ${stamp}`

      const token = await login(admin, ADMIN.email, ADMIN.password)
      const organizationId = await firstOrganizationId(admin, token)
      const warehouseId = await createWarehouse(admin, token, warehouseName, `INT-${stamp}`)
      const assignedId = await createWarehouseman(admin, token, assignedEmail, ASSIGNED_NAME, organizationId)
      await createWarehouseman(admin, token, unassignedEmail, UNASSIGNED_NAME, organizationId)
      await assignWarehouse(admin, token, assignedId, warehouseId)
    } finally {
      await admin.dispose()
    }
  })

  test('a warehouseman signs in on the panel login page and reaches the panel', async ({ page }) => {
    await signIn(page, assignedEmail)
    await expect(page).toHaveURL(/\/warehouseman$/)
    await expect(page.getByRole('heading', { name: warehouseName })).toBeVisible()
  })

  test('the panel header names the assigned warehouse and the signed-in user', async ({ page }) => {
    await signIn(page, assignedEmail)
    // The whole chain: custom field value -> scoped warehouse lookup -> rendered name.
    await expect(page.getByRole('heading', { name: warehouseName })).toBeVisible()
    await expect(page.getByText(ASSIGNED_NAME)).toBeVisible()
    await expect(page.getByRole('button', { name: SIGN_OUT })).toBeVisible()
  })

  test('a warehouseman with no assignment is still admitted and told so', async ({ page }) => {
    await signIn(page, unassignedEmail)
    await expect(page.getByRole('heading', { name: PANEL_TITLE_EMPTY })).toBeVisible()
    await expect(page.getByRole('link', { name: /Przyjęcie towaru|Goods receipt/ })).toBeVisible()
  })

  test('a wrong password leaves the error on the login page', async ({ page }) => {
    await page.goto('/warehouseman/login')
    await page.getByLabel(EMAIL_FIELD).fill(assignedEmail)
    await page.getByLabel(PASSWORD_FIELD).fill('definitely-not-the-password')
    await page.getByRole('button', { name: SIGN_IN }).click()
    // The visitor must stay here and see why. An unhandled 401 would bounce them to
    // session refresh instead, which reads as the page silently throwing them out.
    await expect(page).toHaveURL(/\/warehouseman\/login$/)
    await expect(page.getByRole('alert')).toBeVisible()
  })

  test('signing out ends the session, not just the screen', async ({ page }) => {
    await signIn(page, assignedEmail)
    await expect(page).toHaveURL(/\/warehouseman$/)

    await page.getByRole('button', { name: SIGN_OUT }).click()
    await expect(page).toHaveURL(/\/warehouseman\/login$/)

    // Landing on the login page proves nothing on its own: the session must be gone,
    // or the next person on a shared tablet inherits it.
    await page.goto('/warehouseman')
    await expect(page.getByRole('heading', { name: warehouseName })).toHaveCount(0)
  })

  test('a stub action opens from the home screen and leads back', async ({ page }) => {
    await signIn(page, assignedEmail)
    await page.getByRole('link', { name: /Przyjęcie towaru|Goods receipt/ }).click()
    await expect(page).toHaveURL(/\/warehouseman\/receiving$/)
    await expect(page.getByText(/nie jest jeszcze dostępna|not available yet/)).toBeVisible()

    await page.getByRole('link', { name: /Wróć|Back/ }).click()
    await expect(page).toHaveURL(/\/warehouseman$/)
  })

  test('a user without panel access is refused after signing in on the panel login', async ({ page }) => {
    await page.goto('/warehouseman/login')
    await page.getByLabel(EMAIL_FIELD).fill(EMPLOYEE.email)
    await page.getByLabel(PASSWORD_FIELD).fill(EMPLOYEE.password)
    await page.getByRole('button', { name: SIGN_IN }).click()
    await expect(page.getByText(ACCESS_DENIED)).toBeVisible()
  })

  test('a stub route is gated exactly like the panel home', async ({ page }) => {
    await page.goto('/warehouseman/login')
    await page.getByLabel(EMAIL_FIELD).fill(EMPLOYEE.email)
    await page.getByLabel(PASSWORD_FIELD).fill(EMPLOYEE.password)
    await page.getByRole('button', { name: SIGN_IN }).click()
    // Let the sign-in navigation settle before asking for another route, or the
    // second navigation races the first and the assertion becomes a coin toss.
    await expect(page.getByText(ACCESS_DENIED)).toBeVisible()

    await page.goto('/warehouseman/receiving')
    await expect(page.getByText(ACCESS_DENIED)).toBeVisible()
  })
})
