import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * Finishing a counted delivery and putting its goods on stock (ADR-0011).
 *
 * The cases here are the ones the design is shaped around, not the happy path alone: the
 * floor's own permission, a destination that must belong to the warehouse, the refusal to
 * finish a delivery holding a lot-tracked product, one posting per variant however many
 * pallets it arrived on, and a retry that replays rather than double-stocks.
 *
 * Posting is triggered through the retry endpoint rather than by waiting on the subscriber.
 * The subscriber is durable and runs in a worker, so whether it has run yet is a question
 * about the environment; the retry endpoint runs the same command in-request, which makes
 * the assertions about what `wms` holds deterministic.
 */

const ADMIN = { email: 'admin@acme.com', password: 'secret' }
const FLOOR_PASSWORD = 'Warehouse123!'
const RUN = Date.now()

const API = '/api/pz/goods-receipts'
const RELEASE_API = `${API}/release`
const CONFIRM_API = `${API}/confirm`
const RETRY_API = `${API}/retry-stock-posting`
const COMPLETE_API = '/api/pz/receiving/confirm'
const DESTINATIONS_API = '/api/pz/receiving/destinations'
const PALLETS_API = '/api/pz/pallets'
const PALLET_LINES_API = '/api/pz/pallet-lines'
const MOVEMENTS_API = '/api/wms/inventory/movements'
const TOGGLES_API = '/api/feature_toggles/global'
const STOCK_POSTING_TOGGLE = 'wms_integration_procurement_goods_receipt'
const LOCK_HEADER = 'x-om-ext-optimistic-lock-expected-updated-at'

type GoodsReceiptRow = {
  id: string
  documentNumber: string
  status: string
  updatedAt: string | null
  stockPosting: { status: string; reason: string | null; locationId: string | null; postedAt: string | null }
}

/** The movements endpoint answers with the column names, not camel case. */
type Movement = {
  id: string
  catalog_variant_id?: string | null
  quantity?: string | number | null
  location_to_id?: string | null
}

async function login(request: APIRequestContext, email: string, password: string): Promise<void> {
  const response = await request.post('/api/auth/login', { form: { email, password }, maxRedirects: 0, failOnStatusCode: false })
  expect(response.status(), `login ${email} -> ${response.status()}: ${await response.text()}`).toBe(200)
}

async function createdId(response: { json: () => Promise<unknown>; status: () => number; text: () => Promise<string> }): Promise<string> {
  expect(response.status(), await response.text()).toBeLessThan(400)
  const body = (await response.json()) as { id?: string }
  expect(body.id, 'created record has no id').toBeTruthy()
  return body.id as string
}

