/*
 * Service worker for the warehouseman panel.
 *
 * It sits at the site root because a worker cannot claim a scope above its own
 * directory, and the scope it has to claim is `/warehouseman`. The registration
 * (see `components/PanelServiceWorker.tsx`) narrows it there, so nothing outside
 * the panel is ever controlled by this file.
 *
 * The policy is mostly a list of refusals, and one of them is a security rule
 * rather than a performance trade-off:
 *
 *   Navigation responses are NEVER written to the cache. Every panel screen is
 *   server-rendered with the signed-in warehouseman's name and warehouse in the
 *   top bar. The panel runs on shared tablets, so a cached page is a page the
 *   next person to pick the tablet up would be shown under their own session.
 *   An offline screen is the correct answer there; somebody else's identity is
 *   not.
 *
 *   `/api/*` is never cached either. Writes are online-only by design, and a
 *   stale pallet count served to somebody counting a pallet is worse than an
 *   error they can see.
 *
 * What is cached is the part that is identical for everyone: the build's static
 * assets, the app icons, the offline screen, and the barcode reader's WASM
 * binary — 1 MB that otherwise gets re-fetched over dock-door Wi-Fi.
 */

const CACHE_VERSION = 'v1'
const CACHE_NAME = 'warehouseman-pwa-' + CACHE_VERSION

const OFFLINE_PAGE_URL = '/pwa/warehouseman/offline.html'

/** Fetched during install, so they are present the first time the network is not. */
const PRECACHE_URLS = [
  OFFLINE_PAGE_URL,
  '/pwa/warehouseman/icon-192.png',
  '/pwa/warehouseman/icon-512.png',
  '/pwa/warehouseman/icon-maskable-512.png',
  '/pwa/warehouseman/apple-touch-icon.png',
  // The barcode reader binary. Self-hosted (see barcode_scanner/README.md) and the
  // slowest thing the counting screen waits for on a weak connection.
  '/zxing/zxing_reader.wasm',
]

/**
 * What the worker does with a request. Split out from the event handler so the
 * policy can be asserted directly in tests rather than inferred from behaviour.
 *
 * Returns one of:
 *   'passthrough'  — the worker does not answer; the browser goes to the network.
 *   'navigate'     — try the network, fall back to the offline screen. Never cached.
 *   'cache-first'  — serve from cache, populate it on a miss.
 */
function classifyRequest(request, scopeOrigin) {
  if (request.method !== 'GET') return 'passthrough'

  var url
  try {
    url = new URL(request.url)
  } catch (err) {
    return 'passthrough'
  }
  if (url.origin !== scopeOrigin) return 'passthrough'

  // Checked before anything else: an HTML document must not fall through into a
  // caching branch no matter what its path looks like.
  if (request.mode === 'navigate') return 'navigate'

  if (url.pathname.indexOf('/api/') === 0) return 'passthrough'

  if (isImmutableAsset(url.pathname)) return 'cache-first'

  return 'passthrough'
}

/**
 * Assets whose URL changes whenever their content does, so a stale hit is
 * impossible rather than merely unlikely. Next fingerprints everything under
 * `/_next/static/`; the precached files are versioned by the cache name.
 */
function isImmutableAsset(pathname) {
  if (pathname.indexOf('/_next/static/') === 0) return true
  return PRECACHE_URLS.indexOf(pathname) !== -1
}

function isCacheableResponse(response) {
  return !!response && response.status === 200 && response.type !== 'opaque'
}

async function handleNavigate(request) {
  try {
    return await fetch(request)
  } catch (err) {
    // Reached only when the network is genuinely unavailable — a server that
    // answers 500 answers, and the panel's own error states handle that.
    const cache = await caches.open(CACHE_NAME)
    const offline = await cache.match(OFFLINE_PAGE_URL)
    if (offline) return offline
    return Response.error()
  }
}

async function handleCacheFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (isCacheableResponse(response)) {
    // `clone()` because the body can only be consumed once and the caller needs it.
    cache.put(request, response.clone())
  }
  return response
}

self.addEventListener('install', (event) => {
  // No `skipWaiting()`. A new worker takes over on the next cold start instead of
  // swapping assets underneath a warehouseman who is halfway through counting a
  // pallet. The panel is relaunched often enough that this is not a slow rollout.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((name) => name.indexOf('warehouseman-pwa-') === 0 && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const decision = classifyRequest(event.request, self.location.origin)
  if (decision === 'navigate') {
    event.respondWith(handleNavigate(event.request))
    return
  }
  if (decision === 'cache-first') {
    event.respondWith(handleCacheFirst(event.request))
  }
  // 'passthrough' deliberately calls nothing: the browser handles the request as
  // if no worker existed, which is the cheapest and least surprising behaviour.
})
