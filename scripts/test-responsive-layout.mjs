/* Render the real shell CSS in Chromium at the zoom levels where a desktop
 * window becomes a narrow CSS viewport. Source assertions catch a removed
 * selector; these geometry checks catch a selector that still exists but no
 * longer produces a usable layout. */

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import electron from 'electron'

const cache = path.resolve('node_modules/.cache')
await mkdir(cache, { recursive: true })
const css = pathToFileURL(path.resolve('src/styles.css')).href
const browserRect = `(node) => {
  const r = node.getBoundingClientRect()
  return { left: r.left, right: r.right, width: r.width }
}`

await writeFile(path.join(cache, 'responsive-layout.html'), `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href=${JSON.stringify(css)}>
<div class="app" id="app" data-sidebar="closed" data-side="closed" data-ai="open">
  <aside class="sidebar" id="sidebar"></aside>
  <main class="main"><div class="doc-head"><button class="sidebar-open">Files</button></div></main>
  <aside class="sidepane"></aside>
  <aside class="ai" id="ai"><div class="ai-head">Copilot</div><div class="ai-log"></div></aside>
  <div class="grip grip-ai"></div>
</div>
<button class="drawer-scrim"></button>
<section class="settings">
  <div class="settings-box">
    <nav class="settings-rail"><div class="settings-rail-head">Options</div><button class="settings-tab">Copilot</button><button class="settings-tab">Appearance</button></nav>
    <div class="settings-pane"><header class="settings-head"><h2 class="settings-heading">Copilot</h2></header><div class="settings-body">
      <div class="settings-row is-stacked" id="model-row"><div class="settings-label"><div class="settings-name">Default model for new conversations</div></div><div class="settings-control"><div class="model-default"><button class="dd">Claude Sonnet Extended Thinking</button></div></div></div>
    </div></div>
  </div>
</section>
<div class="overlay"><section class="panel is-search" id="panel">
  <div class="panel-head"><span class="panel-icon"></span><input class="panel-input" placeholder="Search notes, PDFs, and highlights"><button class="panel-filter-toggle">Filters</button><div class="panel-chips"><button class="panel-chip">Aa</button><button class="panel-chip">Word</button><button class="panel-chip">.*</button><button class="panel-chip is-wide">Replace</button><button class="panel-chip is-wide">Save</button></div></div>
  <div class="panel-filter-presets"><button>Notes</button><button>PDFs</button><button>Highlights</button><button>Tag</button></div><div class="panel-list"></div>
</section></div>`)

await writeFile(path.join(cache, 'responsive-layout-main.mjs'), `
import electron from 'electron'
const { app, BrowserWindow } = electron
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 800, show: false, webPreferences: { backgroundThrottling: false } })
  try {
    await win.loadFile(${JSON.stringify(path.join(cache, 'responsive-layout.html'))})
    const result = []
    for (const zoom of [1.5, 1.75, 2]) {
      win.webContents.setZoomFactor(zoom)
      /* Zoom settles asynchronously: the viewport can report its new width
         while the layout still holds the old one. A fixed 80ms was enough on a
         developer machine and not always on a loaded CI runner, which is how
         the 1.5x width check failed there. Wait for the width to stop moving. */
      let last = -1
      for (let stable = 0; stable < 4;) {
        await new Promise((resolve) => setTimeout(resolve, 40))
        const width = await win.webContents.executeJavaScript('innerWidth')
        if (width === last) stable++
        else { stable = 0; last = width }
      }
      await win.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      result.push(await win.webContents.executeJavaScript(\`(() => {
        const app = document.getElementById('app')
        const opener = document.querySelector('.sidebar-open')
        const rail = document.querySelector('.settings-rail')
        const row = document.getElementById('model-row')
        const input = document.querySelector('.panel-input')
        const filters = document.querySelector('.panel-filter-toggle')
        const chips = document.querySelector('.panel-chips')
        const before = getComputedStyle(opener).display
        app.dataset.sidebar = 'open'
        const after = getComputedStyle(opener).display
        app.dataset.sidebar = 'closed'
        return {
          zoom: ${'${zoom}'}, innerWidth,
          main: (${browserRect})(document.querySelector('.main')),
          ai: (${browserRect})(document.getElementById('ai')),
          aiPosition: getComputedStyle(document.getElementById('ai')).position,
          openerBefore: before, openerAfter: after,
          railDirection: getComputedStyle(rail).flexDirection,
          rowDirection: getComputedStyle(row).flexDirection,
          labelWidth: (${browserRect})(row.querySelector('.settings-label')).width,
          filterDisplay: getComputedStyle(filters).display,
          chipDisplay: getComputedStyle(chips).display,
          inputWidth: (${browserRect})(input).width,
          overflow: document.documentElement.scrollWidth - innerWidth
        }
      })()\`))
    }
    console.log(JSON.stringify({ result }))
    win.destroy()
    app.exit(0)
  } catch (error) {
    console.log(JSON.stringify({ error: String(error && error.stack || error) }))
    app.exit(1)
  }
})`)

const run = spawnSync(electron, [path.join(cache, 'responsive-layout-main.mjs')], { encoding: 'utf8' })
const line = run.stdout.trim().split('\n').filter(Boolean).pop() || ''
let probe
try { probe = JSON.parse(line) } catch {
  console.error(run.stdout)
  console.error(run.stderr)
  throw new Error(`responsive layout harness produced no result (exit ${run.status})`)
}
if (probe.error) throw new Error(probe.error)

for (const view of probe.result) {
  assert.ok(view.innerWidth <= 760, `${view.zoom}x reaches the drawer layout`)
  assert.equal(view.aiPosition, 'fixed', `${view.zoom}x Copilot overlays instead of narrowing the note`)
  /* Chromium reports fractional CSS pixels for rects while innerWidth is an
     integer at non-integral zoom. Two pixels is rounding tolerance, not room
     for a hidden column. */
  assert.ok(view.main.width >= view.innerWidth - 2, `${view.zoom}x note keeps the viewport width`)
  assert.ok(view.ai.left >= -2 && view.ai.right <= view.innerWidth + 2,
    `${view.zoom}x Copilot stays inside the viewport`)
  assert.ok(view.ai.width >= Math.min(300, view.innerWidth - 32), `${view.zoom}x Copilot remains usable`)
  assert.notEqual(view.openerBefore, 'none', `${view.zoom}x closed Files rail has an opener`)
  assert.notEqual(view.openerAfter, 'none', `${view.zoom}x sidebar toggle remains visible when the rail opens`)
  assert.equal(view.rowDirection, 'column', `${view.zoom}x model label gets its own line`)
  assert.ok(view.labelWidth >= 240, `${view.zoom}x setting labels do not collapse word by word`)
  assert.ok(view.overflow <= 1, `${view.zoom}x shell does not create horizontal overflow`)
  if (view.innerWidth <= 620) {
    assert.equal(view.railDirection, 'row', `${view.zoom}x Settings sections become a horizontal strip`)
    assert.notEqual(view.filterDisplay, 'none', `${view.zoom}x Search exposes the Filters button`)
    assert.equal(view.chipDisplay, 'none', `${view.zoom}x advanced search switches start folded`)
    assert.ok(view.inputWidth >= 300, `${view.zoom}x search query keeps useful width`)
  }
}

console.log(`${probe.result.length} responsive zoom layouts passed`)
