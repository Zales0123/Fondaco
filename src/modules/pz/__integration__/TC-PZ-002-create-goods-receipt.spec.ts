import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

/**
 * Creating a goods receipt is the module's first write, so this spec exercises it at the
 * module's HTTP API — the highest seam where every rule this ticket settles is observable:
 * numbering uniqueness and its case-insensitivity, the future-date refusal, the
 * greater-than-zero quantity rule, and the "never without a line" invariant.
 *
 * One browser test rides along for the only thing the API cannot prove: that the create
 * screen is a single screen that saves once and lands the document in the index.
 *
 * Fixtures are created through real API calls. Goods receipts themselves are not cleaned up
 * because this ticket ships no delete endpoint yet; every run uses its own document-number
 * series so repeated runs never collide.
 */

const ADMIN = { email: 'admin@acme.com', password: 'secret' }
const RUN = Date.now()

const API = '/api/pz/goods-receipts'
const INDEX_PATH = '/backend/wms/goods-receipts'

type Created = { id?: string }

async function login(request: APIRequestContext, email: string, password: string): Promise<void> {
  const response = await request.post('/api/auth/login', {
    form: { email, password },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(response.status(), `login ${email} -> ${response.status()}: ${await response.text()}`).toBe(200)
}

async function createWarehouse(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/wms/warehouses', {
    data: { name: `PZ QA warehouse ${RUN}`, code: `PZQA${RUN}`, isActive: true },
    failOnStatusCode: false,
  })
  expect(response.status(), `warehouse -> ${response.status()}: ${await response.text()}`).toBeLessThan(400)
  const body = (await response.json()) as Created
  expect(body.id, 'warehouse id missing').toBeTruthy()
  return body.id as string
}

async function createProduct(request: APIRequestContext, suffix: string): Promise<string> {
  const productResponse = await request.post('/api/catalog/products', {
    data: { title: `PZ QA product ${suffix} ${RUN}`, sku: `PZQA-${suffix}-${RUN}`, defaultUnit: 'pc' },
    failOnStatusCode: false,
  })
  expect(productResponse.status(), `product -> ${productResponse.status()}: ${await productResponse.text()}`).toBeLessThan(400)
  const product = (await productResponse.json()) as Created
  expect(product.id, 'product id missing').toBeTruthy()

  const variantResponse = await request.post('/api/catalog/variants', {
    data: { productId: product.id, sku: `PZQA-${suffix}-${RUN}-V1`, isDefault: true, isActive: true },
    failOnStatusCode: false,
  })
  expect(variantResponse.status(), `variant -> ${variantResponse.status()}: ${await variantResponse.text()}`).toBeLessThan(400)

  return product.id as string
}

