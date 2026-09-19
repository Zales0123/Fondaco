import { expect, test, type APIRequestContext } from '@playwright/test'
import { adoptSession, hideDevDiagnostics } from './browserSession'

/**
 * Confirming a goods receipt, exercised at the module's HTTP API: the one-way transition,
 * its own permission, the warehouse snapshot, the refusal to confirm into a warehouse that
 * has since been deleted, and the two refusals a confirmed document owes everyone —
 * update and delete — whatever the UI offers.
 *
 * It also pins the decision that surprises people most: confirming moves no stock
 * (ADR-0005). The `wms` balances, movements, lots and reservations are counted either side
 * of a confirmation and asserted unchanged.
 */

const ADMIN = { email: 'admin@acme.com', password: 'secret' }
const RUN = Date.now()

const INDEX_PATH = '/backend/wms/goods-receipts'
const API = '/api/pz/goods-receipts'
const CONFIRM_API = '/api/pz/goods-receipts/confirm'
const LOCK_HEADER = 'x-om-ext-optimistic-lock-expected-updated-at'
const MANAGER_PASSWORD = 'Warehouse123!'

type Created = { id?: string }

type GoodsReceiptRow = {
  id: string
  documentNumber: string
  supplierName: string
  status: string
  warehouseId: string
  warehouseSnapshot: { name: string; code: string } | null
  lineCount: number
  updatedAt: string | null
}

