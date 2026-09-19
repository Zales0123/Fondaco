import { describe, expect, it, jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { OFFLINE_PAGE_URL, SERVICE_WORKER_URL } from '../lib/pwa'

/**
 * Exercises the worker that actually ships.
 *
 * The file is plain JavaScript served from `public/`, so it cannot import from `src/`
 * and a TypeScript copy of its policy would be a copy — green while the shipped file
 * drifted. Instead the real file is evaluated in a stubbed worker global, which is the
 * only way these assertions can be about the bytes the browser runs.
 *
 * The assertion this suite exists for is the first one: a navigation response must
 * never reach a cache. Every panel screen is rendered with the signed-in warehouseman's
 * name and warehouse in it, and the panel runs on tablets that are handed between
 * shifts.
 */

const SW_PATH = join(__dirname, '..', '..', '..', '..', 'public', SERVICE_WORKER_URL.replace(/^\//, ''))

type Listener = (event: unknown) => void

type FakeCache = {
  addAll: jest.Mock
  match: jest.Mock
  put: jest.Mock
}

type LoadedWorker = {
  listeners: Map<string, Listener>
  cache: FakeCache
  fetchMock: jest.Mock
  skipWaiting: jest.Mock
  deletedCaches: string[]
}

function loadWorker(options: { cacheContents?: Record<string, unknown>; cacheNames?: string[] } = {}): LoadedWorker {
  const contents = options.cacheContents ?? {}
  const listeners = new Map<string, Listener>()
  const deletedCaches: string[] = []

  const cache: FakeCache = {
    addAll: jest.fn(async () => undefined),
    match: jest.fn(async (key: unknown) => {
      const url = typeof key === 'string' ? key : (key as { url: string }).url
      const pathname = url.startsWith('http') ? new URL(url).pathname : url
      return contents[pathname] ?? undefined
    }),
    put: jest.fn(async () => undefined),
  }

  const fetchMock = jest.fn(async () => ({ status: 200, type: 'basic', clone: () => ({ body: 'clone' }) }))
  const skipWaiting = jest.fn()

  const sandbox = {
    self: {
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
      location: { origin: 'https://fondaco.test' },
      clients: { claim: jest.fn(async () => undefined) },
      skipWaiting,
    },
    caches: {
      open: jest.fn(async () => cache),
      keys: jest.fn(async () => options.cacheNames ?? []),
      delete: jest.fn(async (name: string) => {
        deletedCaches.push(name)
        return true
      }),
    },
    fetch: fetchMock,
    Response: { error: () => ({ status: 0, type: 'error' }) },
    URL,
    Promise,
    console,
  }

  const context = createContext(sandbox)
  runInContext(readFileSync(SW_PATH, 'utf8'), context, { filename: SW_PATH })
  return { listeners, cache, fetchMock, skipWaiting, deletedCaches }
}

/** Drives the `fetch` listener and reports what the worker decided to do. */
async function dispatchFetch(
  worker: LoadedWorker,
  request: { url: string; method?: string; mode?: string },
): Promise<{ answered: boolean; response?: unknown }> {
  let responded: Promise<unknown> | undefined
  const event = {
    request: { method: 'GET', mode: 'no-cors', ...request },
    respondWith: (value: Promise<unknown>) => {
      responded = value
    },
  }
  worker.listeners.get('fetch')!(event)
  if (!responded) return { answered: false }
  return { answered: true, response: await responded }
}

describe('warehouseman service worker', () => {
  it('never writes a navigation response to the cache', async () => {
    const worker = loadWorker()

    await dispatchFetch(worker, { url: 'https://fondaco.test/warehouseman', mode: 'navigate' })
    await dispatchFetch(worker, {
      url: 'https://fondaco.test/warehouseman/receiving/abc/pallets/def',
      mode: 'navigate',
    })

    expect(worker.cache.put).not.toHaveBeenCalled()
  })

  it('never answers a navigation from the cache while the network is reachable', async () => {
    const worker = loadWorker({
      // A page a previous shift's session could have left behind.
      cacheContents: { '/warehouseman': { body: 'stale page for another warehouseman' } },
    })

    const { response } = await dispatchFetch(worker, {
      url: 'https://fondaco.test/warehouseman',
      mode: 'navigate',
    })

    expect(worker.fetchMock).toHaveBeenCalledTimes(1)
    expect(response).toEqual(expect.objectContaining({ status: 200 }))
  })

  it('falls back to the offline screen when a navigation cannot reach the server', async () => {
    const offline = { body: 'offline screen' }
    const worker = loadWorker({ cacheContents: { [OFFLINE_PAGE_URL]: offline } })
    // What a browser with no network actually does: the fetch promise rejects.
    worker.fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch')
    })

    const { response } = await dispatchFetch(worker, {
      url: 'https://fondaco.test/warehouseman/receiving',
      mode: 'navigate',
    })

    expect(response).toBe(offline)
  })

  it('leaves API requests to the browser, cached or not', async () => {
    const worker = loadWorker({
      cacheContents: { '/api/pz/pallet-lines': { body: 'a count from ten minutes ago' } },
    })

    const get = await dispatchFetch(worker, { url: 'https://fondaco.test/api/pz/pallet-lines?palletId=1' })
    const post = await dispatchFetch(worker, {
      url: 'https://fondaco.test/api/pz/pallet-lines',
      method: 'POST',
    })

    expect(get.answered).toBe(false)
    expect(post.answered).toBe(false)
    expect(worker.cache.put).not.toHaveBeenCalled()
  })

  it('serves fingerprinted build assets from the cache', async () => {
    const chunk = { body: 'chunk' }
    const worker = loadWorker({ cacheContents: { '/_next/static/chunks/main-abc123.js': chunk } })

    const { response } = await dispatchFetch(worker, {
      url: 'https://fondaco.test/_next/static/chunks/main-abc123.js',
    })

    expect(response).toBe(chunk)
    expect(worker.fetchMock).not.toHaveBeenCalled()
  })

  it('populates the cache on a miss for a fingerprinted asset', async () => {
    const worker = loadWorker()

    await dispatchFetch(worker, { url: 'https://fondaco.test/_next/static/chunks/main-abc123.js' })

    expect(worker.fetchMock).toHaveBeenCalledTimes(1)
    expect(worker.cache.put).toHaveBeenCalledTimes(1)
  })

  it('ignores other origins entirely', async () => {
    const worker = loadWorker()

    const result = await dispatchFetch(worker, { url: 'https://cdn.example.com/_next/static/x.js' })

    expect(result.answered).toBe(false)
  })

  it('precaches the offline screen, the icons and the barcode reader binary', async () => {
    const worker = loadWorker()

    const event = { waitUntil: (value: Promise<unknown>) => value }
    await worker.listeners.get('install')!(event)

    const precached = worker.cache.addAll.mock.calls[0][0] as string[]
    expect(precached).toContain(OFFLINE_PAGE_URL)
    expect(precached).toContain('/zxing/zxing_reader.wasm')
    expect(precached).toEqual(expect.arrayContaining([expect.stringContaining('icon-192.png')]))
  })

  it('does not take over from a running worker on install', async () => {
    // `skipWaiting()` would swap assets under a warehouseman mid-count; the worker
    // is meant to wait for the next cold start instead.
    const worker = loadWorker()

    await worker.listeners.get('install')!({ waitUntil: (value: Promise<unknown>) => value })

    expect(worker.skipWaiting).not.toHaveBeenCalled()
  })

  it('drops its own stale caches on activate and leaves other apps alone', async () => {
    const worker = loadWorker({
      cacheNames: ['warehouseman-pwa-v0', 'warehouseman-pwa-v1', 'some-other-app-cache'],
    })

    const pending: Promise<unknown>[] = []
    await worker.listeners.get('activate')!({ waitUntil: (value: Promise<unknown>) => pending.push(value) })
    await Promise.all(pending)

    expect(worker.deletedCaches).toEqual(['warehouseman-pwa-v0'])
  })
})
