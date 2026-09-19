import { expect, test, type APIRequestContext } from '@playwright/test'
import { adoptSession, hideDevDiagnostics } from './browserSession'

/**
 * Narrowing the index: the four filters, free-text search over the two columns people
 * actually quote at each other, how they combine, the order the list arrives in, and what
 * the screen says when a combination matches nothing.
 *
 * Every assertion is scoped to this run's own documents through the search term, because
 * the index is shared with whatever else the environment holds and a bare "first page"
 * assertion would be answering a question about someone else's data.
 */

const ADMIN = { email: 'admin@acme.com', password: 'secret' }
const RUN = Date.now()
const TAG = `TCPZ006${RUN}`
const INDEX_PATH = '/backend/wms/goods-receipts'
const API = '/api/pz/goods-receipts'
const LOCK_HEADER = 'x-om-ext-optimistic-lock-expected-updated-at'

type Row = { id: string; documentNumber: string; supplierName: string; status: string; documentDate: string | null }

async function login(request: APIRequestContext, email: string, password: string): Promise<void> {
  const response = await request.post('/api/auth/login', { form: { email, password }, maxRedirects: 0, failOnStatusCode: false })
  expect(response.status(), `login ${email} -> ${response.status()}: ${await response.text()}`).toBe(200)
}

async function createdId(response: { json: () => Promise<unknown>; status: () => number; text: () => Promise<string> }): Promise<string> {
  expect(response.status(), await response.text()).toBeLessThan(400)
  const id = ((await response.json()) as { id?: string }).id
  expect(id, 'created record has no id').toBeTruthy()
  return id as string
}

