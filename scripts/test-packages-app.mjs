import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { appSession, delay } from './lib/app-session.mjs'
if (!process.env.TULIP_NET_TESTS && !process.argv[2]) { console.log('packages app: skipped (set TULIP_NET_TESTS=1 or supply an installed app)'); process.exit(0) }
const code = 'use utf8_slice;\nfn main() { println!("{}", utf8_slice::slice("The 🚀 goes", 4, 5)); }'
const app = await appSession({ executable: process.argv[2] || null, files: { 'Packages.md': '# Packages\n\n```rust\n' + code + '\n```\n' }, config: { tabs: ['Packages.md'], tabIndex: 0, autoInstallPackages: true } })
try {
  const configPath = path.join(app.profile, 'config.json')
  await app.stop()
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  await writeFile(configPath, JSON.stringify({ ...config, trustedVaults: [app.vault] }))
  await app.restart()
  await app.evaluate(`window.__tulip.openNote('Packages.md')`)
  await app.evaluate(`(() => { window.packageEvents = []; window.tulip.on('run:out', e => window.packageEvents.push(e)); window.tulip.on('run:done', e => window.packageEvents.push({ ...e, done: true })); return true })()`)
  async function run (lang, source) {
    const { id } = await app.evaluate(`window.tulip.run.start(${JSON.stringify(lang)}, ${JSON.stringify(source)}, 'Packages.md')`)
    for (let i = 0; i < 600; i++) {
      const result = await app.evaluate(`window.packageEvents.find(e => e.id === ${id} && e.done) || null`)
      if (result) {
        const text = await app.evaluate(`window.packageEvents.filter(e => e.id === ${id}).map(e => e.text || '').join('')`)
        assert.equal(result.code, 0, text + JSON.stringify(result))
        return text
      }
      await delay(100)
    }
    throw new Error('Run did not finish')
  }
  assert.match(await run('rust', code), /🚀/)
  assert.doesNotMatch(await run('rust', code), /Installing /)
  assert.match(await run('ts', 'const message: string = "TypeScript works"; console.log(message)'), /TypeScript works/)
  const record = await app.evaluate(`window.tulip.packages.manage('Packages.md', 'rust')`)
  assert.ok(record.packages.utf8_slice)
  await app.evaluate(`window.__tulip.runCommand('manage-packages'); true`)
  for (let i = 0; i < 100; i++) {
    if (await app.evaluate(`document.querySelector('.packages-list')?.textContent.includes('utf8_slice') || false`)) break
    await delay(50)
  }
  assert.equal(await app.evaluate(`document.querySelector('.packages-dialog')?.open`), true)
  assert.match(await app.evaluate(`document.querySelector('.packages-list').textContent`), /utf8_slice/)
  const style = await app.evaluate(`(() => { const d = document.querySelector('.packages-dialog'); const b = d.getBoundingClientRect(); return { width: b.width, scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, color: getComputedStyle(d).backgroundColor } })()`)
  assert.ok(style.width > 400 && style.width < 800, JSON.stringify(style))
  assert.ok(style.scrollWidth <= style.clientWidth + 1)
  await mkdir('output/playwright', { recursive: true })
  const shot = await app.command('Page.captureScreenshot', { format: 'png' })
  await writeFile('output/playwright/packages.png', Buffer.from(shot.data, 'base64'))
  await app.evaluate(`document.querySelector('.packages-dialog').close(); true`)
  const { id } = await app.evaluate(`window.tulip.run.start('node', 'setTimeout(() => {}, 20000)', 'Packages.md')`)
  assert.equal(await app.evaluate(`window.tulip.run.kill(${id})`), true)
  await delay(500)
  assert.equal(await app.evaluate(`window.packageEvents.find(e => e.id === ${id} && e.done)?.signal`), 'SIGTERM')
  await app.restart()
  assert.equal((await app.evaluate(`window.tulip.packages.manage('Packages.md', 'rust')`)).packages.utf8_slice, record.packages.utf8_slice)
  console.log('packages app: real Rust import/install/repeat, TypeScript, panel, Stop and restart passed')
} finally { await app.dispose() }
