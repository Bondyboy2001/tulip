import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import electron from 'electron'
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export async function appSession ({ executable = null, files = {}, config = {} } = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'tulip-session-check-'))
  const vault = path.join(scratch, 'vault')
  const profile = path.join(scratch, 'profile')
  await mkdir(vault); await mkdir(profile)
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(vault, name)), { recursive: true })
    await writeFile(path.join(vault, name), text)
  }
  await writeFile(path.join(profile, 'config.json'), JSON.stringify({ vaultPath: vault, ...config }))
  const port = await new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
  })
  let child
  const sockets = new Map()
  let commandId = 0
  let tail = ''
  function launch () {
    /* The project's own Electron runs the app in the working directory; a
       packaged executable is the app. A Windows electron path uses
       backslashes, and reading it as a packaged binary launched Electron with
       no path at all — the usage banner and a 45-second wait. */
    const dev = !executable || /node_modules[\\/]electron[\\/]/.test(executable)
    child = spawn(executable || electron, [...(dev ? ['.'] : []), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--disable-gpu'], {
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TULIP_TEST_WINDOW_HIDDEN: '1' }
    })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (text) => { tail = (tail + text).slice(-6000) })
  }
  async function targets () { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page' && t.url.includes('index.html')) }
  async function command (method, params = {}, targetId = null) {
    const pages = await targets()
    const target = targetId ? pages.find((p) => p.id === targetId) : pages[0]
    if (!target) throw new Error('No renderer target')
    let socket = sockets.get(target.id)
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      socket = new WebSocket(target.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
      sockets.set(target.id, socket)
    }
    const id = ++commandId
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 30000)
        const receive = ({ data }) => {
          const reply = JSON.parse(data)
          if (reply.id !== id) return
          clearTimeout(timeout)
          socket.removeEventListener('message', receive)
          if (reply.error || reply.result?.exceptionDetails) reject(new Error(JSON.stringify(reply.error || reply.result.exceptionDetails)))
          else resolve(reply.result)
        }
        socket.addEventListener('message', receive)
        socket.send(JSON.stringify({ id, method, params }))
      })
    } finally { /* Keep the CDP session, including enabled metrics, alive. */ }
  }
  async function evaluate (expression, targetId = null) {
    return (await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, targetId)).result?.value
  }
  async function ready () {
    let last
    /* Two minutes, not 45 seconds: a hosted Windows runner under Defender
       takes longer to bring the window up than a developer machine, and tests
       that failed on the clock were reported as app failures. */
    for (let i = 0; i < 480; i++) {
      try { if (await evaluate('Boolean(window.__tulip && document.querySelector("#boot-screen")?.hidden)')) return } catch (error) { last = error }
      if (child.exitCode != null || child.signalCode != null) throw new Error(`App exited: ${tail}`)
      await delay(250)
    }
    throw new Error(`App not ready: ${last}\n${tail}`)
  }
  async function stop () {
    for (const socket of sockets.values()) socket.close()
    sockets.clear()
    if (child.exitCode != null || child.signalCode != null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    else spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    await exited
  }
  launch()
  try { await ready() } catch (error) { await stop(); await rm(scratch, { recursive: true, force: true }); throw error }
  return { vault, profile, scratch, evaluate, command, targets, stop,
    restart: async () => { await stop(); launch(); await ready() },
    dispose: async () => { await stop(); await rm(scratch, { recursive: true, force: true }) }
  }
}
export function pdfFixture (count = 1) {
  const objects = ['', '']
  const pages = []
  for (let i = 0; i < count; i++) {
    const page = objects.length + 1
    pages.push(`${page} 0 R`)
    const stream = `BT /F1 18 Tf 40 120 Td (Research page ${i + 1}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${page + 1} 0 R >>`)
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[1] = `<< /Type /Pages /Kids [${pages.join(' ')}] /Count ${count} >>`
  let text = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(text)
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  return text + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}
