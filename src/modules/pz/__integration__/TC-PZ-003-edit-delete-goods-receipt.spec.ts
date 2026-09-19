import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * Editing and deleting a draft, exercised at the module's HTTP API — where every rule this
 * ticket settles is observable whatever the UI offers: the draft-only restriction, the
 * version guard, numbering uniqueness on update, and a deleted draft's number becoming free
 * again.
 *
 * One browser test rides along for the conflict a person actually meets: two people with
 * the same draft open, the second save refused with something they can act on.
 *
 * The confirmed-document refusals live in TC-PZ-004, because confirming is what creates a
 * confirmed document and this ticket ships no way to do it.
 */

const ADMIN = { email: 'admin@acme.com', password: 'secret' }
const RUN = Date.now()

const API = '/api/pz/goods-receipts'
const INDEX_PATH = '/backend/wms/goods-receipts'
const LOCK_HEADER = 'x-om-ext-optimistic-lock-expected-updated-at'

type Created = { id?: string; updatedAt?: string | null }

type GoodsReceiptRow = {
  id: string
  documentNumber: string
  documentDate: string | null
  supplierName: string
  warehouseId: string
  status: string
  lineCount: number
  updatedAt: string | null
  lines: Array<{
    id: string
    lineNumber: number
    catalogProductId: string
    quantity: string
    unit: string | null
  }> | null
}

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
    data: { name: `PZ QA edit warehouse ${RUN}`, code: `PZQAE${RUN}`, isActive: true },
    failOnStatusCode: false,
  })
  expect(response.status(), `warehouse -> ${response.status()}: ${await response.text()}`).toBeLessThan(400)
  return ((await response.json()) as Created).id as string
}

async function createProduct(request: APIRequestContext, suffix: string): Promise<string> {
  const productResponse = await request.post('/api/catalog/products', {
    data: { title: `PZ QA edit product ${suffix} ${RUN}`, sku: `PZQAE-${suffix}-${RUN}`, defaultUnit: 'pc' },
    failOnStatusCode: false,
  })
  expect(productResponse.status(), await productResponse.text()).toBeLessThan(400)
  const productId = ((await productResponse.json()) as Created).id as string
  const variantResponse = await request.post('/api/catalog/variants', {
    data: { productId, sku: `PZQAE-${suffix}-${RUN}-V1`, isDefault: true, isActive: true },
    failOnStatusCode: false,
  })
  expect(variantResponse.status(), await variantResponse.text()).toBeLessThan(400)
  return productId
}

