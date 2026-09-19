#!/usr/bin/env node
// Generates a printable/on-screen sheet of scannable barcodes for every catalog
// variant that has one, so the backend barcode scanner can be exercised without
// physical stock. Development aid only — never imported by the app.
//
//   node scripts/barcode-test-sheet.mjs [outputPath]
//
// Default output is .barcode-test-sheet.html in the repo root (gitignored).
// Open it on a laptop screen and scan it with a phone, or print it.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = path.resolve(repoRoot, process.argv[2] ?? '.barcode-test-sheet.html')

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  for (const candidate of ['.env.local', '.env']) {
    const file = path.join(repoRoot, candidate)
    if (!fs.existsSync(file)) continue
    const parsed = parseEnv(fs.readFileSync(file, 'utf8'))
    if (parsed.DATABASE_URL) return parsed.DATABASE_URL
  }
  throw new Error('DATABASE_URL not found in environment, .env.local or .env')
}

// EAN-13 is what the seeded fixtures use; anything else falls back to Code 128,
// which accepts arbitrary alphanumeric payloads.
function formatFor(barcode) {
  if (/^\d{13}$/.test(barcode)) return 'EAN13'
  if (/^\d{8}$/.test(barcode)) return 'EAN8'
  if (/^\d{12}$/.test(barcode)) return 'UPCA'
  return 'Code128'
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  )
}

const { default: pg } = await import('pg')
const { writeBarcode } = await import('zxing-wasm/writer')

const client = new pg.Client({ connectionString: resolveDatabaseUrl() })
await client.connect()

const { rows } = await client.query(`
  select v.id, v.product_id, v.name, v.sku, v.barcode, p.title as product_title
  from catalog_product_variants v
  left join catalog_products p on p.id = v.product_id
  where v.deleted_at is null and v.barcode is not null and v.barcode <> ''
  order by p.title nulls last, v.name
`)
await client.end()

if (!rows.length) {
  console.error('No catalog variants with a barcode were found. Seed fixtures first.')
  process.exit(1)
}

const cards = []
for (const row of rows) {
  const format = formatFor(row.barcode)
  const result = await writeBarcode(row.barcode, { format, withHRT: false, scale: 4 })
  if (result.error || !result.svg) {
    console.warn(`Skipped ${row.barcode} (${format}): ${result.error || 'no svg produced'}`)
    continue
  }
  // Strip the XML prolog/doctype so the SVG can be inlined into the HTML body.
  const inlineSvg = result.svg.replace(/^[\s\S]*?(?=<svg)/, '')
  cards.push(`
    <article class="card">
      <div class="barcode">${inlineSvg}</div>
      <p class="code">${escapeHtml(row.barcode)}</p>
      <p class="name">${escapeHtml(row.product_title ? `${row.product_title} — ${row.name}` : row.name)}</p>
      <p class="meta">SKU ${escapeHtml(row.sku)} · ${escapeHtml(format)}</p>
      <p class="meta target">expects /backend/catalog/products/${escapeHtml(row.product_id)}/variants/${escapeHtml(row.id)}</p>
    </article>`)
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Barcode scanner test sheet</title>
<style>
  :root { color-scheme: light; --fg: #111; --muted: #666; --line: #e5e5e5; }
  body { margin: 0; padding: 32px; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--fg); background: #fff; }
  header { max-width: 60rem; margin: 0 auto 32px; }
  h1 { margin: 0 0 8px; font-size: 1.5rem; }
  header p { margin: 0 0 4px; color: var(--muted); }
  .grid { max-width: 60rem; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 24px; }
  .card { border: 1px solid var(--line); border-radius: 12px; padding: 20px; text-align: center; background: #fff; break-inside: avoid; }
  .barcode svg { max-width: 100%; height: auto; }
  .code { margin: 12px 0 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.1rem; letter-spacing: 0.06em; }
  .name { margin: 0 0 4px; font-weight: 600; }
  .meta { margin: 0; font-size: 0.8rem; color: var(--muted); }
  .target { margin-top: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.7rem; word-break: break-all; }
  @media print { body { padding: 12px; } .card { border-color: #999; } .target { display: none; } }
</style>
</head>
<body>
<header>
  <h1>Barcode scanner test sheet</h1>
  <p>${cards.length} catalog variant${cards.length === 1 ? '' : 's'} with a barcode. Open this on a screen and scan it with a phone, or print it.</p>
  <p>Scanning any code below should land on that variant's edit form in the admin panel.</p>
  <p>Generated ${new Date().toISOString()}</p>
</header>
<div class="grid">${cards.join('\n')}</div>
</body>
</html>
`

fs.writeFileSync(outputPath, html, 'utf8')
console.log(`Wrote ${cards.length} barcode(s) to ${outputPath}`)
