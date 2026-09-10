import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { appSession, delay, pdfFixture } from './lib/app-session.mjs'
const app = await appSession({ executable: process.argv.find((arg) => arg.startsWith('--app='))?.slice(6), files: {
  'Note.md': '# Start\n\n' + 'Research paragraph.\n\n'.repeat(100) + '# Destination\n\nTarget passage.\n',
  'Review.md': 'One\nTwo\nThree\nFour\n', 'Merge.md': 'One\nTwo\nThree\nFour\n', 'Recovered.md': 'One\nTWO\nThree\nFOUR\n', 'Paper.pdf': pdfFixture(10)
}, config: { tabs: ['Note.md'], tabIndex: 0, view: 'read' } })
const waitFor = async (expression) => {
  for (let i = 0; i < 100; i++) { if (await app.evaluate(expression)) return; await delay(60) }
  throw new Error('Timed out: ' + expression)
}
try {
  await app.evaluate('window.__tulip.jumpToHeading("Destination"); true')
  /* The jump records its location through the same path an ordinary open
     does; wait for the entry rather than a fixed moment on a loaded runner. */
  let trail = []
  for (let attempt = 0; attempt < 100; attempt++) {
    trail = await app.evaluate('window.__tulip.state.tabs[0].history')
    if (trail.length >= 2 && trail.at(-1).path === trail.at(-2).path) break
    await delay(50)
  }
  assert.ok(trail.length >= 2 && trail.at(-1).path === trail.at(-2).path, JSON.stringify(trail))
  await app.evaluate('window.__tulip.goHistory(-1)')
  await delay(400)
  assert.ok(await app.evaluate('window.__tulip.viewportLine() < 20'))
  await app.evaluate('window.__tulip.goHistory(1)')
  await delay(300)
  assert.ok(await app.evaluate('window.__tulip.viewportLine() > 150'))
  console.log('ok - heading jumps create navigable same-document locations')

  await app.evaluate('window.__tulip.openOverlay("search", { query: "Target" }); true')
  await waitFor('document.querySelector("#search-result-preview")?.textContent.includes("Target passage")')
  await app.evaluate(`document.querySelector('[data-search-filter="path:"]').click(); true`)
  await waitFor('!!document.querySelector(".search-filter-dialog")')
  await app.evaluate('document.querySelector(".search-filter-dialog").close(); true')
  await app.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  console.log('ok - search displays source passages and opens filter value controls')

  await app.evaluate('window.__tulip.openNote("Merge.md")')
  await app.evaluate('(async () => { await window.tulip.recovery.record({ kind: "conflict", path: "Merge.md", copy: "Recovered.md" }); window.__tulip.runCommand("recovery-inbox") })()')
  await waitFor('!!document.querySelector("#recovery-panel")')
  await app.evaluate('[...document.querySelectorAll("#recovery-panel button")].find(b => b.textContent === "Merge selected changes…").click(); true')
  await waitFor('!!document.querySelector(".change-review")')
  await app.evaluate('const c = document.querySelector(".change-review input"); c.checked = false; c.dispatchEvent(new Event("change")); true')
  if (process.env.TULIP_REVIEW_SHOTS) {
    const shot = await app.command('Page.captureScreenshot', { format: 'png' })
    await writeFile(path.join(process.env.TULIP_REVIEW_SHOTS, 'tulip-selective-merge.png'), Buffer.from(shot.data, 'base64'))
  }
  await app.evaluate('[...document.querySelectorAll(".change-review button")].find(b => b.textContent === "Save selected result").click(); true')
  await waitFor('!document.querySelector(".change-review")')
  assert.equal(await readFile(path.join(app.vault, 'Merge.md'), 'utf8'), 'One\nTwo\nThree\nFOUR\n')
  assert.equal(await readFile(path.join(app.vault, 'Recovered.md'), 'utf8'), 'One\nTWO\nThree\nFOUR\n')
  console.log('ok - selected recovery changes save through real IPC and preserve the recovered copy')
  await app.evaluate('document.querySelector("#recovery-panel").close(); true')

  const passage = await app.evaluate('window.tulip.pdf.passage("Paper.pdf", 3)')
  assert.match(passage.text, /3/)
  const stamped = await app.evaluate('window.tulip.file.readStamped("Merge.md")')
  await writeFile(path.join(app.vault, 'Merge.md'), 'Newer outside edit\n')
  const stale = await app.evaluate(`window.tulip.file.write("Merge.md", "Old preview", {expect:${JSON.stringify(stamped.stamp)}})`)
  assert.equal(stale.stale, true)
  assert.equal(await readFile(path.join(app.vault, 'Merge.md'), 'utf8'), 'Newer outside edit\n')
  console.log('ok - PDF source passages are page-specific and stale preview saves preserve newer edits')
  await delay(1000)
  await app.restart()
  assert.ok(await app.evaluate('window.__tulip.state.tabs.some(t => t.history.some(h => h.path === "Note.md"))'))
  console.log('ok - location history survives app restart')
  await app.evaluate('window.__tulip.openNote("Merge.md")')
  await app.evaluate(`window.tulip.ai.history.save({notes:{"Merge.md":{at:Date.now(),active:"source-test",convos:[{id:"source-test",at:Date.now(),messages:[{t:"you",text:"Show sources"},{t:"bot",text:"See [[Note#Destination]] and [Paper.pdf page 3].",bookmarked:true}]}]}}})`)
  await delay(1000)
  await app.restart()
  await app.evaluate('window.__tulip.openNote("Merge.md")')
  await app.evaluate('window.__tulip.copilot.open()')
  await delay(250)
  await app.evaluate('const input = document.querySelector("#ai-input"); input.value = "/history"; input.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",bubbles:true})); true')
  await waitFor('!![...document.querySelectorAll(".ai-menu-row")].find(b=>b.textContent.includes("Show sources"))')
  await app.evaluate('[...document.querySelectorAll(".ai-menu-row")].find(b=>b.textContent.includes("Show sources")).click(); true')
  await waitFor('!!document.querySelector(".ai-note-source")')
  await app.evaluate('document.querySelector(".ai-note-source").click(); true')
  await waitFor('document.querySelector(".source-preview")?.textContent.includes("Target passage")')
  if (process.env.TULIP_REVIEW_SHOTS) {
    const shot = await app.command('Page.captureScreenshot', { format: 'png' })
    await writeFile(path.join(process.env.TULIP_REVIEW_SHOTS, 'tulip-source-preview.png'), Buffer.from(shot.data, 'base64'))
  }
  await app.evaluate('document.querySelector(".source-preview").close(); document.querySelector(".ai-cite").click(); true')
  await waitFor('document.querySelector(".source-preview")?.textContent.includes("Research page 3")')
  await app.evaluate('document.querySelector(".source-preview button").click(); true')
  await waitFor('window.__tulip.pdf?.page() === 3')
  console.log('ok - saved conversations render note/PDF citations, preview passages and open the cited page')
  await app.evaluate(`(async () => {
    await window.tulip.file.write('Review.md', 'One\\nTWO\\nThree\\nFOUR\\n');
    const operation = (await window.tulip.trust.list()).find(op => op.changes.some(c => c.path === 'Review.md'));
    if (!operation) throw new Error('No review snapshot');
    await window.tulip.ai.history.save({notes:{'Review.md':{at:Date.now(),active:'review-test',convos:[{id:'review-test',at:Date.now(),messages:[{t:'you',text:'Review these changes'},{t:'review',operation}]}]}}});
  })()`)
  // appSession restart deliberately force-kills; let the history checkpoint land.
  await delay(4500)
  await delay(1000)
  await app.restart()
  await app.evaluate('window.__tulip.openNote("Review.md")')
  await app.evaluate('window.__tulip.copilot.open()')
  await app.evaluate('const box = document.querySelector("#ai-input"); box.value = "/history"; box.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",bubbles:true})); true')
  await waitFor('!![...document.querySelectorAll(".ai-menu-row")].find(b=>b.textContent.includes("Review these changes"))')
  await app.evaluate('[...document.querySelectorAll(".ai-menu-row")].find(b=>b.textContent.includes("Review these changes")).click(); true')
  await app.evaluate('document.querySelector(".ai-review-diff").click(); true')
  await waitFor('!!document.querySelector(".ai-review-sections")')
  await app.evaluate('document.querySelector(".ai-review-sections").click(); true')
  await waitFor('!!document.querySelector(".change-review input")')
  await app.evaluate('const choice = document.querySelector(".change-review input"); choice.checked = false; choice.dispatchEvent(new Event("change")); true')
  await app.evaluate('[...document.querySelectorAll(".change-review button")].find(b=>b.textContent === "Save selected result").click(); true')
  await waitFor('!document.querySelector(".change-review")')
  assert.equal(await readFile(path.join(app.vault, 'Review.md'), 'utf8'), 'One\nTwo\nThree\nFOUR\n')
  console.log('ok - Copilot section review reads real history and saves only selected changes')


} finally { await app.dispose() }