function yesterday(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

test.describe('TC-PZ-007 complete a delivery and post its stock', () => {
  let admin: APIRequestContext
  let floor: APIRequestContext
  let warehouseId: string
  let stagingLocationId: string
  let aisleLocationId: string
  let otherWarehouseLocationId: string
  let plainProductId: string
  let plainVariantId: string
  let trackedProductId: string
  let toggleId: string
  let toggleWasEnabled = false
  let sequence = 0

  const nextNumber = () => {
    sequence += 1
    return `PZP/${RUN}/${sequence}`
  }

  async function read(id: string): Promise<GoodsReceiptRow> {
    const response = await admin.get(`${API}?ids=${encodeURIComponent(id)}&pageSize=1`)
    expect(response.status(), await response.text()).toBe(200)
    const row = ((await response.json()) as { items: GoodsReceiptRow[] }).items[0]
    expect(row, `goods receipt ${id} is missing from the index`).toBeTruthy()
    return row
  }

  async function createLocation(input: { warehouseId: string; code: string; type: string; parentId?: string }): Promise<string> {
    return createdId(await admin.post('/api/wms/locations', { data: input, failOnStatusCode: false }))
  }

  /** A released document with one line, ready for the floor to count onto. */
  async function releasedReceipt(productId: string, quantity = '10'): Promise<GoodsReceiptRow> {
    const id = await createdId(
      await admin.post(API, {
        data: {
          documentNumber: nextNumber(),
          documentDate: yesterday(),
          supplierName: 'Hurtownia Kowalski',
          warehouseId,
          lines: [{ catalogProductId: productId, quantity }],
        },
        failOnStatusCode: false,
      }),
    )
    const draft = await read(id)
    const released = await admin.post(RELEASE_API, {
      headers: { [LOCK_HEADER]: draft.updatedAt ?? '' },
      data: { id },
      failOnStatusCode: false,
    })
    expect(released.status(), await released.text()).toBe(200)
    return read(id)
  }

  /** Counts `quantity` of the variant onto a new pallet and closes it. */
  async function countOntoClosedPallet(goodsReceiptId: string, catalogVariantId: string, quantity: string): Promise<void> {
    const palletId = await createdId(await admin.post(PALLETS_API, { data: { goodsReceiptId }, failOnStatusCode: false }))
    const counted = await admin.post(PALLET_LINES_API, {
      data: { palletId, catalogVariantId, quantity },
      failOnStatusCode: false,
    })
    expect(counted.status(), await counted.text()).toBeLessThan(400)

    const pallets = await admin.get(`${PALLETS_API}?goodsReceiptId=${encodeURIComponent(goodsReceiptId)}&pageSize=100`)
    const pallet = ((await pallets.json()) as { items: Array<{ id: string; updatedAt: string | null }> }).items.find(
      (candidate) => candidate.id === palletId,
    )
    const closed = await admin.post(`${PALLETS_API}/close`, {
      headers: { [LOCK_HEADER]: pallet?.updatedAt ?? '' },
      data: { id: palletId },
      failOnStatusCode: false,
    })
    expect(closed.status(), await closed.text()).toBe(200)
  }

  async function movementsFor(goodsReceiptId: string): Promise<Movement[]> {
    const response = await admin.get(`${MOVEMENTS_API}?referenceId=${encodeURIComponent(goodsReceiptId)}&pageSize=100`)
    expect(response.status(), await response.text()).toBe(200)
    return ((await response.json()) as { items?: Movement[] }).items ?? []
  }

  test.beforeAll(async ({ playwright }) => {
    const baseURL = process.env.BASE_URL || 'http://localhost:3000'
    admin = await playwright.request.newContext({ baseURL })
    floor = await playwright.request.newContext({ baseURL })
    try {
      await login(admin, ADMIN.email, ADMIN.password)

      warehouseId = await createdId(
        await admin.post('/api/wms/warehouses', {
          data: { name: `PZ QA posting warehouse ${RUN}`, code: `PZQAP${RUN}`, isActive: true },
          failOnStatusCode: false,
        }),
      )
      const zoneId = await createLocation({ warehouseId, code: `RECV-${RUN}`, type: 'zone' })
      stagingLocationId = await createLocation({ warehouseId, code: `STG-${RUN}`, type: 'staging', parentId: zoneId })
      // A container row: legal in `wms`, refused by us, because stock in an aisle cannot be picked.
      aisleLocationId = zoneId
      const otherWarehouseId = await createdId(
        await admin.post('/api/wms/warehouses', {
          data: { name: `PZ QA other warehouse ${RUN}`, code: `PZQAO${RUN}`, isActive: true },
          failOnStatusCode: false,
        }),
      )
      otherWarehouseLocationId = await createLocation({
        warehouseId: otherWarehouseId,
        code: `OTH-${RUN}`,
        type: 'bin',
      })

      plainProductId = await createdId(
        await admin.post('/api/catalog/products', {
          data: { title: `PZ QA posting product ${RUN}`, sku: `PZQAP-${RUN}`, defaultUnit: 'pc' },
          failOnStatusCode: false,
        }),
      )
      plainVariantId = await createdId(
        await admin.post('/api/catalog/variants', {
          data: { productId: plainProductId, sku: `PZQAP-${RUN}-V1`, isDefault: true, isActive: true },
          failOnStatusCode: false,
        }),
      )

      trackedProductId = await createdId(
        await admin.post('/api/catalog/products', {
          data: { title: `PZ QA tracked product ${RUN}`, sku: `PZQAT-${RUN}`, defaultUnit: 'pc' },
          failOnStatusCode: false,
        }),
      )
      const trackedVariantId = await createdId(
        await admin.post('/api/catalog/variants', {
          data: { productId: trackedProductId, sku: `PZQAT-${RUN}-V1`, isDefault: true, isActive: true },
          failOnStatusCode: false,
        }),
      )
      const profile = await admin.post('/api/wms/inventory-profiles', {
        data: {
          catalogProductId: trackedProductId,
          catalogVariantId: trackedVariantId,
          defaultUom: 'pc',
          defaultStrategy: 'fifo',
          trackLot: true,
        },
        failOnStatusCode: false,
      })
      expect(profile.status(), await profile.text()).toBeLessThan(400)

      // A floor account holding the counting and completion grants and nothing else.
      const roleName = `pz-floor-${RUN}`
      const roleId = await createdId(await admin.post('/api/auth/roles', { data: { name: roleName }, failOnStatusCode: false }))
      const acl = await admin.put('/api/auth/roles/acl', {
        data: {
          roleId,
          features: [
            'pz.goodsReceipts.view',
            'pz.receiving.count',
            'pz.receiving.confirm',
            'catalog.products.view',
            'wms.view',
          ],
        },
        failOnStatusCode: false,
      })
      expect(acl.status(), await acl.text()).toBeLessThan(400)

      const organizations = await admin.get('/api/directory/organizations?pageSize=1')
      const organizationId = ((await organizations.json()) as { items?: Array<{ id?: string }> }).items?.[0]?.id
      expect(organizationId, 'no organization to attach the test warehouseman to').toBeTruthy()
      const floorEmail = `pz-floor-${RUN}@acme.com`
      const createdUser = await admin.post('/api/auth/users', {
        data: {
          email: floorEmail,
          name: 'Integration Warehouseman',
          password: FLOOR_PASSWORD,
          organizationId,
          roles: [roleName],
        },
        failOnStatusCode: false,
      })
      expect(createdUser.status(), await createdUser.text()).toBeLessThan(400)
      await login(floor, floorEmail, FLOOR_PASSWORD)

      // Stock posting ships off (ADR-0005's toggle). Every case below is about what happens
      // when an operator turns it on, so the suite turns it on and puts it back afterwards.
      const toggles = await admin.get(`${TOGGLES_API}?identifier=${STOCK_POSTING_TOGGLE}&pageSize=10`)
      expect(toggles.status(), await toggles.text()).toBe(200)
      const row = ((await toggles.json()) as { items?: Array<{ id: string; identifier: string; defaultValue?: unknown }> }).items?.find(
        (item) => item.identifier === STOCK_POSTING_TOGGLE,
      )
      expect(row, `the ${STOCK_POSTING_TOGGLE} toggle is not registered`).toBeTruthy()
      toggleId = (row as { id: string }).id
      toggleWasEnabled = (row as { defaultValue?: unknown }).defaultValue === true
      const enabled = await admin.put(TOGGLES_API, {
        data: { id: toggleId, defaultValue: true },
        failOnStatusCode: false,
      })
      expect(enabled.status(), await enabled.text()).toBeLessThan(400)
    } catch (error) {
      await admin.dispose()
      await floor.dispose()
      throw error
    }
  })

  test.afterAll(async () => {
    if (toggleId) {
      await admin
        .put(TOGGLES_API, { data: { id: toggleId, defaultValue: toggleWasEnabled }, failOnStatusCode: false })
        .catch(() => undefined)
    }
    await admin?.dispose()
    await floor?.dispose()
  })

  test('offers the floor only the locations goods can actually be put into', async () => {
    const receipt = await releasedReceipt(plainProductId)
    const response = await floor.get(`${DESTINATIONS_API}?goodsReceiptId=${encodeURIComponent(receipt.id)}`)
    expect(response.status(), await response.text()).toBe(200)
    const body = (await response.json()) as { items: Array<{ id: string; code: string }> }
    const ids = body.items.map((item) => item.id)

    expect(ids).toContain(stagingLocationId)
    expect(ids).not.toContain(aisleLocationId)
    expect(ids).not.toContain(otherWarehouseLocationId)
  })

  test('the floor finishes a counted delivery and its goods reach stock once per variant', async () => {
    const receipt = await releasedReceipt(plainProductId)
    // The same product on two pallets: posted per pallet, the wms idempotency key would
    // collapse the second 4 into the first and stock 4 instead of 8 (ADR-0011).
    await countOntoClosedPallet(receipt.id, plainVariantId, '4')
    await countOntoClosedPallet(receipt.id, plainVariantId, '4')

    const current = await read(receipt.id)
    const completed = await floor.post(COMPLETE_API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: { id: receipt.id, destinationLocationId: stagingLocationId },
      failOnStatusCode: false,
    })
    expect(completed.status(), await completed.text()).toBe(200)

    const confirmed = await read(receipt.id)
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.stockPosting.locationId).toBe(stagingLocationId)
    expect(['pending', 'posted']).toContain(confirmed.stockPosting.status)

    // Deterministic trigger: the same command the subscriber dispatches, run in-request.
    const posted = await admin.post(RETRY_API, { data: { id: receipt.id }, failOnStatusCode: false })
    expect([200, 409]).toContain(posted.status())

    const settled = await read(receipt.id)
    expect(settled.stockPosting.status).toBe('posted')
    expect(settled.stockPosting.postedAt).toBeTruthy()

    const movements = (await movementsFor(receipt.id)).filter(
      (movement) => movement.catalog_variant_id === plainVariantId,
    )
    expect(movements).toHaveLength(1)
    expect(Number(movements[0].quantity)).toBe(8)
    expect(movements[0].location_to_id).toBe(stagingLocationId)
  })

  test('a second posting run replays rather than stocking the delivery twice', async () => {
    const receipt = await releasedReceipt(plainProductId)
    await countOntoClosedPallet(receipt.id, plainVariantId, '3')

    const current = await read(receipt.id)
    const completed = await floor.post(COMPLETE_API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: { id: receipt.id, destinationLocationId: stagingLocationId },
      failOnStatusCode: false,
    })
    expect(completed.status(), await completed.text()).toBe(200)

    await admin.post(RETRY_API, { data: { id: receipt.id }, failOnStatusCode: false })
    const afterFirst = await movementsFor(receipt.id)

    // A settled posting refuses rather than running again; the ledger is untouched either way.
    const again = await admin.post(RETRY_API, { data: { id: receipt.id }, failOnStatusCode: false })
    expect([200, 409]).toContain(again.status())
    expect(await movementsFor(receipt.id)).toHaveLength(afterFirst.length)
  })

  test('refuses a destination that is not a location of the document warehouse', async () => {
    const receipt = await releasedReceipt(plainProductId)
    await countOntoClosedPallet(receipt.id, plainVariantId, '1')

    const current = await read(receipt.id)
    const refused = await floor.post(COMPLETE_API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: { id: receipt.id, destinationLocationId: otherWarehouseLocationId },
      failOnStatusCode: false,
    })
    expect(refused.status(), await refused.text()).toBe(409)
    expect((await read(receipt.id)).status).toBe('receiving')
  })

  test('refuses a delivery holding a lot-tracked product, and leaves it countable', async () => {
    const receipt = await releasedReceipt(trackedProductId)
    const variants = await admin.get(`/api/catalog/variants?productId=${encodeURIComponent(trackedProductId)}&pageSize=10`)
    const trackedVariantId = ((await variants.json()) as { items: Array<{ id: string }> }).items[0]?.id
    expect(trackedVariantId, 'the tracked product has no variant').toBeTruthy()
    await countOntoClosedPallet(receipt.id, trackedVariantId as string, '2')

    const current = await read(receipt.id)
    const refused = await floor.post(COMPLETE_API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: { id: receipt.id, destinationLocationId: stagingLocationId },
      failOnStatusCode: false,
    })
    expect(refused.status(), await refused.text()).toBe(409)
    expect(await refused.text()).toMatch(/lot|serial|parti|seryjn/i)

    const unchanged = await read(receipt.id)
    expect(unchanged.status).toBe('receiving')
    expect(unchanged.stockPosting.status).toBe('not_applicable')
    expect(await movementsFor(receipt.id)).toHaveLength(0)
  })

  test('refuses a completion with no destination at all', async () => {
    const receipt = await releasedReceipt(plainProductId)
    await countOntoClosedPallet(receipt.id, plainVariantId, '1')

    const current = await read(receipt.id)
    const refused = await floor.post(COMPLETE_API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: { id: receipt.id },
      failOnStatusCode: false,
    })
    // The warehouse has no Default Destination configured, so there is nothing to fall back on.
    expect(refused.status(), await refused.text()).toBe(409)
    expect((await read(receipt.id)).status).toBe('receiving')
  })

  test('refuses the office confirm endpoint to a caller holding only the floor grant', async () => {
    const receipt = await releasedReceipt(plainProductId)
    await countOntoClosedPallet(receipt.id, plainVariantId, '1')

    const current = await read(receipt.id)
    const refused = await floor.post(CONFIRM_API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: { id: receipt.id, destinationLocationId: stagingLocationId },
      failOnStatusCode: false,
    })
    expect(refused.status(), await refused.text()).toBe(403)

    // The floor's own endpoint accepts exactly the same document.
    const completed = await floor.post(COMPLETE_API, {
      headers: { [LOCK_HEADER]: current.updatedAt ?? '' },
      data: { id: receipt.id, destinationLocationId: stagingLocationId },
      failOnStatusCode: false,
    })
    expect(completed.status(), await completed.text()).toBe(200)
  })

  test('refuses a completion sent with a version the document has moved past', async () => {
    const receipt = await releasedReceipt(plainProductId)
    await countOntoClosedPallet(receipt.id, plainVariantId, '1')

    const refused = await floor.post(COMPLETE_API, {
      headers: { [LOCK_HEADER]: new Date(0).toISOString() },
      data: { id: receipt.id, destinationLocationId: stagingLocationId },
      failOnStatusCode: false,
    })
    expect([409, 412]).toContain(refused.status())
    expect((await read(receipt.id)).status).toBe('receiving')
  })

  test('refuses a completion sent with no version at all', async () => {
    const receipt = await releasedReceipt(plainProductId)
    await countOntoClosedPallet(receipt.id, plainVariantId, '1')

    const refused = await floor.post(COMPLETE_API, {
      data: { id: receipt.id, destinationLocationId: stagingLocationId },
      failOnStatusCode: false,
    })
    expect(refused.status(), await refused.text()).toBe(400)
    expect((await read(receipt.id)).status).toBe('receiving')
  })
})
