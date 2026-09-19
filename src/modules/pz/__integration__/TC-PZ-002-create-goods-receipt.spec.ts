import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { adoptSession, hideDevDiagnostics } from './browserSession'

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

async function createBareProduct(request: APIRequestContext, suffix: string): Promise<string> {
  const response = await request.post('/api/catalog/products', {
    data: { title: `PZ QA product ${suffix} ${RUN}`, sku: `PZQA-${suffix}-${RUN}`, defaultUnit: 'pc' },
    failOnStatusCode: false,
  })
  expect(response.status(), `product -> ${response.status()}: ${await response.text()}`).toBeLessThan(400)
  const product = (await response.json()) as Created
  expect(product.id, 'product id missing').toBeTruthy()
  return product.id as string
}

async function createVariant(
  request: APIRequestContext,
  productId: string,
  sku: string,
  isDefault: boolean,
): Promise<string> {
  const response = await request.post('/api/catalog/variants', {
    data: { productId, sku, isDefault, isActive: true },
    failOnStatusCode: false,
  })
  expect(response.status(), `variant -> ${response.status()}: ${await response.text()}`).toBeLessThan(400)
  const variant = (await response.json()) as Created
  expect(variant.id, 'variant id missing').toBeTruthy()
  return variant.id as string
}

/**
 * Every product gets a non-default variant FIRST and its default second, so a regression to
 * "take whichever variant comes back first" stores the wrong id and the assertions catch it.
 */
async function createProduct(request: APIRequestContext, suffix: string): Promise<{ productId: string; variantId: string }> {
  const productId = await createBareProduct(request, suffix)
  await createVariant(request, productId, `PZQA-${suffix}-${RUN}-ALT`, false)
  const variantId = await createVariant(request, productId, `PZQA-${suffix}-${RUN}-V1`, true)
  return { productId, variantId }
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
 * Presses Tab (or Shift+Tab) until the wanted control has focus, and fails loudly if it is
 * never reached. Every step of the keyboard test moves through real focus order this way —
 * calling `focus()` on the next control would prove nothing about whether a keyboard user
 * can get there.
 */
async function tabUntilFocused(page: Page, target: Locator, options: { shift?: boolean; limit?: number } = {}): Promise<void> {
  const key = options.shift ? 'Shift+Tab' : 'Tab'
  const limit = options.limit ?? 12
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press(key)
    if (await target.evaluate((node) => node === document.activeElement).catch(() => false)) return
  }
  throw new Error(`[internal] ${key} did not reach the expected control within ${limit} presses`)
}

/** Fills a searchable picker that already has focus, then takes an option with the keyboard. */
async function chooseOptionByKeyboard(page: Page, optionName: RegExp, query: string): Promise<void> {
  await page.keyboard.type(query, { delay: 15 })
  await expect(page.getByRole('option', { name: optionName }).first()).toBeVisible({ timeout: 20_000 })
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
}

/** Opens the focused date picker and commits today, which is never a future day. */
async function pickTodayByKeyboard(page: Page): Promise<void> {
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: /^Today,/ })).toBeFocused()
  await page.keyboard.press('Enter')
  const apply = page.getByRole('button', { name: /^(Apply|Zastosuj)$/ })
  await expect(apply).toBeVisible()
  await tabUntilFocused(page, apply)
  await page.keyboard.press('Enter')
  // Tabbing on while the popover is still closing would walk its focus trap instead of the
  // form, so wait for it to be gone before moving on.
  await expect(apply).toHaveCount(0)
}


/** Reads the undo handle the CRUD factory attaches to every command-backed write. */
function readOperation(response: { headers: () => Record<string, string> }): { id: string; undoToken: string } {
  const raw = response.headers()['x-om-operation']
  expect(raw, 'the write did not report an operation to undo').toBeTruthy()
  const parsed = JSON.parse(decodeURIComponent(raw.replace(/^omop:/, ''))) as { id: string; undoToken: string }
  expect(parsed.undoToken).toBeTruthy()
  return parsed
}

