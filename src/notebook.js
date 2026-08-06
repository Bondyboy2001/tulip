/* ============================================================ notebook
   A Jupyter notebook, shown as the cells it is.

   An `.ipynb` is JSON, and the JSON is not the document. Opened in the editor
   it shows `"source": ["import pandas as pd\n", ...]` and three thousand lines
   of base64 where the plots are — the encoding rather than the thing encoded.
   So it gets a viewer of its own, in the same shape as the whiteboard's and
   the grid's — `open`, `save`, `close`, `focus`, `place`, `dirty` — and the
   renderer treats it as one more kind of tab.

   Three things drive the design:

   - The file is the model. Every cell keeps the object it was parsed from and
     is written back through it, so a field this app has never heard of —
     widget state, a collapsed flag, someone's CI metadata — survives a save it
     had nothing to do with. What is written is nbformat's own spelling: keys
     sorted, one space of indent, a trailing newline, which is what `nbformat`
     itself writes. A notebook edited here and a notebook saved by Jupyter
     produce the same bytes, so a one-cell edit is a one-cell diff.

   - Outputs are read and written, and the two are the same shape. A cell that
     has never been run here shows what the file recorded the last time
     something did; a cell that is run shows what this machine's kernel is
     saying, arriving live. Both are nbformat output objects and both go
     through `outputParts` below, because a kernel message and a saved output
     carry the same fields under the same names — the file format is a log of
     those messages. Either way an output is untrusted text from somewhere
     else, which is why the `text/html` ones go through the note sanitiser and
     the SVGs are drawn through an `<img>`.

     Running is not done here. This file asks `kernel.*` and a real Jupyter
     kernel does the work, one per notebook, so that `import pandas as pd` in
     the first cell is still true in the fortieth — see electron/kernel.js.

   - Editing is editing the source. A cell is a textarea over a highlighted
     `<pre>`: the `<pre>` holds the same text and does the layout, the textarea
     sits on top of it with transparent ink, and what you see coloured is what
     you are typing into. It is the cheapest arrangement that gives live
     highlighting, and unlike a CodeMirror per cell it costs nothing for the
     hundred cells you are not in.

   What the viewer can do, beyond showing the file:

     edit          any cell's source, in place, with the caret where you put it
     structure     add, delete, move a cell; change what kind of cell it is
     run           a cell (⇧⏎, ⌘⏎, ⌥⏎) or all of them, against a live kernel
     outputs       clear one cell's, or the whole notebook's
     undo          every structural change above, as snapshots of the cell list
   ================================================================== */

import { el, svgIcon } from './dom.js'
import { highlightInto } from './highlight.js'
import { sanitizeHtml } from './rawhtml.js'

/* ------------------------------------------------------------- the format

   nbformat, as much of it as a reader and a writer need. Everything in this
   half is a pure function of the file's text, which is also what makes it the
   half worth testing: a round trip that comes back different is an edit to one
   cell showing up as a diff against every line of the notebook.
   ================================================================== */

/** nbformat writes a string as the lines it is made of, each keeping its own
 *  newline. Both spellings are legal in a file; this is the one place that
 *  cares which. */
export function cellText (source) {
  if (Array.isArray(source)) return source.join('')
  return typeof source === 'string' ? source : ''
}

/**
 * The inverse: text as the line list nbformat stores.
 *
 * The last line keeps no newline unless the text ended with one, and an empty
 * cell is an empty list rather than `[""]` — both of which are what Jupyter
 * writes, and the difference between a save that changes one cell and a save
 * that changes every cell in the file.
 */
export function sourceLines (text) {
  const value = String(text ?? '')
  if (!value) return []
  const lines = value.split('\n')
  const last = lines.pop()
  const out = lines.map((line) => `${line}\n`)
  if (last !== '') out.push(last)
  return out
}

/* The three kinds of cell nbformat has. `raw` is neither run nor rendered —
   it is carried through to whatever converts the notebook — so it is shown as
   what it is: plain text, edited plainly. */
const CELL_TYPES = new Set(['code', 'markdown', 'raw'])

/**
 * Read a notebook's text into `{ shell, cells }`.
 *
 * `shell` is the whole parsed file, kept exactly as it was — its metadata, its
 * nbformat version, and any key this app does not know about. `cells` is the
 * working model: each one carries the object it came from, so writing puts
 * back what was there and changes only what was edited.
 *
 * Throws when the text is not a notebook. The test is `cells` being an array,
 * which is the one thing every nbformat version agrees on and the one thing
 * this viewer cannot do without.
 */
export function readNotebook (text) {
  let shell
  try {
    shell = JSON.parse(String(text || ''))
  } catch {
    throw new Error('This notebook is not valid JSON.')
  }
  if (!shell || typeof shell !== 'object' || Array.isArray(shell) ||
      !Array.isArray(shell.cells)) {
    throw new Error('This file is not a Jupyter notebook.')
  }

  const cells = shell.cells.map((raw) => {
    const cell = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
    const type = CELL_TYPES.has(cell.cell_type) ? cell.cell_type : 'raw'
    return {
      raw: cell,
      type,
      source: cellText(cell.source),
      outputs: type === 'code' && Array.isArray(cell.outputs) ? cell.outputs : [],
      executionCount: typeof cell.execution_count === 'number' ? cell.execution_count : null
    }
  })

  return { shell, cells }
}

/**
 * Every object rebuilt with its keys in order.
 *
 * `nbformat` serialises with `sort_keys=True`, so this is not a tidiness of
 * ours — it is the file's own spelling, and writing any other order would make
 * the first save Tulip does rewrite every line of a notebook it did not
 * change.
 */
function sortKeys (value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
  return out
}

/**
 * The model back as the file's text.
 *
 * Each cell is written through the object it was read from, so a field nothing
 * here understands is carried across untouched. The four fields this viewer
 * does own are set from the model, and the two that belong only to code cells
 * are taken off anything else — a markdown cell with an `execution_count` is a
 * notebook other tools refuse to open.
 */
export function writeNotebook (shell, cells) {
  const written = cells.map((cell) => {
    const out = { ...cell.raw }
    out.cell_type = cell.type
    out.source = sourceLines(cell.source)
    if (!out.metadata || typeof out.metadata !== 'object') out.metadata = {}
    if (cell.type === 'code') {
      out.outputs = Array.isArray(cell.outputs) ? cell.outputs : []
      out.execution_count = cell.executionCount ?? null
    } else {
      delete out.outputs
      delete out.execution_count
    }
    return out
  })
  return `${JSON.stringify(sortKeys({ ...shell, cells: written }), null, 1)}\n`
}

/* nbformat 4.5 gave every cell an id and made it required; before that there
   was no such field, and adding one would be this app writing a notebook the
   reader's own Jupyter may be too old to open. So a new cell gets an id only
   when the file it is joining already works that way. */
const idFrom = (shell) =>
  (Number(shell?.nbformat) === 4 && Number(shell?.nbformat_minor) >= 5)

