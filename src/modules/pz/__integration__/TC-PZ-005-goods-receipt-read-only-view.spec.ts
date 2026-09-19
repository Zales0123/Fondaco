import { expect, test, type APIRequestContext } from '@playwright/test'
import { adoptSession, hideDevDiagnostics } from './browserSession'

const ADMIN = { email: 'admin@acme.com', password: 'secret' }
const RUN = Date.now()
const API = '/api/pz/goods-receipts'
const INDEX_PATH = '/backend/wms/goods-receipts'
const LOCK_HEADER = 'x-om-ext-optimistic-lock-expected-updated-at'

type Created = { id?: string }
type GoodsReceiptRow = { updatedAt: string | null }

async function login(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/auth/login', {
    form: ADMIN,
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(response.status(), `login -> ${response.status()}: ${await response.text()}`).toBe(200)
}

async function createdId(response: { json: () => Promise<unknown>; status: () => number; text: () => Promise<string> }): Promise<string> {
  expect(response.status(), await response.text()).toBeLessThan(400)
  const id = ((await response.json()) as Created).id
  expect(id, 'created record has no id').toBeTruthy()
  return id as string
}

test.describe('TC-PZ-005 goods receipt read-only view', () => {
  let admin: APIRequestContext
  let adminCookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies']
  let receiptId: string
  let warehouseId: string
  let productId: string
  const documentNumber = `PZV/${RUN}`
  const warehouseName = `PZ QA view warehouse ${RUN}`
  const warehouseCode = `PZQAV${RUN}`
  const originalProductName = `PZ QA recorded product ${RUN}`
  const originalProductSku = `PZQAV-${RUN}-V1`
  const secondProductName = `PZ QA second product ${RUN}`
  const secondProductSku = `PZQAV-${RUN}-V2`

  test.beforeAll(async ({ playwright }) => {
    admin = await playwright.request.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3000' })
    await login(admin)
    adminCookies = (await admin.storageState()).cookies

    warehouseId = await createdId(await admin.post('/api/wms/warehouses', {
      data: { name: warehouseName, code: warehouseCode, isActive: true },
      failOnStatusCode: false,
    }))
    productId = await createdId(await admin.post('/api/catalog/products', {
      data: { title: originalProductName, sku: `PZQAV-${RUN}`, defaultUnit: 'pc' },
      failOnStatusCode: false,
    }))
    await createdId(await admin.post('/api/catalog/variants', {
      data: { productId, sku: originalProductSku, isDefault: true, isActive: true },
      failOnStatusCode: false,
    }))
    const secondProductId = await createdId(await admin.post('/api/catalog/products', {
      data: { title: secondProductName, sku: `PZQAV-SECOND-${RUN}`, defaultUnit: 'kg' },
      failOnStatusCode: false,
    }))
    await createdId(await admin.post('/api/catalog/variants', {
      data: { productId: secondProductId, sku: secondProductSku, isDefault: true, isActive: true },
      failOnStatusCode: false,
    }))

    receiptId = await createdId(await admin.post(API, {
      data: {
        documentNumber,
        documentDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
        supplierName: 'Snapshot Supplier',
        warehouseId,
        lines: [
          { catalogProductId: productId, quantity: '2.5', unit: 'box' },
          { catalogProductId: secondProductId, quantity: '1' },
        ],
      },
      failOnStatusCode: false,
    }))
    const read = await admin.get(`${API}?ids=${encodeURIComponent(receiptId)}&pageSize=1`)
    expect(read.status(), await read.text()).toBe(200)
    const current = ((await read.json()) as { items: GoodsReceiptRow[] }).items[0]
    const confirmed = await admin.post(`${API}/confirm`, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: { id: receiptId },
      failOnStatusCode: false,
    })
    expect(confirmed.status(), await confirmed.text()).toBe(200)
  })

  test.afterAll(async () => {
    await admin?.dispose()
  })

  test('renders recorded values without controls after catalog and warehouse changes, while edit still refuses', async ({ context, page }) => {
    test.setTimeout(120_000)
    await adoptSession(context, adminCookies)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${INDEX_PATH}/${receiptId}`)
    await hideDevDiagnostics(page)

    const detail = page.getByTestId('goods-receipt-detail')
    await expect(detail).toBeVisible()
    await expect(detail).toContainText(documentNumber)
    await expect(detail).toContainText('Snapshot Supplier')
    await expect(detail).toContainText(warehouseName)
    await expect(detail).toContainText(warehouseCode)
    await expect(detail).toContainText(originalProductName)
    await expect(detail).toContainText(originalProductSku)
    await expect(detail).toContainText(secondProductName)
    await expect(detail).toContainText(secondProductSku)
    await expect(detail).toContainText('2.5000')
    await expect(detail).toContainText('box')
    await expect(detail).toContainText('1.0000')
    await expect(detail).toContainText('kg')
    await expect(detail.locator('input, textarea, select, form, button, [contenteditable="true"]')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

    const renamed = await admin.put('/api/catalog/products', {
      data: { id: productId, title: `Renamed after receipt ${RUN}` },
      failOnStatusCode: false,
    })
    expect(renamed.status(), await renamed.text()).toBe(200)
    await page.reload()
    await hideDevDiagnostics(page)
    await expect(detail).toContainText(originalProductName)
    await expect(detail).not.toContainText(`Renamed after receipt ${RUN}`)

    const deletedWarehouse = await admin.delete(`/api/wms/warehouses?id=${encodeURIComponent(warehouseId)}`, {
      failOnStatusCode: false,
    })
    expect(deletedWarehouse.status(), await deletedWarehouse.text()).toBeLessThan(400)
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.reload()
    await hideDevDiagnostics(page)
    await expect(detail).toContainText(warehouseName)
    await expect(detail).toContainText(warehouseCode)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

    await page.goto(`${INDEX_PATH}/${receiptId}/edit`)
    await hideDevDiagnostics(page)
    await expect(page.getByText(/no longer be edited|nie można go już edytować/i).first()).toBeVisible()
    await expect(page.locator('form')).toHaveCount(0)
  })
})
