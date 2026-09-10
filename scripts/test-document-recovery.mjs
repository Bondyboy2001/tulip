import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'
import { appSession, delay } from './lib/app-session.mjs'
const { backupVault } = createRequire(import.meta.url)('../electron/vault-backup')
const app = await appSession({ executable: process.argv[2], files: { 'Note.md': '# Note\n\nOriginal backup.\n', 'Other.md': 'Other' }, config: { tabs: ['Note.md'], tabIndex: 0, view: 'edit' } })
async function waitFor (expression) {
  for (let i = 0; i < 300; i++) { if (await app.evaluate(expression)) return; await delay(100) }
  throw new Error('Timed out: ' + expression)
}
try {
  const backup = path.join(app.scratch, 'copy.tulip-backup')
  await backupVault(app.vault, backup)
  await app.stop()
  const configPath = path.join(app.profile, 'config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const key = createHash('sha256').update(app.vault).digest('hex')
  config.backupPlans = { [key]: { lastPath: backup, lastSuccess: Date.now() } }
  await writeFile(configPath, JSON.stringify(config))
  await app.restart()
  await app.evaluate('window.tulip.file.write("Note.md", "# Note\\n\\nNewer saved text.\\n")')
  await app.evaluate('window.tulip.recovery.record({kind:"conflict",path:"Other.md"})')
  /* The command can land before the restored window has finished reading its
     stores — the palette is one IPC call and the app is still coming up — so
     an empty panel is retried rather than waited on once. */
  const openRecovery = async (ready) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      await app.evaluate('window.__tulip.runCommand("recover-document"); true')
      for (let i = 0; i < 30; i++) {
        if (await app.evaluate(ready)) return
        await delay(200)
      }
    }
    throw new Error(`Timed out: ${ready}`)
  }
  await openRecovery('document.querySelector("#recovery-panel .history-row") && document.querySelector("#recovery-panel")?.textContent.includes("Restore backup as separate copy")')
  let text = await app.evaluate('document.querySelector("#recovery-panel").textContent')
  assert.ok(text.includes('Saved versions') && text.includes('Backup copies') && text.includes('Drafts and conflicts'))
  assert.ok(!text.includes('Other.md'), 'document recovery filters unrelated conflicts')
  await app.evaluate('document.querySelector("#recovery-panel details").open = true')
  await waitFor('document.querySelector("#recovery-panel details .history-diff")')
  assert.ok((await app.evaluate('document.querySelector("#recovery-panel details").textContent')).includes('Original backup'))
  if (process.env.TULIP_REVIEW_SHOTS) {
    const shot = await app.command('Page.captureScreenshot', { format: 'png' })
    await writeFile(path.join(process.env.TULIP_REVIEW_SHOTS, 'document-recovery.png'), Buffer.from(shot.data, 'base64'))
  }
  await app.evaluate('[...document.querySelectorAll("#recovery-panel button")].find(b=>b.textContent === "Restore backup as separate copy").click()')
  await waitFor('window.__tulip.state.current?.path.includes("(backup ")')
  const restored = await app.evaluate('window.__tulip.state.current.path')
  assert.equal(await readFile(path.join(app.vault, restored), 'utf8'), '# Note\n\nOriginal backup.\n')
  assert.equal(await readFile(path.join(app.vault, 'Note.md'), 'utf8'), '# Note\n\nNewer saved text.\n')
  await app.evaluate('window.__tulip.openNote("Note.md")')
  await openRecovery('document.querySelector("#recovery-panel .history-actions button")')
  await app.evaluate('document.querySelector("#recovery-panel .history-actions button").click()')
  await waitFor('document.querySelectorAll("dialog[open]").length === 2')
  await app.evaluate('[...document.querySelectorAll("dialog[open]")].at(-1).querySelector("button").click()')
  await waitFor('document.querySelectorAll("dialog[open]").length === 1')
  await delay(500)
  assert.equal(await readFile(path.join(app.vault, 'Note.md'), 'utf8'), '# Note\n\nOriginal backup.\n')
  await app.evaluate('[...document.querySelectorAll("#recovery-panel button")].find(b=>b.textContent === "Show recovery for all documents").click()')
  await waitFor('document.querySelector("#recovery-panel")?.textContent.includes("Other.md")')
  console.log('ok - unified document recovery compares backups, restores separate copies and saved history, and filters unresolved items')
} finally { await app.dispose() }
