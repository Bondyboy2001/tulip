/* The half of the notebook test that runs in the page. See test-notebook-view.mjs.
 *
 * Everything here drives the real viewer with the events a person's keyboard
 * and mouse send, and reads back what ended up on screen and what ended up in
 * the file. The file half — nbformat, outputs, ANSI — is tested without a
 * browser in test-notebook.mjs; this is the half that only exists once there
 * is a document to press keys against.
 */

import { mountNotebook } from '../src/notebook.js'

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
/* Two frames. `scheduleRepaint` coalesces into one rAF, and the paint it
   schedules can itself land a frame later. */
const settled = async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await wait(0)
}

const PNG = 'iVBORw0KGgo='

const FIXTURE = JSON.stringify({
  cells: [
    {
      cell_type: 'markdown',
      id: 'md1',
      metadata: {},
      attachments: { 'shot.png': { 'image/png': PNG } },
      source: ['# Analysis\n', '\n', '![](attachment:shot.png)']
    },
    {
      cell_type: 'code',
      execution_count: 1,
      id: 'c1',
      metadata: {
        tags: ['setup'],
        execution: {
          'iopub.execute_input': '2026-01-01T00:00:00.000Z',
          'shell.execute_reply': '2026-01-01T00:00:04.500Z'
        }
      },
      outputs: [
        { name: 'stdout', output_type: 'stream', text: ['loaded 40 rows\n'] },
        {
          output_type: 'execute_result',
          execution_count: 1,
          metadata: {},
          data: { 'text/plain': ['FutureWarning: renamed'] }
        }
      ],
      source: ['import pandas as pd\n', "df = pd.read_csv('people.csv')"]
    },
    {
      cell_type: 'code',
      execution_count: null,
      id: 'c2',
      metadata: {},
      outputs: [],
      source: ['df.head()']
    }
  ],
  metadata: {
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
    language_info: { file_extension: '.py', name: 'python', version: '3.12.1' }
  },
  nbformat: 4,
  nbformat_minor: 5
}, null, 1) + '\n'

