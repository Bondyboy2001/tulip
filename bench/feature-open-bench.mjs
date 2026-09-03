#!/usr/bin/env node
/* Cold first-open timings for the lazy surfaces boot benchmarks deliberately
 * exclude. One real renderer opens each route once, so every number includes
 * fetching, parsing, evaluating, mounting and drawing that feature's first
 * usable frame. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import electron from 'electron'

const require = createRequire(import.meta.url)
const { blankDocxBuffer } = require('../electron/docx.js')
const { emptyWhiteboard } = require('../electron/whiteboard-data.js')
const ROOT = path.resolve(import.meta.dirname, '..')
const CHECK = process.argv.includes('--check')
const PORT = 9900 + Math.floor(Math.random() * 80)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return body
}

const scratch = await mkdtemp(path.join(os.tmpdir(), 'tulip-feature-bench-'))
const profile = path.join(scratch, 'profile')
const vault = path.join(scratch, 'vault')
await mkdir(profile, { recursive: true })
await mkdir(vault, { recursive: true })
await writeFile(path.join(vault, 'Welcome.md'), '# Welcome\n\nCold route bench.\n')
await writeFile(path.join(vault, 'Data.csv'), 'name,value\nalpha,1\nbeta,2\n')
await writeFile(path.join(vault, 'Notebook.ipynb'), JSON.stringify({
  cells: [{ cell_type: 'markdown', id: 'intro', metadata: {}, source: ['# Notebook'] }],
  metadata: {}, nbformat: 4, nbformat_minor: 5
}))
await writeFile(path.join(vault, 'Document.docx'), blankDocxBuffer())
await writeFile(path.join(vault, 'Paper.pdf'), pdfFixture())
await writeFile(path.join(vault, 'Board.excalidraw'), `${emptyWhiteboard()}\n`)
await writeFile(path.join(profile, 'config.json'), `${JSON.stringify({
  vaultPath: vault, tabs: ['Welcome.md'], tabIndex: 0, view: 'read'
})}\n`)

const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--disable-gpu'], {
  cwd: ROOT, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe']
})
let tail = ''
child.stderr.on('data', (chunk) => { tail = (tail + chunk).slice(-5000) })

async function target () {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((one) => one.type === 'page' && one.webSocketDebuggerUrl &&
        one.url && one.url !== 'about:blank')
      if (page) return page.webSocketDebuggerUrl
    } catch { /* still launching */ }
    await sleep(60)
  }
  throw new Error(`no renderer target\n${tail}`)
}

async function evaluateOnce (expression) {
  const socket = new WebSocket(await target())
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`feature probe timed out\n${tail}`)), 45000)
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      clearTimeout(timer)
      socket.close()
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error(message.error?.message || message.result.exceptionDetails.exception?.description))
      } else resolve(message.result.result.value)
    })
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression, awaitPromise: true, returnByValue: true
    } }))
  })
}

async function evaluate (expression) {
  let last
  for (let attempt = 0; attempt < 8; attempt++) {
    try { return await evaluateOnce(expression) } catch (error) {
      last = error
      if (!String(error?.message || error).includes('Execution context was destroyed')) throw error
      await sleep(150)
    }
  }
  throw last
}

try {
  const results = await evaluate(`(async () => {
    const wait = async (test, label) => {
      const deadline = performance.now() + 20000
      while (!test()) {
        if (performance.now() > deadline) throw new Error('timed out opening ' + label)
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
    await wait(() => document.querySelector('.row[data-path="Welcome.md"]'), 'vault')
    const timings = {}
    const action = async (label, run, ready) => {
      const start = performance.now()
      await run()
      await wait(ready, label)
      timings[label] = Math.round((performance.now() - start) * 10) / 10
    }
    const open = (file) => window.__tulip.openNote(file)
    await action('settings', () => window.__tulip.settings.open(),
      () => !document.querySelector('#settings').hidden && document.querySelector('#settings-body').children.length)
    document.querySelector('#settings-close').click()
    await action('copilot', () => window.__tulip.runCommand('copilot'),
      () => document.querySelector('#app').dataset.ai === 'open' && document.querySelector('#ai-input'))
    document.querySelector('#ai-close').click()
    await action('csv', () => open('Data.csv'),
      () => !document.querySelector('#data').hidden && document.querySelector('.csv-frame'))
    await action('notebook', () => open('Notebook.ipynb'),
      () => !document.querySelector('#notebook').hidden && document.querySelector('#notebook').children.length)
    await action('docx', () => open('Document.docx'),
      () => !document.querySelector('#docx').hidden && document.querySelector('#docx').children.length)
    await action('pdf', () => open('Paper.pdf'),
      () => !document.querySelector('#pdf').hidden && document.querySelector('.pdf-page'))
    await action('whiteboard', () => open('Board.excalidraw'),
      () => !document.querySelector('#whiteboard').hidden && document.querySelector('#whiteboard').children.length)
    return timings
  })()`)

  console.log(JSON.stringify(results, null, 2))
  if (CHECK) {
    /* Local ceilings are several times the measured cold values, but still
       tight enough to catch a route accidentally becoming eager work done on
       its first click. Hosted runners get the same proportional room as the
       boot/table gates: contention is weather, an order-of-magnitude jump is
       a regression. */
    const limits = process.env.CI
      ? { settings: 900, copilot: 900, csv: 900, notebook: 1200, docx: 1200, pdf: 1800, whiteboard: 2600 }
      : { settings: 350, copilot: 350, csv: 350, notebook: 450, docx: 450, pdf: 700, whiteboard: 1000 }
    const over = Object.entries(limits).filter(([name, limit]) => !(results[name] <= limit))
    if (over.length) {
      console.error('cold feature open is slower than its budget: ' +
        over.map(([name, limit]) => `${name} ${results[name] ?? 'missing'}ms > ${limit}ms`).join(', '))
      process.exitCode = 1
    } else console.log('cold feature-open performance gate passed')
  }
} finally {
  if (child.exitCode == null) {
    if (process.platform === 'win32') child.kill()
    else process.kill(-child.pid, 'SIGTERM')
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3000).then(() => {
      if (child.exitCode == null) {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      }
    })
  ])
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