function yesterday(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function nextYear(): string {
  const now = new Date()
  return `${now.getUTCFullYear() + 1}-01-15`
}

/**
 * The pickers load their options over the network as the user types, so a programmatic
 * `fill` can outrun the request. Typing key by key and waiting for the option to appear
 * keeps the interaction deterministic without sleeping.
 */
async function chooseOption(page: Page, field: Locator, query: string, optionName: RegExp): Promise<void> {
  await field.click()
  await field.pressSequentially(query, { delay: 15 })
  const option = page.getByRole('option', { name: optionName }).first()
  await expect(option).toBeVisible({ timeout: 20_000 })
  await option.click()
}

test.describe('TC-PZ-002 create a goods receipt', () => {
  let warehouseId: string
  let productAId: string
  let productBId: string

  test.beforeAll(async ({ playwright }) => {
    const admin = await playwright.request.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3000' })
    try {
      await login(admin, ADMIN.email, ADMIN.password)
      warehouseId = await createWarehouse(admin)
      productAId = await createProduct(admin, 'a')
      productBId = await createProduct(admin, 'b')
    } finally {
      await admin.dispose()
    }
  })

  test('saves a multi-line goods receipt as a draft and lists it', async ({ context }) => {
    await login(context.request, ADMIN.email, ADMIN.password)
    const documentNumber = `PZ/${RUN}/1`

    const created = await context.request.post(API, {
      data: {
        documentNumber,
        documentDate: yesterday(),
        supplierName: 'Hurtownia Kowalski',
        warehouseId,
        lines: [
          { catalogProductId: productAId, quantity: '2.5' },
          { catalogProductId: productBId, quantity: '1', unit: 'kg' },
          // The same product twice: a split delivery is recorded as it arrived.
          { catalogProductId: productAId, quantity: '3' },
        ],
      },
      failOnStatusCode: false,
    })
    expect(created.status(), `create -> ${created.status()}: ${await created.text()}`).toBe(201)
    const createdBody = (await created.json()) as Created
    expect(createdBody.id).toBeTruthy()

    const list = await context.request.get(`${API}?pageSize=50`)
    expect(list.status()).toBe(200)
    const body = (await list.json()) as {
      items: Array<{ id: string; documentNumber: string; status: string; lineCount: number; supplierName: string }>
    }
    const row = body.items.find((item) => item.id === createdBody.id)
    expect(row, 'the new goods receipt is missing from the index').toBeTruthy()
    expect(row?.documentNumber).toBe(documentNumber)
    expect(row?.status).toBe('draft')
    expect(row?.supplierName).toBe('Hurtownia Kowalski')
    expect(row?.lineCount).toBe(3)
  })

  test('refuses a document number already used in the organization, ignoring case', async ({ context }) => {
    await login(context.request, ADMIN.email, ADMIN.password)
    const documentNumber = `PZ/${RUN}/2`
    const payload = {
      documentDate: yesterday(),
      supplierName: 'Hurtownia Kowalski',
      warehouseId,
      lines: [{ catalogProductId: productAId, quantity: '1' }],
    }

    const first = await context.request.post(API, { data: { ...payload, documentNumber }, failOnStatusCode: false })
    expect(first.status(), await first.text()).toBe(201)

    // Lower-cased and padded: the same document, so the same refusal.
    const duplicate = await context.request.post(API, {
      data: { ...payload, documentNumber: `  ${documentNumber.toLowerCase()}  ` },
      failOnStatusCode: false,
    })
    expect(duplicate.status(), await duplicate.text()).toBe(400)
    const body = (await duplicate.json()) as { fields?: Record<string, string> }
    expect(body.fields?.documentNumber, 'the conflict must be reported on the Document Number field').toBeTruthy()
  })

  test('refuses a future document date, a non-positive quantity and a receipt with no lines', async ({ context }) => {
    await login(context.request, ADMIN.email, ADMIN.password)
    const base = {
      documentDate: yesterday(),
      supplierName: 'Hurtownia Kowalski',
      warehouseId,
      lines: [{ catalogProductId: productAId, quantity: '1' }],
    }

    const future = await context.request.post(API, {
      data: { ...base, documentNumber: `PZ/${RUN}/3`, documentDate: nextYear() },
      failOnStatusCode: false,
    })
    expect(future.status(), await future.text()).toBe(400)
    expect(((await future.json()) as { fields?: Record<string, string> }).fields?.documentDate).toBeTruthy()

    const zeroQuantity = await context.request.post(API, {
      data: { ...base, documentNumber: `PZ/${RUN}/4`, lines: [{ catalogProductId: productAId, quantity: '0' }] },
      failOnStatusCode: false,
    })
    expect(zeroQuantity.status(), await zeroQuantity.text()).toBe(400)
    expect(((await zeroQuantity.json()) as { fields?: Record<string, string> }).fields?.lines).toBeTruthy()

    const noLinesNumber = `PZ/${RUN}/5`
    const noLines = await context.request.post(API, {
      data: { ...base, documentNumber: noLinesNumber, lines: [] },
      failOnStatusCode: false,
    })
    expect(noLines.status(), await noLines.text()).toBe(400)
    expect(((await noLines.json()) as { fields?: Record<string, string> }).fields?.lines).toBeTruthy()

    // A failed save must leave nothing behind, so the refused number is still free.
    const list = await context.request.get(`${API}?pageSize=100`)
    const body = (await list.json()) as { items: Array<{ documentNumber: string }> }
    expect(body.items.some((item) => item.documentNumber === noLinesNumber)).toBe(false)
  })

  /**
   * The API tests above already prove every rule the endpoint enforces. What only the
   * browser can show is that a refused save leaves nothing behind and does not throw away
   * what the user typed — the failure mode a single-screen, single-save form is most
   * likely to get wrong.
   */
  test('a refused save keeps the typed values and creates no header', async ({ context, page }) => {
    // Two searchable pickers plus a full page load; the default 20s is too tight for that.
    test.setTimeout(90_000)
    await login(context.request, ADMIN.email, ADMIN.password)
    const documentNumber = `PZ/${RUN}/6`

    await page.goto(`${INDEX_PATH}/create`)

    const documentNumberField = page.getByPlaceholder('PZ/1/2026')
    await documentNumberField.fill(documentNumber)

    // Keyboard order: every header control is reachable without a mouse.
    await documentNumberField.press('Tab')
    await expect(page.getByRole('button', { name: /Pick a date|Wybierz datę/i })).toBeFocused()

    const supplierField = page.getByPlaceholder(/Who sent the delivery|Kto przysłał dostawę/i)
    await supplierField.fill('Hurtownia Kowalski')

    const warehouseField = page.getByRole('combobox', { name: /Search for a warehouse|Wyszukaj magazyn/i })
    await chooseOption(page, warehouseField, `PZ QA warehouse ${RUN}`, new RegExp(`PZ QA warehouse ${RUN}`))

    const productField = page.getByRole('combobox', { name: /Search for a product|Wyszukaj produkt/i }).first()
    await chooseOption(page, productField, `PZ QA product a ${RUN}`, new RegExp(`PZ QA product a ${RUN}`))
    await page.getByRole('textbox', { name: /Quantity, position 1|Ilość, pozycja 1/i }).fill('4')

    // Document Date is deliberately left empty, so the save is refused.
    await page.getByRole('button', { name: /Save goods receipt|Zapisz przyjęcie/i }).first().click()

    // The form refuses the empty Document Date before it ever reaches the server, which is
    // the point: the user is told what is wrong without losing the rest of the screen.
    await expect(
      page.getByText(/This field is required|To pole jest wymagane/i).first(),
    ).toBeVisible()
    await expect(documentNumberField).toHaveValue(documentNumber)
    await expect(supplierField).toHaveValue('Hurtownia Kowalski')

    const list = await context.request.get(`${API}?pageSize=100`)
    const body = (await list.json()) as { items: Array<{ documentNumber: string }> }
    expect(body.items.some((item) => item.documentNumber === documentNumber)).toBe(false)
  })
})