async function listById(request: APIRequestContext, id: string): Promise<GoodsReceiptRow[]> {
  const response = await request.get(`${API}?ids=${encodeURIComponent(id)}&pageSize=1`)
  expect(response.status()).toBe(200)
  return ((await response.json()) as { items: GoodsReceiptRow[] }).items
}



test.describe('TC-PZ-002 create a goods receipt', () => {
  let admin: APIRequestContext
  let adminCookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies']
  let warehouseId: string
  let productAId: string
  let productBId: string
  let variantAId: string
  let variantBId: string
  let productWithoutDefaultId: string

  /**
   * One login for the whole file. Every browser test adopts the same session cookies
   * instead of logging in again: a login per test is wasteful and enough to trip the auth
   * rate limit on a long-lived dev server.
   */
  test.beforeAll(async ({ playwright }) => {
    admin = await playwright.request.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3000' })
    await login(admin, ADMIN.email, ADMIN.password)
    adminCookies = (await admin.storageState()).cookies
    try {
      warehouseId = await createWarehouse(admin)
      const productA = await createProduct(admin, 'a')
      const productB = await createProduct(admin, 'b')
      productAId = productA.productId
      variantAId = productA.variantId
      productBId = productB.productId
      variantBId = productB.variantId
      productWithoutDefaultId = await createBareProduct(admin, 'nodefault')
      await createVariant(admin, productWithoutDefaultId, `PZQA-nodefault-${RUN}-ALT`, false)
    } catch (error) {
      await admin.dispose()
      throw error
    }
  })

  test.afterAll(async () => {
    await admin?.dispose()
  })

  test('saves a multi-line goods receipt as a draft and lists it', async () => {
    const documentNumber = `PZ/${RUN}/1`

    const created = await admin.post(API, {
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

    const row = await readGoodsReceipt(admin, createdBody.id as string)
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

  test('refuses a document number already used in the organization, ignoring case', async () => {
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
      admin.post(API, { data: { ...payload, documentNumber }, failOnStatusCode: false }),
      admin.post(API, {
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
    const sequential = await admin.post(API, {
      data: { ...payload, documentNumber: documentNumber.toUpperCase() },
      failOnStatusCode: false,
    })
    expect(sequential.status(), await sequential.text()).toBe(400)
  })

  test('refuses a product that cannot be resolved to a single default variant', async () => {
    const response = await admin.post(API, {
      data: {
        documentNumber: `PZ/${RUN}/8`,
        documentDate: yesterday(),
        supplierName: 'Hurtownia Kowalski',
        warehouseId,
        lines: [{ catalogProductId: productWithoutDefaultId, quantity: '1' }],
      },
      failOnStatusCode: false,
    })
    expect(response.status(), await response.text()).toBe(400)
    // Refused rather than filed against whichever variant happened to come back first.
    expect(((await response.json()) as { fields?: Record<string, string> }).fields?.lines).toBeTruthy()
  })

  test('refuses a future document date, a non-positive quantity and a receipt with no lines', async () => {
    const base = {
      documentDate: yesterday(),
      supplierName: 'Hurtownia Kowalski',
      warehouseId,
      lines: [{ catalogProductId: productAId, quantity: '1' }],
    }

    const future = await admin.post(API, {
      data: { ...base, documentNumber: `PZ/${RUN}/3`, documentDate: nextYear() },
      failOnStatusCode: false,
    })
    expect(future.status(), await future.text()).toBe(400)
    expect(((await future.json()) as { fields?: Record<string, string> }).fields?.documentDate).toBeTruthy()

    const zeroQuantity = await admin.post(API, {
      data: { ...base, documentNumber: `PZ/${RUN}/4`, lines: [{ catalogProductId: productAId, quantity: '0' }] },
      failOnStatusCode: false,
    })
    expect(zeroQuantity.status(), await zeroQuantity.text()).toBe(400)
    expect(((await zeroQuantity.json()) as { fields?: Record<string, string> }).fields?.lines).toBeTruthy()

    const noLinesNumber = `PZ/${RUN}/5`
    const noLines = await admin.post(API, {
      data: { ...base, documentNumber: noLinesNumber, lines: [] },
      failOnStatusCode: false,
    })
    expect(noLines.status(), await noLines.text()).toBe(400)
    expect(((await noLines.json()) as { fields?: Record<string, string> }).fields?.lines).toBeTruthy()

    // A failed save must leave nothing behind, so the refused number is still free — proven
    // both by its absence from the whole index and by a later create taking it.
    expect(await documentNumberExists(admin, noLinesNumber)).toBe(false)
    const reused = await admin.post(API, {
      data: { ...base, documentNumber: noLinesNumber },
      failOnStatusCode: false,
    })
    expect(reused.status(), await reused.text()).toBe(201)
  })


  /**
   * Undo and redo are framework contracts every command has to honour, and a goods receipt
   * is an aggregate: putting it back means the same header AND the same lines, under the
   * ids the document already had. A redo that minted new ids would leave the original
   * lines pointing at a row nobody can reach.
   */
  test('undo removes the whole document and redo restores it under its original ids', async () => {
    const documentNumber = `PZ/${RUN}/9`

    const created = await admin.post(API, {
      data: {
        documentNumber,
        documentDate: yesterday(),
        supplierName: 'Hurtownia Kowalski',
        warehouseId,
        lines: [
          { catalogProductId: productAId, quantity: '2' },
          { catalogProductId: productBId, quantity: '3', unit: 'kg' },
        ],
      },
      failOnStatusCode: false,
    })
    expect(created.status(), await created.text()).toBe(201)
    const operation = readOperation(created)
    const receiptId = ((await created.json()) as Created).id as string
    const before = await readGoodsReceipt(admin, receiptId)
    expect(before.lines).toHaveLength(2)

    const undone = await admin.post('/api/audit_logs/audit-logs/actions/undo', {
      data: { undoToken: operation.undoToken },
      failOnStatusCode: false,
    })
    expect(undone.status(), await undone.text()).toBe(200)
    expect(await listById(admin, receiptId)).toHaveLength(0)

    const redone = await admin.post('/api/audit_logs/audit-logs/actions/redo', {
      data: { logId: operation.id },
      failOnStatusCode: false,
    })
    expect(redone.status(), await redone.text()).toBe(200)

    const after = await readGoodsReceipt(admin, receiptId)
    expect(after.id).toBe(before.id)
    expect(after.documentNumber).toBe(documentNumber)
    expect(after.status).toBe('draft')
    expect(after.lines?.map((line) => line.id)).toEqual(before.lines?.map((line) => line.id))
    expect(after.lines?.map((line) => line.quantity)).toEqual(['2.0000', '3.0000'])
    expect(after.lines?.map((line) => line.unit)).toEqual(['pc', 'kg'])
    expect(after.lines?.map((line) => line.catalogVariantId)).toEqual([variantAId, variantBId])
  })

  /**
   * The whole create flow without a mouse, ending in a real document. Focus is taken once,
   * on the first field, and every move after that is Tab, Shift+Tab, typing or Enter — so a
   * control the tab order cannot reach fails the test. It also adds and removes lines, which
   * is the other thing only the screen can show.
   */
  test('completes a multi-line create from the keyboard alone', async ({ context, page }) => {
    test.setTimeout(180_000)
    await adoptSession(context, adminCookies)
    const documentNumber = `PZ/${RUN}/7`

    await page.goto(`${INDEX_PATH}/create`)
    await hideDevDiagnostics(page)
    const documentNumberField = page.getByPlaceholder('ZPZ/1/2026')
    await documentNumberField.focus()
    await expect(documentNumberField).toBeFocused()
    await page.keyboard.type(documentNumber, { delay: 10 })

    await tabUntilFocused(page, page.getByRole('button', { name: /Pick a date|Wybierz datę/i }), { limit: 1 })
    await pickTodayByKeyboard(page)

    // Committing the date closes a popover, and focus lands wherever the popover left it
    // rather than back on the trigger, so the walk to Supplier is given room.
    const supplierField = page.getByPlaceholder(/Who sent the delivery|Kto przysłał dostawę/i)
    await tabUntilFocused(page, supplierField, { limit: 60 })
    await page.keyboard.type('Hurtownia Kowalski', { delay: 10 })

    await tabUntilFocused(page, page.getByRole('combobox', { name: /Search for a warehouse|Wyszukaj magazyn/i }), { limit: 1 })
    await chooseOptionByKeyboard(page, new RegExp(`PZ QA warehouse ${RUN}`), `PZ QA warehouse ${RUN}`)

    await tabUntilFocused(page, page.getByRole('combobox', { name: /Product, position 1|Produkt, pozycja 1/i }), { limit: 1 })
    await chooseOptionByKeyboard(page, new RegExp(`PZ QA product a ${RUN}`), `PZ QA product a ${RUN}`)
    await tabUntilFocused(page, page.getByRole('textbox', { name: /Quantity, position 1|Ilość, pozycja 1/i }), { limit: 1 })
    await page.keyboard.type('2.5')

    // Unit, Remove, then Add line: three presses from the quantity field.
    const addLine = page.getByRole('button', { name: /Add line|Dodaj pozycję/i })
    await tabUntilFocused(page, addLine, { limit: 3 })
    await page.keyboard.press('Enter')

    // The new row is inserted above the Add button, so its controls are behind us.
    const secondProduct = page.getByRole('combobox', { name: /Product, position 2|Produkt, pozycja 2/i })
    await tabUntilFocused(page, secondProduct, { shift: true, limit: 4 })
    await chooseOptionByKeyboard(page, new RegExp(`PZ QA product b ${RUN}`), `PZ QA product b ${RUN}`)
    await tabUntilFocused(page, page.getByRole('textbox', { name: /Quantity, position 2|Ilość, pozycja 2/i }), { limit: 1 })
    await page.keyboard.type('4')

    // A third line, so removing the second proves the rest are renumbered rather than left
    // with a hole.
    await tabUntilFocused(page, addLine, { limit: 3 })
    await page.keyboard.press('Enter')
    const thirdProduct = page.getByRole('combobox', { name: /Product, position 3|Produkt, pozycja 3/i })
    await tabUntilFocused(page, thirdProduct, { shift: true, limit: 4 })
    await chooseOptionByKeyboard(page, new RegExp(`PZ QA product b ${RUN}`), `PZ QA product b ${RUN}`)
    await tabUntilFocused(page, page.getByRole('textbox', { name: /Quantity, position 3|Ilość, pozycja 3/i }), { limit: 1 })
    await page.keyboard.type('1')

    // Back up to the second line's remove button and press it.
    const removeSecond = page.getByRole('button', { name: /Remove position 2|Usuń pozycję 2/i })
    await tabUntilFocused(page, removeSecond, { shift: true, limit: 8 })
    await page.keyboard.press('Enter')
    await expect(thirdProduct).toHaveCount(0)

    // Removing the focused control drops focus to the document, so the walk to Save starts
    // at the top of the page and crosses the whole sidebar — long, but reachable without a
    // mouse, which is what the acceptance criterion asks for.
    const save = page.getByRole('button', { name: /Save goods receipt order|Zapisz zlecenie/i }).first()
    await tabUntilFocused(page, save, { limit: 200 })
    await page.keyboard.press('Enter')

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
    await adoptSession(context, adminCookies)
    const documentNumber = `PZ/${RUN}/6`

    await page.goto(`${INDEX_PATH}/create`)
    await hideDevDiagnostics(page)

    const documentNumberField = page.getByPlaceholder('ZPZ/1/2026')
    // The form autofocuses its first field on mount; typing before that happens lets the
    // hydrating controlled input reset what was typed.
    await expect(documentNumberField).toBeFocused()
    await documentNumberField.fill(documentNumber)
    await expect(documentNumberField).toHaveValue(documentNumber)

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
    await page.getByRole('button', { name: /Save goods receipt order|Zapisz zlecenie/i }).first().click()

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
