import assert from 'node:assert/strict'
import electron from 'electron'
import { appSession, delay, pdfFixture } from './lib/app-session.mjs'

const executable = process.argv[2] || electron
const app = await appSession({ executable, files: {
  'Note.md': '# A note\n\nWords to read.\n',
  'Bookmarked.md': '# Bookmarked\n\n<!-- bookmark -->\nSaved place.\n',
  'Table.csv': 'Name,Count\nTulip,5\n',
  'Paper.pdf': pdfFixture(),
  'Source.py': 'print("hello")\n'
}, config: { tabs: ['Note.md'], tabIndex: 0 } })
const waitFor = async (expression, tries = 400) => {
  for (let i = 0; i < tries; i++) { if (await app.evaluate(expression)) return; await delay(50) }
  throw new Error('Timed out: ' + expression)
}
async function palette (query = '') {
  await app.evaluate(`window.__tulip.runCommand('commands'); true`)
  if (query) await app.evaluate(`(() => {
    const input = document.querySelector('#panel-input')
    input.value = ${JSON.stringify(query)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await delay(200)
  const result = await app.evaluate(`({
    groups: document.querySelectorAll('#panel-list .panel-group').length,
    names: [...document.querySelectorAll('#panel-list [role="option"]')].map(n => n.querySelector('.title')?.textContent || n.textContent)
  })`)
  assert.equal(result.groups, 0)
  await app.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  return result.names.join('\n')
}
try {
  for (const [file, grid] of [['Table.csv', true], ['Paper.pdf', false], ['Note.md', false], ['Source.py', false], ['Table.csv', true], ['Paper.pdf', false]]) {
    await app.evaluate(`window.__tulip.openNote(${JSON.stringify(file)})`)
    /* The palette's context comes from what is on screen, and the viewer is
       loaded lazily: asking before the grid has mounted is asking about the
       document before it existed, which CI did under load. */
    await waitFor(`window.__tulip.state.current?.path === ${JSON.stringify(file)}`)
    if (grid) await waitFor(`!!document.querySelector('.csv-frame')`)
    const names = await palette()
    assert.match(names, /Settings/)
    assert.match(names, /Open logs.md/)
    assert.doesNotMatch(names, /Copy diagnostics|Reveal crash log|Change interface font|Change markdown font|Back up vault|Restore vault|Toggle copilot|Open Getting Started/)
    assert.equal(names.includes('Auto-resize all columns'), grid, file)
    assert.equal(names.includes('Filter this column'), grid, file)
    if (file === 'Paper.pdf' || file === 'Source.py') {
      assert.doesNotMatch(names, /Lint current|Fold all headings|Bookmark this place|Export as HTML|Import cards/)
    }
    assert.equal((await palette('columns')).includes('Auto-resize all columns'), grid, `${file}: search uses the same scope`)
    console.log(`${file}: flat and context-filtered`)
  }
  await app.evaluate(`window.__tulip.openNote('Note.md')`)
  assert.doesNotMatch(await palette(), /Go to bookmark|Run all code blocks/)
  await app.evaluate(`window.__tulip.openNote('Bookmarked.md')`)
  assert.match(await palette(), /Go to bookmark/)
  console.log('command palette: all checks passed')
} finally { await app.dispose() }
