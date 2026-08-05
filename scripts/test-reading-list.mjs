import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

await mkdir('node_modules/.cache', { recursive: true })
await esbuild.build({
  entryPoints: ['scripts/test-reading-list.page.mjs'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'text' },
  outfile: 'node_modules/.cache/reading-list-page.js',
  logLevel: 'error'
})

await writeFile('node_modules/.cache/reading-list-page.html', `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="${resolve('src/styles.css')}">
<script type="module">
  window.__done = import('./reading-list-page.js').then((mod) => mod.run())
<\/script>`)

await writeFile('node_modules/.cache/reading-list-main.mjs', `
import electron from 'electron'
const { app, BrowserWindow } = electron
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false })
  try {
    await win.loadFile(${JSON.stringify(resolve('node_modules/.cache/reading-list-page.html'))})
    for (let wait = 0; wait < 120; wait++) {
      const result = await win.webContents.executeJavaScript(
        '(async () => window.__done ? { result: await window.__done } : null)()'
      )
      if (result) {
        console.log(JSON.stringify(result))
        win.destroy()
        app.exit(result.error ? 1 : 0)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    console.log(JSON.stringify({ error: 'timed out waiting for reading-list scenario' }))
    app.exit(1)
  } catch (error) {
    console.log(JSON.stringify({ error: String(error && error.stack || error) }))
    app.exit(1)
  }
})`)

const run = spawnSync('node_modules/.bin/electron', ['node_modules/.cache/reading-list-main.mjs'], {
  encoding: 'utf8'
})
const line = run.stdout.trim().split('\n').filter(Boolean).pop() || ''
let payload
try { payload = JSON.parse(line) } catch {
  console.error(run.stdout)
  console.error(run.stderr)
  throw new Error(`reading-list harness produced no result (exit ${run.status})`)
}
if (payload.error) throw new Error(payload.error)

assert.equal(payload.result.first, '1')
assert.equal(payload.result.second, '2')
assert.equal(payload.result.firstPosition, 'absolute')
assert.equal(payload.result.secondPosition, 'absolute')
console.log('reading list: resumed markers are correct')
