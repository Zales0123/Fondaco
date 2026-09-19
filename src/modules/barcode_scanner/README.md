# barcode_scanner

Camera barcode scanning for the admin panel. Adds **Catalog → Scan barcode**
(`/backend/catalog/scan`): scan a product barcode, land on the matching
variant's edit form.

## How it works

1. `BarcodeScannerDialog` opens the rear camera via `getUserMedia` and polls a
   `BarcodeDetector` every 100 ms.
2. The decoded value is looked up through the installed
   `GET /api/catalog/variants?search=<code>`, which already filters
   case-insensitively across `name` / `sku` / `barcode` and is already scoped to
   the caller's tenant and organization. **This module owns no API route and no
   entity** — it adds a page and a component, nothing else.
3. Match resolution: a single exact `barcode` hit, else a single exact `sku`
   hit, else a single result overall. Several candidates render a chooser; none
   renders an empty state. On a match the page navigates to
   `/backend/catalog/products/<productId>/variants/<variantId>`.

The page requires `catalog.products.view`, matching what the API enforces.

## Detector: native first, WASM fallback

`globalThis.BarcodeDetector` is used when present (Chrome/Edge on Android and
ChromeOS — hardware-accelerated). **Safari and Firefox do not implement it**, so
everywhere else falls back to the `barcode-detector` ponyfill, which runs
ZXing-C++ compiled to WebAssembly. On iOS and macOS Safari the WASM path is the
only path.

### The WASM binary is vendored — keep it in sync

`public/zxing/zxing_reader.wasm` is a copy of
`node_modules/zxing-wasm/dist/reader/zxing_reader.wasm`, served from our own
origin. The library would otherwise fetch it from the jsDelivr CDN at runtime,
which breaks under a strict CSP and offline.

> **When bumping `barcode-detector` (or its `zxing-wasm` dependency), re-copy the
> binary**, or the JS glue and the WASM module will disagree:
>
> ```bash
> cp node_modules/zxing-wasm/dist/reader/zxing_reader.wasm public/zxing/zxing_reader.wasm
> ```

## Camera requires a secure context

`getUserMedia` only runs on HTTPS or `localhost`. A phone opening
`http://<LAN-IP>:3000` will never get a camera — the dialog detects this and
says so explicitly instead of failing silently. Every failure mode (insecure
context, unsupported browser, permission denied, no camera) has its own message,
and manual keyboard entry is always available as a fallback.

Torch/flashlight is offered only when the active video track reports the
capability (Chromium on Android); iOS does not expose it.

## Testing without physical stock

`node scripts/barcode-test-sheet.mjs` renders every catalog variant that has a
barcode into `.barcode-test-sheet.html` (gitignored). Open it on a screen and
scan it with a phone, or print it.
