/* Runs scripts/table-tests.js inside Electron, because the table is a
   contenteditable grid in a CodeMirror block widget and neither half of that is
   real under Node. Bundles the tests, loads them in an off-screen window, and
   reports what failed.

     node scripts/test-table.mjs
*/

import * as esbuild from 'esbuild'
import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const require = createRequire(import.meta.url)
const electron = require('electron')
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
  const win = new BrowserWindow({ show: true, width: 1200, height: 900 })
  try {
    await win.loadFile(${JSON.stringify(page)})
    app.focus({ steal: true })
    win.focus()
    win.webContents.focus()
    // The suite is async, so the load event says nothing about it: the results
    // land on the window once every test has settled. Wait for those.
    const results = await win.webContents.executeJavaScript(
      'new Promise((resolve, reject) => {' +
      '  const started = Date.now();' +
      '  const look = () => {' +
      '    if (window.__tableTests) return resolve(window.__tableTests);' +
      '    if (Date.now() - started > 20000) return reject(new Error("tests never finished"));' +
      '    setTimeout(look, 50);' +
      '  };' +
      '  look();' +
      '})'
    )
    console.log('__RESULTS__' + JSON.stringify(results))
    app.exit(0)
  } catch (error) {
    console.log('__RESULTS__' + JSON.stringify([{ name: 'harness', ok: false, error: String(error && error.stack || error) }]))
    app.exit(1)
  }
})
`)

const run = spawnSync(electron, [main], {
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
})

const line = (run.stdout || '').split('\n').find((text) => text.startsWith('__RESULTS__'))
if (!line) {
  console.error(run.stdout || '')
  console.error(run.stderr || '')
  console.error('the table tests produced no result')
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
