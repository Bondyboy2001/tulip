#!/usr/bin/env node
/* Launches the application exactly where packaging left it and drives its
 * public preload bridge over CDP. File-presence and signature checks prove a
 * bundle was assembled; this proves the executable, main process, preload,
 * renderer and vault write path work together in that bundle. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

function pdfFixture () {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 43 >>\nstream\nBT /F1 18 Tf 40 120 Td (Tulip PDF) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return body
}

const executable = process.argv[2]
if (!executable) {
  // scripts/run-tests.mjs discovers every test-*.mjs before a package exists.
  // Packaging jobs call this script with the exact executable and exercise the
  // strict path below; the source-test phase has nothing meaningful to launch.
  console.log('packaged app smoke: skipped (no packaged executable supplied)')
  process.exit(0)
}

const scratch = await mkdtemp(path.join(os.tmpdir(), 'tulip-package-smoke-'))
const profile = path.join(scratch, 'profile')
const vault = path.join(scratch, 'vault')
await mkdir(profile, { recursive: true })
await mkdir(vault, { recursive: true })
await writeFile(path.join(profile, 'config.json'), `${JSON.stringify({ vaultPath: vault })}\n`)
await writeFile(path.join(vault, 'Smoke.md'), '# Packaged smoke\n\nBefore.\n')
await writeFile(path.join(vault, 'Paper.pdf'), pdfFixture())
await writeFile(path.join(vault, 'Reference.md'), '# Reference\n\n' + 'A paragraph to keep beside the paper.\n\n'.repeat(150))

const port = await new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    server.close(() => resolve(address.port))
  })
})

const output = []
const launch = () => spawn(executable, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  '--disable-gpu'
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  /* Exercise the real installed executable without flashing a window or
     stealing focus from the desktop. electron/main.js keeps its initial
     BrowserWindow hidden when this harness-only switch is present. */
  env: { ...process.env, TULIP_TEST_WINDOW_HIDDEN: '1' }
})
let child = launch()
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    output.push(chunk)
    if (output.length > 80) output.shift()
  })
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let preferredTarget = null
async function pageTarget () {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`packaged app exited ${child.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => (!preferredTarget || target.id === preferredTarget) && target.type === 'page' && target.webSocketDebuggerUrl &&
        target.url && target.url !== 'about:blank')
      if (page) return page.webSocketDebuggerUrl
    } catch { /* the debug server is not listening yet */ }
    await delay(100)
  }
  throw new Error('timed out waiting for the packaged renderer')
}

async function evaluateOnce (expression) {
  const socket = new WebSocket(await pageTarget())
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('packaged renderer probe timed out')), 20000)
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        if (message.id !== 1) return
        clearTimeout(timer)
        if (message.result?.exceptionDetails) {
          reject(new Error(message.result.exceptionDetails.exception?.description || 'renderer probe threw'))
        } else {
          const remote = message.result?.result
          if (!remote || !Object.hasOwn(remote, 'value')) {
            reject(new Error(`renderer probe returned no value: ${JSON.stringify(message)}`))
          } else {
            resolve(remote.value)
          }
        }
      })
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      }))
    })
  } finally {
    socket.close()
  }
}

async function evaluate (expression) {
  let last
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await evaluateOnce(expression)
    } catch (error) {
      last = error
      if (!String(error?.message || error).includes('Execution context was destroyed')) throw error
      await delay(150)
    }
  }
  throw last
}

const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((target) => target.type === 'page' && target.url.includes('index.html'))
async function stop () {
  const exited = new Promise((resolve) => child.once('exit', resolve))
  if (process.platform === 'darwin') {
    const quit = spawn('/usr/bin/osascript', ['-e', 'tell application id "com.hb.tulip" to quit'], { stdio: 'ignore' })
    await new Promise((resolve) => quit.once('exit', resolve))
  } else if (process.platform === 'win32') {
    /* A plain kill reaps the main process and leaves Chromium's children
       holding the profile — the removal below then fails with EBUSY. */
    await delay(700)
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else { await delay(700); child.kill('SIGTERM') }
  await Promise.race([exited, delay(5000).then(() => child.kill('SIGKILL'))])
}
async function ready () {
  return evaluate(`(async () => {
    const end = Date.now() + 15000
    while ((!window.__tulip?.state?.vault || document.querySelector('#app')?.hasAttribute('data-booting')) && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return Boolean(window.__tulip?.state?.vault)
  })()`)
}
try {
  assert.equal(await ready(), true)
  const initial = (await targets())[0]
  preferredTarget = initial.id
  const ui = await evaluate(`(async () => {
    await window.__tulip.openNote('Smoke.md')
    const motion = []
    for (const mode of ['view-read', 'view-edit']) {
      window.__tulip.runCommand(mode)
      await new Promise((resolve) => setTimeout(resolve, 100))
      for (let turn = 0; turn < 2; turn++) {
        window.__tulip.runCommand('sidebar')
        const started = performance.now()
        const frames = []
        while (performance.now() - started < 390) {
          await new Promise((resolve) => requestAnimationFrame(resolve))
          const stage = document.querySelector('#stage').getBoundingClientRect()
          const tools = document.querySelector('.doc-tools').getBoundingClientRect()
          frames.push({ at: performance.now() - started, width: stage.width, left: stage.left, tools: tools.left })
        }
        const late = frames.filter((frame) => frame.at >= 240)
        const settled = frames[frames.length - 1]
        if (late.some((frame) => Math.abs(frame.width - settled.width) > 1)) throw new Error('Document width changed at the end of the sidebar animation')
        if (late.some((frame) => Math.abs(frame.left - settled.left) > 4)) throw new Error('Document snapped at the end of the sidebar animation')
        if (late.some((frame) => Math.abs(frame.tools - settled.tools) > 4)) throw new Error('Toolbar snapped at the end of the sidebar animation')
        motion.push({ mode, frames: frames.length })
      }
    }
    window.__tulip.runCommand('view-read')
    const zoomStarted = performance.now()
    await Promise.all([1.25, 1.5, 1.75, 1.5, 1.25].map((factor) => window.tulip.zoom.set(factor)))
    if ((await window.tulip.config.get()).zoom !== 1.25) throw new Error('Rapid zoom did not reach the latest requested size')
    if (document.documentElement.style.width || document.documentElement.style.height) throw new Error('Zoom left a temporary page resize behind')
    if (performance.now() - zoomStarted > 1500) throw new Error('Rapid zoom requests backed up')
    await window.tulip.zoom.set(1.5)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const toolsRemoved = !document.querySelector('#workspace-tools')
    const sidebarButton = document.querySelector('#sidebar-open')
    const sidebarIcon = Boolean(sidebarButton.querySelector('svg')) && sidebarButton.textContent.trim() === ''
    if (document.querySelector('#app').dataset.sidebar === 'open') window.__tulip.runCommand('sidebar')
    sidebarButton.click()
    const sidebarOpened = document.querySelector('#app').dataset.sidebar === 'open'
    const toggleVisible = getComputedStyle(sidebarButton).display !== 'none'
    sidebarButton.click()
    const sidebarClosed = document.querySelector('#app').dataset.sidebar === 'closed'
    sidebarButton.click()
    window.__tulip.runCommand('shortcuts')
    const search = document.querySelector('#shortcuts-search')
    search.value = 'copilot'
    search.dispatchEvent(new Event('input'))
    const visibleShortcuts = [...document.querySelectorAll('.shortcuts-row:not([hidden])')].map((row) => row.textContent)
    document.querySelector('#shortcuts-close').click()
    window.__tulip.runCommand('open-beside')
    await new Promise((resolve) => setTimeout(resolve, 250))
    const beside = document.querySelector('#app').dataset.side
    await window.__tulip.openNote('Paper.pdf')
    document.querySelector('#sidepane-swap').click()
    await new Promise((resolve) => setTimeout(resolve, 800))
    const swapMain = window.__tulip.state.current?.path
    const sideTitle = document.querySelector('#sidepane-title').textContent
    window.__tulip.runCommand('save-workspace')
    const form = document.querySelector('dialog.workspace-tools form')
    form.querySelector('input').value = 'Research'
    form.requestSubmit()
    while (document.querySelector('dialog.workspace-tools')) await new Promise((resolve) => setTimeout(resolve, 50))
    await window.__tulip.openNote('Reference.md')
    window.__tulip.runCommand('open-beside')
    await window.__tulip.openNote('Smoke.md')
    await new Promise((resolve) => setTimeout(resolve, 500))
    document.querySelector('#sidepane-body').scrollTop = 250
    await new Promise((resolve) => setTimeout(resolve, 350))
    if ((await window.tulip.config.get()).sideScroll < 200) throw new Error('Side reading position was not saved')
    await window.tulip.window.open('Paper.pdf')
    return { toolsRemoved, sidebarIcon, sidebarOpened, toggleVisible, sidebarClosed, visibleShortcuts, beside, swapMain, sideTitle }
  })()`)
  assert.equal(ui.toolsRemoved, true)
  assert.equal(ui.sidebarIcon, true)
  assert.equal(ui.sidebarOpened, true)
  assert.equal(ui.toggleVisible, true)
  assert.equal(ui.sidebarClosed, true)
  assert.equal(ui.visibleShortcuts.length, 2)
  assert.equal(ui.beside, 'open')
  assert.equal(ui.swapMain, 'Smoke.md')
  assert.match(ui.sideTitle, /Paper/)
  let pages
  for (let i = 0; i < 50; i++) { pages = await targets(); if (pages.length === 2) break; await delay(100) }
  assert.equal(pages.length, 2)
  preferredTarget = pages.find((page) => page.id !== initial.id).id
  assert.equal(await ready(), true)
  const second = await evaluate(`(async () => {
    await window.__tulip.openNote('Paper.pdf')
    await window.tulip.config.set({ tabPlaces: [1] })
    return { path: window.__tulip.state.current?.path, copilotVisible: !document.querySelector('#ai-toggle').hidden }
  })()`)
  assert.equal(second.path, 'Paper.pdf')
  assert.equal(second.copilotVisible, true)
  await evaluate(`window.tulip.workspace.save('Two windows')`)
  await evaluate(`window.tulip.config.set({ sideWidth: 411 })`)
  await stop()
  preferredTarget = null
  child = launch()
  child.stdout.resume(); child.stderr.resume()
  assert.equal(await ready(), true)
  for (let i = 0; i < 50; i++) { pages = await targets(); if (pages.length === 2) break; await delay(100) }
  assert.equal(pages.length, 2, 'both windows return after relaunch')
  const restored = []
  for (const page of pages) {
    preferredTarget = page.id
    await ready()
    restored.push(await evaluate(`({ path: window.__tulip.state.current?.path, side: document.querySelector('#sidepane-title').textContent, copilotVisible: !document.querySelector('#ai-toggle').hidden, sideScroll: document.querySelector('#sidepane-body').scrollTop })`))
  }
  assert.deepEqual(restored.map((item) => item.path).sort(), ['Paper.pdf', 'Smoke.md'])
  assert.ok(restored.every((item) => item.copilotVisible))
  assert.match(restored.find((item) => item.path === 'Smoke.md').side, /Reference/)
  assert.ok(restored.find((item) => item.path === 'Smoke.md').sideScroll >= 200, 'side reading position returns')
  await evaluate(`if (document.querySelector('#app').dataset.sidebar === 'open') window.__tulip.runCommand('sidebar'); true`)
  const socket = new WebSocket(await pageTarget())
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
  const shot = await new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => {
      const result = JSON.parse(event.data)
      if (result.id === 50) result.error ? reject(new Error(result.error.message)) : resolve(result.result.data)
    })
    socket.send(JSON.stringify({ id: 50, method: 'Page.captureScreenshot', params: { format: 'png' } }))
  })
  socket.close()
  await writeFile(path.join(os.tmpdir(), 'tulip-workspace-tools.png'), Buffer.from(shot, 'base64'))
  console.log('installed workspace: smooth reading/editing sidebar transitions, icon-only sidebar opener, no Tools button, shortcut filtering, side-pane swap, independent Copilot visibility, and two-window relaunch passed')
} catch (error) {
  console.error(output.join('').slice(-3000))
  throw error
} finally {
  if (child.exitCode == null) await stop()
  /* A Windows profile holds a few files open for a beat after the process
     tree is gone; a removal that lands in that beat is EBUSY. */
  for (let attempt = 0; attempt < 10; attempt++) {
    try { await rm(scratch, { recursive: true, force: true }); break } catch { await delay(500) }
  }
}