async function login(request: APIRequestContext, email: string, password: string): Promise<void> {
  const response = await request.post('/api/auth/login', {
    form: { email, password },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(response.status(), `login ${email} -> ${response.status()}: ${await response.text()}`).toBe(200)
}

async function createdId(response: { json: () => Promise<unknown>; status: () => number; text: () => Promise<string> }): Promise<string> {
  expect(response.status(), await response.text()).toBeLessThan(400)
  const id = ((await response.json()) as Created).id
  expect(id, 'created record has no id').toBeTruthy()
  return id as string
}

async function readGoodsReceipt(request: APIRequestContext, id: string): Promise<GoodsReceiptRow> {
  const response = await request.get(`${API}?ids=${encodeURIComponent(id)}&pageSize=1`)
  expect(response.status(), await response.text()).toBe(200)
  const row = ((await response.json()) as { items: GoodsReceiptRow[] }).items[0]
  expect(row, `goods receipt ${id} is missing from the index`).toBeTruthy()
  return row
}

/** Counts every `wms` record a stock posting would touch, so "nothing moved" can be asserted. */
async function readWmsTotals(request: APIRequestContext): Promise<Record<string, number>> {
  const paths = {
    balances: '/api/wms/inventory/balances?pageSize=1',
    movements: '/api/wms/inventory/movements?pageSize=1',
    reservations: '/api/wms/inventory/reservations?pageSize=1',
    lots: '/api/wms/lots?pageSize=1',
  }
  const totals: Record<string, number> = {}
  for (const [key, path] of Object.entries(paths)) {
    const response = await request.get(path, { failOnStatusCode: false })
    expect(response.status(), `${key} -> ${response.status()}: ${await response.text()}`).toBe(200)
    const body = (await response.json()) as { total?: number; items?: unknown[] }
    totals[key] = typeof body.total === 'number' ? body.total : (body.items?.length ?? 0)
  }
  return totals
}

function yesterday(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

test.describe('TC-PZ-004 confirm a goods receipt', () => {
  /**
   * One login per account for the whole file. Every browser test adopts the same session
   * cookies instead of logging in again: a login per test is wasteful and enough to trip
   * the auth rate limit on a long-lived dev server.
   */
  let admin: APIRequestContext
  let manager: APIRequestContext
  let adminCookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies']
  let warehouseId: string
  let productId: string
  let sequence = 0

  const nextNumber = () => {
    sequence += 1
    return `PZC/${RUN}/${sequence}`
  }

  async function createWarehouse(request: APIRequestContext, suffix: string): Promise<string> {
    return createdId(
      await request.post('/api/wms/warehouses', {
        data: { name: `PZ QA confirm warehouse ${suffix} ${RUN}`, code: `PZQAC${suffix}${RUN}`, isActive: true },
        failOnStatusCode: false,
      }),
    )
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
        lines: [{ catalogProductId: productId, quantity: '3' }],
        ...overrides,
        documentNumber,
      },
      failOnStatusCode: false,
    })
    return { id: await createdId(response), documentNumber }
  }

  test.beforeAll(async ({ playwright }) => {
    const baseURL = process.env.BASE_URL || 'http://localhost:3000'
    admin = await playwright.request.newContext({ baseURL })
    manager = await playwright.request.newContext({ baseURL })
    try {
      await login(admin, ADMIN.email, ADMIN.password)
      adminCookies = (await admin.storageState()).cookies
      warehouseId = await createWarehouse(admin, 'main')
      productId = await createdId(
        await admin.post('/api/catalog/products', {
          data: { title: `PZ QA confirm product ${RUN}`, sku: `PZQAC-${RUN}`, defaultUnit: 'pc' },
          failOnStatusCode: false,
        }),
      )
      await createdId(
        await admin.post('/api/catalog/variants', {
          data: { productId, sku: `PZQAC-${RUN}-V1`, isDefault: true, isActive: true },
          failOnStatusCode: false,
        }),
      )

      // A role that can enter deliveries but not finalise them — the separation the ticket
      // asks for only means something if a real caller can hold one half of it.
      const roleName = `pz-manager-${RUN}`
      const roleId = await createdId(
        await admin.post('/api/auth/roles', { data: { name: roleName }, failOnStatusCode: false }),
      )
      const acl = await admin.put('/api/auth/roles/acl', {
        data: {
          roleId,
          features: ['pz.goodsReceipts.view', 'pz.goodsReceipts.manage', 'catalog.products.view', 'wms.view'],
        },
        failOnStatusCode: false,
      })
      expect(acl.status(), await acl.text()).toBeLessThan(400)

      const organizations = await admin.get('/api/directory/organizations?pageSize=1')
      const organizationId = ((await organizations.json()) as { items?: Array<{ id?: string }> }).items?.[0]?.id
      expect(organizationId, 'no organization to attach the test manager to').toBeTruthy()

      const managerEmail = `pz-manager-${RUN}@acme.com`
      const created = await admin.post('/api/auth/users', {
        data: {
          email: managerEmail,
          name: 'Integration Goods Receipt Manager',
          password: MANAGER_PASSWORD,
          organizationId,
          roles: [roleName],
        },
        failOnStatusCode: false,
      })
      expect(created.status(), await created.text()).toBeLessThan(400)
      await login(manager, managerEmail, MANAGER_PASSWORD)
    } catch (error) {
      await admin.dispose()
      await manager.dispose()
      throw error
    }
  })

  test.afterAll(async () => {
    await admin?.dispose()
    await manager?.dispose()
  })

  test('confirms a draft, snapshots its warehouse and moves no stock', async () => {
    const draft = await createDraft(admin)
    const before = await readGoodsReceipt(admin, draft.id)
    expect(before.warehouseSnapshot).toBeNull()
    const stockBefore = await readWmsTotals(admin)

    const confirmed = await admin.post(CONFIRM_API, {
      headers: { [LOCK_HEADER]: before.updatedAt ?? '' },
      data: { id: draft.id },
      failOnStatusCode: false,
    })
    expect(confirmed.status(), await confirmed.text()).toBe(200)
    expect(((await confirmed.json()) as { status?: string }).status).toBe('confirmed')

    const after = await readGoodsReceipt(admin, draft.id)
    expect(after.status).toBe('confirmed')
    expect(after.warehouseSnapshot?.name).toBe(`PZ QA confirm warehouse main ${RUN}`)
    expect(after.warehouseSnapshot?.code).toBe(`PZQACmain${RUN}`)

    // ADR-0005: a goods receipt records a delivery, it does not move stock.
    expect(await readWmsTotals(admin)).toEqual(stockBefore)
  })

  test('is one-way: a confirmed goods receipt refuses confirm, update and delete', async () => {
    const draft = await createDraft(admin)
    const opened = await readGoodsReceipt(admin, draft.id)
    const first = await admin.post(CONFIRM_API, {
      headers: { [LOCK_HEADER]: opened.updatedAt ?? '' },
      data: { id: draft.id },
      failOnStatusCode: false,
    })
    expect(first.status(), await first.text()).toBe(200)

    const current = await readGoodsReceipt(admin, draft.id)

    const again = await admin.post(CONFIRM_API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: { id: draft.id },
      failOnStatusCode: false,
    })
    expect(again.status(), await again.text()).toBe(409)

    const updated = await admin.put(API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: {
        id: draft.id,
        documentNumber: draft.documentNumber,
        documentDate: yesterday(),
        supplierName: 'Hurtownia Zmieniona',
        warehouseId,
        lines: [{ catalogProductId: productId, quantity: '9' }],
      },
      failOnStatusCode: false,
    })
    expect(updated.status(), await updated.text()).toBe(409)

    const deleted = await admin.delete(`${API}?id=${encodeURIComponent(draft.id)}`, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      failOnStatusCode: false,
    })
    expect(deleted.status(), await deleted.text()).toBe(409)

    // Nothing the refusals touched changed the document.
    const unchanged = await readGoodsReceipt(admin, draft.id)
    expect(unchanged.status).toBe('confirmed')
    expect(unchanged.supplierName).toBe('Hurtownia Kowalski')
  })

  test('refuses a caller holding manage but not confirm', async () => {
    const draft = await createDraft(admin)
    const current = await readGoodsReceipt(admin, draft.id)

    // The same caller can read and edit the draft, so the refusal is about confirming.
    const readable = await manager.get(`${API}?ids=${encodeURIComponent(draft.id)}&pageSize=1`)
    expect(readable.status(), await readable.text()).toBe(200)

    const refused = await manager.post(CONFIRM_API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: { id: draft.id },
      failOnStatusCode: false,
    })
    expect(refused.status(), await refused.text()).toBe(403)
    expect((await readGoodsReceipt(admin, draft.id)).status).toBe('draft')
  })

  test('refuses to confirm into a warehouse that has since been deleted', async () => {
    const doomedWarehouseId = await createWarehouse(admin, 'doomed')
    const draft = await createDraft(admin, { warehouseId: doomedWarehouseId })
    const current = await readGoodsReceipt(admin, draft.id)

    const removed = await admin.delete(`/api/wms/warehouses?id=${encodeURIComponent(doomedWarehouseId)}`, {
      failOnStatusCode: false,
    })
    expect(removed.status(), await removed.text()).toBeLessThan(400)

    const refused = await admin.post(CONFIRM_API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: { id: draft.id },
      failOnStatusCode: false,
    })
    expect(refused.status(), await refused.text()).toBe(409)
    // Surfaced as a data problem rather than frozen into the record.
    expect((await readGoodsReceipt(admin, draft.id)).status).toBe('draft')
  })

  test('offers no way to un-confirm', async () => {
    const response = await admin.get('/api/docs/openapi')
    expect(response.status()).toBe(200)
    const paths = Object.keys(((await response.json()) as { paths?: Record<string, unknown> }).paths ?? {})
    const pzPaths = paths.filter((path) => path.includes('goods-receipt'))
    expect(pzPaths.length).toBeGreaterThan(0)
    expect(pzPaths.filter((path) => /unconfirm|un-confirm|revert|reopen/i.test(path))).toEqual([])
  })

  test('offers a Confirm control that warns before it takes effect, and closes the document', async ({ context, page }) => {
    test.setTimeout(120_000)
    await adoptSession(context, adminCookies)
    const draft = await createDraft(admin)

    await page.goto(`${INDEX_PATH}/${draft.id}/edit`)
    await hideDevDiagnostics(page)

    // Confirmation is an action beside the form, not a status field among the inputs.
    await expect(page.getByRole('combobox', { name: /Status/i })).toHaveCount(0)
    const confirmControl = page.getByRole('button', { name: /^(Confirm|Zatwierdź)$/ }).first()
    await expect(confirmControl).toBeVisible()
    await confirmControl.click()

    // Nothing happens until the user is told it cannot be undone.
    await expect(page.getByText(/cannot be undone|nie można go cofnąć/i).first()).toBeVisible()
    expect((await readGoodsReceipt(admin, draft.id)).status).toBe('draft')

    await page.getByRole('button', { name: /Confirm goods receipt|Zatwierdź przyjęcie/i }).first().click()
    await page.waitForURL(new RegExp(`${INDEX_PATH}(\\?|$)`))

    // The index is read through the same endpoint the table renders, with its list cache
    // disabled, so the document is confirmed there the moment the user lands back on it.
    // The badge itself is not asserted in the page: the index has no filter or search yet
    // (#20), so which page a given row falls on depends on how much data the run left
    // behind.
    expect((await readGoodsReceipt(admin, draft.id)).status).toBe('confirmed')

    // Reopening it offers no way back: the edit screen refuses rather than re-rendering
    // the form.
    await page.goto(`${INDEX_PATH}/${draft.id}/edit`)
    await hideDevDiagnostics(page)
    await expect(page.getByText(/no longer be edited|nie można go już edytować/i).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /^(Confirm|Zatwierdź)$/ })).toHaveCount(0)
  })
})
