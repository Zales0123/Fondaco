/**
 * Draws the warehouseman panel's home-screen icons into `public/pwa/warehouseman/`.
 *
 *   node scripts/generate-warehouseman-icons.mjs
 *
 * The mark is drawn from rectangles rather than set in a typeface on purpose: the
 * script then depends on no font being installed and produces the same bytes on any
 * machine, which is what makes checking the PNGs into git honest.
 *
 * Near-black on white, because the judge of an app icon here is a tablet held at
 * arm's length under a dock-door skylight, and hue is the first thing daylight takes.
 * The colours are `--foreground`/`--background` from `globals.css`.
 */
import { createCanvas } from '@napi-rs/canvas'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'pwa', 'warehouseman')

const INK = '#ffffff'
const FIELD = '#1a1a1a'

/** A maskable icon may be cropped to a circle 80% of its width; an inscribed square is
 *  0.8/√2 ≈ 0.566 wide, so the mark stays comfortably inside that. */
const MASKABLE_MARK_SCALE = 0.5
/** Nothing crops these, so the mark can breathe closer to the edge. */
const PLAIN_MARK_SCALE = 0.62

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

/**
 * The Fondaco F, as three bars. Proportions are deliberately heavy — a hairline stem
 * disappears at the 48px the launcher actually renders.
 */
function drawMark(ctx, centerX, centerY, height) {
  const width = height * 0.82
  const left = centerX - width / 2
  const top = centerY - height / 2
  const stem = width * 0.3
  const topArm = height * 0.235
  const midArm = height * 0.195
  const midTop = top + height * 0.41
  const corner = stem * 0.16

  ctx.fillStyle = INK
  roundedRectPath(ctx, left, top, stem, height, corner)
  ctx.fill()
  roundedRectPath(ctx, left, top, width, topArm, corner)
  ctx.fill()
  roundedRectPath(ctx, left, midTop, width * 0.72, midArm, corner)
  ctx.fill()
}

function render({ size, markScale, cornerRadius }) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = FIELD
  if (cornerRadius > 0) {
    roundedRectPath(ctx, 0, 0, size, size, cornerRadius)
    ctx.fill()
  } else {
    // Full bleed: the platform applies its own mask (Android) or rounding (iOS), and
    // a corner we rounded ourselves would show as a light notch inside theirs.
    ctx.fillRect(0, 0, size, size)
  }

  drawMark(ctx, size / 2, size / 2, size * markScale)
  return canvas.toBuffer('image/png')
}

const ICONS = [
  { file: 'icon-192.png', size: 192, markScale: PLAIN_MARK_SCALE, cornerRadius: 192 * 0.22 },
  { file: 'icon-512.png', size: 512, markScale: PLAIN_MARK_SCALE, cornerRadius: 512 * 0.22 },
  { file: 'icon-maskable-512.png', size: 512, markScale: MASKABLE_MARK_SCALE, cornerRadius: 0 },
  // iOS rounds the corners itself and refuses transparency, so this one is square.
  { file: 'apple-touch-icon.png', size: 180, markScale: PLAIN_MARK_SCALE, cornerRadius: 0 },
]

await mkdir(OUT_DIR, { recursive: true })
for (const icon of ICONS) {
  await writeFile(join(OUT_DIR, icon.file), render(icon))
  console.log(`wrote ${icon.file} (${icon.size}px)`)
}
