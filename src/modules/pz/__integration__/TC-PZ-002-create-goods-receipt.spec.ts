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

async function createProduct(request: APIRequestContext, suffix: string): Promise<{ productId: string; variantId: string }> {
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
  const variant = (await variantResponse.json()) as Created
  expect(variant.id, 'variant id missing').toBeTruthy()

  return { productId: product.id as string, variantId: variant.id as string }
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

type GoodsReceiptRow = {
  id: string
  documentNumber: string
  documentDate: string | null
  supplierName: string
  warehouseId: string
  status: string
  lineCount: number
  lines: Array<{
    id: string
    lineNumber: number
    catalogProductId: string
    catalogVariantId: string
    catalogSnapshot: { name: string; sku: string | null } | null
    quantity: string
    unit: string | null
    uomSnapshot: { code: string | null; productDefaultUnit: string | null } | null
  }> | null
}

/** Reads one aggregate back through the public list endpoint, lines included. */
async function readGoodsReceipt(request: APIRequestContext, id: string): Promise<GoodsReceiptRow> {
  const response = await request.get(`${API}?ids=${encodeURIComponent(id)}&pageSize=1`)
  expect(response.status(), `read -> ${response.status()}: ${await response.text()}`).toBe(200)
  const body = (await response.json()) as { items: GoodsReceiptRow[] }
  const row = body.items[0]
  expect(row, `goods receipt ${id} is missing from the index`).toBeTruthy()
  return row
}

/**
 * Walks every page rather than sampling the first one: "the refused number left nothing
 * behind" must not depend on how many documents the environment already holds.
 */
async function documentNumberExists(request: APIRequestContext, documentNumber: string): Promise<boolean> {
  for (let page = 1; page <= 200; page += 1) {
    const response = await request.get(`${API}?page=${page}&pageSize=100`)
    expect(response.status()).toBe(200)
    const body = (await response.json()) as { items: GoodsReceiptRow[]; totalPages?: number }
    if (body.items.some((item) => item.documentNumber === documentNumber)) return true
    if (body.items.length === 0 || page >= (body.totalPages ?? 1)) return false
  }
  throw new Error('[internal] goods receipt index paging did not terminate')
}

/**
 * Fills a searchable picker without touching the mouse: type, wait for the option to be
 * offered, then take it with the keyboard. Typing key by key is what the picker listens
 * for, and waiting for the option keeps the interaction deterministic without sleeping.
 */
async function chooseOptionByKeyboard(page: Page, optionName: RegExp, query: string): Promise<void> {
  await page.keyboard.type(query, { delay: 15 })
  await expect(page.getByRole('option', { name: optionName }).first()).toBeVisible({ timeout: 20_000 })
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
}

/** Opens the date picker from the keyboard and commits today, which is never a future day. */
async function pickTodayByKeyboard(page: Page): Promise<void> {
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: /^Today,/ })).toBeFocused()
  await page.keyboard.press('Enter')
  const apply = page.getByRole('button', { name: /^(Apply|Zastosuj)$/ })
  await expect(apply).toBeVisible()
  await apply.press('Enter')
}

