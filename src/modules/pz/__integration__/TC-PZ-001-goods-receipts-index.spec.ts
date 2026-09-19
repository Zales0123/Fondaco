import { expect, test, type APIRequestContext } from '@playwright/test'
import { adoptSession } from './browserSession'

/**
 * The index is gated by `pz.goodsReceipts.view` declared in page metadata and route
 * metadata, so the only honest proof is a browser reaching the real route with a real
 * session. Both halves of the gate are exercised, and the empty state is asserted where
 * it is actually rendered — nothing can be created yet, so an empty index is the
 * feature's whole observable behaviour at this point.
 *
 * Shape and naming follow TC-WHM-001.
 */

const ADMIN = { email: 'admin@acme.com', password: 'secret' }
const EMPLOYEE = { email: 'employee@acme.com', password: 'secret' }

const INDEX_PATH = '/backend/wms/goods-receipts'

// The environment may serve Polish or English; match either rather than pinning the
// assertion to whichever locale the run happens to resolve.
const PAGE_TITLE = /Przyjęcia zewnętrzne|Goods Receipts/
const EMPTY_TITLE = /Brak przyjęć zewnętrznych|No goods receipts yet/
const LOAD_ERROR = /Nie udało się wczytać przyjęć zewnętrznych|Could not load goods receipts/
const COLUMN_HEADERS = [
  /Numer dokumentu|Document Number/,
  /Data dokumentu|Document Date/,
  /Dostawca|Supplier/,
  /Magazyn|Warehouse/,
  /Status/,
  /Pozycje|Lines/,
]
const ACCESS_DENIED = /Access Denied|Odmowa dostępu|Brak dostępu/i

async function login(request: APIRequestContext, email: string, password: string): Promise<void> {
  const response = await request.post('/api/auth/login', {
    form: { email, password },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  // A failed form login answers with a redirect back to the login page, which would sail
  // past a bare `< 400` check and leave every following request anonymous.
  expect(response.status(), `login ${email} -> ${response.status()}: ${await response.text()}`).toBe(200)
}

test.describe('TC-PZ-001 goods receipts index', () => {
  /**
   * One login per account for the whole file. Every test adopts the same session cookies
   * instead of logging in again: a login per test is wasteful and enough to trip the auth
   * rate limit on a long-lived dev server.
   */
  let adminCookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies']
  let employeeCookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies']

  test.beforeAll(async ({ playwright }) => {
    const baseURL = process.env.BASE_URL || 'http://localhost:3000'
    const admin = await playwright.request.newContext({ baseURL })
    const employee = await playwright.request.newContext({ baseURL })
    try {
      await login(admin, ADMIN.email, ADMIN.password)
      await login(employee, EMPLOYEE.email, EMPLOYEE.password)
      adminCookies = (await admin.storageState()).cookies
      employeeCookies = (await employee.storageState()).cookies
    } finally {
      await admin.dispose()
      await employee.dispose()
    }
  })

  test('a user with the view feature reaches the index and its columns', async ({ context, page }) => {
    await adoptSession(context, adminCookies)
    await page.goto(INDEX_PATH)
    await expect(page.getByRole('heading', { name: PAGE_TITLE })).toBeVisible()
    for (const column of COLUMN_HEADERS) {
      await expect(page.getByRole('columnheader', { name: column })).toBeVisible()
    }
  })

  /**
   * The empty state is asserted against an empty response rather than an empty database:
   * once goods receipts can be created, "the table happens to have no rows right now" is
   * a property of the environment, not of the feature.
   */
  test('an index with nothing in it explains that no deliveries have been recorded', async ({ context, page }) => {
    await adoptSession(context, adminCookies)
    await page.route('**/api/pz/goods-receipts**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50, totalPages: 0 }),
      }),
    )
    await page.goto(INDEX_PATH)
    await expect(page.getByText(EMPTY_TITLE)).toBeVisible()
  })

  test('the list endpoint answers the caller scope and requires the view feature', async ({ context }) => {
    await adoptSession(context, adminCookies)
    const allowed = await context.request.get('/api/pz/goods-receipts?pageSize=1')
    expect(allowed.status(), `list -> ${allowed.status()}: ${await allowed.text()}`).toBe(200)
    const body = (await allowed.json()) as { items?: unknown[]; total?: number }
    expect(Array.isArray(body.items)).toBeTruthy()
  })

  test('a failed load says so instead of claiming there is nothing to show', async ({ context, page }) => {
    await adoptSession(context, adminCookies)
    await page.route('**/api/pz/goods-receipts**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }),
    )
    await page.goto(INDEX_PATH)
    await expect(page.getByText(LOAD_ERROR)).toBeVisible()
    // An empty table and an unreachable one must never look the same.
    await expect(page.getByText(EMPTY_TITLE)).toHaveCount(0)
  })

  test('a user without the view feature is refused the page, the endpoint and the sidebar item', async ({ context, page }) => {
    await adoptSession(context, employeeCookies)

    // Pinned to 403 rather than "any 4xx": a crashing endpoint would satisfy a loose
    // assertion and report the authorization gate as working.
    const refused = await context.request.get('/api/pz/goods-receipts?pageSize=1', { failOnStatusCode: false })
    expect(refused.status(), `list -> ${refused.status()}: ${await refused.text()}`).toBe(403)

    await page.goto(INDEX_PATH)
    await expect(page.getByRole('heading', { name: PAGE_TITLE })).toHaveCount(0)
    await expect(page.getByText(ACCESS_DENIED)).toBeVisible()
    await expect(page.getByRole('link', { name: PAGE_TITLE })).toHaveCount(0)
  })
})
