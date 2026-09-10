#!/usr/bin/env node
/* Launches the application exactly where packaging left it and drives its
 * public preload bridge over CDP. File-presence and signature checks prove a
 * bundle was assembled; this proves the executable, main process, preload,
 * renderer and vault write path work together in that bundle. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

const port = await new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    server.close(() => resolve(address.port))
  })
})

const output = []
const child = spawn(executable, [
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
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    output.push(chunk)
    if (output.length > 80) output.shift()
  })
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let targetPage = 'index.html'
async function pageTarget () {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`packaged app exited ${child.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl &&
        target.url && target.url.endsWith('/' + targetPage))
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

try {
  const result = await evaluate(`(async () => {
    const deadline = Date.now() + 20000
    while ((!window.tulip || !document.querySelector('#tree')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!window.tulip) throw new Error('preload bridge did not arrive')
    const current = await window.tulip.vault.current()
    const before = await window.tulip.file.read('Smoke.md')
    const write = await window.tulip.file.write('Smoke.md', before + '\\nAfter.\\n')
    const after = await window.tulip.file.read('Smoke.md')
    await window.tulip.durability.flush()
    if (!window.__tulip) throw new Error('renderer test handle did not arrive')
    const pdfStarted = performance.now()
    let sawPdfLoading = false
    const openingPdf = window.__tulip.openNote('Paper.pdf')
    while (!document.querySelector('.pdf-page') && Date.now() < deadline) {
      sawPdfLoading ||= Boolean(document.querySelector('#pdf')?.classList.contains('is-loading'))
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    const pdfOpened = await openingPdf
    return {
      version: await window.tulip.version(),
      vault: current && current.path,
      preload: typeof window.tulip.file.write === 'function',
      renderer: Boolean(document.querySelector('#app')),
      landingHidden: Boolean(document.querySelector('#landing')?.hidden),
      writeOk: write?.ok !== false,
      readBack: after.endsWith('After.\\n'),
      pdfOpened,
      pdfLoadingSeen: sawPdfLoading,
      pdfPageReady: Boolean(document.querySelector('.pdf-page')),
      pdfOpenMs: Math.round((performance.now() - pdfStarted) * 10) / 10
    }
  })()`)

  await evaluate(`window.tulip.settings.open()`)
  targetPage = 'settings-window.html'
  const settingsResult = await evaluate(`(async () => {
    const deadline = Date.now() + 20000
    while ((document.querySelector('#settings')?.hidden ||
      document.querySelector('#settings-title')?.textContent !== 'Appearance') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const tabs = [...document.querySelectorAll('.settings-tab')].map((tab) => tab.textContent)
    const selectSettings = (label) => [...document.querySelectorAll('.settings-tab')].find((tab) => tab.textContent === label)?.click()
    selectSettings('Editor')
    const readable = () => document.querySelector('[data-setting="readableWidth"] .switch')
    readable().focus()
    readable().click()
    /* With readable length off the widths stay pickable: choosing one is the
       gesture that turns readable length back on — see the change handler in
       src/settings.js, and the width-preset test that holds it. */
    const widthEnabledWhileOff = [...document.querySelectorAll('[data-setting="measure"] button')].every((button) => !button.disabled)
    const toggleKeptFocus = document.activeElement === readable()
    readable().click()
    const widthEnabled = [...document.querySelectorAll('[data-setting="measure"] button')].every((button) => !button.disabled)
    const search = document.querySelector('.settings-search-field')
    // By a word in the row's own name: the old key spelled Python, the setting
    // no longer does, and the search reads names, groups and keys.
    search.value = 'packages'
    search.dispatchEvent(new Event('input'))
    document.querySelector('.settings-suggest-row')?.click()
    const searchDestination = document.querySelector('#settings-title').textContent
    const foundSetting = document.querySelector('.settings-row.is-found')?.dataset.setting
    search.value = 'zzzznonexistent'
    search.dispatchEvent(new Event('input'))
    const noResults = document.querySelector('.settings-search-empty')?.textContent
    search.value = ''
    search.dispatchEvent(new Event('input'))
    selectSettings('General')
    const setupTitle = document.querySelector('#settings-title')?.textContent
    const setupText = document.querySelector('#settings-body')?.textContent || ''



    selectSettings('Shortcuts')
    while (!document.querySelector('.hotkey-name') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    const shortcutNames = [...document.querySelectorAll('.hotkey-name')].map(row => row.textContent)
    return {
      settingsChecks: { tabs, widthEnabledWhileOff, widthEnabled, toggleKeptFocus, searchDestination, foundSetting, noResults },
      setupTitle, setupHasVaultDefault: setupText.includes('Default vault') && setupText.includes('Last open'),
      shortcutNames, settingsWindow: document.body.classList.contains('settings-window'),
      hints: document.querySelectorAll('.settings-label .settings-hint').length
    }
  })()`)
  Object.assign(result, settingsResult)
  assert.equal(result.settingsWindow, true)
  assert.equal(result.hints, 0)
  assert.ok(result.shortcutNames.length > 10)
  assert.deepEqual(result.shortcutNames, [...result.shortcutNames].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })))
  const originalTheme = await evaluate(`(async () => {
    const config = await window.tulip.config.get()
    await window.tulip.config.set({ theme: 'dark' })
    return config.theme || 'light'
  })()`)
  targetPage = 'index.html'
  const themeChanged = await evaluate(`(async () => {
    const deadline = Date.now() + 3000
    while (document.documentElement.dataset.theme !== 'midnight' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    return document.documentElement.dataset.theme
  })()`)
  assert.equal(themeChanged, 'midnight', 'legacy dark setting maps to Midnight and repaints the document window')
  targetPage = 'settings-window.html'
  await evaluate(`window.tulip.config.set({ theme: ${JSON.stringify(originalTheme)} })`)
  // A second open focuses the existing utility window.
  await evaluate(`window.tulip.settings.open()`)
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  assert.equal(targets.filter(target => target.url?.endsWith('/settings-window.html')).length, 1)

  assert.match(result.version, /^\d+\.\d+\.\d+$/)
  assert.equal(path.resolve(result.vault), path.resolve(vault))
  assert.equal(result.preload, true)
  assert.equal(result.renderer, true)
  assert.equal(result.landingHidden, true)
  assert.equal(result.writeOk, true)
  assert.equal(result.readBack, true)
  assert.deepEqual(result.settingsChecks.tabs, ['Appearance', 'General', 'Shortcuts', 'Editor', 'Documents', 'Study', 'Copilot'])
  assert.equal(result.settingsChecks.widthEnabledWhileOff, true,
    'picking a width is the gesture that turns readable length back on')
  assert.equal(result.settingsChecks.widthEnabled, true)
  assert.equal(result.settingsChecks.toggleKeptFocus, true)
  assert.equal(result.settingsChecks.searchDestination, 'Documents')
  assert.equal(result.settingsChecks.foundSetting, 'autoInstallPackages')
  assert.equal(result.settingsChecks.noResults, 'No settings found')
  assert.equal(result.setupTitle, 'General')
  assert.equal(result.setupHasVaultDefault, true)
  assert.equal(result.pdfOpened, true)
  assert.equal(result.pdfLoadingSeen, true)
  assert.equal(result.pdfPageReady, true)
  assert.match(await readFile(path.join(vault, 'Smoke.md'), 'utf8'), /After\.\n$/)
  console.log(`packaged app smoke: ${result.version}, renderer/preload/vault write/settings/PDF passed ` +
    `(${result.pdfOpenMs}ms PDF open)`)
} catch (error) {
  if (output.length) console.error(output.join('').slice(-8000))
  throw error
} finally {
  if (child.exitCode == null) child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(3000).then(() => { if (child.exitCode == null) child.kill('SIGKILL') })
  ])
  await rm(scratch, { recursive: true, force: true })
}