function yesterday(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

async function readGoodsReceipt(request: APIRequestContext, id: string): Promise<GoodsReceiptRow> {
  const response = await request.get(`${API}?ids=${encodeURIComponent(id)}&pageSize=1`)
  expect(response.status(), await response.text()).toBe(200)
  const row = ((await response.json()) as { items: GoodsReceiptRow[] }).items[0]
  expect(row, `goods receipt ${id} is missing from the index`).toBeTruthy()
  return row
}

async function listById(request: APIRequestContext, id: string): Promise<GoodsReceiptRow[]> {
  const response = await request.get(`${API}?ids=${encodeURIComponent(id)}&pageSize=1`)
  expect(response.status()).toBe(200)
  return ((await response.json()) as { items: GoodsReceiptRow[] }).items
}

/** Reads the undo handle the CRUD factory attaches to every command-backed write. */
function readOperation(response: { headers: () => Record<string, string> }): { id: string; undoToken: string } {
  const raw = response.headers()['x-om-operation']
  expect(raw, 'the write did not report an operation to undo').toBeTruthy()
  const parsed = JSON.parse(decodeURIComponent(raw.replace(/^omop:/, ''))) as { id: string; undoToken: string }
  expect(parsed.undoToken).toBeTruthy()
  return parsed
}


test.describe('TC-PZ-003 edit and delete draft goods receipts', () => {
  let admin: APIRequestContext
  let adminCookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies']
  let warehouseId: string
  let productAId: string
  let productBId: string
  let sequence = 0

  const nextNumber = () => {
    sequence += 1
    return `PZE/${RUN}/${sequence}`
  }

  async function createDraft(
    request: APIRequestContext,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; documentNumber: string }> {
    const documentNumber = (overrides.documentNumber as string | undefined) ?? nextNumber()
    const response = await request.post(API, {
      data: {
        documentDate: yesterday(),
        supplierName: 'Hurtownia Kowalski',
        warehouseId,
        lines: [{ catalogProductId: productAId, quantity: '2' }],
        ...overrides,
        documentNumber,
      },
      failOnStatusCode: false,
    })
    expect(response.status(), `create -> ${response.status()}: ${await response.text()}`).toBe(201)
    return { id: ((await response.json()) as Created).id as string, documentNumber }
  }

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
      productAId = await createProduct(admin, 'a')
      productBId = await createProduct(admin, 'b')
    } catch (error) {
      await admin.dispose()
      throw error
    }
  })

  test.afterAll(async () => {
    await admin?.dispose()
  })

  test('edits a draft header and replaces its lines', async () => {
    const draft = await createDraft(admin)
    const before = await readGoodsReceipt(admin, draft.id)

    const updated = await admin.put(API, {
      headers: { [LOCK_HEADER]: before.updatedAt ?? '' },
      data: {
        id: draft.id,
        documentNumber: draft.documentNumber,
        documentDate: yesterday(),
        supplierName: 'Hurtownia Nowak',
        warehouseId,
        lines: [
          { catalogProductId: productBId, quantity: '5', unit: 'kg' },
          { catalogProductId: productAId, quantity: '1.25' },
        ],
      },
      failOnStatusCode: false,
    })
    expect(updated.status(), await updated.text()).toBe(200)

    const after = await readGoodsReceipt(admin, draft.id)
    expect(after.supplierName).toBe('Hurtownia Nowak')
    expect(after.status).toBe('draft')
    expect(after.lineCount).toBe(2)
    expect(after.lines?.map((line) => line.lineNumber)).toEqual([1, 2])
    expect(after.lines?.map((line) => line.catalogProductId)).toEqual([productBId, productAId])
    expect(after.lines?.map((line) => line.quantity)).toEqual(['5.0000', '1.2500'])
    expect(after.lines?.map((line) => line.unit)).toEqual(['kg', 'pc'])
    // The version moved, which is what makes the stale-save guard work at all.
    expect(after.updatedAt).not.toBe(before.updatedAt)
  })

  test('refuses a save that would leave the goods receipt with no lines', async () => {
    const draft = await createDraft(admin)
    const current = await readGoodsReceipt(admin, draft.id)

    const response = await admin.put(API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: {
        id: draft.id,
        documentNumber: draft.documentNumber,
        documentDate: yesterday(),
        supplierName: 'Hurtownia Kowalski',
        warehouseId,
        lines: [],
      },
      failOnStatusCode: false,
    })
    expect(response.status(), await response.text()).toBe(400)
    expect(((await response.json()) as { fields?: Record<string, string> }).fields?.lines).toBeTruthy()
    expect((await readGoodsReceipt(admin, draft.id)).lineCount).toBe(1)
  })

  test('refuses a stale save with a conflict instead of overwriting', async () => {
    const draft = await createDraft(admin)
    const opened = await readGoodsReceipt(admin, draft.id)

    const body = {
      id: draft.id,
      documentNumber: draft.documentNumber,
      documentDate: yesterday(),
      warehouseId,
      lines: [{ catalogProductId: productAId, quantity: '2' }],
    }

    // Someone else saves first.
    const first = await admin.put(API, {
      headers: { [LOCK_HEADER]: opened.updatedAt ?? '' },
      data: { ...body, supplierName: 'Hurtownia Pierwsza' },
      failOnStatusCode: false,
    })
    expect(first.status(), await first.text()).toBe(200)

    // The stale copy still holds the version it was opened with.
    const stale = await admin.put(API, {
      headers: { [LOCK_HEADER]: opened.updatedAt ?? '' },
      data: { ...body, supplierName: 'Hurtownia Druga' },
      failOnStatusCode: false,
    })
    expect(stale.status(), await stale.text()).toBe(409)
    const conflict = (await stale.json()) as { code?: string; currentUpdatedAt?: string }
    expect(conflict.code).toBe('optimistic_lock_conflict')
    expect(conflict.currentUpdatedAt).toBeTruthy()

    // The first save stands; the stale one changed nothing.
    expect((await readGoodsReceipt(admin, draft.id)).supplierName).toBe('Hurtownia Pierwsza')
  })

  test('refuses a document number already used, but not the document keeping its own', async () => {
    const taken = await createDraft(admin)
    const draft = await createDraft(admin)
    const current = await readGoodsReceipt(admin, draft.id)

    const body = {
      id: draft.id,
      documentDate: yesterday(),
      supplierName: 'Hurtownia Kowalski',
      warehouseId,
      lines: [{ catalogProductId: productAId, quantity: '2' }],
    }

    const collision = await admin.put(API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: { ...body, documentNumber: taken.documentNumber },
      failOnStatusCode: false,
    })
    expect(collision.status(), await collision.text()).toBe(400)
    expect(((await collision.json()) as { fields?: Record<string, string> }).fields?.documentNumber).toBeTruthy()

    // Keeping its own number is not a collision with itself.
    const unchanged = await admin.put(API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: { ...body, documentNumber: draft.documentNumber },
      failOnStatusCode: false,
    })
    expect(unchanged.status(), await unchanged.text()).toBe(200)
  })

  test('deletes a draft and frees its document number', async () => {
    const draft = await createDraft(admin)
    const current = await readGoodsReceipt(admin, draft.id)

    const deleted = await admin.delete(`${API}?id=${encodeURIComponent(draft.id)}`, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      failOnStatusCode: false,
    })
    expect(deleted.status(), await deleted.text()).toBe(200)
    expect(await listById(admin, draft.id)).toHaveLength(0)

    // The unique index ignores soft-deleted rows, so the number is free again.
    const reused = await admin.post(API, {
      data: {
        documentNumber: draft.documentNumber,
        documentDate: yesterday(),
        supplierName: 'Hurtownia Kowalski',
        warehouseId,
        lines: [{ catalogProductId: productAId, quantity: '1' }],
      },
      failOnStatusCode: false,
    })
    expect(reused.status(), await reused.text()).toBe(201)
  })

  test('refuses a write that carries no record version', async () => {
    const draft = await createDraft(admin)
    const body = {
      id: draft.id,
      documentNumber: draft.documentNumber,
      documentDate: yesterday(),
      supplierName: 'Hurtownia Bez Wersji',
      warehouseId,
      lines: [{ catalogProductId: productAId, quantity: '2' }],
    }

    // The installed lock helper is additive and ignores a missing version, so this is the
    // module's own requirement; without it a blind write would silently win.
    const update = await admin.put(API, { data: body, failOnStatusCode: false })
    expect(update.status(), await update.text()).toBe(400)

    const remove = await admin.delete(`${API}?id=${encodeURIComponent(draft.id)}`, { failOnStatusCode: false })
    expect(remove.status(), await remove.text()).toBe(400)


    const garbage = await admin.put(API, {
      headers: { [LOCK_HEADER]: 'not-a-timestamp' },
      data: body,
      failOnStatusCode: false,
    })
    // An unparseable token is worse than a missing one: the installed helper cannot compare
    // it and would return silently, so it must be refused rather than treated as satisfied.
    expect(garbage.status(), await garbage.text()).toBe(400)

    expect((await readGoodsReceipt(admin, draft.id)).supplierName).toBe('Hurtownia Kowalski')
  })

  test('undoes an edit, is idempotent on retry, and refuses once the document moved on', async () => {
    const draft = await createDraft(admin)
    const opened = await readGoodsReceipt(admin, draft.id)
    const body = {
      id: draft.id,
      documentNumber: draft.documentNumber,
      documentDate: yesterday(),
      warehouseId,
    }

    const edited = await admin.put(API, {
      headers: { [LOCK_HEADER]: opened.updatedAt ?? '' },
      data: {
        ...body,
        supplierName: 'Hurtownia Po Edycji',
        lines: [
          { catalogProductId: productBId, quantity: '7', unit: 'kg' },
          { catalogProductId: productAId, quantity: '2' },
        ],
      },
      failOnStatusCode: false,
    })
    expect(edited.status(), await edited.text()).toBe(200)
    const operation = readOperation(edited)
    expect((await readGoodsReceipt(admin, draft.id)).lineCount).toBe(2)

    const undone = await admin.post('/api/audit_logs/audit-logs/actions/undo', {
      data: { undoToken: operation.undoToken },
      failOnStatusCode: false,
    })
    expect(undone.status(), await undone.text()).toBe(200)

    const restored = await readGoodsReceipt(admin, draft.id)
    expect(restored.supplierName).toBe('Hurtownia Kowalski')
    expect(restored.lineCount).toBe(1)
    expect(restored.lines?.map((line) => line.catalogProductId)).toEqual([productAId])

    // Replaying the same undo token is refused before it reaches the handler, which is
    // the bus contract; what matters here is that the document is not touched again.
    const retried = await admin.post('/api/audit_logs/audit-logs/actions/undo', {
      data: { undoToken: operation.undoToken },
      failOnStatusCode: false,
    })
    expect(retried.status(), await retried.text()).toBeGreaterThanOrEqual(400)
    const afterRetry = await readGoodsReceipt(admin, draft.id)
    expect(afterRetry.supplierName).toBe('Hurtownia Kowalski')
    expect(afterRetry.lineCount).toBe(1)
  })

  test('refuses to undo an edit the document has already moved past', async () => {
    const draft = await createDraft(admin)
    const opened = await readGoodsReceipt(admin, draft.id)
    const body = {
      id: draft.id,
      documentNumber: draft.documentNumber,
      documentDate: yesterday(),
      warehouseId,
      lines: [{ catalogProductId: productAId, quantity: '2' }],
    }

    const first = await admin.put(API, {
      headers: { [LOCK_HEADER]: opened.updatedAt ?? '' },
      data: { ...body, supplierName: 'Hurtownia Pierwsza Edycja' },
      failOnStatusCode: false,
    })
    expect(first.status(), await first.text()).toBe(200)
    const operation = readOperation(first)

    // Someone edits again, so the first edit is no longer the document's current shape.
    const current = await readGoodsReceipt(admin, draft.id)
    const second = await admin.put(API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: { ...body, supplierName: 'Hurtownia Druga Edycja' },
      failOnStatusCode: false,
    })
    expect(second.status(), await second.text()).toBe(200)

    const undone = await admin.post('/api/audit_logs/audit-logs/actions/undo', {
      data: { undoToken: operation.undoToken },
      failOnStatusCode: false,
    })
    // Refused — by the command bus, which will not redeem a token the record has moved
    // past, with the command's own staleness guard behind it as defence in depth.
    expect(undone.status(), await undone.text()).toBeGreaterThanOrEqual(400)
    expect(undone.status()).toBeLessThan(500)
    // Undoing would have thrown away the second edit; it stands instead.
    expect((await readGoodsReceipt(admin, draft.id)).supplierName).toBe('Hurtownia Druga Edycja')
  })

  test('refuses to undo an edit once the goods receipt has been deleted', async () => {
    const draft = await createDraft(admin)
    const opened = await readGoodsReceipt(admin, draft.id)
    const edited = await admin.put(API, {
      headers: { [LOCK_HEADER]: opened.updatedAt ?? '' },
      data: {
        id: draft.id,
        documentNumber: draft.documentNumber,
        documentDate: yesterday(),
        supplierName: 'Hurtownia Przed Usunięciem',
        warehouseId,
        lines: [{ catalogProductId: productAId, quantity: '2' }],
      },
      failOnStatusCode: false,
    })
    expect(edited.status(), await edited.text()).toBe(200)
    const operation = readOperation(edited)

    const current = await readGoodsReceipt(admin, draft.id)
    const removed = await admin.delete(`${API}?id=${encodeURIComponent(draft.id)}`, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      failOnStatusCode: false,
    })
    expect(removed.status(), await removed.text()).toBe(200)

    // Undoing the edit would mutate a deleted record and burn the undo, leaving the later
    // delete-undo to restore a state nobody asked for. The bus refuses the superseded token
    // first; the command's own check on `deletedAt` is what stops it if it ever gets through.
    const undone = await admin.post('/api/audit_logs/audit-logs/actions/undo', {
      data: { undoToken: operation.undoToken },
      failOnStatusCode: false,
    })
    expect(undone.status(), await undone.text()).toBeGreaterThanOrEqual(400)
    expect(undone.status()).toBeLessThan(500)
    expect(await listById(admin, draft.id)).toHaveLength(0)
  })

  test('loads a draft with its lines and saves added and removed lines from the screen', async ({ context, page }) => {
    test.setTimeout(120_000)
    await context.addCookies(adminCookies)
    const draft = await createDraft(admin, {
      lines: [
        { catalogProductId: productAId, quantity: '2' },
        { catalogProductId: productBId, quantity: '5', unit: 'kg' },
      ],
    })

    await page.goto(`${INDEX_PATH}/${draft.id}/edit`)

    // The screen opens with the stored lines, not an empty editor.
    await expect(page.getByRole('textbox', { name: /Quantity, position 1|Ilość, pozycja 1/i })).toHaveValue('2.0000')
    await expect(page.getByRole('textbox', { name: /Quantity, position 2|Ilość, pozycja 2/i })).toHaveValue('5.0000')
    await expect(page.getByRole('textbox', { name: /Unit, position 2|Jednostka, pozycja 2/i })).toHaveValue('kg')

    await page.getByRole('textbox', { name: /Quantity, position 1|Ilość, pozycja 1/i }).fill('8')
    await page.getByRole('button', { name: /Remove position 2|Usuń pozycję 2/i }).click()
    await expect(page.getByRole('textbox', { name: /Quantity, position 2|Ilość, pozycja 2/i })).toHaveCount(0)

    await page.getByRole('button', { name: /Save changes|Zapisz zmiany/i }).first().click()
    await page.waitForURL(new RegExp(`${INDEX_PATH}(\\?|$)`))

    const saved = await readGoodsReceipt(admin, draft.id)
    expect(saved.lineCount).toBe(1)
    expect(saved.lines?.map((line) => line.quantity)).toEqual(['8.0000'])
    expect(saved.lines?.map((line) => line.catalogProductId)).toEqual([productAId])
  })

  test('tells the second editor their copy is stale instead of losing their colleague work', async ({ context, page }) => {
    test.setTimeout(120_000)
    await context.addCookies(adminCookies)
    const draft = await createDraft(context.request)

    await page.goto(`${INDEX_PATH}/${draft.id}/edit`)
    const supplierField = page.getByPlaceholder(/Who sent the delivery|Kto przysłał dostawę/i)
    await expect(supplierField).toHaveValue('Hurtownia Kowalski')

    // A colleague saves while this screen is open.
    const opened = await readGoodsReceipt(context.request, draft.id)
    const colleague = await context.request.put(API, {
      headers: { [LOCK_HEADER]: opened.updatedAt ?? '' },
      data: {
        id: draft.id,
        documentNumber: draft.documentNumber,
        documentDate: yesterday(),
        supplierName: 'Hurtownia Kolegi',
        warehouseId,
        lines: [{ catalogProductId: productAId, quantity: '2' }],
      },
      failOnStatusCode: false,
    })
    expect(colleague.status(), await colleague.text()).toBe(200)

    await supplierField.fill('Hurtownia Moja')
    await page.getByRole('button', { name: /Save changes|Zapisz zmiany/i }).first().click()

    // The conflict surface renders both an explanation and a way to recover, so more than
    // one node carries the copy; the point is that the user is told and offered a refresh.
    await expect(
      page.getByText(/modified by someone else|zmodyfikowany przez|Odśwież/i).first(),
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: /Refresh|Odśwież/i }).first()).toBeVisible()
    // The colleague's save is what stands.
    expect((await readGoodsReceipt(context.request, draft.id)).supplierName).toBe('Hurtownia Kolegi')
  })
})
