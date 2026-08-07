/* Runs scripts/table-tests.js inside Electron, because the table is a
   contenteditable grid in a CodeMirror block widget and neither half of that is
   real under Node. Bundles the tests, loads them in an off-screen window, and
   reports what failed.

     node scripts/test-table.mjs
*/

import * as esbuild from 'esbuild'
import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const cache = path.join(root, 'node_modules/.cache')
await mkdir(cache, { recursive: true })

const bundle = path.join(cache, 'tulip-table-tests.js')
await esbuild.build({
  entryPoints: [path.join(root, 'scripts/table-tests.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  loader: { '.svg': 'text' },
  outfile: bundle,
  logLevel: 'error'
})

/* The app's own stylesheet, beside the page: how wide a grid ends up is a
   question only the real rules can answer. */
await copyFile(path.join(root, 'src/styles.css'), path.join(cache, 'tulip-table-tests.css'))

const page = path.join(cache, 'tulip-table-tests.html')
await writeFile(page, `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="./tulip-table-tests.css">
<body><script src="./tulip-table-tests.js"></script></body>`)

const main = path.join(cache, 'tulip-table-tests-main.cjs')
await writeFile(main, `
const { app, BrowserWindow } = require('electron')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  /* Shown and focused, not hidden: Chromium defers focus events on a document
     that does not have focus, so in an off-screen window a cell became the
     active element without ever being told — and a table cell only reveals its
     own Markdown when it hears that it was focused. */
  /* And not throttled when it is behind something: the suite runs in parallel
     (scripts/run-tests.mjs), and Chromium stops servicing rAF in a background
     window, which is the same stall as the focus problem above by a different
     route. */
  const win = new BrowserWindow({
    show: true, width: 1200, height: 900, webPreferences: { backgroundThrottling: false }
  })

  /* The deadline inside the page cannot fire if the page is what went — a
     renderer that is killed takes its own timers with it, and the wait for it
     would never end. This process is a different one, so its clock still runs.
     Later than the page's own cap, so the page reports its own stall when it
     still can, and this only speaks when nothing else could. */
  const backstop = setTimeout(() => {
    console.log('__RESULTS__' + JSON.stringify([{
      name: 'harness', ok: false, error: 'the renderer never reported back within 240s'
    }]))
    app.exit(1)
  }, 240000)
  backstop.unref?.()
  win.webContents.on('render-process-gone', (_event, details) => {
    console.log('__RESULTS__' + JSON.stringify([{
      name: 'harness', ok: false, error: 'the renderer died: ' + JSON.stringify(details)
    }]))
    app.exit(1)
  })

  try {
    await win.loadFile(${JSON.stringify(page)})
    app.focus({ steal: true })
    win.focus()
    win.webContents.focus()
    /* The suite is async, so the load event says nothing about it: the results
       land on the window once every test has settled. Wait for those.

       The wait is for *progress*, not for a total running time. A machine with
       several Electron windows on it can stop scheduling this renderer
       altogether — measured here, both rAF and setTimeout stopped for eighteen
       of twenty seconds while the tests themselves were fine — and a deadline
       counted in wall clock turns that into a failed suite with nothing to look
       at. So the clock is reset by every test that starts, and a poll that
       itself arrives very late is treated as time the page never had rather
       than time the test spent: what fails the suite is a test that stops
       making progress, which is the thing worth failing for.

       Every one of those allowances is bounded, because a wait that can be
       extended indefinitely is a CI job that hangs instead of failing — which
       is worse than the flake it set out to fix. Only stalls of a second or
       more are forgiven (below that it is ordinary scheduler drift, not
       starvation), no more than a minute of them in total, and CAP ends the
       wait whatever else is true. */
    const results = await win.webContents.executeJavaScript(
      'new Promise((resolve, reject) => {' +
      '  const STEP = 50, IDLE = 20000, CAP = 180000, STALL = 1000, FORGIVE = 60000;' +
      '  const begun = Date.now();' +
      '  let mark = "", since = begun, polled = begun, given = 0;' +
      '  const look = () => {' +
      '    if (window.__tableTests) return resolve(window.__tableTests);' +
      '    const now = Date.now();' +
      '    const gap = now - polled;' +
      '    polled = now;' +
      /* A poll that took a second when it asked for fifty milliseconds is the
         renderer having been starved, not the test having stalled. Give that
         time back rather than charging it to whichever test was running. */
      '    if (gap > STALL && given < FORGIVE) {' +
      '      const back = Math.min(gap, FORGIVE - given);' +
      '      given += back; since += back;' +
      '    }' +
      '    const at = JSON.stringify(window.__tableProgress || null);' +
      '    if (at !== mark) { mark = at; since = now; }' +
      '    if (now - since > IDLE) {' +
      '      return reject(new Error("no test finished for " + Math.round((now - since) / 1000) + "s — stalled in " + mark));' +
      '    }' +
      '    if (now - begun > CAP) {' +
      '      return reject(new Error("the suite ran past " + (CAP / 1000) + "s — last was " + mark));' +
      '    }' +
      '    setTimeout(look, STEP);' +
      '  };' +
      '  look();' +
      '})'
    )
    clearTimeout(backstop)
    console.log('__RESULTS__' + JSON.stringify(results))
    app.exit(0)
  } catch (error) {
    console.log('__RESULTS__' + JSON.stringify([{ name: 'harness', ok: false, error: String(error && error.stack || error) }]))
    app.exit(1)
  }
})
`)

/* The outermost backstop. Everything above assumes Electron got far enough to
   run the code that reports; this covers the case where it did not, so the
   worst a wedged run can cost is five minutes rather than the whole job. */
const run = spawnSync(path.join(root, 'node_modules/.bin/electron'), [main], {
  encoding: 'utf8',
  timeout: 300000,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
})

const line = (run.stdout || '').split('\n').find((text) => text.startsWith('__RESULTS__'))
if (!line) {
  console.error(run.stdout || '')
  console.error(run.stderr || '')
  console.error(run.signal === 'SIGTERM'
    ? 'the table tests were killed after 300s — Electron never reported back'
    : 'the table tests produced no result')
  process.exit(1)
}

const results = JSON.parse(line.slice('__RESULTS__'.length))
const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? '  ok  ' : ' FAIL '} ${result.name}`)
  if (!result.ok) console.log(String(result.error).split('\n').map((l) => `        ${l}`).join('\n'))
}
console.log(`\ntables: ${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
