/* The shell's accessibility contract, run against the real window.

   Tulip's controls are hand-built, so nothing about roles and names is
   inherited from a component library; every regression here is one edit away.
   This drives axe-core over the mounted shell — the sidebar, the document,
   the open copilot and the palette — and over the settings window, and fails
   on critical and serious findings.

   Moderate findings the shell carries knowingly are not gated: `region`
   reports the three panel grips, which are appended to the app shell as
   fixed-position splitters and so sit outside any landmark. Wrapping them in
   a landmark to satisfy a best-practice check would announce a "Panel
   dividers" region on every visit, which is a worse reading than the one it
   fixes. Everything that is a failure under WCAG A/AA is gated.

   Run it behind a build: `npm run build && npm run test:a11y`. */
import { appSession, delay } from './lib/app-session.mjs'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const axeSource = await readFile(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8')
const GATED = ['critical', 'serious']

/** The findings the gate owns, as short lines rather than a wall. */
const gatedViolations = (target) => `(async () => {
  const r = await axe.run(${target}, { resultTypes: ['violations'] })
  return r.violations
    .filter((v) => ${JSON.stringify(GATED)}.includes(v.impact))
    .map((v) => v.id + ' (' + v.impact + ', ' + v.nodes.length + ' node' + (v.nodes.length === 1 ? '' : 's') + ')')
})()`

/** A CDP session over one page target. */
async function connect (url) {
  const socket = new WebSocket(url)
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
  let id = 0
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id
    const receive = ({ data }) => {
      const reply = JSON.parse(data)
      if (reply.id !== n) return
      socket.removeEventListener('message', receive)
      reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result)
    }
    socket.addEventListener('message', receive)
    socket.send(JSON.stringify({ id: n, method, params }))
  })
  return {
    run: async (expression) => {
      const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
      return r.result.value
    },
    close: () => socket.close()
  }
}

const app = await appSession({
  files: {
    'Note.md': '# Note\n\nSome text with a [link](https://example.com).\n\n```js\nconsole.log(1)\n```\n'
  },
  config: { tabs: ['Note.md'], tabIndex: 0, ai: 'open' }
})
let settings = null
try {
  /* The panel is loaded lazily after boot; the palette is opened the way the
     reader opens it, so both surfaces are actually on screen for the scan. */
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await app.evaluate(`Boolean(document.querySelector('.ai-setup'))`)) break
    await delay(100)
  }
  await app.evaluate(`document.getElementById('btn-search').click(); true`)
  await delay(200)

  await app.evaluate(axeSource)
  const shell = await app.evaluate(gatedViolations('document'))
  assert.deepEqual(shell, [], `the shell has no critical or serious violations: ${shell.join(', ')}`)

  const first = (await app.targets())[0]
  const endpoint = new URL(first.webSocketDebuggerUrl)
  const port = endpoint.host
  await app.evaluate(`window.tulip.settings.open('copilot')`)
  let target = null
  for (let attempt = 0; attempt < 60 && !target; attempt++) {
    await delay(100)
    const targets = await (await fetch(`http://${port}/json/list`)).json()
    target = targets.find((t) => t.url.includes('settings-window.html')) || null
  }
  assert.ok(target, 'the settings window opened')
  settings = await connect(target.webSocketDebuggerUrl)
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await settings.run(`document.getElementById('settings')?.hidden === false`)) break
    await delay(100)
  }
  await settings.run(axeSource)
  const pane = await settings.run(gatedViolations('document'))
  assert.deepEqual(pane, [], `the settings window has no critical or serious violations: ${pane.join(', ')}`)

  console.log('PASS: shell and settings have no critical or serious accessibility findings')
} finally {
  settings?.close()
  await app.dispose()
}