test.describe('TC-PZ-002 create a goods receipt', () => {
  let warehouseId: string
  let productAId: string
  let productBId: string
  let variantAId: string
  let variantBId: string

  test.beforeAll(async ({ playwright }) => {
    const admin = await playwright.request.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3000' })
    try {
      await login(admin, ADMIN.email, ADMIN.password)
      warehouseId = await createWarehouse(admin)
      const productA = await createProduct(admin, 'a')
      const productB = await createProduct(admin, 'b')
      productAId = productA.productId
      variantAId = productA.variantId
      productBId = productB.productId
      variantBId = productB.variantId
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

    const row = await readGoodsReceipt(context.request, createdBody.id as string)
    expect(row.documentNumber).toBe(documentNumber)
    expect(row.status).toBe('draft')
    expect(row.supplierName).toBe('Hurtownia Kowalski')
    expect(row.documentDate).toBe(yesterday())
    expect(row.warehouseId).toBe(warehouseId)
    expect(row.lineCount).toBe(3)

    // Every stored line field, not just how many there are: a wrong variant, a lost
    // snapshot or a silently reordered position all have to fail this.
    expect(row.lines?.map((line) => line.lineNumber)).toEqual([1, 2, 3])
    expect(row.lines?.map((line) => line.quantity)).toEqual(['2.5000', '1.0000', '3.0000'])
    expect(row.lines?.map((line) => line.catalogProductId)).toEqual([productAId, productBId, productAId])
    expect(row.lines?.map((line) => line.unit)).toEqual(['pc', 'kg', 'pc'])
    expect(row.lines?.map((line) => line.uomSnapshot)).toEqual([
      { code: 'pc', productDefaultUnit: 'pc' },
      { code: 'kg', productDefaultUnit: 'pc' },
      { code: 'pc', productDefaultUnit: 'pc' },
    ])
    expect(row.lines?.map((line) => line.catalogVariantId)).toEqual([variantAId, variantBId, variantAId])
    expect(row.lines?.map((line) => line.catalogSnapshot?.name)).toEqual([
      `PZ QA product a ${RUN}`,
      `PZ QA product b ${RUN}`,
      `PZ QA product a ${RUN}`,
    ])
    expect(row.lines?.map((line) => line.catalogSnapshot?.sku)).toEqual([
      `PZQA-a-${RUN}-V1`,
      `PZQA-b-${RUN}-V1`,
      `PZQA-a-${RUN}-V1`,
    ])
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

    // Fired together so the read-before-write cannot be what refuses the second one: the
    // partial unique index is the guard, and a sequential test would pass without it.
    const [first, second] = await Promise.all([
      context.request.post(API, { data: { ...payload, documentNumber }, failOnStatusCode: false }),
      context.request.post(API, {
        // Lower-cased and padded: the same document, so the same refusal.
        data: { ...payload, documentNumber: `  ${documentNumber.toLowerCase()}  ` },
        failOnStatusCode: false,
      }),
    ])

    const statuses = [first.status(), second.status()].sort((a, b) => a - b)
    expect(statuses, `${first.status()} / ${second.status()}`).toEqual([201, 400])
    const rejected = first.status() === 400 ? first : second
    const body = (await rejected.json()) as { fields?: Record<string, string> }
    expect(body.fields?.documentNumber, 'the conflict must be reported on the Document Number field').toBeTruthy()

    // And a plain sequential duplicate is refused the same way.
    const sequential = await context.request.post(API, {
      data: { ...payload, documentNumber: documentNumber.toUpperCase() },
      failOnStatusCode: false,
    })
    expect(sequential.status(), await sequential.text()).toBe(400)
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

    // A failed save must leave nothing behind, so the refused number is still free — proven
    // both by its absence from the whole index and by a later create taking it.
    expect(await documentNumberExists(context.request, noLinesNumber)).toBe(false)
    const reused = await context.request.post(API, {
      data: { ...base, documentNumber: noLinesNumber },
      failOnStatusCode: false,
    })
    expect(reused.status(), await reused.text()).toBe(201)
  })


  /**
   * The whole create flow without a mouse, ending in a real document. It also removes a
   * line before saving, which is the other thing only the screen can show.
   */
  test('completes a multi-line create from the keyboard alone', async ({ context, page }) => {
    test.setTimeout(120_000)
    await login(context.request, ADMIN.email, ADMIN.password)
    const documentNumber = `PZ/${RUN}/7`

    await page.goto(`${INDEX_PATH}/create`)
    await page.getByPlaceholder('PZ/1/2026').focus()
    await page.keyboard.type(documentNumber, { delay: 10 })

    await page.keyboard.press('Tab')
    await pickTodayByKeyboard(page)

    await page.getByPlaceholder(/Who sent the delivery|Kto przysłał dostawę/i).focus()
    await page.keyboard.type('Hurtownia Kowalski', { delay: 10 })

    await page.keyboard.press('Tab')
    await chooseOptionByKeyboard(page, new RegExp(`PZ QA warehouse ${RUN}`), `PZ QA warehouse ${RUN}`)

    await page.getByRole('combobox', { name: /Product, position 1|Produkt, pozycja 1/i }).focus()
    await chooseOptionByKeyboard(page, new RegExp(`PZ QA product a ${RUN}`), `PZ QA product a ${RUN}`)
    await page.keyboard.press('Tab')
    await page.keyboard.type('2.5')

    // A second line, added and then removed from the keyboard.
    await page.getByRole('button', { name: /Add line|Dodaj pozycję/i }).press('Enter')
    await page.getByRole('combobox', { name: /Product, position 2|Produkt, pozycja 2/i }).focus()
    await chooseOptionByKeyboard(page, new RegExp(`PZ QA product b ${RUN}`), `PZ QA product b ${RUN}`)
    await page.keyboard.press('Tab')
    await page.keyboard.type('4')

    // A third line survives the removal of the second, so line numbers are reassigned by
    // order rather than left with a hole.
    await page.getByRole('button', { name: /Add line|Dodaj pozycję/i }).press('Enter')
    await page.getByRole('combobox', { name: /Product, position 3|Produkt, pozycja 3/i }).focus()
    await chooseOptionByKeyboard(page, new RegExp(`PZ QA product b ${RUN}`), `PZ QA product b ${RUN}`)
    await page.keyboard.press('Tab')
    await page.keyboard.type('1')

    await page.getByRole('button', { name: /Remove position 2|Usuń pozycję 2/i }).press('Enter')
    await expect(page.getByRole('combobox', { name: /Product, position 3|Produkt, pozycja 3/i })).toHaveCount(0)

    await page.getByRole('button', { name: /Save goods receipt|Zapisz przyjęcie/i }).first().press('Enter')

    await page.waitForURL(new RegExp(`${INDEX_PATH}(\\?|$)`))
    await expect(page.getByText(documentNumber)).toBeVisible()

    const list = await context.request.get(`${API}?pageSize=100`)
    const body = (await list.json()) as { items: GoodsReceiptRow[] }
    const created = body.items.find((item) => item.documentNumber === documentNumber)
    expect(created, 'the keyboard-created goods receipt is missing from the index').toBeTruthy()
    const row = await readGoodsReceipt(context.request, created!.id)
    expect(row.status).toBe('draft')
    expect(row.lineCount).toBe(2)
    expect(row.lines?.map((line) => line.lineNumber)).toEqual([1, 2])
    expect(row.lines?.map((line) => line.quantity)).toEqual(['2.5000', '1.0000'])
    expect(row.lines?.map((line) => line.catalogProductId)).toEqual([productAId, productBId])
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

    // The picker is named by its own position, so two lines never share an accessible name.
    const productField = page.getByRole('combobox', { name: /Product, position 1|Produkt, pozycja 1/i })
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

    expect(await documentNumberExists(context.request, documentNumber)).toBe(false)
  })
})