export async function run () {
  const host = document.getElementById('host')
  const written = new Map()          // path -> text
  let writes = 0
  const rendered = []                // every string handed to the markdown renderer
  const dressed = []                 // what the app's embed pass was handed, after
  const asked = []                   // every question the viewer stopped to ask
  const notes = []                   // every line it sent to the status bar

  let answer = true                  // what `ask` says next

  /* A kernel that is entirely under this test's control: `execute` hands back
     an id and nothing else happens until the test pushes events down the same
     channel the real bridge does. */
  let listener = null
  let nextMsg = 0
  const executed = []
  const answered = []
  const completions = { matches: ['df.head', 'df.hist'], cursor_start: 0, cursor_end: 2 }

  const kernel = {
    start: async () => ({ kernel: 'Python 3', name: 'python3', state: 'idle' }),
    execute: async (path, code) => {
      const msgId = `m${nextMsg++}`
      executed.push({ code, msgId })
      return { msgId }
    },
    interrupt: async () => true,
    restart: async () => true,
    shutdown: async () => true,
    specs: async () => ({ specs: [{ name: 'python3', displayName: 'Python 3', language: 'python' }] }),
    input: async (path, value) => { answered.push(value); return true },
    complete: async () => completions,
    inspect: async () => ({ found: true, data: { 'text/plain': 'head(n=5) -> DataFrame' } }),
    on: (fn) => { listener = fn; return () => { listener = null } }
  }

  const book = mountNotebook({
    host,
    file: {
      read: async () => FIXTURE,
      write: async (path, text) => { written.set(path, text); writes++ }
    },
    markdown: {
      prepare: async () => true,
      /* The app's markdown leaves every picture as a stub for `dress` to swap,
         which is the arrangement the reading view is built on — so the fake
         does the same, and `dress` records what it was handed. */
      render: (text) => {
        rendered.push(text)
        return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
          (_w, alt, src) => `<span class="embed-slot" data-src="${src}" data-alt="${alt}"></span>`)
      },
      dress: (node) => { dressed.push(node.innerHTML) }
    },
    kernel,
    ask: async (question) => { asked.push(question); return answer },
    notify: (text) => notes.push(text),
    onDirty: () => {},
    onSaved: () => {},
    onStatus: () => {}
  })

  await book.open('Papers/Analysis.ipynb')
  await settled()

  /* ------------------------------------------------------------ helpers */

  const scroller = host.querySelector('.nb-scroll')
  const column = host.querySelector('.nb-col')
  const search = host.querySelector('.nb-find')

  const sections = () => [...column.querySelectorAll('.nb-cell')]
  const sourceOf = (index) => {
    const section = sections()[index]
    return section?.querySelector('.nb-input')?.value ??
      section?.querySelector('.cm-content')?.textContent?.replace(/\n$/, '') ??
      section?.querySelector('.nb-ink')?.textContent?.replace(/\n$/, '')
  }
  const typeOf = (index) =>
    [...(sections()[index]?.classList || [])].find((c) => c.startsWith('is-'))
  const chosen = () => sections().findIndex((s) => s.classList.contains('is-at'))

  /** A key, as the window would deliver it: to whatever has focus. */
  const key = (name, init = {}) =>
    (document.activeElement === document.body ? scroller : document.activeElement)
      .dispatchEvent(new KeyboardEvent('keydown', {
        key: name, bubbles: true, cancelable: true, ...init
      }))

  const commandKey = async (name, init) => { key(name, init); await settled() }

  /** What the kernel says, down the same path the real bridge uses. */
  const say = (event) => listener?.({ path: 'Papers/Analysis.ipynb', ...event })

  /**
   * Start the chosen cell and wait for the request to reach the kernel — not
   * for the run to finish.
   *
   * `runCell` hands back a promise that settles when the kernel says it is
   * done with the cell, which is exactly right and exactly why awaiting it
   * here would wedge: nothing says `done` until this test does.
   */
  const startRun = async () => {
    const before = executed.length
    book.run.cell()
    for (let n = 0; n < 100 && executed.length === before; n++) await wait(10)
    await settled()
    return executed[executed.length - 1]?.msgId
  }

  const result = {}
  /* Where the scenario has got to, for the harness to report when something
     here wedges. A "timed out" with no stage is not a diagnosis. */
  const stage = (name) => { window.__stage = name }

  /* ------------------------------------------------- what opening it drew */

  stage('opened')

  result.cellCount = sections().length
  result.kinds = sections().map((s) => typeOf(sections().indexOf(s)))
  /* A pasted image is a real `<img>` by the time anyone looks at it, and the
     app's own embed pass never sees the `attachment:` stub — it would only
     answer "not found in this vault", which is what a notebook with a pasted
     screenshot in it used to show. */
  const shot = sections()[0].querySelector('img')
  result.attachmentDrawn = shot?.src?.startsWith(`data:image/png;base64,${PNG}`) || ''
  result.attachmentLeftForVault = dressed.some((html) => html.includes('attachment:shot.png'))
  // The cell's own source is untouched: what is resolved is the drawing of it.
  result.attachmentSourceKept = rendered.some((text) => text.includes('attachment:shot.png'))
  /* How long the last run took, read out of the file rather than remembered. */
  result.duration = sections()[1]?.querySelector('.nb-took')?.textContent || ''
  result.tags = [...sections()[1].querySelectorAll('.nb-tag')].map((t) => t.textContent)
  // A notebook just opened is one the keyboard can already drive.
  result.selectedOnOpen = chosen()

  /* ------------------------------------------------------- the command keys */

  stage('command keys')

  scroller.focus()
  await commandKey('ArrowDown')
  result.afterFirstDown = chosen()
  await commandKey('ArrowDown')
  result.afterSecondDown = chosen()
  result.context = book.context()

  /* Run cell, with nothing focused and no textarea to read a caret from. This
     is the case that did nothing at all before there was a selection. */
  const ran = chosen()
  const runMsg = await startRun()
  result.ranWithoutCaret = executed.length === 1 && executed[0].code === 'df.head()'
  say({ kind: 'count', msgId: runMsg, executionCount: 2 })
  say({
    kind: 'output',
    msgId: runMsg,
    msgType: 'display_data',
    content: { data: { 'text/plain': 'frame 1' }, metadata: {}, transient: { display_id: 'live' } }
  })
  await settled()
  result.liveOutput = sections()[ran].querySelector('.nb-out-text')?.textContent?.trim()

  /* A redraw of the same display replaces it. Appended, a notebook animating
     in place would keep every frame it ever drew. */
  say({
    kind: 'output',
    msgId: runMsg,
    msgType: 'update_display_data',
    content: { data: { 'text/plain': 'frame 2' }, metadata: {}, transient: { display_id: 'live' } }
  })
  await settled()
  const outs = sections()[ran].querySelectorAll('.nb-outputs > *')
  result.redrawnCount = outs.length
  result.redrawnText = outs[0]?.textContent?.trim()

  /* The line a cell blocked on `input()` is answered on. Before this there was
     nowhere to type, so the kernel was told not to ask. */
  say({ kind: 'input', msgId: runMsg, prompt: 'Name? ', password: false })
  await settled()
  const field = sections()[ran].querySelector('.nb-stdin-input')
  result.stdinShown = !!field
  result.stdinPrompt = sections()[ran].querySelector('.nb-stdin-label')?.textContent?.trim()
  if (field) {
    field.value = 'Ada'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settled()
  }
  result.stdinAnswer = answered[0]
  result.stdinGone = !sections()[ran].querySelector('.nb-stdin-input')
  // What was typed is part of what the cell printed, the way it is in a terminal.
  result.stdinEchoed = sections()[ran].textContent.includes('Name? Ada')

  say({ kind: 'done', msgId: runMsg, status: 'ok' })
  await settled()

  /* ------------------------------------------------------------- folding */

  stage('folding')

  const outputsBefore = !!sections()[ran].querySelector('.nb-outputs')
  scroller.focus()
  await commandKey('o')
  result.foldedAway = outputsBefore && !sections()[ran].querySelector('.nb-outputs')
  result.foldedSaysSo = !!sections()[ran].querySelector('.nb-outputs-shut')
  await commandKey('o')
  result.unfolded = !!sections()[ran].querySelector('.nb-outputs')

  /* ------------------------------------------------- adding and deleting */

  stage('adding')

  scroller.focus()
  await commandKey('b')                       // a cell below this one
  result.afterAdd = sections().length
  result.addedIsChosen = chosen()

  scroller.focus()
  await commandKey('d')
  await commandKey('d')                       // twice, close together
  result.afterDelete = sections().length

  /* A single `d` is not a delete. Delete is the one command here that throws
     work away and it is worth two keys. */
  scroller.focus()
  await commandKey('d')
  await wait(800)                             // longer than the double-key window
  await commandKey('d')
  result.afterLoneD = sections().length

  /* ------------------------------------------------- retyping and copying */

  stage('retyping')

  scroller.focus()
  await commandKey('m')
  result.retyped = typeOf(chosen())
  await commandKey('y')
  result.retypedBack = typeOf(chosen())

  scroller.focus()
  await commandKey('c')
  await commandKey('v')
  result.afterPaste = sections().length
  result.pasteMatches = sourceOf(chosen()) === sourceOf(chosen() - 1)

  scroller.focus()
  await commandKey('d')
  await commandKey('d')

  /* ------------------------------------------------------------- moving

     A cell's own controls no longer close over the number it had when it was
     drawn — they ask where the cell is at the moment they are pressed — which
     is what lets a paint keep the sections it has already built. Both halves
     of that are checked here: that a section which only moved is the same
     element afterwards, and that its buttons still act on its own cell. */

  stage('moving')

  const toolNamed = (index, label) =>
    [...sections()[index].querySelectorAll('.nb-cell-tools button')]
      .find((button) => button.getAttribute('aria-label') === label)

  /* The sections themselves, because a cell that has only moved is drawn in
     the one it already had — so which element is where afterwards says both
     that the right cell moved and that nothing else was rebuilt to find out. */
  const before = sections()

  toolNamed(1, 'Move down').click()
  await settled()
  const after = sections()
  result.movedDown = after[1] === before[2] && after[2] === before[1]
  result.moveKeptOthers = after[0] === before[0]

  // The same cell, moved back from the place it has been carried to.
  toolNamed(2, 'Move up').click()
  await settled()
  result.movedBack = sections().every((section, index) => section === before[index])

  /* And the section says which cell it is showing now, which is the one thing
     about it that is the number rather than the cell. */
  result.renumbered = sections().every((section, index) =>
    section.dataset.index === String(index))

  /* ------------------------------------------------------------ the find */

  stage('find')

  search.value = 'futurewarning'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await settled()
  /* A word that is only in an output. The search read sources alone before,
     so the text was on screen and the search could not see it. */
  result.foundInOutput = host.querySelector('.nb-found')?.textContent || ''
  result.hitCell = sections().findIndex((s) => s.classList.contains('is-hit'))

  search.value = 'df'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await settled()
  const forward = host.querySelector('.nb-found')?.textContent
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await settled()
  const stepped = host.querySelector('.nb-found')?.textContent
  search.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', shiftKey: true, bubbles: true, cancelable: true
  }))
  await settled()
  result.findSteps = [forward, stepped, host.querySelector('.nb-found')?.textContent]

  search.value = ''
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await settled()

  /* -------------------------------------------------- what a save costs */

  stage('streaming')

  /* Output asks for a checkpoint, not a save. A cell printing in a loop sends
     a message a millisecond and each save re-serialises the whole file — so
     the count here is the difference between a readable long run and a window
     that spends it writing megabytes. */
  const cell = sections().length - 1
  scroller.focus()
  await commandKey('End')
  const streamMsg = await startRun()
  const writesBefore = writes
  for (let n = 0; n < 200; n++) {
    say({
      kind: 'output',
      msgId: streamMsg,
      msgType: 'stream',
      content: { name: 'stdout', text: `line ${n}\n` }
    })
  }
  await settled()
  await wait(1200)                            // past the ordinary save delay
  result.writesWhileStreaming = writes - writesBefore
  result.streamDrawn = sections()[cell]?.textContent.includes('line 199')

  say({ kind: 'done', msgId: streamMsg, status: 'ok' })
  await wait(1200)
  result.wroteWhenDone = writes > writesBefore

  /* ----------------------------------------------- undo during a run */

  stage('undo')

  /* The run maps are keyed by the cell object, so that a cell moved mid-run
     cannot hand its output to whoever took its index. Undo restores *copies*,
     so without re-pointing them the rest of a running cell's output went
     nowhere and said nothing. */
  scroller.focus()
  await commandKey('End')
  const undoMsg = await startRun()
  await commandKey('b')                       // a structural change to undo
  book.history(false)                         // ⌘Z
  await settled()
  say({
    kind: 'output',
    msgId: undoMsg,
    msgType: 'stream',
    content: { name: 'stdout', text: 'after the undo\n' }
  })
  await settled()
  result.outputSurvivedUndo = column.textContent.includes('after the undo')
  say({ kind: 'done', msgId: undoMsg, status: 'ok' })
  await settled()

  /* ------------------------------------------------------- the restart */

  stage('restart')

  answer = false
  await book.run.restart()
  await settled()
  result.restartAsked = asked.length > 0
  result.restartRefused = asked[asked.length - 1]?.go === 'Restart'

  /* --------------------------------------------------------- exporting */

  stage('export')

  await book.exportAs('script')
  await settled()
  result.scriptPath = [...written.keys()].find((p) => p.endsWith('.py')) || ''
  result.scriptBody = (written.get(result.scriptPath) || '').slice(0, 200)

  await book.exportAs('html')
  await settled()
  result.htmlPath = [...written.keys()].find((p) => p.endsWith('.html')) || ''
  result.notes = notes

  /* --------------------------------------------------------- completion */

  stage('completion')

  scroller.focus()
  await commandKey('Home')
  await commandKey('ArrowDown')               // the first code cell
  const input = sections()[1].querySelector('.cm-content')
  input.focus()
  document.execCommand('selectAll')
  document.execCommand('insertText', false, 'df')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  await wait(50)
  const rows = [...host.querySelectorAll('.nb-hint-row')].map((r) => r.textContent)
  result.completions = rows
  if (rows.length) {
    host.querySelectorAll('.nb-hint-row')[1]
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await settled()
  }
  result.completed = sourceOf(1)

  /* Tab at the start of a line is still indentation, and always was. */
  const plain = sections()[1].querySelector('.cm-content')
  plain.focus()
  document.execCommand('selectAll')
  document.execCommand('delete')
  plain.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  await settled()
  result.tabIndents = sourceOf(1)

  /* ---------------------------------------------------- what got written */

  stage('saving')

  await book.save({ flush: true })
  result.saved = written.get('Papers/Analysis.ipynb') || ''

  return result
}
