import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import electron from 'electron'

await mkdir('node_modules/.cache', { recursive: true })
await esbuild.build({
  entryPoints: ['scripts/test-flashcards.page.mjs'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  loader: { '.svg': 'text' },
  outfile: 'node_modules/.cache/flashcards-page.js',
  logLevel: 'error'
})

await writeFile('node_modules/.cache/flashcards-page.html', `<!doctype html>
<meta charset="utf-8">
<script type="module">
  window.__done = import('./flashcards-page.js').then((mod) => mod.run())
</script>`)

await writeFile('node_modules/.cache/flashcards-main.mjs', `
import electron from 'electron'
const { app, BrowserWindow } = electron
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false })
  try {
    await win.loadFile(${JSON.stringify(resolve('node_modules/.cache/flashcards-page.html'))})
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
    console.log(JSON.stringify({ error: 'timed out waiting for flashcard scenario' }))
    app.exit(1)
  } catch (error) {
    console.log(JSON.stringify({ error: String(error && error.stack || error) }))
    app.exit(1)
  }
})`)

const run = spawnSync(electron, ['node_modules/.cache/flashcards-main.mjs'], {
  encoding: 'utf8'
})
const line = run.stdout.trim().split('\n').filter(Boolean).pop() || ''
let payload
try { payload = JSON.parse(line) } catch {
  console.error(run.stdout)
  console.error(run.stderr)
  throw new Error(`flashcard renderer harness produced no result (exit ${run.status})`)
}
if (payload.error) throw new Error(payload.error)

assert.deepEqual(payload.result.before, {
  enhanced: 1,
  buttons: 3,
  media: true,
  explanationHidden: true
})
assert.equal(payload.result.result, 'wrong')
assert.match(payload.result.feedback, /correct answer is “Mars”/)
assert.equal(payload.result.explanationHiddenAfter, false)
assert.equal(payload.result.correctMarked, true)
assert.equal(payload.result.wrongMarked, true)
assert.equal(payload.result.allAnswersResolved, true)
assert.equal(payload.result.disabled, true)
console.log('flashcard renderer: interactive choices passed')
