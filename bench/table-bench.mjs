/* Runs bench/table-bench-entry.js inside Electron, for the same reason
   scripts/test-table.mjs does: the grid is a contenteditable inside a
   CodeMirror block widget, and neither half of that is real under Node.

     node bench/table-bench.mjs            one run
     node bench/table-bench.mjs --save     …and write it down as the baseline
     node bench/table-bench.mjs --against  …and compare against the baseline
     node bench/table-bench.mjs --profile  …and say where the time went

   The baseline lands in node_modules/.cache, which is nobody's repository. */

import * as esbuild from 'esbuild'
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const cache = path.join(root, 'node_modules/.cache')
await mkdir(cache, { recursive: true })

const bundle = path.join(cache, 'tulip-table-bench.js')
await esbuild.build({
  entryPoints: [path.join(root, 'bench/table-bench-entry.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  loader: { '.svg': 'text' },
  outfile: bundle,
  logLevel: 'error'
})

// The app's own stylesheet: how much layout a grid costs is a question only the
// real rules can answer.
await copyFile(path.join(root, 'src/styles.css'), path.join(cache, 'tulip-table-bench.css'))

const page = path.join(cache, 'tulip-table-bench.html')
await writeFile(page, `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="./tulip-table-bench.css">
<body><script src="./tulip-table-bench.js"></script></body>`)

const profiling = process.argv.includes('--profile')
const main = path.join(cache, 'tulip-table-bench-main.cjs')
await writeFile(main, `
const { app, BrowserWindow } = require('electron')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1200, height: 900 })
  try {
    /* The sampling profiler, when asked for. Attached before the page runs and
       read after it, so what comes back is the whole workload rather than a
       window of it. */
    const profiling = ${profiling}
    if (profiling) {
      win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Profiler.enable')
      await win.webContents.debugger.sendCommand('Profiler.setSamplingInterval', { interval: 100 })
      await win.webContents.debugger.sendCommand('Profiler.start')
    }
    await win.loadFile(${JSON.stringify(page)})
    app.focus({ steal: true })
    win.focus()
    win.webContents.focus()
    const results = await win.webContents.executeJavaScript(
      'new Promise((resolve, reject) => {' +
      '  const started = Date.now();' +
      '  const look = () => {' +
      '    if (window.__tableBench) return resolve(window.__tableBench);' +
      '    if (Date.now() - started > 120000) return reject(new Error("the benchmark never finished"));' +
      '    setTimeout(look, 50);' +
      '  };' +
      '  look();' +
      '})'
    )
    if (profiling) {
      const { profile } = await win.webContents.debugger.sendCommand('Profiler.stop')
      console.log('__PROFILE__' + JSON.stringify(profile))
    }
    console.log('__RESULTS__' + JSON.stringify(results))
    app.exit(0)
  } catch (error) {
    console.error(String(error && error.stack || error))
    app.exit(1)
  }
})
`)

const runElectron = () => spawnSync(path.join(root, 'node_modules/.bin/electron'), [main], {
  encoding: 'utf8',
  timeout: 150_000,
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
})

/* A macOS app activation can occasionally lose the first launch to another
   Electron window. One retry turns that incidental empty run into either a
   real measurement or a loud, reproducible failure; it never combines values
   from two processes. */
let run = runElectron()
if (!(run.stdout || '').includes('__RESULTS__')) run = runElectron()

const line = (run.stdout || '').split('\n').find((text) => text.startsWith('__RESULTS__'))
if (!line) {
  console.error(run.stdout || '')
  console.error(run.stderr || '')
  process.exit(1)
}

const results = JSON.parse(line.slice('__RESULTS__'.length))

/* Self time per function, out of the sampler's own arithmetic: every sample
   names the node it landed in, and the gap before it is what that node was
   doing. Anonymous frames are named by where they are, which for a bundle is
   the only way to tell two of them apart. */
function hotFunctions (profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const self = new Map()
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i])
    if (!node) continue
    const frame = node.callFrame
    const where = `${frame.functionName || '(anonymous)'}  ${(frame.url || '').split('/').pop()}:${frame.lineNumber + 1}`
    self.set(where, (self.get(where) || 0) + (profile.timeDeltas[i] || 0) / 1000)
  }
  return [...self.entries()].sort((a, b) => b[1] - a[1])
}

const profileLine = (run.stdout || '').split('\n').find((text) => text.startsWith('__PROFILE__'))
if (profileLine) {
  const hot = hotFunctions(JSON.parse(profileLine.slice('__PROFILE__'.length)))
  const total = hot.reduce((sum, [, ms]) => sum + ms, 0)
  console.log('\nwhere the time went (self time, whole run)\n')
  for (const [where, ms] of hot.slice(0, 18)) {
    console.log(`  ${ms.toFixed(1).padStart(7)}ms  ${((ms / total) * 100).toFixed(1).padStart(4)}%  ${where}`)
  }
}
const MEASURES = [
  ['build', 'open a note with the table in it'],
  ['buildJs', '  …of which, building the grid in JS'],
  ['buildLayout', '  …of which, Chromium laying it out'],
  ['keystroke', 'one keystroke in a cell'],
  ['elsewhere', 'an edit elsewhere in the note'],
  ['select', 'drag a rectangle across 40 rows']
]

const baselineFile = path.join(cache, 'tulip-table-bench-baseline.json')
const against = process.argv.includes('--against')
let baseline = null
if (against) {
  try { baseline = JSON.parse(await readFile(baselineFile, 'utf8')) } catch { baseline = null }
  if (!baseline) console.error('no baseline saved yet — run with --save first\n')
}

const ms = (n) => `${n.toFixed(1)}ms`.padStart(9)
console.log(`\n${results.rows} rows, ${results.cells} cells\n`)
for (const [key, what] of MEASURES) {
  const now = results[key]
  // A measure this run did not take, or one the saved baseline pre-dates: said
  // plainly rather than crashing the report that was the point of the run.
  if (typeof now !== 'number') continue
  const was = baseline?.[key]
  if (typeof was !== 'number') { console.log(`${ms(now)}  ${what}`); continue }
  const change = ((now - was) / was) * 100
  const arrow = change < -2 ? '↓' : change > 2 ? '↑' : '='
  console.log(`${ms(now)}  was ${ms(was).trim()}  ${arrow} ${Math.abs(change).toFixed(0)}%  ${what}`)
}
console.log('')

if (process.argv.includes('--save')) {
  await writeFile(baselineFile, JSON.stringify(results, null, 2))
  console.log(`baseline saved to ${path.relative(root, baselineFile)}\n`)
}

if (process.argv.includes('--check')) {
  /* Deliberately broad ceilings. This is a regression alarm, not a promise
     that a shared CI machine behaves like an idle laptop. Each is comfortably
     above the measured baseline but below the multi-frame pauses that brought
     this benchmark into existence. */
  const ceilings = { build: 220, keystroke: 45, elsewhere: 20, select: 80 }
  const failed = Object.entries(ceilings)
    .filter(([key, limit]) => typeof results[key] !== 'number' || results[key] > limit)
  if (failed.length) {
    console.error('table performance gate failed: ' + failed
      .map(([key, limit]) => `${key} ${results[key] ?? 'missing'}ms > ${limit}ms`).join(', '))
    process.exit(1)
  }
  console.log('table performance gate passed\n')
}
