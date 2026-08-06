/**
 * Draws the app icon and writes build/icon.png at 1024².
 *
 *   ./node_modules/.bin/electron scripts/make-icon.cjs
 *
 * Rendering happens in an offscreen Chromium window, so the only dependency is
 * the Electron already in node_modules. build-app.sh turns the PNG into an
 * .icns with the sips/iconutil pair that ships with macOS.
 *
 * CommonJS on purpose: an ESM main entry that awaits anything before
 * app.whenReady() can have Electron quit out from under it, which shows up as
 * a silent SIGTERM with no output at all.
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SIZE = 1024

const PAGE = `<!doctype html><meta charset="utf-8">
<body style="margin:0"><canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script>
const S = ${SIZE}
const ctx = document.getElementById('c').getContext('2d')
const u = (v) => v * S

/* macOS icons are superellipses, not rounded rectangles: the curvature is
   continuous, which is why a plain border-radius always looks subtly wrong
   beside a system icon. n = 5 matches the platform shape closely. */
function squircle (inset) {
  const r = S / 2 - u(inset)
  const c0 = S / 2
  const n = 5
  ctx.beginPath()
  for (let i = 0; i <= 720; i++) {
    const t = (i / 720) * Math.PI * 2
    const c = Math.cos(t)
    const s = Math.sin(t)
    ctx.lineTo(
      c0 + Math.sign(c) * Math.abs(c) ** (2 / n) * r,
      c0 + Math.sign(s) * Math.abs(s) ** (2 / n) * r
    )
  }
  ctx.closePath()
}

/* The rounded square is inset rather than full-bleed: macOS reserves that
   margin for its own shadow, and an icon drawn to the edge sits visibly
   larger than everything beside it in the Dock. */
const INSET = 0.098

squircle(INSET)
ctx.save()
ctx.clip()
const paper = ctx.createLinearGradient(0, 0, 0, S)
paper.addColorStop(0, '#FDFCFA')
paper.addColorStop(1, '#EFE8DE')
ctx.fillStyle = paper
ctx.fillRect(0, 0, S, S)

// Stem and leaf first, so the flower sits over them.
ctx.strokeStyle = '#4F6B4B'
ctx.lineWidth = u(0.026)
ctx.lineCap = 'round'
ctx.beginPath()
ctx.moveTo(u(0.5), u(0.56))
ctx.quadraticCurveTo(u(0.508), u(0.68), u(0.5), u(0.80))
ctx.stroke()

ctx.fillStyle = '#4F6B4B'
ctx.beginPath()
ctx.moveTo(u(0.503), u(0.735))
ctx.bezierCurveTo(u(0.42), u(0.735), u(0.35), u(0.685), u(0.325), u(0.60))
ctx.bezierCurveTo(u(0.425), u(0.612), u(0.487), u(0.66), u(0.503), u(0.735))
ctx.fill()

/* One closed outline for the whole flower: a narrow cup, three lobes, two
   notches between them. Drawing it as separate petals is what made the first
   attempt read as a poppy — the lobes have to grow out of the cup's silhouette,
   not sit on top of it. */
ctx.fillStyle = '#8E2F4C'
ctx.beginPath()
ctx.moveTo(u(0.5), u(0.585))
ctx.bezierCurveTo(u(0.615), u(0.585), u(0.665), u(0.500), u(0.665), u(0.390))
ctx.bezierCurveTo(u(0.665), u(0.325), u(0.655), u(0.290), u(0.645), u(0.265))
ctx.bezierCurveTo(u(0.620), u(0.300), u(0.590), u(0.325), u(0.558), u(0.335))
ctx.bezierCurveTo(u(0.545), u(0.300), u(0.530), u(0.270), u(0.500), u(0.238))
ctx.bezierCurveTo(u(0.470), u(0.270), u(0.455), u(0.300), u(0.442), u(0.335))
ctx.bezierCurveTo(u(0.410), u(0.325), u(0.380), u(0.300), u(0.355), u(0.265))
ctx.bezierCurveTo(u(0.345), u(0.290), u(0.335), u(0.325), u(0.335), u(0.390))
ctx.bezierCurveTo(u(0.335), u(0.500), u(0.385), u(0.585), u(0.500), u(0.585))
ctx.closePath()
ctx.fill()

