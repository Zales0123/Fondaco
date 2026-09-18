import { expect, test, type APIRequestContext } from '@playwright/test'

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

const INDEX_PATH = '/backend/pz/goods-receipts'

// The environment may serve Polish or English; match either rather than pinning the
// assertion to whichever locale the run happens to resolve.
const PAGE_TITLE = /Przyjęcia zewnętrzne|Goods Receipts/
const EMPTY_TITLE = /Brak przyjęć zewnętrznych|No goods receipts yet/
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
  test('a user with the view feature reaches the index and sees the empty state', async ({ context, page }) => {
    await login(context.request, ADMIN.email, ADMIN.password)
    await page.goto(INDEX_PATH)
    await expect(page.getByRole('heading', { name: PAGE_TITLE })).toBeVisible()
    await expect(page.getByText(EMPTY_TITLE)).toBeVisible()
  })

  test('the list endpoint answers the caller scope and requires the view feature', async ({ context }) => {
    await login(context.request, ADMIN.email, ADMIN.password)
    const allowed = await context.request.get('/api/pz/goods-receipts?pageSize=1')
    expect(allowed.status(), `list -> ${allowed.status()}: ${await allowed.text()}`).toBe(200)
    const body = (await allowed.json()) as { items?: unknown[]; total?: number }
    expect(Array.isArray(body.items)).toBeTruthy()
    expect(body.items).toHaveLength(0)
  })

  test('a user without the view feature is refused the page, the endpoint and the sidebar item', async ({ context, page }) => {
    await login(context.request, EMPLOYEE.email, EMPLOYEE.password)

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
