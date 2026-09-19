# barcode_scanner

Camera barcode scanning for the admin panel. Adds **Catalog → Scan barcode**
(`/backend/catalog/scan`): scan a product barcode, land on the edit form of the
product that owns it.

A barcode identifies a *variant*, so the lookup matches variants — but the
destination is that variant's **product**.

## How it works

1. `BarcodeScannerDialog` opens the rear camera via `getUserMedia` and polls a
   `BarcodeDetector` every 100 ms.
2. The decoded value is looked up through the installed
   `GET /api/catalog/variants?search=<code>`, which already filters
   case-insensitively across `name` / `sku` / `barcode` and is already scoped to
   the caller's tenant and organization. **This module owns no API route and no
   entity** — it adds a page and a component, nothing else.
3. Match resolution: a single exact `barcode` hit, else a single exact `sku`
   hit, else a single result overall. If several variants match but they all
   belong to the **same** product, that is not ambiguous — the destination is
   the product, so it navigates anyway. Only candidates spanning different
   products render a chooser; no match renders an empty state.
4. On a match the page navigates to `/backend/catalog/products/<productId>`.
   A variant with no `product_id` cannot be opened and surfaces an error
   instead of navigating.

The page requires `catalog.products.view`, matching what the API enforces.

## Two modes: one-shot and continuous

`BarcodeScannerDialog` defaults to **one-shot**: the first successful decode
stops the camera, shows "Barcode captured", fires `onDetected` and offers
"Scan again". That is right for scanning *one* thing — a product barcode, a
pallet label — because the next step is navigating somewhere.

`continuous` flips it for callers that **count**. The camera stays on, the poll
loop keeps running, and `onDetected` fires once per accepted scan. Nothing about
the one-shot path changes; every new prop is optional and defaults to today's
behaviour.

| Prop | Default | Effect |
|---|---|---|
| `continuous` | `false` | Keeps scanning; adds a full-width **Done** button, because the dialog no longer closes itself. |
| `log` | `undefined` | Running history, **newest entry first** — the natural shape of `[entry, ...previous]`. The first five render under the video in that order, each with a check/cross icon so the outcome never rests on colour alone. |
| `interruption` | `undefined` | A step that must be answered before scanning continues. Takes over the dialog body and **suspends acceptance entirely**. |

### `interruption`: the caller needs an answer before the next scan

Some callers cannot act on a code alone. Counting a delivery is the example:
the code names *which* product, but not *how many*, and one scan should be able
to mean a carton of twenty-four rather than one box presented twenty-four times.

So the caller renders its own question — `warehouseman`'s is
`components/ScanQuantityStep.tsx` — and hands it over as a node. The dialog
knows nothing about what is being asked. It owns exactly one rule: **while an
interruption is up, nothing is scanned.** Concretely that means the poll loop
returns before reading the frame, the manual-entry field is hidden and its
Cmd/Ctrl+Enter is refused, and the Done button is out of reach.

Two details are load-bearing:

- **The `<video>` element is hidden, never unmounted.** It holds the live
  `MediaStream`. Dropping it would stop the camera and make every counted item
  pay a fresh `getUserMedia` start — one to two seconds, per carton. This is
  also why the step is not a second stacked dialog.
- **The repeat-rule state is frozen**, not advanced — neither a decode nor an
  empty frame is observed, exactly as while `busy`. See the ADR note below.

### When does the same barcode count twice?

> Under `interruption`, "after the step closes *and* the code has since left the
> frame". The freeze is what makes that true: a carton still in front of the lens
> when the step closes is the one just counted, not a new one, and lowering the
> device to tap `+10` must not be read as it leaving. See `docs/adr/0011` and
> `docs/adr/0012`.

Counting a pallet means scanning **twenty identical cartons in a row**, and
every one of them has to count — so "ignore the same code for N milliseconds"
would silently swallow most of a delivery. `lib/scanStream.ts` implements the
rule that replaces it, as a pure state machine (see
`docs/adr/0011-a-repeated-scan-counts-again-only-after-the-code-leaves-the-frame.md`):

- a **different** value than the last accepted one counts immediately;
- the **same** value counts again only once `EMPTY_TICKS_TO_CLEAR` (3) poll
  ticks *in a row* have decoded nothing — the code physically left the frame,
  as opposed to one blurred look at a label still sitting there — **and**
  `SCAN_REPEAT_COOLDOWN_MS` (900 ms) has passed since the last acceptance. Any
  decode resets the run of empty ticks.

Acceptance is suspended entirely while the caller reports `busy`, so a slow
round trip cannot queue ten counts off one carton held in front of the lens.

### Feedback

The operator looks at the pallet, not at the screen, so each accepted scan gets
a 250 ms success ring on the video plus `lib/scanFeedback.ts` — an ~880 Hz,
60 ms WebAudio blip and a 40 ms `navigator.vibrate`. Both channels are
best-effort and independently guarded: a laptop with no vibration motor, a
browser that blocks audio, or a device with neither still counts cartons, and
`playScanFeedback()` never throws. The audio context is created lazily and
reused, because browsers cap how many a page may hold.

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
