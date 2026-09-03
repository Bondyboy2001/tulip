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
], { stdio: ['ignore', 'pipe', 'pipe'] })
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    output.push(chunk)
    if (output.length > 80) output.shift()
  })
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function pageTarget () {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`packaged app exited ${child.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl &&
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
    await window.__tulip.runCommand('setup')
    while ((document.querySelector('#settings')?.hidden ||
      document.querySelector('#settings-title')?.textContent !== 'Getting started') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const setupTitle = document.querySelector('#settings-title')?.textContent
    const setupText = document.querySelector('#settings-body')?.textContent || ''
    document.querySelector('#settings-close')?.click()
    return {
      version: await window.tulip.version(),
      vault: current && current.path,
      preload: typeof window.tulip.file.write === 'function',
      renderer: Boolean(document.querySelector('#app')),
      landingHidden: Boolean(document.querySelector('#landing')?.hidden),
      writeOk: write?.ok !== false,
      readBack: after.endsWith('After.\\n'),
      setupTitle,
      setupHasBackupHealth: setupText.includes('Last verified backup') &&
        setupText.includes('No verified backup has been recorded yet.')
    }
  })()`)

  assert.match(result.version, /^\d+\.\d+\.\d+$/)
  assert.equal(path.resolve(result.vault), path.resolve(vault))
  assert.equal(result.preload, true)
  assert.equal(result.renderer, true)
  assert.equal(result.landingHidden, true)
  assert.equal(result.writeOk, true)
  assert.equal(result.readBack, true)
  assert.equal(result.setupTitle, 'Getting started')
  assert.equal(result.setupHasBackupHealth, true)
  assert.match(await readFile(path.join(vault, 'Smoke.md'), 'utf8'), /After\.\n$/)
  console.log(`packaged app smoke: ${result.version}, renderer/preload/vault write/setup guidance passed`)
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
