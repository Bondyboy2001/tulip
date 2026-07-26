/**
 * Evaluates expressions inside the running renderer over the DevTools protocol.
 * Launch the app with --remote-debugging-port=9222 first.
 *
 *   node scripts/drive.mjs "document.title"
 *   node scripts/drive.mjs --file probe.js
 */
import { readFile } from 'node:fs/promises'

const PORT = process.env.CDP_PORT || 9222

async function pageTarget () {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('No page target. Is the app running with --remote-debugging-port?')
  return page.webSocketDebuggerUrl
}

async function evaluate (expression) {
  const ws = new WebSocket(await pageTarget())
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  const result = await new Promise((resolve, reject) => {
    const id = 1
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== id) return
      if (msg.result?.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.exception?.description || 'threw'))
      } else {
        resolve(msg.result?.result?.value)
      }
    })
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true }
    }))
    setTimeout(() => reject(new Error('timed out')), 10000)
  })

  ws.close()
  return result
}

/** A real mouse click, which goes through hit-testing rather than posAtCoords. */
export async function click (x, y) {
  const ws = new WebSocket(await pageTarget())
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  let id = 0
  const send = (method, params) => new Promise((res) => {
    const mine = ++id
    const onMsg = (e) => {
      const m = JSON.parse(e.data)
      if (m.id === mine) { ws.removeEventListener('message', onMsg); res(m) }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id: mine, method, params }))
  })
  const base = { x, y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
  ws.close()
}

const args = process.argv.slice(2)
if (args[0] === '--click') {
  await click(Number(args[1]), Number(args[2]))
  console.log('clicked', args[1], args[2])
  process.exit(0)
}

const expression = args[0] === '--file'
  ? await readFile(args[1], 'utf8')
  : args[0]

try {
  const value = await evaluate(expression)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
} catch (err) {
  console.error('ERROR:', err.message)
  process.exit(1)
}
