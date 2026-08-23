/* Does a Copilot edit paint a red/green review diff in the file itself?

   Mounts the real editor in a real Chromium window (a layout engine is needed
   for the paint assertions), applies an Edit-tool style change through the
   same path the copilot panel drives — `view.patch(text, { agent: true })` —
   and reads back both the decorations on the state and the computed colours.
   A small window appears for about a second: headless Electron windows pause
   the frames this needs. See src/editor.js `buildAgentDiff`. */

import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
/* The executable the package exports, not the .bin shim: on Windows the shim
   is a .cmd, which spawn will not start without a shell since Node closed
   that hole, and the test died with ENOENT before it began. */
import electron from 'electron'

await mkdir('node_modules/.cache', { recursive: true })
await esbuild.build({
  entryPoints: ['scripts/test-agent-diff.page.mjs'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'text' },
  outfile: 'node_modules/.cache/agent-diff-page.js',
  logLevel: 'error'
})

/* The theme reads the app's CSS variables; only the handful the agent-diff
   rules use are needed here. */
await writeFile('node_modules/.cache/agent-diff-page.html', `<!doctype html>
<meta charset="utf-8">
<style>
:root {
  --code-added: #40693C; --code-removed: #A63A5A;
  --font-body: serif; --font-ui: sans-serif; --font-mono: monospace;
  --measure: 72ch; --ink: #1c1c1c; --muted: #777; --faint: #aaa;
  --sel: #dde3f0; --accent: #3056d3; --accent-dim: #e3e9fa;
  --active-line: #f4f4f4; --agent-flash: #e3e9fa;
  --line-soft: #ddd; --z-sticky: 4;
}
body { margin: 0; }
</style>
<script>
  /* The bridge the preload would expose: nothing under test reaches the main
     process, but modules wire their listeners at import time. */
  window.tulip = new Proxy(function () {}, {
    get: (target, key) => (key in target ? target[key] : window.tulip),
    apply: () => window.tulip
  })
</script>
<script type="module">
  window.__done = import('./agent-diff-page.js').then((mod) => mod.run())
</script>`)

await writeFile('node_modules/.cache/agent-diff-main.mjs', `
import electron from 'electron'
const { app, BrowserWindow } = electron
const say = (payload) => { console.log(JSON.stringify(payload)); app.exit(payload.error ? 1 : 0) }
app.whenReady().then(async () => {
  /* Not throttled behind another window — see the note in test-grid.mjs. */
  const win = new BrowserWindow({
    width: 520, height: 400, show: true, webPreferences: { backgroundThrottling: false }
  })
  try {
    await win.loadFile(${JSON.stringify(await import('node:path').then((m) => m.resolve('node_modules/.cache/agent-diff-page.html')))})
    for (let wait = 0; wait < 120; wait++) {
      const probe = await win.webContents.executeJavaScript(\`
        (async () => {
          if (!window.__done) return null
          try { return { result: await window.__done } }
          catch (err) { return { error: String(err && err.stack || err) } }
        })()\`)
      if (probe) { win.destroy(); return say(probe) }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    say({ error: 'timed out waiting for the agent-diff scenario' })
  } catch (err) {
    say({ error: String(err && err.stack || err) })
  }
})`)

const run = spawnSync(electron, ['node_modules/.cache/agent-diff-main.mjs'],
  { encoding: 'utf8' })
const line = run.stdout.trim().split('\n').filter(Boolean).pop() || ''
let probe
try { probe = JSON.parse(line) } catch {
  console.error(run.stdout)
  console.error(run.stderr)
  throw new Error(`agent-diff harness produced no result (exit ${run.status})`)
}
if (probe.error) throw new Error(probe.error)
const result = probe.result
console.error(JSON.stringify(result, null, 2))

/* The state carries the whole diff: the rewritten line is lit, the words that
   moved inside it are marked over exactly the changed words, and every removed
   line is in the widget — with its own changed words marked the same way. */
assert.deepEqual(result.lines, [3], 'the one rewritten line is the line decorated')
assert.ok(result.wordTexts.join(' ').includes('leaps'), 'the new word is marked')
assert.ok(result.wordTexts.join(' ').includes('quiet'), 'the other new word is marked')
assert.equal(result.widgetCount, 2, 'one removed-lines block per run of removals')
assert.equal(result.removedRows.length, 3, 'both removed runs are shown, line for line')
assert.ok(result.removedRows[0].text.includes('jumps'), 'the rewritten line is the first removed row')
assert.ok(result.removedRows[0].marked >= 1, 'the removed words are marked')
assert.ok(result.removedRows.slice(1).every((row) => row.marked === 0),
  'lines removed whole keep their flat tint')
assert.ok(result.removedRows[2].text.includes('Old line to delete'))

/* And it is painted, in the editing view as it is in raw. */
assert.ok(result.inEditView.added >= 1, 'edit view: the added line is in the page')
assert.ok(result.inEditView.addedWords >= 1, 'edit view: the changed words are in the page')
assert.equal(result.inEditView.deletedDisplay, 'block', 'edit view: removed lines are not hidden')
assert.ok(result.inEditView.removedWords >= 1, 'edit view: removed words are in the page')
assert.notEqual(result.inEditView.addedPaint, 'rgba(0, 0, 0, 0)', 'edit view: the added line is painted')
assert.notEqual(result.inEditView.deletedPaint, 'rgba(0, 0, 0, 0)', 'edit view: removed lines are painted')

assert.equal(result.inRawView.isRaw, true, 'raw view engaged')
assert.deepEqual(result.rawLines, [3], 'the review survives the view switch')
assert.ok(result.rawWords >= 1, 'raw view: the changed words are still marked')
assert.equal(result.inRawView.deletedDisplay, 'block', 'raw view: removed lines are shown')
assert.notEqual(result.inRawView.addedPaint, 'rgba(0, 0, 0, 0)', 'raw view: the added line is painted')

assert.match(result.codeStyle.deletedFontFamily, /monospace/, 'code removals use the code font')
assert.equal(result.codeStyle.deletedFontSize, '12.5px', 'code removals use the code font size')
assert.equal(result.codeStyle.addedMarker, '"+"', 'code additions show a + marker')
assert.equal(result.codeStyle.addedMarkerZIndex, '4', 'the + marker sits above the sticky gutter')

console.log('agent-diff: all checks passed')
