import assert from 'node:assert/strict'
import { readFile, chmod, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { appSession, delay } from './lib/app-session.mjs'
const executable = process.argv[2]
if (!executable) { console.log('recovery app: skipped until a built executable is supplied'); process.exit(0) }
/* Broken.md ships with the vault: the health scan below reads it from the
   index, and a file written into a running vault waits on the watcher — which
   on a hosted Windows runner had not delivered it after thirty seconds. What
   this test is about is the scan and the scratch tab, not the watcher's
   latency, so the fixture is there when the app starts. */
const app = await appSession({ executable, files: { 'Note.md': '# Note\n\nSaved original.\n', 'Atomic.txt': 'original', 'Broken.md': '# Broken\n\n[[Missing note]]\n\n![](absent.png)\n\n[@unknown]\n' }, config: { tabs: ['Note.md'], tabIndex: 0, view: 'edit' } })
async function waitFor (expression) {
  for (let i = 0; i < 300; i++) { if (await app.evaluate(expression)) return; await delay(100) }
  throw new Error(`Timed out: ${expression}`)
}
try {
  await waitFor('Boolean(window.__tulip.editor)')
  // Keep typing past the draft interval without allowing the debounce save.
  await app.evaluate(`(async () => {
    const editor = window.__tulip.editor;
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: '\\nCrash checkpoint' } });
    for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 150)); editor.dispatch({ changes: { from: editor.state.doc.length, insert: '.' } }) }
    return true;
  })()`)
  const drafts = await app.evaluate('window.tulip.draft.list()')
  assert.ok(drafts.some((d) => d.text.includes('Crash checkpoint')))
  await app.restart()
  assert.ok(!(await readFile(path.join(app.vault, 'Note.md'), 'utf8')).includes('Crash checkpoint'))
  await waitFor('!document.querySelector("#recovery-indicator").hidden')
  await app.evaluate('window.__tulip.runCommand("recovery-inbox"); true')
  await waitFor('Boolean(document.querySelector("#recovery-panel")?.open)')
  assert.ok((await app.evaluate('document.querySelector("#recovery-panel").textContent')).includes('Unsaved draft'))
  if (process.env.TULIP_REVIEW_SHOTS) {
    const shot = await app.command('Page.captureScreenshot', { format: 'png' })
    await writeFile(path.join(process.env.TULIP_REVIEW_SHOTS, 'tulip-recovery.png'), Buffer.from(shot.data, 'base64'))
  }
  await app.evaluate('document.querySelector("#recovery-panel").close(); true')
  assert.ok((await app.evaluate('window.tulip.draft.list()')).length > 0)
  await app.evaluate('window.__tulip.runCommand("recovery-inbox"); true')
  await waitFor('Boolean(document.querySelector("#recovery-panel")?.open)')
  await app.evaluate('[...document.querySelectorAll("#recovery-panel button")].find((b) => b.textContent === "Restore as separate copy").click(); true')
  await waitFor('window.__tulip.state.current?.path.includes("recovered")')
  const restored = await app.evaluate('window.__tulip.state.current.path')
  assert.ok((await readFile(path.join(app.vault, restored), 'utf8')).includes('Crash checkpoint'))
  assert.ok(!(await readFile(path.join(app.vault, 'Note.md'), 'utf8')).includes('Crash checkpoint'))
  console.log('ok - real continuous typing survives force quit; closing recovery keeps the draft; restore preserves original')

  if (process.platform !== 'win32') {
    await app.evaluate('window.__tulip.openNote("Note.md").then(() => true)')
    await waitFor('Boolean(window.__tulip.editor)')
    await chmod(app.vault, 0o555)
    await app.evaluate('window.__tulip.editor.dispatch({ changes: { from: 0, insert: "Unsaved failure\\n" } }); window.__tulip.runCommand("save"); true')
    await waitFor('!document.querySelector("#recovery-indicator").hidden')
    assert.equal(await app.evaluate('window.__tulip.state.dirty'), true)
    assert.ok(!(await readFile(path.join(app.vault, 'Note.md'), 'utf8')).includes('Unsaved failure'))
    await chmod(app.vault, 0o755)
    await app.evaluate('window.__tulip.runCommand("save"); true')
    await waitFor('!window.__tulip.state.dirty')
    assert.ok((await readFile(path.join(app.vault, 'Note.md'), 'utf8')).includes('Unsaved failure'))
    console.log('ok - denied save retains dirty buffer and reminder; retry saves the edit')
  }
  // Start a large atomic replacement and interrupt the process without waiting
  // for its reply. Either complete version is valid; a partial note is not.
  await app.evaluate('void window.tulip.file.write("Atomic.txt", "X".repeat(12000000)); true')
  await app.stop()
  const atomic = await readFile(path.join(app.vault, 'Atomic.txt'), 'utf8')
  assert.ok(atomic === 'original' || atomic === 'X'.repeat(12000000), 'interrupted save is old or complete, never partial')
  await app.restart()
  console.log('ok - interrupted atomic replacement preserves a complete file and app restarts')
  await waitFor('(async () => { const page = await window.tulip.vault.notes({ offset: 0, limit: 100 }); return (page.notes || page).some(n => n.path === "Broken.md") })()')
  const before = await readdir(app.vault)
  await app.evaluate('window.__tulip.runCommand("vault-health"); true')
  await waitFor('window.__tulip.state.tabs[window.__tulip.state.tabIndex]?.memory?.text.includes("Missing note")')
  assert.equal(await app.evaluate('Boolean(document.querySelector("#vault-health-panel"))'), false)
  const memoryIndex = await app.evaluate('window.__tulip.state.tabIndex')
  assert.equal(await app.evaluate('window.__tulip.state.current'), null)
  const text = await app.evaluate('window.__tulip.state.tabs[window.__tulip.state.tabIndex].memory.text')
  assert.ok(text.startsWith('# Logs') && text.includes('Broken.md:3') && text.includes('absent.png') && text.includes('unknown'))
  if (process.env.TULIP_REVIEW_SHOTS) {
    const shot = await app.command('Page.captureScreenshot', { format: 'png' })
    await writeFile(path.join(process.env.TULIP_REVIEW_SHOTS, 'tulip-health.png'), Buffer.from(shot.data, 'base64'))
  }
  assert.equal(await app.evaluate('document.querySelector("#view-switch").hidden'), true)
  await app.evaluate('window.__tulip.runCommand("find"); true')
  await waitFor('Boolean(document.querySelector(".memory-document .cm-search"))')
  await app.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await app.command('Input.insertText', { text: 'Temporary edit\n' })
  await waitFor('window.__tulip.state.tabs[window.__tulip.state.tabIndex].memory.text.startsWith("Temporary edit")')
  await app.evaluate('window.__tulip.runCommand("save"); true')
  await app.evaluate(`window.__tulip.selectTab(${memoryIndex - 1})`)
  assert.equal(await app.evaluate('Boolean(document.querySelector(".memory-document"))'), false)
  await app.evaluate(`window.__tulip.selectTab(${memoryIndex})`)
  await waitFor('document.querySelector(".memory-document .cm-content")?.textContent.includes("Temporary edit")')
  await app.evaluate('window.__tulip.runCommand("vault-health"); true')
  await waitFor('document.querySelector(".memory-document .cm-content")?.textContent.startsWith("# Logs")')
  assert.equal(await app.evaluate('window.__tulip.state.tabs.filter(t => t.memory).length'), 1)
  await app.evaluate('window.__tulip.runCommand("close-tab"); true')
  assert.equal(await app.evaluate('Boolean(document.querySelector(".memory-document"))'), false)
  assert.deepEqual(await readdir(app.vault), before)
  assert.equal(await readFile(path.join(app.vault, 'Broken.md'), 'utf8'), '# Broken\n\n[[Missing note]]\n\n![](absent.png)\n\n[@unknown]\n')
  const config = await readFile(path.join(app.profile, 'config.json'), 'utf8')
  assert.ok(!config.includes('logs.md') && !config.includes('Temporary edit'))
  console.log('ok - Markdown scratch tab opens, edits in memory, survives tab switching, refreshes, closes and never writes to vault or session')

} finally { await chmod(app.vault, 0o755).catch(() => {}); await app.dispose() }
