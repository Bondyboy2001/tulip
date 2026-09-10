/* Consent, seen from outside the moment it was given.

   Trust is granted by a native dialog at the first run and kept in the config
   as vault paths. Nothing showed the list back or offered to take one back;
   this drives the real settings window: trust a vault the way the app would
   have, open the pane, revoke it from the row, and prove both the config and
   the main process agree it is gone.

   Run it behind a build: `npm run build && npm run test:trust`. */
import { appSession, delay } from './lib/app-session.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const app = await appSession({
  files: { 'Note.md': '# Note\n\nSome text.\n' },
  config: { tabs: ['Note.md'], tabIndex: 0 }
})
let socket
try {
  /* The trust list is main's to write, and the renderer may not set it — that
     is the point of the key. So: stop, write the config a past dialog would
     have left, start again. */
  await app.stop()
  const configPath = path.join(app.profile, 'config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  await writeFile(configPath, JSON.stringify({ ...config, trustedVaults: [app.vault] }))
  await app.restart()
  assert.equal(await app.evaluate(`window.tulip.run.trusted()`), true)

  const first = (await app.targets())[0]
  const port = new URL(first.webSocketDebuggerUrl).host
  await app.evaluate(`window.tulip.settings.open('vault')`)

  let target = null
  for (let attempt = 0; attempt < 60 && !target; attempt++) {
    await delay(100)
    const targets = await (await fetch(`http://${port}/json/list`)).json()
    target = targets.find((t) => t.url.includes('settings-window.html')) || null
  }
  assert.ok(target, 'the settings window opened')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
  let id = 0
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id
    const receive = ({ data }) => {
      const v = JSON.parse(data)
      if (v.id !== n) return
      socket.removeEventListener('message', receive)
      v.error ? reject(v.error) : resolve(v.result)
    }
    socket.addEventListener('message', receive)
    socket.send(JSON.stringify({ id: n, method, params }))
  })
  const run = async (expression) => {
    const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  let rows = 0
  for (let attempt = 0; attempt < 60 && !rows; attempt++) {
    rows = await run(`document.querySelectorAll('.trusted-row').length`)
    if (!rows) await delay(100)
  }
  assert.equal(rows, 1, 'the trusted vault is listed')
  assert.equal(await run(`document.querySelector('.trusted-name').textContent`), path.basename(app.vault))
  await run(`document.querySelector('.trusted-row button').click(); true`)

  /* Config writes are coalesced; the revocation is not done until the file
     says so, which is also what a restart would read. */
  for (let attempt = 0; attempt < 50; attempt++) {
    const saved = JSON.parse(await readFile(configPath, 'utf8'))
    if (!(saved.trustedVaults || []).includes(app.vault)) break
    await delay(100)
  }
  const saved = JSON.parse(await readFile(configPath, 'utf8'))
  assert.ok(!(saved.trustedVaults || []).includes(app.vault), 'revoking removes the vault from the config')
  assert.equal(await app.evaluate(`window.tulip.run.trusted()`), false, 'and main stops treating it as trusted')

  console.log('PASS: a trusted vault is listed and revocation takes effect')
} finally {
  socket?.close()
  await app.dispose()
}
