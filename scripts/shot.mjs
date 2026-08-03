/**
 * A screenshot of the running renderer, over the DevTools protocol.
 *
 *   CDP_PORT=9391 node scripts/shot.mjs out.png [selector]
 *
 * With a selector, the shot is clipped to that element — which is usually what
 * you want when judging one piece of chrome rather than the whole window.
 */
import { writeFile } from 'node:fs/promises'

const PORT = process.env.CDP_PORT || 9222
const [out, selector] = process.argv.slice(2)

const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
const page = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) throw new Error('no page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) })

let id = 0
const send = (method, params) => new Promise((resolve) => {
  const mine = ++id
  const onMsg = (e) => {
    const m = JSON.parse(e.data)
    if (m.id === mine) { ws.removeEventListener('message', onMsg); resolve(m.result) }
  }
  ws.addEventListener('message', onMsg)
  ws.send(JSON.stringify({ id: mine, method, params }))
})

let clip
if (selector) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => { const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null; const b = e.getBoundingClientRect();
      return JSON.stringify({ x: b.x - 14, y: b.y - 14, width: b.width + 28, height: b.height + 28 }) })()`,
    returnByValue: true
  })
  if (r?.result?.value) clip = { ...JSON.parse(r.result.value), scale: 2 }
}

const shot = await send('Page.captureScreenshot', clip ? { clip, captureBeyondViewport: true } : {})
await writeFile(out, Buffer.from(shot.data, 'base64'))
ws.close()
console.log('wrote', out)
