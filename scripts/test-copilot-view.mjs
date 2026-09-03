/* Does the copilot panel keep its books?
 *
 * The parsers and the prompt are checked without a browser in test-ai.mjs.
 * This is the other half: the panel itself, mounted in a real Chromium window
 * against a bridge that answers the way main does and writes down every call.
 * Nothing here is measured — the window is not shown — so it runs in the pool
 * with the rest rather than in the windowed lane.
 *
 * It exists because the panel is a state machine over several conversations
 * at once, and every bug it has had was one of these: a turn filed into the
 * wrong chat, a question resent twice, a dialog asked once too often. None of
 * that was reachable by grepping the source, which was the only test it had.
 *
 * Same harness as test-notebook-view.mjs.
 */

import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import electron from 'electron'

await mkdir('node_modules/.cache', { recursive: true })
await esbuild.build({
  entryPoints: ['scripts/test-copilot.page.mjs'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'text' },
  outfile: 'node_modules/.cache/copilot-page.js',
  logLevel: 'error'
})

await writeFile('node_modules/.cache/copilot-page.html', `<!doctype html>
<meta charset="utf-8">
<style>
  :root { --font-ui: sans-serif; --font-mono: monospace; --ink: #222; --muted: #666;
          --accent: #3056d3; --line-soft: #eee; --hover: #eee; }
  body { margin: 0; }
  #host { width: 400px; height: 600px; }
  .ai-log { height: 400px; overflow: auto; }
</style>
<div id="host"></div>
<script type="module">
  Object.defineProperty(document, 'hasFocus', { value: () => true })
  window.__done = import('./copilot-page.js').then((mod) => mod.run())
</script>`)

await writeFile('node_modules/.cache/copilot-main.mjs', `
import electron from 'electron'
const { app, BrowserWindow } = electron
const say = (payload) => { console.log(JSON.stringify(payload)); app.exit(payload.error ? 1 : 0) }
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 440, height: 640, show: false, webPreferences: { backgroundThrottling: false }
  })
  const said = []
  win.webContents.on('console-message', (e, level, message) =>
    said.push(String(e?.message ?? message ?? '')))
  win.webContents.on('did-fail-load', (_e, code, desc) => said.push('load failed: ' + code + ' ' + desc))
  try {
    await win.loadFile(${JSON.stringify(path.resolve('node_modules/.cache/copilot-page.html'))})
    for (let wait = 0; wait < 200; wait++) {
      const probe = await win.webContents.executeJavaScript(\`
        (async () => {
          if (!window.__done) return { stage: 'the page module never loaded' }
          const settled = await Promise.race([
            window.__done.then((result) => ({ result }), (err) => ({ error: String(err && err.stack || err) })),
            new Promise((resolve) => setTimeout(() => resolve(null), 50))
          ])
          return settled || { stage: window.__stage || '(nothing yet)' }
        })()\`)
      if (probe && !probe.stage) { win.destroy(); return say(probe) }
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (wait === 199) {
        say({ error: 'timed out waiting for the copilot scenario — reached: ' +
          (probe && probe.stage) + (said.length ? '\\n' + said.slice(-12).join('\\n') : '') })
      }
    }
  } catch (err) {
    say({ error: String(err && err.stack || err) })
  }
})`)

const run = spawnSync(electron, ['node_modules/.cache/copilot-main.mjs'], { encoding: 'utf8' })
const line = run.stdout.trim().split('\n').filter(Boolean).pop() || ''
let probe
try { probe = JSON.parse(line) } catch {
  console.error(run.stdout)
  console.error(run.stderr)
  throw new Error(`copilot harness produced no result (exit ${run.status})`)
}
if (probe.error) throw new Error(probe.error)
const r = probe.result

let passed = 0
const ok = (what, fn) => { fn(); passed++; console.log(`ok - ${what}`) }

ok('a question starts one copilot, sends once, and is busy until the reply', () => {
  assert.equal(r.startedOnce, 1)
  assert.equal(r.sentOnce, 1)
  assert.equal(r.busyAfterSend, true)
  assert.equal(r.idleAfterReply, true)
  assert.equal(r.replyDrawn, true)
})

ok('the turn’s cost is shown beside the context reading', () => {
  assert.match(r.costShown, /\$0\.01/)
})

ok('a finished reply can be put into the note, and says why when it cannot', () => {
  assert.equal(r.insertOffered, 1)
  assert.deepEqual(r.inserted, ['It is a note.'])
  assert.match(r.insertRefused, /Open a note in the editor/)
})

ok('questions asked mid-turn queue, and go out together as one turn', () => {
  /* The first follow-up went straight out — the chat was idle — and the two
     typed while it ran are the ones that waited. */
  assert.equal(r.queuedRows, 2)
  assert.equal(r.sentAfterDrain - r.sentBeforeDrain, 1)
  assert.equal(r.drainedText, 'Second follow-up\n\nThird follow-up')
  assert.equal(r.queuedRowsAfterDrain, 0)
})

ok('a session main let go of is restarted and the message resent, silently', () => {
  assert.equal(r.restartedOnGone, 1)
  assert.equal(r.resentOnGone, true)
  assert.equal(r.noWarningOnGone, true)
  assert.equal(r.busyAfterRestart, true)
})

ok('a thread the CLI no longer has is dropped, said, and not resumed again', () => {
  assert.equal(r.resumedWith, 'ses_old')
  assert.equal(r.lostThreadNoted, true)
  assert.equal(r.idleAfterLoss, true)
  assert.equal(r.resumedAfterLoss, null)
})

ok('a review of several files can reject one of them', () => {
  assert.equal(r.perFileRejects, 2)
  assert.deepEqual(r.restoredOne, [{ id: 'op-1', path: 'b.md' }])
  assert.equal(r.singleFileRejects, 0)
})

ok('/stop stops the running turn', () => {
  assert.equal(r.stoppedByCommand, 1)
  assert.equal(r.idleAfterStop, true)
  assert.equal(r.stoppedRow, true)
})

ok('Ask mode asks once per chat, and again for a new chat or after leaving Ask', () => {
  assert.equal(r.askedOnceForTwoTurns, 1)
  assert.equal(r.askedAgainForNewChat, 2)
  assert.equal(r.askedAgainAfterModeChange, 3)
})

ok('the "getting long" notice is given once and remembered on disk', () => {
  assert.equal(r.longNoticeGiven, 1)
  assert.equal(r.longNoticePersisted, true)
})

console.log(`${passed} copilot panel checks passed`)
