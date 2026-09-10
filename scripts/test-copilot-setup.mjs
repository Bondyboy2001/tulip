/* The copilot's way out of a CLI that is not ready, and the routing behind it.

   A panel that says "not ready" and stops leaves the reader to the README;
   `Set up` opens Settings on the Copilot pane, where the doctor's row names
   the command that fixes it. The pane is opened by name through the main
   process, so the contract spans both processes: this drives the real window,
   presses the control, and reads which pane the settings window landed on.

   The window is driven for real — see scripts/lib/app-session.mjs — so run it
   behind a build: `npm run build && npm run test:copilot-setup`. */
import { appSession, delay } from './lib/app-session.mjs'
import assert from 'node:assert/strict'

const app = await appSession({
  files: { 'Note.md': '# Note\n\nSome text.\n' },
  config: { tabs: ['Note.md'], tabIndex: 0, ai: 'open' }
})
let socket
try {
  // The panel is built because the config says it is open, but its module is
  // loaded lazily after boot; wait for the mount before asking for the control.
  let mounted = false
  for (let attempt = 0; attempt < 100 && !mounted; attempt++) {
    mounted = await app.evaluate(`Boolean(document.querySelector('.ai-setup'))`)
    if (!mounted) await delay(100)
  }
  assert.ok(mounted, 'the copilot panel mounted with its setup control')
  assert.equal(await app.evaluate(`document.querySelector('.ai-setup').hidden`), true,
    'the control stays hidden until the doctor says something is wrong')

  const first = (await app.targets())[0]
  const endpoint = new URL(first.webSocketDebuggerUrl)
  await app.evaluate(`window.tulip.settings.open('copilot')`)

  let target = null
  for (let attempt = 0; attempt < 60 && !target; attempt++) {
    await delay(100)
    const targets = await (await fetch(`http://${endpoint.host}/json/list`)).json()
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
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await run(`document.getElementById('settings')?.hidden === false`)) break
    await delay(100)
  }
  assert.equal(await run(`document.getElementById('settings-title').textContent`), 'Copilot',
    'the requested pane is the one that opened')

  console.log('PASS: Set up opens Settings on the Copilot pane')
} finally {
  socket?.close()
  await app.dispose()
}