test.describe('TC-PZ-006 goods receipts index filters, search and sort', () => {
  let admin: APIRequestContext
  let adminCookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies']
  let warehouseAId: string
  let warehouseBId: string
  let productId: string

  /** Every document this file creates, so a query can be narrowed to them alone. */
  const documents: Record<string, Row> = {}

  async function list(params: Record<string, string>): Promise<Row[]> {
    const query = new URLSearchParams({ pageSize: '50', ...params })
    const response = await admin.get(`${API}?${query.toString()}`, { failOnStatusCode: false })
    expect(response.status(), await response.text()).toBe(200)
    return ((await response.json()) as { items: Row[] }).items
  }

  const numbersFrom = (rows: Row[]) => rows.map((row) => row.documentNumber)

  test.beforeAll(async ({ playwright }) => {
    const baseURL = process.env.BASE_URL || 'http://localhost:3000'
    admin = await playwright.request.newContext({ baseURL })
    try {
      await login(admin, ADMIN.email, ADMIN.password)
      adminCookies = (await admin.storageState()).cookies

      warehouseAId = await createdId(await admin.post('/api/wms/warehouses', {
        data: { name: `${TAG} warehouse A`, code: `${TAG}A`, isActive: true }, failOnStatusCode: false,
      }))
      warehouseBId = await createdId(await admin.post('/api/wms/warehouses', {
        data: { name: `${TAG} warehouse B`, code: `${TAG}B`, isActive: true }, failOnStatusCode: false,
      }))
      productId = await createdId(await admin.post('/api/catalog/products', {
        data: { title: `${TAG} product`, sku: `${TAG}-P`, defaultUnit: 'pc' }, failOnStatusCode: false,
      }))
      await createdId(await admin.post('/api/catalog/variants', {
        data: { productId, sku: `${TAG}-P-V1`, isDefault: true, isActive: true }, failOnStatusCode: false,
      }))

      // Three documents that differ in exactly the dimensions the filters cut on.
      const seed = async (key: string, documentNumber: string, supplierName: string, documentDate: string, warehouseId: string) => {
        const id = await createdId(await admin.post(API, {
          data: { documentNumber, documentDate, supplierName, warehouseId, lines: [{ catalogProductId: productId, quantity: '1' }] },
          failOnStatusCode: false,
        }))
        documents[key] = { id, documentNumber, supplierName, status: 'draft', documentDate }
      }
      await seed('january', `${TAG}/1`, `${TAG} Alfa`, '2026-01-10', warehouseAId)
      await seed('february', `${TAG}/2`, `${TAG} Beta`, '2026-02-20', warehouseBId)
      await seed('march', `${TAG}/3`, `${TAG} Alfa`, '2026-03-30', warehouseAId)

      // One of them is confirmed, so the status filter has both sides to choose between.
      const current = (await list({ search: `${TAG}/3` }))[0]
      const confirmed = await admin.post(`${API}/confirm`, {
        headers: { [LOCK_HEADER]: (current as Row & { updatedAt?: string }).updatedAt ?? '' },
        data: { id: documents.march.id },
        failOnStatusCode: false,
      })
      expect(confirmed.status(), await confirmed.text()).toBe(200)
      documents.march.status = 'confirmed'
    } catch (error) {
      await admin.dispose()
      throw error
    }
  })

  test.afterAll(async () => {
    await admin?.dispose()
  })

  test('search matches a document number and a supplier name', async () => {
    expect(numbersFrom(await list({ search: `${TAG}/2` }))).toEqual([`${TAG}/2`])

    // The same term reaches a different column: nobody says which one they are quoting.
    const bySupplier = numbersFrom(await list({ search: `${TAG} Alfa` }))
    expect(bySupplier.sort()).toEqual([`${TAG}/1`, `${TAG}/3`])

    expect(await list({ search: `${TAG} nobody-by-this-name` })).toEqual([])
  })

  test('each filter narrows the index on its own', async () => {
    expect(numbersFrom(await list({ search: TAG, status: 'confirmed' }))).toEqual([`${TAG}/3`])
    expect(numbersFrom(await list({ search: TAG, status: 'draft' })).sort()).toEqual([`${TAG}/1`, `${TAG}/2`])

    expect(numbersFrom(await list({ search: TAG, warehouseId: warehouseBId }))).toEqual([`${TAG}/2`])

    expect(numbersFrom(await list({ search: TAG, documentDateFrom: '2026-02-01', documentDateTo: '2026-02-28' })))
      .toEqual([`${TAG}/2`])
    // Both ends are inclusive — a range naming a single day returns that day's document.
    expect(numbersFrom(await list({ search: TAG, documentDateFrom: '2026-01-10', documentDateTo: '2026-01-10' })))
      .toEqual([`${TAG}/1`])
    // An open end still bounds the other side.
    expect(numbersFrom(await list({ search: TAG, documentDateFrom: '2026-02-01' }))).toEqual([`${TAG}/3`, `${TAG}/2`])
  })

  test('filters and search combine rather than replacing one another', async () => {
    // Alone, each of these matches something; together they match nothing, which is only
    // true if they are being ANDed.
    expect(numbersFrom(await list({ search: `${TAG} Beta` }))).toEqual([`${TAG}/2`])
    expect(numbersFrom(await list({ search: TAG, warehouseId: warehouseAId })).sort()).toEqual([`${TAG}/1`, `${TAG}/3`])
    expect(await list({ search: `${TAG} Beta`, warehouseId: warehouseAId })).toEqual([])

    // And a combination that does hold narrows to exactly the one document in it.
    expect(numbersFrom(await list({
      search: `${TAG} Alfa`,
      warehouseId: warehouseAId,
      status: 'confirmed',
      documentDateFrom: '2026-03-01',
    }))).toEqual([`${TAG}/3`])
  })

  test('defaults to the newest document date first, then document number descending', async () => {
    expect(numbersFrom(await list({ search: TAG }))).toEqual([`${TAG}/3`, `${TAG}/2`, `${TAG}/1`])

    // Same-day documents are ordered by document number, so paging cannot repeat or skip a
    // row when several deliveries share a date.
    const sameDay = `${TAG}SAME`
    for (const suffix of ['1', '2', '3']) {
      await createdId(await admin.post(API, {
        data: {
          documentNumber: `${sameDay}/${suffix}`,
          documentDate: '2026-04-04',
          supplierName: `${sameDay} supplier`,
          warehouseId: warehouseAId,
          lines: [{ catalogProductId: productId, quantity: '1' }],
        },
        failOnStatusCode: false,
      }))
    }
    const ordered = numbersFrom(await list({ search: sameDay }))
    expect(ordered).toEqual([...ordered].sort())
    expect(ordered).toHaveLength(3)
  })

  test('sorts on document number, document date and status, in both directions', async () => {
    expect(numbersFrom(await list({ search: TAG, sortField: 'documentNumber', sortDir: 'asc' })))
      .toEqual([`${TAG}/1`, `${TAG}/2`, `${TAG}/3`])
    expect(numbersFrom(await list({ search: TAG, sortField: 'documentNumber', sortDir: 'desc' })))
      .toEqual([`${TAG}/3`, `${TAG}/2`, `${TAG}/1`])

    expect(numbersFrom(await list({ search: TAG, sortField: 'documentDate', sortDir: 'asc' })))
      .toEqual([`${TAG}/1`, `${TAG}/2`, `${TAG}/3`])

    const byStatus = await list({ search: TAG, sortField: 'status', sortDir: 'asc' })
    expect(byStatus.map((row) => row.status)).toEqual(['confirmed', 'draft', 'draft'])
  })

  test('refuses a filter value it cannot honour rather than ignoring it', async () => {
    // Silently dropping an unparseable filter would show the user a wider list than they
    // asked for and let them act on it believing it was narrowed.
    for (const query of ['warehouseId=not-a-uuid', 'documentDateFrom=2026-13-99', 'status=archived']) {
      const response = await admin.get(`${API}?${query}`, { failOnStatusCode: false })
      expect(response.status(), `${query} -> ${response.status()}`).toBe(400)
    }
  })

  test('the index narrows in the browser and says so when nothing matches', async ({ context, page }) => {
    test.setTimeout(120_000)
    await adoptSession(context, adminCookies)
    await page.goto(INDEX_PATH)
    await hideDevDiagnostics(page)

    const search = page.getByPlaceholder(/Search by document number|Szukaj po numerze/i).first()
    await expect(search).toBeVisible()

    await search.fill(`${TAG} Beta`)
    await expect(page.getByRole('row', { name: new RegExp(`${TAG}/2`) })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('table tbody tr')).toHaveCount(1)

    // A combination matching nothing is not the same screen as an index with nothing in it:
    // it must not invite the user to create a document, it must offer the way back out.
    await search.fill(`${TAG} nobody-by-this-name`)
    const emptyResults = page.locator('[data-testid="filtered-empty-results"]')
    await expect(emptyResults).toBeVisible({ timeout: 30_000 })
    await expect(emptyResults.getByRole('button', { name: /Clear search and filters|Wyczyść/i })).toBeVisible()
    await expect(emptyResults.getByText(/No goods receipt orders yet|Brak zleceń przyjęć zewnętrznych/i)).toHaveCount(0)

    // Clearing hands the full index back.
    await emptyResults.getByRole('button', { name: /Clear search and filters|Wyczyść/i }).click()
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 30_000 })
  })

  test('offers View on a confirmed row and Edit on a draft, and both lead somewhere', async ({ context, page }) => {
    test.setTimeout(120_000)
    await adoptSession(context, adminCookies)
    await page.goto(INDEX_PATH)
    await hideDevDiagnostics(page)

    const search = page.getByPlaceholder(/Search by document number|Szukaj po numerze/i).first()

    // The confirmed document is read-only, so its action reads View and opens the view.
    await search.fill(documents.march.documentNumber)
    const confirmedRow = page.getByRole('row', { name: new RegExp(documents.march.documentNumber) })
    await expect(confirmedRow).toBeVisible({ timeout: 30_000 })
    await confirmedRow.getByRole('button', { name: /Open actions|Akcje/i }).click()
    await expect(page.getByRole('menuitem', { name: /^(View|Podgląd)$/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /^(Edit|Edytuj)$/ })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: /^(Delete|Usuń)$/ })).toHaveCount(0)
    await page.getByRole('menuitem', { name: /^(View|Podgląd)$/ }).click()
    await page.waitForURL(new RegExp(`${INDEX_PATH}/${documents.march.id}$`))
    await expect(page.getByTestId('goods-receipt-detail')).toBeVisible({ timeout: 30_000 })

    // A draft is still editable, so its action reads Edit and opens the form.
    await page.goto(INDEX_PATH)
    await hideDevDiagnostics(page)
    await search.fill(documents.january.documentNumber)
    const draftRow = page.getByRole('row', { name: new RegExp(documents.january.documentNumber) })
    await expect(draftRow).toBeVisible({ timeout: 30_000 })
    await draftRow.getByRole('button', { name: /Open actions|Akcje/i }).click()
    await expect(page.getByRole('menuitem', { name: /^(Edit|Edytuj)$/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /^(View|Podgląd)$/ })).toHaveCount(0)
  })
})
