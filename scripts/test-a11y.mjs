/* The shell's accessibility contract, run against the real window.

   Tulip's controls are hand-built, so nothing about roles and names is
   inherited from a component library; every regression here is one edit away.
   This drives axe-core over the mounted shell — the sidebar, the document,
   the open copilot and the palette — and over the settings window, and fails
   on critical and serious findings.

   Moderate findings the shell carries knowingly are not gated: `region`
   reports the three panel grips, which are appended to the app shell as
   fixed-position splitters and so sit outside any landmark. Wrapping them in
   a landmark to satisfy a best-practice check would announce a "Panel
   dividers" region on every visit, which is a worse reading than the one it
   fixes. Everything that is a failure under WCAG A/AA is gated.

   Run it behind a build: `npm run build && npm run test:a11y`. */
import { appSession, delay, pdfFixture } from './lib/app-session.mjs'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const axeSource = await readFile(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8')
const GATED = ['critical', 'serious']

/** The findings the gate owns, as short lines rather than a wall. */
const gatedViolations = (target) => `(async () => {
  const r = await axe.run(${target}, { resultTypes: ['violations'] })
  return r.violations
    .filter((v) => ${JSON.stringify(GATED)}.includes(v.impact))
    .map((v) => v.id + ' (' + v.impact + ', ' + v.nodes.length + ' node' + (v.nodes.length === 1 ? '' : 's') + ')')
})()`

/** A CDP session over one page target. */
async function connect (url) {
  const socket = new WebSocket(url)
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
  let id = 0
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id
    const receive = ({ data }) => {
      const reply = JSON.parse(data)
      if (reply.id !== n) return
      socket.removeEventListener('message', receive)
      reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result)
    }
    socket.addEventListener('message', receive)
    socket.send(JSON.stringify({ id: n, method, params }))
  })
  return {
    run: async (expression) => {
      const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
      return r.result.value
    },
    close: () => socket.close()
  }
}

const app = await appSession({
  files: {
    'Note.md': '# Note\n\nSome text with a [link](https://example.com).\n\n```js\nconsole.log(1)\n```\n',
    /* The interactive surfaces: the quiz buttons of a flashcard bank, a
       language table's grid and study card, a notebook's cells, and a PDF's
       viewer. These are where a reading of the shell stops being enough —
       they are hand-built widgets, each with its own roles to get wrong. */
    'Cards.fc': '---\ntype: flashcards\n---\n\n> [!quiz] Which planet is known as the Red Planet?\n> - [ ] Venus\n> - [x] Mars\n> - [ ] Jupiter\n> Explanation: Iron minerals give Mars its colour.\n',
    'Greek.lang': '---\nlang: el\n---\n\n| Word | English |\n| --- | --- |\n| νερό | water |\n| ψωμί | bread |\n',
    'Notebook.ipynb': JSON.stringify({
      cells: [
        { cell_type: 'markdown', metadata: {}, source: ['# Notebook\n\nA markdown cell.'] },
        { cell_type: 'code', metadata: {}, source: ['print(1)'], outputs: [], execution_count: null }
      ],
      metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
      nbformat: 4,
      nbformat_minor: 5
    }),
    'Paper.pdf': pdfFixture(2)
  },
  config: { tabs: ['Note.md'], tabIndex: 0, ai: 'open' }
})
let settings = null
try {
  /* The panel is loaded lazily after boot; the palette is opened the way the
     reader opens it, so both surfaces are actually on screen for the scan. */
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await app.evaluate(`Boolean(document.querySelector('.ai-setup'))`)) break
    await delay(100)
  }
  await app.evaluate(`document.getElementById('btn-search').click(); true`)
  await delay(200)

  await app.evaluate(axeSource)
  const shell = await app.evaluate(gatedViolations('document'))
  assert.deepEqual(shell, [], `the shell has no critical or serious violations: ${shell.join(', ')}`)

  const first = (await app.targets())[0]
  const endpoint = new URL(first.webSocketDebuggerUrl)
  const port = endpoint.host
  await app.evaluate(`window.tulip.settings.open('copilot')`)
  let target = null
  for (let attempt = 0; attempt < 60 && !target; attempt++) {
    await delay(100)
    const targets = await (await fetch(`http://${port}/json/list`)).json()
    target = targets.find((t) => t.url.includes('settings-window.html')) || null
  }
  assert.ok(target, 'the settings window opened')
  settings = await connect(target.webSocketDebuggerUrl)
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await settings.run(`document.getElementById('settings')?.hidden === false`)) break
    await delay(100)
  }
  await settings.run(axeSource)
  const pane = await settings.run(gatedViolations('document'))
  assert.deepEqual(pane, [], `the settings window has no critical or serious violations: ${pane.join(', ')}`)

  /* The interactive surfaces, opened the way a reader opens them. Each viewer
     is asked for by selector so the scan runs against a mounted surface, not
     the tab it replaced. */
  const surfaces = [
    ['the flashcard bank', 'Cards.fc', '.quiz-option'],
    ['the language table', 'Greek.lang', '.lang-table, table'],
    ['the notebook', 'Notebook.ipynb', '.notebook, .nb-cell, [class*="notebook"]'],
    ['the PDF viewer', 'Paper.pdf', 'canvas, .pdf-view, #fileview']
  ]
  for (const [name, file, selector] of surfaces) {
    await app.evaluate(`window.__tulip.openNote(${JSON.stringify(file)})`)
    let mounted = false
    for (let attempt = 0; attempt < 100 && !mounted; attempt++) {
      mounted = await app.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
      if (!mounted) await delay(100)
    }
    assert.ok(mounted, `${name} mounted (${selector})`)
    const findings = await app.evaluate(gatedViolations('document'))
    assert.deepEqual(findings, [], `${name} has no critical or serious violations: ${findings.join(', ')}`)
  }

  /* The study card is a second surface under the same file — it appears when
     a session starts, not with the table, so it is asked for on its own. */
  await app.evaluate(`window.__tulip.openNote('Greek.lang')`)
  let studied = false
  for (let attempt = 0; attempt < 100 && !studied; attempt++) {
    studied = await app.evaluate(`(() => {
      const start = document.getElementById('study-start')
      if (!start) return false
      start.click()
      return true
    })()`)
    if (!studied) await delay(100)
  }
  if (studied) {
    await delay(600)
    const findings = await app.evaluate(gatedViolations('document'))
    assert.deepEqual(findings, [], `the study card has no critical or serious violations: ${findings.join(', ')}`)
  }

  console.log('PASS: shell, settings and interactive surfaces have no critical or serious accessibility findings')
} finally {
  settings?.close()
  await app.dispose()
}