// The front petal, a shade brighter. The only modelling in the mark, and
// enough to keep three petals legible at 32px.
ctx.fillStyle = '#A63A5A'
ctx.beginPath()
ctx.moveTo(u(0.5), u(0.245))
ctx.bezierCurveTo(u(0.545), u(0.330), u(0.552), u(0.460), u(0.500), u(0.585))
ctx.bezierCurveTo(u(0.448), u(0.460), u(0.455), u(0.330), u(0.500), u(0.245))
ctx.closePath()
ctx.fill()

ctx.restore()

// A hairline edge keeps the icon from dissolving into a light dock.
squircle(INSET)
ctx.strokeStyle = '#0000001A'
ctx.lineWidth = u(0.0035)
ctx.stroke()

window.__png = document.getElementById('c').toDataURL('image/png')

/* Windows wants an .ico, which is a container of several fixed sizes rather
   than one image scaled at display time — Explorer, the taskbar and Alt-Tab
   each pick a different entry. Chromium's own downscaler does the resampling
   here, so the small sizes stay legible instead of turning to mush. */
window.__icons = {}
for (const n of [16, 24, 32, 48, 64, 128, 256]) {
  const small = document.createElement('canvas')
  small.width = small.height = n
  const g = small.getContext('2d')
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(document.getElementById('c'), 0, 0, n, n)
  window.__icons[n] = small.toDataURL('image/png')
}
</script></body>`


/**
 * Pack PNGs into an .ico. Since Vista an icon directory entry may hold a PNG
 * verbatim instead of a BMP, which is the whole of the format below: a 6-byte
 * header, one 16-byte entry per size, then the PNG bytes.
 *
 * Sizes are written as a single byte, and 256 does not fit in one — the format
 * spells it 0, which is why the entry below reads `size & 0xFF` rather than
 * rejecting it.
 */
function packIco (icons) {
  const images = Object.keys(icons)
    .map(Number)
    .sort((a, b) => a - b)
    .map((size) => ({ size, data: Buffer.from(icons[size].split(',')[1], 'base64') }))

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)              // reserved
  header.writeUInt16LE(1, 2)              // 1 = icon (2 would be a cursor)
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  // The first image starts after the header and the whole directory.
  let offset = header.length + directory.length
  images.forEach(({ size, data }, i) => {
    const at = i * 16
    directory.writeUInt8(size & 0xFF, at)      // width  (0 means 256)
    directory.writeUInt8(size & 0xFF, at + 1)  // height
    directory.writeUInt8(0, at + 2)            // palette size: none
    directory.writeUInt8(0, at + 3)            // reserved
    directory.writeUInt16LE(1, at + 4)         // colour planes
    directory.writeUInt16LE(32, at + 6)        // bits per pixel
    directory.writeUInt32LE(data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += data.length
  })

  return Buffer.concat([header, directory, ...images.map((image) => image.data)])
}

app.whenReady().then(async () => {
  /* Loaded from a file rather than a data: URL — Chromium restricts scripts in
     a top-level data: navigation, and the failure is a silent hang. */
  const build = path.join(ROOT, 'build')
  mkdirSync(build, { recursive: true })
  const page = path.join(build, 'icon.html')
  writeFileSync(page, PAGE)

  const win = new BrowserWindow({ show: false, width: SIZE, height: SIZE })

  try {
    await win.loadFile(page)
    const dataUrl = await win.webContents.executeJavaScript('window.__png')
    const out = path.join(build, 'icon.png')
    writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'))
    console.log('wrote', out)

    const icons = await win.webContents.executeJavaScript('window.__icons')
    const ico = path.join(build, 'icon.ico')
    writeFileSync(ico, packIco(icons))
    console.log('wrote', ico)
  } catch (err) {
    console.error('icon render failed:', err)
    process.exitCode = 1
  }

  app.quit()
})