let idCounter = 0
const newCellId = () =>
  `${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** An empty cell of `type`, in the shape the notebook it is joining uses. */
export function newCell (type, shell = null) {
  const raw = { cell_type: type, metadata: {}, source: [] }
  if (idFrom(shell)) raw.id = newCellId()
  if (type === 'code') { raw.execution_count = null; raw.outputs = [] }
  return { raw, type, source: '', outputs: [], executionCount: null }
}

/** The language the code cells are in, for colouring them. `language_info` is
 *  written by the kernel that ran the notebook and `kernelspec` by whoever
 *  chose it; either will do, and a notebook that has neither is shown
 *  uncoloured rather than guessed at. */
export function notebookLanguage (shell) {
  const info = shell?.metadata?.language_info
  const spec = shell?.metadata?.kernelspec
  const name = info?.name || spec?.language || ''
  return String(name || '').toLowerCase()
}

/** What the status bar says about a notebook: what it is made of. */
export function notebookShape (cells) {
  const code = cells.filter((cell) => cell.type === 'code').length
  const markdown = cells.filter((cell) => cell.type === 'markdown').length
  const outputs = cells.reduce((sum, cell) => sum + (cell.outputs?.length || 0), 0)
  return { cells: cells.length, code, markdown, outputs }
}

/* ------------------------------------------------------------- the outputs

   What a cell recorded, as the parts a viewer can draw. nbformat gives each
   output either a stream of text, a traceback, or a bundle of alternative
   renderings of the same value — a plot as a PNG *and* as `<Figure size ...>`
   — and choosing between those is this function's whole job.
   ================================================================== */

/** A `data` value: a string, or the lines it was split into. */
const bundleText = (value) => cellText(value)

/* Richest first, which is the order every notebook renderer picks in. HTML
   before the images because a DataFrame ships both an HTML table and a text
   drawing of one, and the table is the answer; the images before text because
   a plot ships a PNG and the string `<Figure size 640x480>`. */
const MIME_ORDER = [
  'text/html',
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'text/markdown',
  'text/latex',
  'application/json',
  'text/plain'
]

/**
 * One nbformat output as the parts to draw for it.
 *
 * An array rather than a single part because an error is a name and a
 * traceback, and because an unrecognised output should come back empty rather
 * than as a guess. Pure, and the reason the whole of this half is: what a
 * viewer draws for a given output is exactly the sort of thing that is easy to
 * get subtly wrong and impossible to notice by looking.
 */
export function outputParts (output) {
  if (!output || typeof output !== 'object') return []

  if (output.output_type === 'stream') {
    const text = bundleText(output.text)
    if (!text) return []
    return [{ kind: 'stream', stream: output.name === 'stderr' ? 'stderr' : 'stdout', text }]
  }

  if (output.output_type === 'error') {
    const trace = Array.isArray(output.traceback) ? output.traceback.join('\n') : ''
    const head = [output.ename, output.evalue].filter(Boolean).join(': ')
    return [{ kind: 'error', text: trace || head || 'Error', title: head }]
  }

  if (output.output_type !== 'display_data' && output.output_type !== 'execute_result') {
    return []
  }

  const data = (output.data && typeof output.data === 'object') ? output.data : {}
  const mime = MIME_ORDER.find((type) => data[type] !== undefined)
  if (!mime) return []
  const value = data[mime]

  if (mime === 'image/svg+xml') return [{ kind: 'svg', markup: bundleText(value) }]
  if (mime.startsWith('image/')) {
    /* Base64 arrives wrapped at whatever width the writer chose, and the
       newlines inside it are not part of the payload. */
    return [{ kind: 'image', mime, data: bundleText(value).replace(/\s+/g, '') }]
  }
  if (mime === 'text/html') return [{ kind: 'html', markup: bundleText(value) }]
  if (mime === 'text/markdown') return [{ kind: 'markdown', text: bundleText(value) }]
  if (mime === 'application/json') {
    let text
    try { text = JSON.stringify(value, null, 2) } catch { text = String(value) }
    return [{ kind: 'text', text }]
  }
  // text/latex included: it is maths as source, and shown as the source it is.
  return [{ kind: 'text', text: bundleText(value) }]
}

/* ------------------------------------------------------- what a kernel says

   A running kernel and a saved notebook describe the same four things in the
   same words. `stream`, `display_data`, `execute_result` and `error` arrive
   from the kernel carrying the fields nbformat records under those names —
   which is not a coincidence, because the file format is a log of these
   messages. So a message becomes an output by naming its type, and a plot that
   arrives live is the same object as a plot read from disk, drawn by the same
   `outputParts` above.
   ================================================================== */

/**
 * One kernel message as the nbformat output it is, or `null` for the many that
 * are not outputs at all — `execute_input` is our own request echoed back,
 * comm traffic belongs to widgets this app does not draw.
 */
export function kernelOutput (msgType, content) {
  const body = (content && typeof content === 'object') ? content : {}

  if (msgType === 'stream') {
    return {
      output_type: 'stream',
      name: body.name === 'stderr' ? 'stderr' : 'stdout',
      text: cellText(body.text)
    }
  }
  if (msgType === 'display_data' || msgType === 'execute_result') {
    const output = {
      output_type: msgType,
      data: (body.data && typeof body.data === 'object') ? body.data : {},
      metadata: (body.metadata && typeof body.metadata === 'object') ? body.metadata : {}
    }
    // Only `execute_result` is numbered: it is the value of the cell, and the
    // number is the prompt it belongs to.
    if (msgType === 'execute_result') output.execution_count = body.execution_count ?? null
    return output
  }
  if (msgType === 'error') {
    return {
      output_type: 'error',
      ename: String(body.ename || 'Error'),
      evalue: String(body.evalue || ''),
      traceback: Array.isArray(body.traceback) ? body.traceback.map(String) : []
    }
  }
  /* Not an output but an instruction about them, and carried as one so that a
     cell's whole story arrives down a single path in order. `applyOutput`
     below is what acts on it; it never reaches the file. */
  if (msgType === 'clear_output') {
    return { output_type: 'clear_output', wait: body.wait === true }
  }
  return null
}

/**
 * Add one output to what a cell has produced so far.
 *
 * Pure, and returns the next state rather than editing this one, because the
 * two rules here are the sort that are easy to get subtly wrong:
 *
 * - Consecutive stream outputs on the same name are one output. A loop that
 *   prints a thousand lines sends a thousand messages, and recording them as a
 *   thousand outputs would write a notebook no other tool writes and make the
 *   viewer build a thousand `<pre>`s to show one paragraph.
 *
 * - `clear_output` with `wait` does not clear anything yet. It means "replace
 *   this when there is something to replace it with", which is how a progress
 *   bar redraws without the cell flickering empty between frames.
 *
 * @param {{outputs: object[], clearWhenNext: boolean}} state
 * @param {object} output  an output from `kernelOutput`
 */
export function applyOutput (state, output) {
  const outputs = Array.isArray(state?.outputs) ? state.outputs : []
  const clearWhenNext = state?.clearWhenNext === true
  if (!output) return { outputs, clearWhenNext }

  if (output.output_type === 'clear_output') {
    return output.wait
      ? { outputs, clearWhenNext: true }
      : { outputs: [], clearWhenNext: false }
  }

  const base = clearWhenNext ? [] : outputs
  const last = base[base.length - 1]
  if (output.output_type === 'stream' && last?.output_type === 'stream' &&
      last.name === output.name) {
    const merged = { ...last, text: cellText(last.text) + cellText(output.text) }
    return { outputs: [...base.slice(0, -1), merged], clearWhenNext: false }
  }
  return { outputs: [...base, output], clearWhenNext: false }
}

/* ---------------------------------------------------------------- ansi

   Every kernel colours its own output, and a traceback is nothing but colour:
   the file holds the escape codes verbatim. Rendered as text they are visible
   noise around the one line that says what went wrong.
   ================================================================== */

const ANSI_COLOURS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

/* Select Graphic Rendition — the `m` sequences, which are the only ones that
   change how text looks. Every other escape sequence moves a cursor around a
   terminal there is none of here, and is dropped. */
const SGR = /\u001b\[([0-9;]*)m/g
const OTHER_ESCAPES =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g

/**
 * A carriage return means "start this line again", which is how a progress bar
 * draws itself a hundred times into one line. Only the last drawing is the one
 * that was on screen, so that is the one kept.
 */
function collapseReturns (text) {
  if (!text.includes('\r')) return text
  return text.split('\n').map((line) => {
    const at = line.lastIndexOf('\r')
    return at === -1 ? line : line.slice(at + 1)
  }).join('\n')
}

/**
 * ANSI-coloured text as the spans to build for it.
 *
 * @returns {{text: string, classes: string}[]}
 */
export function ansiSpans (text) {
  const source = collapseReturns(String(text ?? ''))
  const out = []
  let state = { fg: '', bg: '', bold: false, italic: false, underline: false }

  const classesOf = () => [
    state.fg && `nb-fg-${state.fg}`,
    state.bg && `nb-bg-${state.bg}`,
    state.bold && 'nb-bold',
    state.italic && 'nb-italic',
    state.underline && 'nb-underline'
  ].filter(Boolean).join(' ')

  const push = (chunk) => {
    if (!chunk) return
    const clean = chunk.replace(OTHER_ESCAPES, '')
    if (!clean) return
    const classes = classesOf()
    // Runs with the same look are one span: a traceback is thousands of tiny
    // coloured fragments, and most of them are neighbours wearing the same one.
    const last = out[out.length - 1]
    if (last && last.classes === classes) last.text += clean
    else out.push({ text: clean, classes })
  }

  let at = 0
  let match
  SGR.lastIndex = 0
  while ((match = SGR.exec(source))) {
    push(source.slice(at, match.index))
    at = match.index + match[0].length
    /* An empty parameter list is `[m`, which means reset — the same as
       `0`, and the one case where splitting on `;` gives nothing to read. */
    const codes = (match[1] || '0').split(';').map((code) => Number(code) || 0)
    for (const code of codes) {
      if (code === 0) state = { fg: '', bg: '', bold: false, italic: false, underline: false }
      else if (code === 1) state.bold = true
      else if (code === 3) state.italic = true
      else if (code === 4) state.underline = true
      else if (code === 22) state.bold = false
      else if (code === 23) state.italic = false
      else if (code === 24) state.underline = false
      else if (code >= 30 && code <= 37) state.fg = ANSI_COLOURS[code - 30]
      else if (code === 39) state.fg = ''
      else if (code >= 40 && code <= 47) state.bg = ANSI_COLOURS[code - 40]
      else if (code === 49) state.bg = ''
      else if (code >= 90 && code <= 97) state.fg = `bright-${ANSI_COLOURS[code - 90]}`
      else if (code >= 100 && code <= 107) state.bg = `bright-${ANSI_COLOURS[code - 100]}`
    }
  }
  push(source.slice(at))
  return out
}

/* --------------------------------------------------------------- the view */

/* One output is allowed this much text on screen. A cell that printed a
   hundred megabytes is a real thing to be handed, and building it as DOM would
   take the window down — so what is shown is the head of it, and the viewer
   says plainly that there is more in the file. */
const OUTPUT_LIMIT = 100_000

/* Long enough that a keystroke never waits on a parser, short enough that a
   pause in typing is coloured before you look up. */
const HIGHLIGHT_DELAY = 140

const PLACEHOLDER = {
  code: 'Empty code cell',
  markdown: 'Empty markdown cell',
  raw: 'Empty raw cell'
}

/**
 * Mount the notebook viewer into `host`. One instance for the life of the
 * window, like every other viewer here.
 *
 * @param host        the pane this draws into
 * @param file        the renderer's `api.file` — `read` and `write`
 * @param markdown    how a markdown cell is rendered: `{ prepare, render }`,
 *                    the app's own dialect handed in rather than rebuilt, so a
 *                    formula in a notebook is set the way one in a note is
 * @param onDirty     told when there are unsaved edits, and when there are not
 * @param onSaved     told when a save landed
 * @param onStatus    told that what the status bar says about this notebook
 *                    has changed — it reads `summary()` for itself
 */
export function mountNotebook ({
  host,
  file,
  markdown = null,
  kernel = null,
  onDirty = () => {},
  onSaved = () => {},
  onStatus = () => {}
}) {
  let current = null          // { path }
  let shell = null            // the file, as parsed
  let cells = []              // the working model
  let language = ''
  let dirty = false
  let readonly = false
  let saving = null
  let flushRequested = false
  let saveTimer = null
  /* Which cell is being typed into, and — for a markdown cell — which one is
     showing its source rather than its rendering. Two different questions: a
     markdown cell stays open for editing when the caret leaves it for the
     toolbar, and only closes when something else is chosen. */
  let editingIndex = -1
  /* Snapshots of the cell list, for the structural changes. Text edits are the
     textarea's own undo and are deliberately not in here — a stack that
     swallowed both would step over a whole paragraph you typed to get back to
     a cell you deleted. */
  let history = []
  let future = []
  const HISTORY_LIMIT = 60

  /* ------------------------------------------------------------ running

     What is known about this notebook's kernel, and which cells are waiting on
     it. `runs` is keyed by the cell *object* rather than its index, because a
     cell that is running can be moved or deleted while it runs and an index
     would then point at somebody else's output. */
  let kernelInfo = null        // { kernel, name, state } once started
  let kernelStarting = null    // the in-flight start, so two clicks start one
  let kernelNotice = ''        // something the kernel wants said, e.g. a substitution
  const runs = new Map()       // cell -> { msgId, state: {outputs, clearWhenNext} }
  let queue = []               // cells still to run, for Run all
  let queueStop = false

  const isRunning = (cell) => runs.has(cell)
  const anyRunning = () => runs.size > 0 || queue.length > 0

  host.classList.add('nb')

  const bar = el('div', 'nb-bar')
  const barShape = el('div', 'nb-shape')
  const barActions = el('div', 'nb-bar-actions')

  /* ⌘F over a notebook. What is searched is the cells, because that is what
     the pane holds — there is no buffer here for the editor's find panel to
     search, and the JSON it would search instead is not what is on screen.
     Cell-wise rather than word-wise for the same reason the grid's find is
     cell-wise: the answer to "where is `read_csv`" is a cell, and taking you
     to it is the whole of what is being asked. */
  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'nb-find'
  search.placeholder = 'Find in cells'
  search.setAttribute('aria-label', 'Find in cells')
  const found = el('span', 'nb-found')

  let hits = []
  let hitAt = -1

  const clearHits = () => {
    for (const section of column.children) section.classList?.remove('is-hit')
  }

  const runSearch = ({ advance = false } = {}) => {
    const query = search.value.trim().toLowerCase()
    clearHits()
    if (!query) {
      hits = []
      hitAt = -1
      found.textContent = ''
      return
    }
    hits = cells.reduce((list, cell, index) => {
      if (cell.source.toLowerCase().includes(query)) list.push(index)
      return list
    }, [])
    if (!hits.length) {
      hitAt = -1
      found.textContent = 'no cells'
      return
    }
    hitAt = advance
      ? (hitAt + 1) % hits.length
      : Math.max(0, hits.findIndex((index) => index >= Math.max(0, hitAt)))
    found.textContent = `${hitAt + 1} of ${hits.length}`
    const section = column.children[hits[hitAt]]
    section?.classList.add('is-hit')
    section?.scrollIntoView({ block: 'center' })
  }

  search.addEventListener('input', () => { hitAt = -1; runSearch() })
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); runSearch({ advance: true }) }
    if (event.key === 'Escape') {
      event.stopPropagation()
      search.value = ''
      runSearch()
      scroller.focus({ preventScroll: true })
    }
  })

  const finder = el('div', 'nb-find-wrap')
  finder.append(search, found)
  bar.append(barShape, finder, barActions)

  const scroller = el('div', 'nb-scroll')
  scroller.tabIndex = -1
  const column = el('div', 'nb-col')
  scroller.append(column)
  host.replaceChildren(bar, scroller)

  const editable = () => !readonly && !!current
  /* Running is an Editing-view act, like every other control here: it writes
     outputs into the file, and Reading view is where a notebook is a document
     rather than a workspace. It also needs the bridge to exist at all, which
     it does not in the tests or in a window built without it. */
  const canRun = () => editable() && !!kernel?.start

  const setDirty = (next) => {
    if (dirty === next) return
    dirty = next
    onDirty(next)
  }

  const queueSave = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveFile().catch(() => {}) }, 900)
  }

  const saveFile = async ({ flush = false } = {}) => {
    if (flush) flushRequested = true
    if (saving) return saving
    saving = (async () => {
      do {
        if (!current || !dirty) break
        clearTimeout(saveTimer)
        const text = writeNotebook(shell, cells)
        await file.write(current.path, text)
        setDirty(false)
        onSaved()
      } while (flushRequested && dirty)
      flushRequested = false
      return true
    })()
    try { return await saving } finally { saving = null }
  }

  /** Every change to the shape of the notebook goes through here, so that
   *  every one of them is undoable and none of them can forget to save. */
  const change = (run, { repaint = true } = {}) => {
    if (!editable()) return false
    history.push(cells.map((cell) => ({ ...cell })))
    if (history.length > HISTORY_LIMIT) history.shift()
    future = []
    run()
    setDirty(true)
    queueSave()
    if (repaint) paint()
    // The shape of the notebook is what the status bar says about it, and
    // every change that comes through here can have changed it.
    onStatus()
    return true
  }

  const stepHistory = (redo) => {
    if (!editable()) return false
    const from = redo ? future : history
    if (!from.length) return false
    const to = redo ? history : future
    to.push(cells.map((cell) => ({ ...cell })))
    cells = from.pop()
    setDirty(true)
    queueSave()
    paint()
    onStatus()
    return true
  }

  /* ---------------------------------------------------------- the outputs */

  /** A run of text, coloured by whatever escape codes are in it. */
  function textBlock (text, className) {
    const pre = el('pre', className)
    const shown = text.length > OUTPUT_LIMIT ? text.slice(0, OUTPUT_LIMIT) : text
    for (const span of ansiSpans(shown)) {
      if (!span.classes) { pre.append(document.createTextNode(span.text)); continue }
      const mark = el('span', span.classes)
      mark.textContent = span.text
      pre.append(mark)
    }
    if (text.length > OUTPUT_LIMIT) {
      pre.append(el('span', 'nb-elided',
        `\n… ${(text.length - OUTPUT_LIMIT).toLocaleString()} more characters in the file`))
    }
    return pre
  }

  function drawPart (part) {
    if (part.kind === 'stream') {
      return textBlock(part.text, `nb-out-text is-${part.stream}`)
    }
    if (part.kind === 'error') {
      const box = el('div', 'nb-out-error')
      box.append(textBlock(part.text, 'nb-out-text'))
      return box
    }
    if (part.kind === 'image') {
      const figure = el('div', 'nb-out-image')
      const img = document.createElement('img')
      img.src = `data:${part.mime};base64,${part.data}`
      img.alt = 'Cell output'
      img.loading = 'lazy'
      figure.append(img)
      return figure
    }
    if (part.kind === 'svg') {
      /* Through an `<img>` rather than into the document. An SVG is a document
         of its own with scripts and external references of its own, and one
         loaded as an image cannot run or fetch any of it — which is the whole
         point, because this markup was written by whatever the notebook ran. */
      const figure = el('div', 'nb-out-image')
      const img = document.createElement('img')
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(part.markup)}`
      img.alt = 'Cell output'
      figure.append(img)
      return figure
    }
    if (part.kind === 'html') {
      const box = el('div', 'nb-out-html')
      box.innerHTML = sanitizeHtml(part.markup, () => null)
      return box
    }
    if (part.kind === 'markdown') {
      const box = el('div', 'nb-md')
      if (markdown?.render) box.innerHTML = markdown.render(part.text)
      else box.append(textBlock(part.text, 'nb-out-text'))
      return box
    }
    return textBlock(part.text, 'nb-out-text')
  }

  function drawOutputs (cell) {
    const wrap = el('div', 'nb-outputs')
    for (const output of cell.outputs) {
      for (const part of outputParts(output)) wrap.append(drawPart(part))
    }
    return wrap.childElementCount ? wrap : null
  }

  /* ------------------------------------------------------------- running

     A cell that is running changes two things on screen and nothing else: its
     prompt, and its outputs. Repainting the notebook for either would be the
     wrong tool — `paint()` rebuilds every textarea, which throws away the
     caret of whoever is typing in a different cell while this one runs.
     ================================================================== */

  /** The section showing a cell right now, or null if it is not on screen. */
  function sectionFor (cell) {
    const index = cells.indexOf(cell)
    return index < 0 ? null : (column.children[index] || null)
  }

  /** Redraw just one cell's prompt and outputs, in place. */
  function repaintCell (cell) {
    const section = sectionFor(cell)
    if (!section) return

    section.querySelector(':scope > .nb-gutter')?.replaceWith(drawGutter(cell))
    section.classList.toggle('is-running', isRunning(cell) || queue.includes(cell))

    const body = section.querySelector('.nb-body')
    if (!body) return
    const existing = body.querySelector(':scope > .nb-outputs')
    const next = cell.type === 'code' ? drawOutputs(cell) : null
    if (existing && next) existing.replaceWith(next)
    else if (existing) existing.remove()
    else if (next) body.append(next)
  }

  /* One paint per frame. A loop printing a thousand lines sends a thousand
     messages, and rebuilding the output panel for each makes the work grow
     with the square of the output — chunk 900 redrawing chunks 1 to 899 again.
     The same bargain src/runcode.js makes, for the same reason. */
  const dirtyCells = new Set()
  let repaintFrame = null

  function scheduleRepaint (cell) {
    dirtyCells.add(cell)
    if (repaintFrame != null) return
    repaintFrame = requestAnimationFrame(() => {
      repaintFrame = null
      const pending = [...dirtyCells]
      dirtyCells.clear()
      for (const each of pending) repaintCell(each)
    })
  }

  function repaintNow (cell) {
    dirtyCells.delete(cell)
    repaintCell(cell)
  }

  /* Output that arrived before the cell that asked for it learned its request
     id. `kernel:execute` resolves over one bridge and the output comes down
     another, so the first chunk can and does overtake the id — the same race
     src/runcode.js keeps a holding pen for. */
  const inbox = new Map()      // msgId -> event[]
  const byMsg = new Map()      // msgId -> cell

  function kernelEvent (event) {
    if (!current || event?.path !== current.path) return

    if (event.kind === 'state') {
      if (kernelInfo) kernelInfo.state = event.state
      paintBar()
      return
    }
    if (event.kind === 'notice') {
      kernelNotice = String(event.text || '')
      paintBar()
      return
    }

    const cell = byMsg.get(event.msgId)
    if (!cell) {
      // Not yet claimed. Hold it, bounded, so a runaway cell whose id never
      // arrives cannot grow this without limit.
      const held = inbox.get(event.msgId) || []
      if (held.length < 5000) held.push(event)
      inbox.set(event.msgId, held)
      return
    }
    applyEvent(cell, event)
  }

  function applyEvent (cell, event) {
    const run = runs.get(cell)
    if (!run) return

    if (event.kind === 'count') {
      cell.executionCount = event.executionCount ?? null
      scheduleRepaint(cell)
      return
    }

    if (event.kind === 'output') {
      const output = kernelOutput(event.msgType, event.content)
      if (!output) return
      run.state = applyOutput(run.state, output)
      cell.outputs = run.state.outputs
      /* Written into the cell, and the cell is the file — so a run makes the
         notebook dirty exactly as typing does, and the outputs are still there
         when it is opened again. */
      setDirty(true)
      queueSave()
      scheduleRepaint(cell)
      return
    }

    if (event.kind === 'done') {
      runs.delete(cell)
      byMsg.delete(event.msgId)
      inbox.delete(event.msgId)
      if (event.error) {
        /* A run that ended without the kernel saying why still has to say
           something. Recorded as an error output rather than a dialog: it
           belongs to the cell it happened to. */
        run.state = applyOutput(run.state, {
          output_type: 'error', ename: 'Tulip', evalue: event.error, traceback: [event.error]
        })
        cell.outputs = run.state.outputs
        setDirty(true)
        queueSave()
      }
      run.settle?.({ status: event.status || 'ok' })
      repaintNow(cell)
      paintBar()
      onStatus()
    }
  }

  /** The kernel for this notebook, started on first use. Two clicks while it
   *  is starting wait on the one start rather than racing to make two. */
  function ensureKernel () {
    if (kernelInfo) return Promise.resolve(kernelInfo)
    if (kernelStarting) return kernelStarting
    if (!kernel?.start) return Promise.reject(new Error('Running cells is not available.'))

    const wanted = shell?.metadata?.kernelspec?.name || ''
    const path = current?.path
    kernelStarting = kernel.start(path, wanted)
      .then((info) => {
        // The notebook was closed or swapped while Python was starting.
        if (current?.path !== path) return info
        kernelInfo = { ...info }
        paintBar()
        return kernelInfo
      })
      .finally(() => { kernelStarting = null })
    paintBar()
    return kernelStarting
  }

  /**
   * Run one cell and settle when the kernel is done with it.
   *
   * An empty cell is skipped rather than sent: Jupyter gives it no number and
   * no output, so sending it would cost a round trip to change nothing.
   */
  async function runCell (cell) {
    if (!current || cell.type !== 'code' || !cell.source.trim()) return { status: 'skipped' }
    if (isRunning(cell)) return { status: 'busy' }

    const run = { msgId: null, state: { outputs: [], clearWhenNext: false }, settle: null }
    const finished = new Promise((resolve) => { run.settle = resolve })
    runs.set(cell, run)
    /* Cleared before the run, not after it: the old output is what the *last*
       run printed, and leaving it under a spinner reads as this run's. */
    cell.outputs = []
    cell.executionCount = null
    repaintNow(cell)
    paintBar()

    try {
      await ensureKernel()
      if (!runs.has(cell)) return { status: 'aborted' }
      const { msgId } = await kernel.execute(current.path, cell.source)
      run.msgId = msgId
      byMsg.set(msgId, cell)
      // Anything that overtook the id, now that there is somewhere to put it.
      for (const held of inbox.get(msgId) || []) applyEvent(cell, held)
      inbox.delete(msgId)
    } catch (err) {
      runs.delete(cell)
      if (run.msgId) byMsg.delete(run.msgId)
      const text = err?.message || 'This cell could not be run.'
      run.state = applyOutput(run.state, {
        output_type: 'error', ename: 'Tulip', evalue: text, traceback: [text]
      })
      cell.outputs = run.state.outputs
      setDirty(true)
      queueSave()
      repaintNow(cell)
      paintBar()
      return { status: 'error' }
    }
    return finished
  }

  /**
   * Run a list of cells in order, stopping at the first that fails.
   *
   * Stopping is what `stop_on_error` means and what Jupyter does: the cells
   * below one that raised would run against a state that never happened, and
   * their output would describe a notebook nobody has.
   */
  async function runCells (list) {
    queue = list.filter((cell) => cell.type === 'code' && cell.source.trim())
    queueStop = false
    paintBar()
    while (queue.length && !queueStop) {
      const cell = queue.shift()
      // It may have been deleted while the cell above it was running.
      if (!cells.includes(cell)) continue
      sectionFor(cell)?.scrollIntoView({ block: 'nearest' })
      const result = await runCell(cell)
      if (result?.status === 'error' || result?.status === 'aborted') break
    }
    queue = []
    queueStop = false
    paintBar()
  }

  const runAll = () => runCells([...cells])

  function stopQueue () {
    queueStop = true
    queue = []
  }

  async function interruptKernel () {
    stopQueue()
    if (kernelInfo) await kernel.interrupt(current.path).catch(() => {})
    paintBar()
  }

  async function restartKernel () {
    stopQueue()
    if (!kernelInfo) return
    await kernel.restart(current.path).catch(() => {})
    /* Every number in the file describes a session that no longer exists. The
       outputs stay — they are what those runs printed, and deleting them is a
       separate thing the reader can ask for. */
    for (const cell of cells) {
      if (cell.type === 'code') cell.executionCount = null
    }
    runs.clear()
    byMsg.clear()
    inbox.clear()
    setDirty(true)
    queueSave()
    paint()
  }

  /** Let go of this notebook's kernel. Called when it closes, so a Python
   *  process is not left holding a gigabyte for a pane nobody is looking at. */
  function releaseKernel () {
    const path = current?.path
    stopQueue()
    runs.clear()
    byMsg.clear()
    inbox.clear()
    kernelInfo = null
    kernelStarting = null
    kernelNotice = ''
    if (path && kernel?.shutdown) kernel.shutdown(path).catch(() => {})
  }

  const stopListening = kernel?.on ? kernel.on(kernelEvent) : null

  /* ----------------------------------------------------------- the source */

  const highlightTimers = new WeakMap()

  /** Colour the `<pre>` under a cell's textarea. Debounced, because a parse
   *  per keystroke is a parse the typist waits on. */
  function colour (pre, text, token, { now = false } = {}) {
    clearTimeout(highlightTimers.get(pre))
    const run = () => {
      highlightInto(pre, `${text}\n`, token).then((done) => {
        // An unknown language still has to sit exactly under the textarea, so
        // the plain text stays in place when there is no parser for it.
        if (!done && pre.isConnected) pre.textContent = `${text}\n`
      }).catch(() => {})
    }
    if (now) run()
    else highlightTimers.set(pre, setTimeout(run, HIGHLIGHT_DELAY))
  }

  /** The grammar a cell's source is coloured with. */
  const tokenFor = (cell) =>
    cell.type === 'markdown' ? 'markdown' : cell.type === 'code' ? language : ''

  /**
   * The editable source of one cell: a `<pre>` that holds the text and does
   * the layout, and a textarea over it with transparent ink. They must wrap
   * identically or the caret drifts from the letter under it — which is why
   * the `<pre>` is written synchronously on every keystroke and only its
   * colouring is deferred.
   */
  function drawSource (cell, index) {
    const wrap = el('div', 'nb-source')
    const pre = el('pre', 'nb-ink')
    pre.textContent = `${cell.source}\n`
    wrap.append(pre)
    colour(pre, cell.source, tokenFor(cell), { now: true })

    if (!editable()) {
      if (!cell.source) wrap.classList.add('is-empty')
      return wrap
    }

    const input = document.createElement('textarea')
    input.className = 'nb-input'
    input.value = cell.source
    input.spellcheck = cell.type === 'markdown'
    input.wrap = 'soft'
    input.setAttribute('aria-label', `${cell.type} cell ${index + 1}`)
    if (!cell.source) input.placeholder = PLACEHOLDER[cell.type] || ''

    input.addEventListener('input', () => {
      cell.source = input.value
      pre.textContent = `${input.value}\n`
      colour(pre, input.value, tokenFor(cell))
      setDirty(true)
      queueSave()
      onStatus()
    })

    input.addEventListener('focus', () => {
      editingIndex = index
      wrap.closest('.nb-cell')?.classList.add('is-editing')
    })

    input.addEventListener('keydown', (event) => {
      /* The three Enters every notebook has, and the reason a code cell cannot
         simply treat Enter as newline and be done: ⇧⏎ runs and moves on, which
         is how a notebook is read top to bottom; ⌘⏎ runs and stays, which is
         how one cell is worked on; ⌥⏎ runs and opens a new cell under it. */
      if (event.key === 'Enter' && (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)) {
        event.preventDefault()
        if (!canRun()) return
        const at = cells.indexOf(cell)
        // Markdown and raw cells have nothing to run, but ⇧⏎ still means
        // "done with this one" — it renders the prose and moves on.
        const running = cell.type === 'code' ? runCell(cell) : Promise.resolve()
        void running

        if (event.metaKey || event.ctrlKey) {
          if (cell.type === 'markdown') { editingIndex = -1; paint() }
          return
        }
        if (event.altKey) { addCell(at + 1); return }
        if (cell.type === 'markdown') editingIndex = -1
        if (at === cells.length - 1) addCell(at + 1)
        else { paint(); focusCell(at + 1) }
        return
      }
      if (event.key === 'Escape') {
        event.stopPropagation()
        // A markdown cell goes back to being the prose it describes; anything
        // else simply hands the keys back to the window.
        if (cell.type === 'markdown') { editingIndex = -1; paint() }
        scroller.focus({ preventScroll: true })
        return
      }
      /* Tab indents rather than leaving the cell. A code cell is the one place
         in this app where the key means indentation, and a notebook whose
         Tab key jumped to the next cell would be one nobody could write
         Python in. Shift-Tab is the way out, and back through the toolbar. */
      if (event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault()
        const { selectionStart: from, selectionEnd: to } = input
        input.setRangeText('    ', from, to, 'end')
        input.dispatchEvent(new Event('input'))
      }
    })

    wrap.append(input)
    return wrap
  }

  /* ------------------------------------------------------------ the cells */

  /* `[*]` is Jupyter's own spelling for "this is running or waiting to", and
     the one thing a reader watching a slow cell is looking for. */
  const promptFor = (cell) => {
    if (cell.type !== 'code') return ''
    if (isRunning(cell) || queue.includes(cell)) return '[*]'
    return cell.executionCount == null ? '[ ]' : `[${cell.executionCount}]`
  }

  function iconButton (label, markup, onClick) {
    const button = el('button', 'nb-cell-btn')
    button.type = 'button'
    button.title = label
    button.setAttribute('aria-label', label)
    button.append(svgIcon(markup, { viewBox: '0 0 24 24', className: 'nb-cell-ico' }))
    button.addEventListener('click', onClick)
    return button
  }

  const ARROW_UP = `<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  const ARROW_DOWN = `<path d="M12 5v13M6.5 12.5 12 18l5.5-5.5" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  const PLUS = `<path d="M12 5.5v13M5.5 12h13" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round"/>`
  const TRASH = `<path d="M5.5 7h13M9.5 7V5.4h5V7M7.5 7l.8 12.1h7.4L16.5 7"
      fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
      stroke-linejoin="round"/>`
  const BROOM = `<path d="M14.5 4.5 9 10M6 19l-1.5-4.5 7-7L15 9l-7 7z" fill="none"
      stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  const PLAY = `<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>`
  const STOP = `<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>`

  /** The controls that act on one cell. Present only while the notebook is
   *  editable — in Reading view a notebook is a document, not a workspace. */
  function drawTools (cell, index) {
    const tools = el('div', 'nb-cell-tools')

    const type = document.createElement('select')
    type.className = 'nb-cell-type'
    type.title = 'What kind of cell this is'
    type.setAttribute('aria-label', 'Cell type')
    for (const [value, label] of [['code', 'Code'], ['markdown', 'Markdown'], ['raw', 'Raw']]) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      type.append(option)
    }
    type.value = cell.type
    type.addEventListener('change', () => {
      const wanted = type.value
      change(() => {
        cell.type = wanted
        /* Outputs belong to code that ran. A cell turned into prose has none,
           and turning it back does not bring them back — which is honest: they
           were never this cell's outputs once it stopped being that code. */
        if (wanted !== 'code') { cell.outputs = []; cell.executionCount = null }
        editingIndex = wanted === 'markdown' ? -1 : index
      })
    })
    tools.append(type)

    tools.append(iconButton('Move up', ARROW_UP, () => moveCell(index, -1)))
    tools.append(iconButton('Move down', ARROW_DOWN, () => moveCell(index, 1)))
    tools.append(iconButton('Add a cell below', PLUS, () => addCell(index + 1)))
    if (cell.type === 'code' && cell.outputs.length) {
      tools.append(iconButton('Clear this cell’s output', BROOM, () => change(() => {
        cell.outputs = []
        cell.executionCount = null
      })))
    }
    tools.append(iconButton('Delete this cell', TRASH, () => deleteCell(index)))
    return tools
  }

  /**
   * The strip to the left of a cell: what number the run has, and the control
   * that starts it.
   *
   * Its own function because a run changes both of those and nothing else, so
   * this is exactly what `repaintCell` swaps while a cell runs — see there for
   * why repainting the notebook instead is the wrong tool.
   */
  function drawGutter (cell) {
    const gutter = el('div', 'nb-gutter')
    const prompt = el('div', 'nb-prompt', promptFor(cell))
    if (cell.type === 'code') {
      prompt.title = isRunning(cell) || queue.includes(cell)
        ? 'Running'
        : cell.executionCount == null
          ? 'This cell has not been run'
          : `Run ${cell.executionCount} of this kernel`
    }
    gutter.append(prompt)

    /* Run lives in the gutter under the prompt rather than in the hover
       toolbar with the rest. It is the one control here anybody presses twice
       in a row, and the prompt beside it is what it changes — a Run you have
       to hover to find is a Run people never discover. While the cell is
       running the same button interrupts: "stop this" is wanted from the
       control you just pressed, and in the place you pressed it. */
    if (cell.type === 'code' && canRun()) {
      const busy = isRunning(cell) || queue.includes(cell)
      const run = iconButton(
        busy ? 'Interrupt' : 'Run this cell  (⇧⏎)',
        busy ? STOP : PLAY,
        () => { if (busy) interruptKernel(); else runCell(cell) }
      )
      run.classList.add('nb-run')
      gutter.append(run)
    }
    return gutter
  }

  function drawCell (cell, index) {
    const section = el('section', `nb-cell is-${cell.type}`)
    section.dataset.index = String(index)
    if (isRunning(cell) || queue.includes(cell)) section.classList.add('is-running')

    section.append(drawGutter(cell))

    const body = el('div', 'nb-body')

    /* A markdown cell is prose, so prose is what it shows — until it is asked
       for its source. A code cell is source either way: that is what the cell
       *is*, and there is nothing else of it to render. */
    if (cell.type === 'markdown' && editingIndex !== index) {
      const rendered = el('div', 'nb-md')
      if (cell.source.trim() && markdown?.render) {
        rendered.innerHTML = markdown.render(cell.source)
      } else if (cell.source.trim()) {
        rendered.textContent = cell.source
      } else {
        rendered.append(el('p', 'nb-empty', PLACEHOLDER.markdown))
      }
      if (editable()) {
        rendered.title = 'Double-click to edit'
        rendered.addEventListener('dblclick', () => {
          editingIndex = index
          paint()
          focusCell(index)
        })
      }
      body.append(rendered)
    } else {
      body.append(drawSource(cell, index))
    }

    const outputs = cell.type === 'code' ? drawOutputs(cell) : null
    if (outputs) body.append(outputs)

    section.append(body)
    if (editable()) section.append(drawTools(cell, index))
    return section
  }

  /* --------------------------------------------------------- the structure */

  function addCell (at, type = 'code') {
    change(() => {
      cells.splice(at, 0, newCell(type, shell))
      editingIndex = type === 'markdown' ? at : -1
    })
    focusCell(at)
  }

  function deleteCell (index) {
    change(() => {
      cells.splice(index, 1)
      /* Never nothing. A notebook with no cells is a valid file and an
         unusable screen — there is nowhere to click to start typing again. */
      if (!cells.length) cells.push(newCell('code', shell))
      editingIndex = -1
    })
  }

  function moveCell (index, by) {
    const to = index + by
    if (to < 0 || to >= cells.length) return
    change(() => {
      const [cell] = cells.splice(index, 1)
      cells.splice(to, 0, cell)
      if (editingIndex === index) editingIndex = to
    })
    focusCell(to)
  }

  /** Put the caret in a cell, once the paint that built it has happened. */
  function focusCell (index) {
    const section = column.children[index]
    const input = section?.querySelector('.nb-input')
    if (input) input.focus()
    else section?.scrollIntoView({ block: 'nearest' })
  }

  /* ------------------------------------------------------------- painting */

  function paintBar () {
    const shape = notebookShape(cells)
    /* Which kernel is *running*, when one is — the file's `kernelspec` is what
       the notebook asked for, and those are different facts the moment a
       notebook written elsewhere is opened here. */
    const named = kernelInfo?.kernel || shell?.metadata?.kernelspec?.display_name || ''
    barShape.textContent = [
      `${shape.cells} ${shape.cells === 1 ? 'cell' : 'cells'}`,
      named,
      kernelInfo ? (anyRunning() ? 'busy' : 'idle') : (kernelStarting ? 'starting…' : '')
    ].filter(Boolean).join(' · ')
    barShape.title = kernelNotice || ''
    barShape.classList.toggle('is-notice', !!kernelNotice)

    barActions.replaceChildren()
    if (!editable()) return

    if (canRun()) {
      const runAllBtn = el('button', 'nb-btn', 'Run all')
      runAllBtn.type = 'button'
      runAllBtn.title = 'Run every code cell, top to bottom'
      runAllBtn.disabled = anyRunning()
      runAllBtn.addEventListener('click', () => { runAll() })
      barActions.append(runAllBtn)

      if (anyRunning()) {
        const stop = el('button', 'nb-btn is-stop', 'Interrupt')
        stop.type = 'button'
        stop.title = 'Stop what the kernel is doing'
        stop.addEventListener('click', () => { interruptKernel() })
        barActions.append(stop)
      }

      if (kernelInfo) {
        const restart = el('button', 'nb-btn', 'Restart')
        restart.type = 'button'
        restart.title = 'Throw away every variable and start the kernel again'
        restart.addEventListener('click', () => { restartKernel() })
        barActions.append(restart)
      }
    }

    const add = el('button', 'nb-btn', 'Add cell')
    add.type = 'button'
    add.addEventListener('click', () => addCell(cells.length))
    barActions.append(add)

    if (cells.some((cell) => cell.outputs.length)) {
      const clear = el('button', 'nb-btn', 'Clear all outputs')
      clear.type = 'button'
      clear.title = 'Remove every recorded output from this notebook'
      clear.addEventListener('click', () => change(() => {
        for (const cell of cells) {
          cell.outputs = []
          cell.executionCount = null
        }
      }))
      barActions.append(clear)
    }
  }

  function paint () {
    const at = scroller.scrollTop
    const built = cells.map((cell, index) => drawCell(cell, index))
    /* The one place to start typing in a notebook whose last cell is full. It
       is a button rather than a bare click target so it is reachable by
       keyboard like everything else on the page. */
    if (editable()) {
      const tail = el('button', 'nb-tail', '+ Add a cell')
      tail.type = 'button'
      tail.addEventListener('click', () => addCell(cells.length))
      built.push(tail)
    }
    column.replaceChildren(...built)
    paintBar()
    scroller.scrollTop = at
  }

  const summary = () => {
    if (!current) return ''
    const shape = notebookShape(cells)
    const parts = [`${shape.cells} ${shape.cells === 1 ? 'cell' : 'cells'}`]
    if (shape.code) parts.push(`${shape.code} code`)
    if (shape.markdown) parts.push(`${shape.markdown} markdown`)
    if (!shape.outputs) parts.push('no saved output')
    return parts.join(' · ')
  }

  return {
    /**
     * Show the notebook at `path`.
     *
     * A file that will not parse throws rather than opening empty: the tab has
     * to go back to what it was showing, and a blank notebook pane that
     * autosaves is a blank notebook pane that overwrites the file.
     */
    async open (path, place = null) {
      const text = await file.read(path)
      const read = readNotebook(text)
      /* The kernel that is running belongs to the notebook being replaced. Let
         it go before the model does, while `current` still says which one it
         was — after this point there is nothing left to name it by. */
      if (current && current.path !== path) releaseKernel()
      shell = read.shell
      cells = read.cells
      // Never nothing, for the same reason a delete never empties it.
      if (!cells.length) cells.push(newCell('code', shell))
      language = notebookLanguage(shell)
      current = { path }
      editingIndex = -1
      history = []
      future = []
      search.value = ''
      hits = []
      hitAt = -1
      found.textContent = ''
      setDirty(false)

      /* The maths in every markdown cell, loaded before the first of them is
         rendered: the renderer's markdown sets formulae synchronously, and a
         KaTeX that has not arrived yet is a notebook of `$\alpha$` as text. */
      if (markdown?.prepare) {
        await markdown.prepare(
          cells.filter((cell) => cell.type === 'markdown')
            .map((cell) => cell.source).join('\n\n')
        ).catch(() => {})
        if (current?.path !== path) return
      }

      paint()
      scroller.scrollTop = Number(place?.top) || 0
      onStatus()
    },

    save: saveFile,

    async close () {
      await saveFile({ flush: true }).catch(() => {})
      clearTimeout(saveTimer)
      releaseKernel()
      current = null
      shell = null
      cells = []
      history = []
      future = []
      editingIndex = -1
      hits = []
      hitAt = -1
      search.value = ''
      found.textContent = ''
      column.replaceChildren()
      barActions.replaceChildren()
      barShape.textContent = ''
    },

    /**
     * Reading or Editing, from the window's own view switch.
     *
     * Called before `open` as well as after it — the view is a preference that
     * outlives any one document — so it stands on its own with no file loaded.
     */
    setReadonly (flag) {
      const next = !!flag
      if (next === readonly) return
      readonly = next
      host.classList.toggle('is-reading', readonly)
      // Leaving Editing closes any markdown cell that was showing its source:
      // there is nothing to type into any more, and the prose is the document.
      if (readonly) editingIndex = -1
      if (current) paint()
    },

    focus () {
      const input = column.querySelector('.nb-input')
      if (input && editingIndex >= 0) input.focus()
      else scroller.focus({ preventScroll: true })
    },

    place: () => ({ top: scroller.scrollTop }),
    dirty: () => dirty,

    /** ⌘F, routed here by the renderer while a notebook is the open document. */
    find () { search.focus(); search.select() },

    /** Running, for the window menu — the same three things the bar offers,
     *  reachable from a keyboard shortcut rather than a click. */
    run: {
      cell: () => {
        const cell = cells[editingIndex]
        return cell ? runCell(cell) : Promise.resolve({ status: 'skipped' })
      },
      all: runAll,
      interrupt: interruptKernel,
      restart: restartKernel,
      busy: anyRunning
    },

    /** The window is going. Let go of the kernel and stop listening for what
     *  it says — this pane is mounted for the life of the window, so without
     *  this the process outlives everything that could show its output. */
    destroy () {
      releaseKernel()
      stopListening?.()
    },

    /**
     * ⌘Z and ⇧⌘Z, which arrive through the window menu rather than as keys.
     *
     * Only ever the shape of the notebook. A caret inside a cell never reaches
     * here at all — the renderer sends an undo with a text field focused to
     * that field's own history, which is the right answer for a textarea and
     * the reason this stack does not hold text edits: one holding both would
     * step over a paragraph you typed to get back to a cell you deleted.
     */
    history: (redo) => stepHistory(redo),

    summary,

    /** What the copilot is told. It cannot see the pane, and what it cannot
     *  read for itself is which cells are here and what they hold — the file
     *  it would otherwise have to read is mostly base64. */
    context () {
      if (!current) return { text: '', cells: 0 }
      const shape = notebookShape(cells)
      const text = cells.map((cell, index) => {
        const head = cell.type === 'code'
          ? `# %% [${index + 1}] code`
          : `# %% [${index + 1}] ${cell.type}`
        return `${head}\n${cell.source}`
      }).join('\n\n')
      return { text, cells: shape.cells, code: shape.code, language }
    }
  }
}
