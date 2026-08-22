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
import { dropdown } from './dropdown.js'
import { languageChip } from './languages.js'
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
 * A cell's identity within this session, which is not the same as its
 * `id` in the file.
 *
 * The running maps below are keyed by the cell *object*, deliberately: a cell
 * that is moved or deleted mid-run must not hand its output to whoever
 * inherited its index. But undo restores *copies* of the cells — that is what
 * the history holds — so after an undo the object a run is keyed by is no
 * longer in the list, and the rest of that cell's output went to nobody and
 * said nothing. This is what survives the copy, so the maps can be pointed at
 * the cell that came back.
 *
 * Not written to the file: `writeNotebook` builds each cell from its `raw` and
 * the four fields it owns, and this is none of them.
 */
let keyCounter = 0
const nextKey = () => `c${(keyCounter++).toString(36)}`

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
      key: nextKey(),
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
  return { key: nextKey(), raw, type, source: '', outputs: [], executionCount: null }
}

/**
 * A cell copied deeply enough to be pasted somewhere else.
 *
 * Deep, because a paste that shared the original's `raw` would be two cells
 * that edit each other's metadata; and a new `id`, because nbformat 4.5 asks
 * for them to be unique within a file and two cells claiming one is a notebook
 * some readers refuse. The execution number does not come along: this copy has
 * never been run, whatever the cell it came from had done.
 */
export function copyCell (cell, shell = null) {
  const raw = JSON.parse(JSON.stringify(cell.raw ?? {}))
  if (idFrom(shell)) raw.id = newCellId()
  else delete raw.id
  /* Timing describes a run of the original. Carried over it would claim this
     copy took four seconds before anybody ran it. */
  if (raw.metadata?.execution) delete raw.metadata.execution
  return {
    key: nextKey(),
    raw,
    type: cell.type,
    source: cell.source,
    outputs: cell.type === 'code' ? JSON.parse(JSON.stringify(cell.outputs ?? [])) : [],
    executionCount: null
  }
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
  let code = 0
  let markdown = 0
  let outputs = 0
  for (const cell of cells) {
    if (cell.type === 'code') code++
    else if (cell.type === 'markdown') markdown++
    outputs += cell.outputs?.length || 0
  }
  return { cells: cells.length, code, markdown, outputs }
}

/* ------------------------------------------------------- what a cell records

   nbformat keeps more about a cell than its source and its outputs, and this
   app used to carry all of it across a save without reading a word of it. Four
   of those fields are worth reading, because each is a thing the reader can
   see is wrong when it is ignored: how long the cell took, whether it was
   folded shut, what it is tagged, and the images pasted into its prose.
   ================================================================== */

/** A cell's `metadata`, made if it is not there. Cells arrive from files other
 *  programs wrote, and half of them have no metadata object at all. */
function metaOf (cell) {
  const raw = cell.raw || (cell.raw = {})
  if (!raw.metadata || typeof raw.metadata !== 'object' || Array.isArray(raw.metadata)) {
    raw.metadata = {}
  }
  return raw.metadata
}

const asTime = (value) => {
  const at = Date.parse(String(value || ''))
  return Number.isFinite(at) ? at : null
}

/**
 * How long a cell's last run took, in milliseconds, or null.
 *
 * Read from the file rather than remembered, so it is still there when the
 * notebook is reopened — which is the whole reason it is written in the first
 * place. `metadata.execution` is the spelling jupyter-server itself records,
 * and its two useful stamps are when the kernel began the cell and when it
 * answered for it. The `status` pair is the fallback for kernels that write
 * only those.
 */
export function cellDuration (cell) {
  const run = cell?.raw?.metadata?.execution
  if (!run || typeof run !== 'object') return null
  const from = asTime(run['iopub.execute_input']) ?? asTime(run['iopub.status.busy'])
  const to = asTime(run['shell.execute_reply']) ?? asTime(run['iopub.status.idle'])
  if (from == null || to == null || to < from) return null
  return to - from
}

/** Record what a run took, in the file's own spelling. */
export function setCellDuration (cell, startedAt, endedAt) {
  const meta = metaOf(cell)
  if (startedAt == null || endedAt == null) { delete meta.execution; return }
  meta.execution = {
    ...(meta.execution && typeof meta.execution === 'object' ? meta.execution : {}),
    'iopub.execute_input': new Date(startedAt).toISOString(),
    'shell.execute_reply': new Date(endedAt).toISOString()
  }
}

/**
 * A duration as the reader wants it: no more digits than tell them something.
 *
 * A cell that took eleven milliseconds and a cell that took twelve are the
 * same cell, so the point of this is the order of magnitude and the one
 * significant figure past it.
 */
export function formatDuration (ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  if (minutes < 60) return `${minutes} m ${String(seconds).padStart(2, '0')} s`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} m`
}

/* Folding. `jupyter.source_hidden` and `jupyter.outputs_hidden` are what
   JupyterLab writes; `collapsed` is what the Notebook wrote before it, and
   files old enough to have one are exactly the files most likely to be opened
   here. Both are read; only the modern pair is written, and the legacy key is
   cleared alongside so the two cannot come to disagree. */
export function sourceHidden (cell) {
  return cell?.raw?.metadata?.jupyter?.source_hidden === true
}

export function outputsHidden (cell) {
  const meta = cell?.raw?.metadata
  return meta?.jupyter?.outputs_hidden === true || meta?.collapsed === true
}

/** @param {'source'|'outputs'} which */
export function setHidden (cell, which, flag) {
  const meta = metaOf(cell)
  const jupyter = (meta.jupyter && typeof meta.jupyter === 'object') ? meta.jupyter : {}
  const key = which === 'source' ? 'source_hidden' : 'outputs_hidden'
  if (flag) jupyter[key] = true
  else delete jupyter[key]
  if (which === 'outputs') delete meta.collapsed
  /* An empty `jupyter` object is a key nbformat did not have before this app
     touched it, and the difference between a one-cell diff and a one-cell diff
     plus noise. */
  if (Object.keys(jupyter).length) meta.jupyter = jupyter
  else delete meta.jupyter
}

/** The tags a cell carries. Papermill, nbconvert and every notebook CI read
 *  these, and nothing here could show them, so a cell tagged `skip` looked
 *  exactly like a cell that was not. */
export function cellTags (cell) {
  const tags = cell?.raw?.metadata?.tags
  return Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string' && tag) : []
}

export function setCellTags (cell, tags) {
  const meta = metaOf(cell)
  const clean = [...new Set(
    (tags || []).map((tag) => String(tag).trim()).filter(Boolean)
  )]
  if (clean.length) meta.tags = clean
  else delete meta.tags
}

/* An image pasted into a markdown cell does not become a file beside the
   notebook — it is stored in the cell, and referred to by a scheme no browser
   has ever heard of. Left alone it renders as a broken image, which is what
   every notebook with a pasted screenshot in it looked like here. */
const ATTACHMENT = /attachment:([^)\s"'>\]]+)/g

/**
 * The data URI one named attachment stands for, or '' when there is no such
 * attachment — which is a link visibly pointing at something missing, and the
 * truth, where a blank `src` would have claimed the image was empty.
 */
function attachmentUrl (name, attachments) {
  const store = (attachments && typeof attachments === 'object') ? attachments : null
  if (!store || !name) return ''
  let wanted = name
  try { wanted = decodeURIComponent(name) } catch { /* as written, then */ }
  const bundle = store[wanted] ?? store[name]
  if (!bundle || typeof bundle !== 'object') return ''
  const mime = Object.keys(bundle).find((type) => type.startsWith('image/')) ||
    Object.keys(bundle)[0]
  if (!mime) return ''
  return `data:${mime};base64,${cellText(bundle[mime]).replace(/\s+/g, '')}`
}

/**
 * Keep an output image off the main thread.
 *
 * The pictures a notebook carries are recorded output, not the page: a file
 * with fifty plots in it holds fifty base64 bitmaps, and a data URI is decoded
 * synchronously by default — so opening such a notebook decoded every one of
 * them before the first cell could be scrolled. Neither hint changes what is
 * drawn; both change when.
 */
function outOfLine (img) {
  img.loading = 'lazy'
  img.decoding = 'async'
  return img
}

/**
 * Markdown source with its `attachment:` references turned into data URIs.
 *
 * For the export, which has no app around it to resolve anything — the viewer
 * does this a step later instead, against the elements the app's own markdown
 * produced, so that an ordinary image beside the notebook keeps going through
 * the app's own embed pipeline rather than this one.
 */
export function withAttachments (text, attachments) {
  const source = String(text ?? '')
  if (!attachments || !source.includes('attachment:')) return source
  return source.replace(ATTACHMENT, (whole, name) =>
    attachmentUrl(name, attachments) || whole)
}

/* ------------------------------------------------------------- the outputs

   What a cell recorded, as the parts a viewer can draw. nbformat gives each
   output either a stream of text, a traceback, or a bundle of alternative
   renderings of the same value — a plot as a PNG *and* as `<Figure size ...>`
   — and choosing between those is this function's whole job.
   ================================================================== */

/** A `data` value: a string, or the lines it was split into. */
const bundleText = (value) => cellText(value)

/* One output is allowed this much text on screen. A cell that printed a
   hundred megabytes is a real thing to be handed, and building it as DOM would
   take the window down — so what is shown is the head of it, and the viewer
   says plainly that there is more in the file. */
export const OUTPUT_LIMIT = 100_000

/**
 * The head of an output's text, kept flat and kept beside it.
 *
 * A stream that is still arriving is a string built by appending, and an engine
 * holds one of those as a tree of the pieces rather than as characters. Asking
 * for the first hundred thousand of them is what forces that tree flat — so
 * drawing the head of a growing cell once a frame walks the whole of it once a
 * frame, and the work grows with the square of what was printed. A cell that
 * prints for a minute took the window with it.
 *
 * So the head is remembered, and `applyOutput` builds the next one from the
 * last rather than from the whole: the last is already short and already flat.
 *
 * A `WeakMap` because this is a memo about an output rather than a field of
 * one. Nothing here reaches the file, and an output the viewer has let go of
 * takes its head with it.
 */
const HEADS = new WeakMap()

/** The first `OUTPUT_LIMIT` characters of `text`, computed once per output. */
function headOf (output, text) {
  let head = HEADS.get(output)
  if (head === undefined) {
    head = text.length > OUTPUT_LIMIT ? text.slice(0, OUTPUT_LIMIT) : text
    HEADS.set(output, head)
  }
  return head
}

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
    return [{
      kind: 'stream',
      stream: output.name === 'stderr' ? 'stderr' : 'stdout',
      text,
      head: headOf(output, text)
    }]
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
    /* The value itself, not a rendering of it. A response body is a tree with
       one interesting branch and forty dull ones, and forty dull ones spelled
       out is how you fail to find the interesting one — so the viewer gets
       what it needs to draw it as a tree that opens. The text is carried
       alongside for anything that cannot. */
    let text
    try { text = JSON.stringify(value, null, 2) } catch { text = String(value) }
    return [{ kind: 'json', value, text }]
  }
  if (mime === 'text/latex') {
    /* Maths, and this app already sets maths — the same KaTeX that renders a
       formula in a note. Shown as its own source was the honest answer only
       while there was nothing here to render it with, and `display(Eq(...))`
       is the most common thing sympy does. */
    return [{ kind: 'latex', text: bundleText(value) }]
  }
  return [{ kind: 'text', text: bundleText(value) }]
}

/**
 * The `text/latex` an output will actually be drawn as, or ''.
 *
 * The same choice `outputParts` makes — an output carrying a table *and* a
 * formula is drawn as the table, and its latex is never set — asked without
 * building the rest. Which matters because building the rest means scrubbing
 * the whitespace out of every recorded image on the way past: a fresh copy of
 * every plot in the file, made to answer a question about its formulae.
 */
function outputLatex (output) {
  const type = output?.output_type
  if (type !== 'display_data' && type !== 'execute_result') return ''
  const data = (output.data && typeof output.data === 'object') ? output.data : {}
  const mime = MIME_ORDER.find((each) => data[each] !== undefined)
  return mime === 'text/latex' ? cellText(data[mime]) : ''
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
 * Which drawing an output *is*, when a library means to replace it later.
 *
 * A symbol rather than a field, because this must not reach the file. A
 * `display_id` belongs to the conversation with a running kernel — nbformat
 * calls it `transient` and does not record it — and writing one into the
 * notebook would put a key in the JSON that `nbformat` itself never writes,
 * which is a diff on a line nobody edited. Symbols are invisible to
 * `Object.keys`, so `sortKeys` drops it and `JSON.stringify` never sees it.
 */
export const DISPLAY_ID = Symbol('display_id')

/** The same trick for "this one replaces an earlier one" — see `applyOutput`. */
const REPLACES = Symbol('replaces')

const displayIdOf = (body) => {
  const id = body?.transient?.display_id
  return typeof id === 'string' && id ? id : ''
}

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
  if (msgType === 'display_data' || msgType === 'execute_result' ||
      msgType === 'update_display_data') {
    /* An update is a `display_data` addressed to one that already exists. It
       is built as one here — same fields, same shape — and `applyOutput` is
       what reads the marker below and puts it where it belongs. Nothing else
       needs to know that a redraw is different from a draw. */
    const output = {
      output_type: msgType === 'update_display_data' ? 'display_data' : msgType,
      data: (body.data && typeof body.data === 'object') ? body.data : {},
      metadata: (body.metadata && typeof body.metadata === 'object') ? body.metadata : {}
    }
    // Only `execute_result` is numbered: it is the value of the cell, and the
    // number is the prompt it belongs to.
    if (msgType === 'execute_result') output.execution_count = body.execution_count ?? null
    const id = displayIdOf(body)
    if (id) output[DISPLAY_ID] = id
    /* The one thing that does distinguish an update: it replaces rather than
       appends, and an update naming a display nobody has drawn is dropped.
       Carried as a symbol too, for the same reason. */
    if (msgType === 'update_display_data') output[REPLACES] = id || true
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
 * - An `update_display_data` is not a new output at all. It names a drawing
 *   already on screen and says what it is now — how sympy steps through a
 *   derivation in place, and how anything that animates without being a widget
 *   does it. Appended, it would leave the notebook holding every frame; and
 *   dropped, which is what happened before, it left the first frame on screen
 *   for ever and the reader believing it.
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

  if (output[REPLACES]) {
    const id = output[DISPLAY_ID]
    /* Last rather than first: a cell that displayed the same id twice has two
       drawings of it, and the one being updated is the one most recently made.
       An update for an id nothing here drew is dropped rather than appended —
       which is what Jupyter does, and the alternative is a frame arriving with
       no context in the middle of a cell's output. */
    const at = id ? outputs.findLastIndex((each) => each[DISPLAY_ID] === id) : -1
    if (at < 0) return { outputs, clearWhenNext }
    const next = outputs.slice()
    next[at] = output
    return { outputs: next, clearWhenNext }
  }

  const base = clearWhenNext ? [] : outputs
  const last = base[base.length - 1]
  if (output.output_type === 'stream' && last?.output_type === 'stream' &&
      last.name === output.name) {
    const arrived = cellText(output.text)
    const merged = { ...last, text: cellText(last.text) + arrived }
    /* The head carried forward, so that drawing the merged output never has to
       walk the whole of what has been printed — see `headOf` for why that is
       the difference between a readable long run and a frozen window. Only
       when the last one has a head already: seeding it from the whole here is
       the very walk being avoided, and `headOf` will do it once if anything
       ever draws this. */
    const before = HEADS.get(last)
    if (before !== undefined) {
      HEADS.set(merged, before.length >= OUTPUT_LIMIT
        ? before
        : (before + arrived).slice(0, OUTPUT_LIMIT))
    }
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
    /* `\r\n` is one line ending, not a redraw. Splitting on `\n` leaves that
       `\r` at the end of the line before it, and reading it as "start this
       line again" threw the line away — so every line of CRLF output came out
       blank, which is all the output a kernel on Windows produces. */
    const body = line.endsWith('\r') ? line.slice(0, -1) : line
    const at = body.lastIndexOf('\r')
    return at === -1 ? body : body.slice(at + 1)
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

/** The same text with the colour taken out — for anywhere the spans cannot go,
 *  which is the exported HTML and the text a search reads. */
export const stripAnsi = (text) => ansiSpans(text).map((span) => span.text).join('')

function buildSearchText (cell) {
  const bits = [cell?.source || '']
  for (const output of cell?.outputs || []) {
    for (const part of outputParts(output)) {
      if (part.kind === 'image' || part.kind === 'svg') continue
      if (part.kind === 'html') bits.push(part.markup.replace(/<[^>]*>/g, ' '))
      else if (part.text) bits.push(stripAnsi(part.text))
    }
  }
  return bits.join('\n')
}

/**
 * What a cell's searchable text was, the last time anything asked.
 *
 * ⌘F asks about every cell on every keystroke, and answering means walking
 * each output: joining its line lists, scrubbing the whitespace out of every
 * recorded image, taking the colour out of everything the cell printed and the
 * tags out of every table it drew — over the whole of it, not the head that is
 * on screen. On a few hundred cells with a page of output each that is most of
 * a second per letter typed, and the letter appears when it is over.
 *
 * So it is remembered, against the two things it is made of: the cell's source
 * and the array its outputs are in. `applyOutput` returns a new array for every
 * message rather than editing one, and every other path that changes a cell's
 * outputs assigns a new array too — so that array's identity is exactly the
 * question "has anything been printed since", asked in one step.
 *
 * A `WeakMap` for the reason `HEADS` is one: a memo about a cell rather than a
 * field of it, and a cell the notebook has let go of takes it with it.
 */
const SEARCH_TEXT = new WeakMap()   // cell -> { source, outputs, text, lower }

function searchMemo (cell) {
  const had = SEARCH_TEXT.get(cell)
  if (had && had.source === cell.source && had.outputs === cell.outputs) return had
  const text = buildSearchText(cell)
  /* Lowercased here too: the find bar wants it that way, and lowercasing
     megabytes per keystroke is the same waste one step along. */
  const memo = { source: cell.source, outputs: cell.outputs, text, lower: text.toLowerCase() }
  SEARCH_TEXT.set(cell, memo)
  return memo
}

const memoable = (cell) => !!cell && typeof cell === 'object'

/**
 * Everything in a cell that a search could match.
 *
 * Its source and what it printed, because "where does this warning come from"
 * is as much a question about a notebook as "where is `read_csv`" — and the
 * answer to the first was not findable here at all. A picture has no text to
 * match; a table has, once its tags are out of the way, and a reader looking
 * for a column name should find the table that has it.
 */
export function cellSearchText (cell) {
  return memoable(cell) ? searchMemo(cell).text : buildSearchText(cell)
}

/** The same text, lowercased once rather than per query. */
const cellSearchKey = (cell) =>
  memoable(cell) ? searchMemo(cell).lower : buildSearchText(cell).toLowerCase()

/* ------------------------------------------------------------- taking it out

   A notebook is a bad thing to hand to anyone who has not got Jupyter, and a
   worse thing to put under review: the JSON of a one-line edit is a diff
   nobody can read. Both of these are one function of the file's text, so both
   are testable, and neither needs the running app.
   ================================================================== */

/** Every line of `text` commented, for the markdown that goes into a script. */
const commented = (text) =>
  String(text ?? '').split('\n').map((line) => (line ? `# ${line}` : '#')).join('\n')

/**
 * The notebook as a script, in the `# %%` format Jupytext, VS Code, PyCharm
 * and Spyder all read.
 *
 * Not nbconvert's output, which puts `In[1]:` in comments and is a
 * one-way door: this round-trips. What is lost is the outputs, which is the
 * point — a script is the code, and the code is what is worth reviewing.
 */
export function notebookToScript (shell, cells) {
  const language = notebookLanguage(shell)
  const name = shell?.metadata?.kernelspec?.display_name ||
    shell?.metadata?.kernelspec?.name || ''
  const head = [
    '# ---',
    '# Exported from a Jupyter notebook by Tulip.',
    name ? `# kernel: ${name}` : '',
    language ? `# language: ${language}` : '',
    '# ---'
  ].filter(Boolean).join('\n')

  const body = cells.map((cell) => {
    if (cell.type === 'code') return `# %%\n${cell.source}`
    return `# %% [${cell.type}]\n${commented(cell.source)}`
  }).join('\n\n')

  return `${head}\n\n${body}\n`
}

const escapeHtml = (text) => String(text ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')

/* Enough style to be readable in a browser and in a mail client, inline
   because an exported file that needs a stylesheet beside it is a file that
   arrives broken. */
const EXPORT_CSS = `
  body { margin: 0 auto; padding: 32px 24px; max-width: 54rem;
         font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         color: #1c1c1e; background: #fff; }
  .cell { margin: 0 0 22px; }
  pre { margin: 0; padding: 10px 12px; overflow-x: auto; border-radius: 6px;
        font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre.src { background: #f5f5f7; border: 1px solid #e3e3e6; }
  pre.out { background: transparent; color: #3a3a3c; padding: 6px 12px; }
  pre.err { background: #fff2f2; color: #a11; border-left: 2px solid #a11;
            border-radius: 0 6px 6px 0; }
  .prompt { font: 11px/1 ui-monospace, monospace; color: #8a8a8e; margin-bottom: 4px; }
  img { max-width: 100%; background: #fff; border-radius: 4px; }
  table { border-collapse: collapse; font-size: 13px; }
  th, td { padding: 3px 10px; border: 1px solid #ddd; text-align: right; }
  th { background: #f5f5f7; }
  @media (prefers-color-scheme: dark) {
    body { color: #ececec; background: #1c1c1e; }
    pre.src { background: #2a2a2c; border-color: #3a3a3c; }
    pre.out { color: #c7c7cc; }
    th, td { border-color: #3a3a3c; } th { background: #2a2a2c; }
  }`

/**
 * The notebook as one HTML file, outputs and all.
 *
 * @param renderMarkdown  how prose becomes HTML — the app's own dialect, handed
 *                        in for the same reason the viewer takes it, so an
 *                        exported notebook reads like the notebook did
 * @param sanitize        what an output's own HTML is put through. It was
 *                        written by whatever the notebook ran and is going into
 *                        a file somebody will double-click, which is the one
 *                        moment it stops being sandboxed by this app.
 */
export function notebookToHtml (shell, cells, {
  title = 'Notebook',
  renderMarkdown = null,
  sanitize = (markup) => markup
} = {}) {
  const drawn = cells.map((cell) => {
    if (cell.type === 'markdown') {
      const source = withAttachments(cell.source, cell.raw?.attachments)
      const body = renderMarkdown ? renderMarkdown(source) : `<p>${escapeHtml(source)}</p>`
      return `<div class="cell">${body}</div>`
    }
    if (cell.type === 'raw') {
      return `<div class="cell"><pre class="out">${escapeHtml(cell.source)}</pre></div>`
    }

    const prompt = cell.executionCount == null ? '[ ]' : `[${cell.executionCount}]`
    const took = formatDuration(cellDuration(cell))
    const bits = [
      `<div class="prompt">${escapeHtml(prompt)}${took ? ` · ${escapeHtml(took)}` : ''}</div>`,
      `<pre class="src">${escapeHtml(cell.source)}</pre>`
    ]
    for (const output of cell.outputs) {
      for (const part of outputParts(output)) {
        if (part.kind === 'stream') {
          bits.push(`<pre class="out${part.stream === 'stderr' ? ' err' : ''}">` +
            `${escapeHtml(stripAnsi(part.text))}</pre>`)
        } else if (part.kind === 'error') {
          bits.push(`<pre class="err">${escapeHtml(stripAnsi(part.text))}</pre>`)
        } else if (part.kind === 'image') {
          bits.push(`<img src="data:${part.mime};base64,${part.data}" alt="Cell output">`)
        } else if (part.kind === 'svg') {
          bits.push(`<img src="data:image/svg+xml;charset=utf-8,` +
            `${encodeURIComponent(part.markup)}" alt="Cell output">`)
        } else if (part.kind === 'html') {
          bits.push(`<div>${sanitize(part.markup)}</div>`)
        } else if (part.kind === 'markdown' && renderMarkdown) {
          bits.push(`<div>${renderMarkdown(part.text)}</div>`)
        } else {
          bits.push(`<pre class="out">${escapeHtml(part.text)}</pre>`)
        }
      }
    }
    return `<div class="cell">${bits.join('\n')}</div>`
  })

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
${drawn.join('\n')}
</body>
</html>
`
}

/* --------------------------------------------------------------- the view */

/* Long enough that a keystroke never waits on a parser, short enough that a
   pause in typing is coloured before you look up. */
const HIGHLIGHT_DELAY = 140

const PLACEHOLDER = {
  code: 'Empty code cell',
  markdown: 'Empty markdown cell',
  raw: 'Empty raw cell'
}

/* What a cut or a copy is holding, as cells rather than as text.

   Outside the mount, and deliberately: the pane is one instance for the life
   of the window, but a notebook copied *from* is closed the moment the one
   pasted *into* is opened — and moving a cell between two notebooks is most of
   why anyone copies one. Plain data, so nothing in here keeps a closed
   notebook's model alive. */
let clipboard = []

/* Beyond this many drawn parts a cell is not showing you its output, it is
   showing you a scroll bar. Streams merge in `applyOutput`, so the cell that
   reaches this is the one that displayed thousands of separate things — a plot
   inside a loop — and building all of them is a window that stops answering
   while it does. */
const OUTPUT_COUNT_LIMIT = 200

/**
 * Mount the notebook viewer into `host`. One instance for the life of the
 * window, like every other viewer here.
 *
 * @param host        the pane this draws into
 * @param file        the renderer's `api.file` — `read` and `write`
 * @param markdown    how a markdown cell is rendered: `{ prepare, render }`,
 *                    the app's own dialect handed in rather than rebuilt, so a
 *                    formula in a notebook is set the way one in a note is
 * @param ask         the app's own confirmation dialog, for the one thing here
 *                    that cannot be undone — a restart throws away every
 *                    variable in the session. A window built without it simply
 *                    does not ask, which is what this did before.
 * @param notify      a line for the status bar: where an export landed, and
 *                    why one did not
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
  ask = null,
  notify = () => {},
  onDirty = () => {},
  onSaved = () => {},
  onStatus = () => {}
}) {
  /** @type {any} */
  let current = null          // { path }
  let shell = null            // the file, as parsed
  let cells = []              // the working model
  let language = ''
  let dirty = false
  let readonly = false
  let saving = null
  let flushRequested = false
  let saveTimer = null
  /* How many times this notebook has been changed, which is what a save
     compares against to know whether the file it wrote is still the notebook
     on screen. Only ever goes up; nothing reads the number itself. */
  let edits = 0
  /* Which cell is being typed into, and — for a markdown cell — which one is
     showing its source rather than its rendering. Two different questions: a
     markdown cell stays open for editing when the caret leaves it for the
     toolbar, and only closes when something else is chosen. */
  let editingIndex = -1
  /* Which cell the notebook is *at*, which is a different question again, and
     the one this viewer had no answer to.

     Editing a cell and having a cell chosen are two states, the way they are
     in every notebook there has ever been: the caret is in the cell or it is
     not, and when it is not the keyboard still has to be able to say which
     cell it means. Without this there was no way to move between cells, add
     one or delete one without a mouse — Escape handed the keys to a scroller
     with nothing listening — and the window menu's Run cell read `editingIndex`
     and so did nothing at all in Reading view, where there are no textareas to
     have focused. */
  let selected = -1
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
  /* Every kernel this machine can offer, asked for once and kept. Asking spawns
     the Jupyter server, which is the same cost as running a cell — so it is not
     asked on open, only when someone opens the picker. */
  let kernelSpecs = null       // [{ name, displayName, language }] once asked
  let specsAsked = null        // the in-flight ask, so an impatient click is one
  const SPECS_FAILED = 'Could not list the kernels on this machine:'
  const runs = new Map()       // cell -> { msgId, state: {outputs, clearWhenNext} }
  let queue = []               // cells still to run, for Run all
  /* The same cells, asked a different question. Every cell drawn asks whether
     it is waiting, so searching the queue for it makes painting a Run all cost
     the square of the notebook — a set answers in one step. */
  const queued = new Set()
  let queueStop = false
  /* How far through a Run all is. Two numbers rather than one, so the bar can
     say "7 of 40" — a disabled button is the only thing it said before, which
     tells a reader that something is happening and nothing about what. */
  let queueTotal = 0
  let queueDone = 0

  const isRunning = (cell) => runs.has(cell)
  const anyRunning = () => runs.size > 0 || queue.length > 0

  host.classList.add('nb')

  const bar = el('div', 'nb-bar')
  const barShape = el('div', 'nb-shape')
  const barActions = el('div', 'nb-bar-actions')

  /* The bar says which kernel is behind the notebook and what it is doing, and
     the kernel is the control that changes it — "Python 3 (ipykernel)" is
     exactly the place a reader looks when they want a different one. The cell
     count is not here: it does not change with anything on this bar, and it is
     already in the window's status line, where the rest of a file's shape is.

     The kernel's language wears the same mark a fenced block does, so the
     answer to "what am I about to run this in" is legible before it is read. */
  const kernelSlot = el('span', 'nb-shape-kernel')
  /* The kernel's state, drawn as a coloured dot and nothing else — `role` and
     the label paintBar keeps on it are what make it more than a decoration to
     a reader who cannot see the colour. */
  const stateText = el('span', 'nb-shape-state')
  stateText.setAttribute('role', 'img')
  const kernelName = el('span', 'nb-kernel-name')
  const kernelPick = dropdown({
    label: 'Kernel',
    className: 'nb-kernel-pick',
    placeholder: 'Kernel',
    onOpen: () => loadKernelSpecs(),
    onChange: (name) => { useKernel(name) }
  })
  barShape.append(kernelSlot, stateText)

  /* Two menus rather than five more buttons. Each holds the commands that are
     one deliberate decision each — which is what makes them wrong as buttons,
     since a button is what you press without deciding. Built once and refilled
     by `paintBar`, so a repaint mid-run does not close an open menu. */
  const runPick = dropdown({
    label: 'Run',
    className: 'nb-run-pick',
    placeholder: 'Run…',
    onChange: (what) => {
      /* Back to the placeholder at once. These are commands, not a setting:
         "Run all above" is a thing you did, not a state the notebook is now
         in, and leaving it showing would say otherwise. */
      runPick.set(null, '')
      if (what === 'above') runAbove()
      else if (what === 'below') runBelow()
      else if (what === 'restart-all') restartAndRunAll()
    }
  })
  const exportPick = dropdown({
    label: 'Export',
    className: 'nb-export-pick',
    placeholder: 'Export…',
    onChange: (what) => {
      exportPick.set(null, '')
      exportAs(what)
    }
  })

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
  search.setAttribute('aria-label', 'Find in cells and outputs')
  const found = el('span', 'nb-found')

  let hits = []
  let hitAt = -1

  const clearHits = () => {
    for (const section of column.children) section.classList?.remove('is-hit')
  }

  /**
   * Where the query is, cell by cell.
   *
   * Outputs are searched as well as sources, because "where does this warning
   * come from" is as much a question about a notebook as "where is
   * `read_csv`", and the first was not answerable here at all — the text was
   * on screen and the search could not see it.
   *
   * @param {number} advance  0 to stay, ±1 to step
   * @param {boolean} move    whether to take the reader to the hit. False when
   *                          the search is merely being kept honest after a
   *                          repaint: a page that scrolls itself every time a
   *                          cell is added is a page you have lost your place
   *                          in, and nobody asked to be moved.
   */
  const runSearch = ({ advance = 0, move = true } = {}) => {
    const query = search.value.trim().toLowerCase()
    clearHits()
    if (!query) {
      hits = []
      hitAt = -1
      found.textContent = ''
      return
    }
    hits = cells.reduce((list, cell, index) => {
      if (cellSearchKey(cell).includes(query)) list.push(index)
      return list
    }, [])
    if (!hits.length) {
      hitAt = -1
      found.textContent = 'no cells'
      return
    }
    hitAt = advance
      ? (hitAt + advance + hits.length) % hits.length
      : Math.max(0, hits.findIndex((index) => index >= Math.max(0, hitAt)))
    found.textContent = `${hitAt + 1} of ${hits.length}`
    const index = hits[hitAt]
    const section = column.children[index]
    section?.classList.add('is-hit')
    if (!move) return
    section?.scrollIntoView({ block: 'center' })
    select(index)

    /* And the match itself, where there is a textarea to show it in. The
       browser's own selection is the highlight — nothing has to be drawn, it
       survives scrolling, and it puts the caret at the thing you searched for
       rather than merely near it. */
    const input = section?.querySelector('.nb-input')
    const at = input ? input.value.toLowerCase().indexOf(query) : -1
    if (input && at >= 0) {
      input.focus({ preventScroll: true })
      input.setSelectionRange(at, at + query.length)
      /* Focus put the caret in the cell, which is not what ⌘F is for: the next
         Return must step to the next hit, not add a newline. */
      search.focus()
    }
  }

  /** The hits again, against the cells as they are now.
   *
   *  A search's answers are indexes into a list that adding, deleting or
   *  moving a cell rewrites — so `is-hit` used to point at whichever cell had
   *  since inherited the number, and the count in the corner described a
   *  notebook that no longer existed. Cheap enough to simply redo. */
  const refreshSearch = () => { if (search.value.trim()) runSearch({ move: false }) }

  search.addEventListener('input', () => { hitAt = -1; runSearch() })
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      // ⇧⏎ steps back, the way it does in every find bar there is.
      runSearch({ advance: event.shiftKey ? -1 : 1 })
    }
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
  /* Running is not editing. Reading view is the same notebook with the typing
     taken out of it: the kernel, the run buttons and the outputs are what a
     notebook *is*, and a reader who cannot press Run is looking at a
     screenshot. What Reading view withholds is the source — the textarea, and
     the controls that add, move, delete or retype a cell.
     It still needs the bridge to exist at all, which it does not in the tests
     or in a window built without it. */
  const canRun = () => !!current && !!kernel?.start

  /* ---------------------------------------------------------- the selection

     Which cell everything without a mouse means. `atCell` is the answer even
     when nothing has been chosen — the cell being typed into, and failing that
     the top of the file — so that a command reached from the window menu on a
     freshly opened notebook does something rather than nothing.
     ================================================================== */

  const atCell = () => {
    if (selected >= 0 && selected < cells.length) return selected
    if (editingIndex >= 0 && editingIndex < cells.length) return editingIndex
    return 0
  }

  /**
   * Where a cell is now.
   *
   * A cell's own controls used to close over the number it had when it was
   * drawn, which meant every one of them went wrong the moment anything above
   * it was added or deleted — so the only safe answer was to rebuild the whole
   * notebook after every change, which is what `paint` did. Asking at the
   * moment a button is pressed costs a walk of the list once per click, and it
   * is what lets `paint` keep a section that has merely moved.
   */
  const indexOf = (cell) => cells.indexOf(cell)

  /** The ring, moved without rebuilding a single cell. `paint` is far too big
   *  a hammer for an arrow key, and would throw away the caret besides.
   *
   *  Two elements touched rather than every cell in the notebook: holding down
   *  ↓ over three hundred cells asked the engine to reconsider three hundred
   *  elements' styling per keypress to move one ring by one place. `atNode` is
   *  the one wearing it, and `paint` — which draws the ring itself — hands this
   *  the section it drew it on. */
  let atNode = null
  function paintSelection () {
    const next = selected >= 0 ? column.children[selected] : null
    if (next === atNode) return
    atNode?.classList?.remove('is-at')
    next?.classList?.add('is-at')
    atNode = next
  }

  /**
   * Choose a cell.
   *
   * `scroll` only when the keyboard did it: a click has already put the cell
   * where the reader is looking, and scrolling under a click that landed
   * where it meant to is the page moving for no reason.
   */
  function select (index, { scroll = false } = {}) {
    const next = Math.max(-1, Math.min(index, cells.length - 1))
    if (next === selected) {
      if (scroll) column.children[next]?.scrollIntoView({ block: 'nearest' })
      return
    }
    selected = next
    paintSelection()
    if (scroll) column.children[next]?.scrollIntoView({ block: 'nearest' })
  }

  const setDirty = (next) => {
    if (next) edits++
    if (dirty === next) return
    dirty = next
    onDirty(next)
  }

  /* A typed edit is saved a beat after the typing stops. */
  const SAVE_DELAY = 900
  /* Output is not. Writing this file means `writeNotebook`, which deep-copies
     and serialises the *whole* notebook — every recorded plot's base64 among it
     — and then writes all of it to disk. A cell that prints in a loop makes an
     edit of that size several times a second, and at 900ms each one of them
     was a full re-serialisation of a file that can easily be tens of
     megabytes. The run got slower the more it had already printed.

     So output only asks for a checkpoint, and a checkpoint is at most this
     often. Nothing is at risk in the gap: the run's own `done` asks for an
     ordinary save, and so does anything the reader types. */
  const CHECKPOINT_DELAY = 20_000
  let savedAt = 0

  const queueSave = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = null; saveFile().catch(() => {}) }, SAVE_DELAY)
  }

  /**
   * Ask for a save eventually, and never sooner than the last one plus a
   * checkpoint's wait. Yields to a save that is already coming — one is enough,
   * and the sooner one is the one the reader asked for.
   */
  const queueCheckpoint = () => {
    if (saveTimer) return
    const wait = Math.max(0, CHECKPOINT_DELAY - (Date.now() - savedAt))
    saveTimer = setTimeout(() => { saveTimer = null; saveFile().catch(() => {}) }, wait)
  }

  const saveFile = async ({ flush = false } = {}) => {
    if (flush) flushRequested = true
    if (saving) return saving
    saving = (async () => {
      do {
        if (!current || !dirty) break
        clearTimeout(saveTimer)
        saveTimer = null
        /* What is about to be written, named. A write is not instant, and a
           notebook is edited by two hands during one: the typist, and a kernel
           putting output into a cell. Calling it clean afterwards regardless
           marks those edits as saved when they are not in the file — and the
           save they had already asked for finds nothing to do and skips. The
           whole of a run's output could be lost that way, silently, and stay
           lost until something else was typed. */
        const at = edits
        const text = writeNotebook(shell, cells)
        await file.write(current.path, text)
        savedAt = Date.now()
        const clean = edits === at
        if (clean) setDirty(false)
        /* Only a clean write is a saved file. `onSaved` is the host's cue to
           forget the buffer — it clears the flag that quitting checks before
           flushing — so announcing one for a write that raced an edit is how
           that edit gets dropped at ⌘Q. */
        if (clean) onSaved()
        /* Still dirty means something arrived mid-write. Its own `queueSave`
           is already pending — set after the `clearTimeout` above, because it
           happened after it — so the debounced path picks it up. A flush has
           no later to wait for, and goes round again here. */
      } while (flushRequested && dirty)
      flushRequested = false
      return true
    })()
    try { return await saving } finally { saving = null }
  }

  /**
   * Every change to the notebook goes through here, so that every one of them
   * is undoable and none of them can forget to save.
   *
   * `needs` is who is allowed to make it, and there are three answers:
   *
   *   edit  the notebook's shape — cells added, deleted, moved, retyped
   *   run   what a run left behind: outputs and their numbers. Allowed
   *         wherever running is, so Reading view can clear them — a reader who
   *         can fill a notebook with output can empty it again
   *   open  how the notebook is folded. Neither an edit nor a run: it changes
   *         what is on screen, it is written down so it is still folded
   *         tomorrow, and nothing about it needs a kernel or an editor
   */
  const change = (run, { repaint = true, needs = 'edit' } = {}) => {
    const allowed = needs === 'edit'
      ? editable()
      : needs === 'run'
        ? (canRun() || editable())
        : !!current
    if (!allowed) return false
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

  /**
   * Point the running maps at the cells that are in the list now.
   *
   * The history holds *copies* — `{ ...cell }` — so an undo replaces every cell
   * object with one that was never in `runs`, `queued` or `byMsg`. Those are
   * keyed by object on purpose, so that a cell moved or deleted mid-run cannot
   * hand its output to whoever took its index; but nothing re-pointed them
   * afterwards, so an undo during a run quietly orphaned it. The rest of that
   * cell's output arrived, found no cell, and was dropped without a word.
   *
   * `key` survives the copy, which is what makes the cell findable again.
   */
  function refollowRuns () {
    const byKey = new Map(cells.map((cell) => [cell.key, cell]))
    const swap = (cell) => byKey.get(cell.key) || cell

    for (const [cell, run] of [...runs]) {
      const now = swap(cell)
      if (now === cell) continue
      runs.delete(cell)
      runs.set(now, run)
      /* The output already collected belongs to the cell that comes back, not
         to the copy of it the history was holding. */
      now.outputs = run.state.outputs
    }
    for (const [msgId, cell] of [...byMsg]) byMsg.set(msgId, swap(cell))
    for (const cell of [...queued]) {
      const now = swap(cell)
      if (now === cell) continue
      queued.delete(cell)
      queued.add(now)
    }
    queue = queue.map(swap)
    for (const cell of [...dirtyCells]) {
      const now = swap(cell)
      if (now === cell) continue
      dirtyCells.delete(cell)
      dirtyCells.add(now)
    }
  }

  const stepHistory = (redo) => {
    if (!editable()) return false
    const from = redo ? future : history
    if (!from.length) return false
    const to = redo ? history : future
    to.push(cells.map((cell) => ({ ...cell })))
    cells = from.pop()
    refollowRuns()
    if (selected >= cells.length) selected = cells.length - 1
    setDirty(true)
    queueSave()
    paint()
    onStatus()
    return true
  }

  /* ---------------------------------------------------------- the outputs */

  /**
   * Prose into a node, the way the reading view puts prose into one.
   *
   * `render` is only half of it: the app's markdown leaves every picture as a
   * stub for `dress` to swap for the real thing — an image, a PDF, a video,
   * whatever the link turned out to point at. A notebook that called `render`
   * alone drew markdown cells with holes where their images should be, which
   * is every notebook with a screenshot in it.
   */
  function setProse (node, text, attachments = null) {
    node.innerHTML = markdown.render(text)
    /* The cell's own images first, and before `dress` rather than after: an
       `attachment:` is a name inside this cell, not a path in the vault, so
       the app's resolver can only answer "not found in this vault" — which is
       exactly what a notebook with a pasted screenshot showed. */
    if (attachments) dressAttachments(node, attachments)
    markdown.dress?.(node)
    return node
  }

  /** Swap the stubs `attachment:` links left for the images they name. */
  function dressAttachments (node, attachments) {
    const stubs = node.querySelectorAll(
      '.embed-slot[data-src^="attachment:"], img[src^="attachment:"]')
    for (const stub of stubs) {
      const src = stub.dataset?.src || stub.getAttribute('src') || ''
      const url = attachmentUrl(src.slice('attachment:'.length), attachments)
      if (!url) continue
      const img = document.createElement('img')
      img.src = url
      img.alt = stub.dataset?.alt || stub.getAttribute('alt') || ''
      img.className = 'nb-md-image'
      outOfLine(img)
      stub.replaceWith(img)
    }
  }

  /** A run of text, coloured by whatever escape codes are in it. `head` is the
   *  part of it that fits on screen, where the caller already has it — see
   *  `headOf`: taking it from the text instead is what a cell printing into a
   *  loop pays once a frame, over everything it has printed so far. */
  function textBlock (text, className, head = null) {
    const pre = el('pre', className)
    const shown = text.length > OUTPUT_LIMIT
      ? (head ?? text.slice(0, OUTPUT_LIMIT))
      : text
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
      return textBlock(part.text, `nb-out-text is-${part.stream}`, part.head)
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
      figure.append(outOfLine(img))
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
      figure.append(outOfLine(img))
      return figure
    }
    if (part.kind === 'html') {
      const box = el('div', 'nb-out-html')
      box.innerHTML = sanitizeHtml(part.markup, () => null)
      return box
    }
    if (part.kind === 'markdown') {
      const box = el('div', 'nb-md')
      if (markdown?.render) setProse(box, part.text)
      else box.append(textBlock(part.text, 'nb-out-text'))
      return box
    }
    if (part.kind === 'latex') return drawLatex(part.text)
    if (part.kind === 'json') return drawJson(part)
    return textBlock(part.text, 'nb-out-text')
  }

  /* Whether KaTeX has arrived. `markdown.prepare` loads it on demand and keeps
     it; this is the same question asked from the other side, so that a latex
     output drawn before it has landed can be drawn again after. */
  let mathReady = false
  /* Which generation of drawn output is current — see `nodesFor`. It moves
     when KaTeX arrives, because that changes what a `text/latex` output is
     drawn as and nothing about the output itself says so. */
  let drawEpoch = 0
  /* Which latex outputs have already been handed to the loader. A `text/latex`
     that holds no delimiters KaTeX recognises leaves `mathReady` false for
     ever, so without this every repaint would ask about it again — a promise
     per latex output per paint, answering the same no. */
  const latexAsked = new Set()

  /**
   * Maths from a kernel, set as maths.
   *
   * `text/latex` is the richest thing sympy produces and was shown here as its
   * own source — correct while there was nothing to render it with, and this
   * app has been rendering formulae in prose all along. It goes through the
   * same dialect a note's maths does, so `\displaystyle` from sympy is set the
   * way `$$…$$` in a note is.
   */
  function drawLatex (text) {
    const box = el('div', 'nb-out-latex')
    if (mathReady && markdown?.render) {
      setProse(box, text)
      return box
    }
    /* Its source until KaTeX is here, and then the notebook is asked to draw
       this cell again. Which happens once per session: the loader keeps what
       it built, so every latex output after the first is set immediately. */
    box.append(textBlock(text, 'nb-out-text'))
    if (markdown?.prepare && !latexAsked.has(text)) {
      latexAsked.add(text)
      markdown.prepare(text).then((needed) => {
        if (!needed || mathReady) return
        mathReady = true
        /* Every latex output already on screen is now drawn wrong — as its own
           source — and nothing about those outputs says so. See `nodesFor`. */
        drawEpoch++
        if (current) paint()
      }).catch(() => {})
    }
    return box
  }

  /* How deep a JSON output opens by itself. Deep enough to see the shape of a
     response, shallow enough that a large one does not arrive as a wall. */
  const JSON_OPEN_DEPTH = 1
  const JSON_NODE_LIMIT = 2000

  /**
   * A JSON output as a tree that opens, rather than as the text of one.
   *
   * A response body is one interesting branch and forty dull ones, and forty
   * dull ones spelled out is how you fail to find the interesting one.
   * `<details>` rather than anything hand-built: it is keyboard-reachable,
   * findable by the browser's own find, and free.
   */
  function drawJson (part) {
    const box = el('div', 'nb-out-json')
    let drawn = 0

    const leaf = (value) => {
      const kind = value === null ? 'null' : typeof value
      return el('span', `nb-json-${kind}`,
        kind === 'string' ? JSON.stringify(value) : String(value))
    }

    const build = (value, label, depth) => {
      if (drawn++ > JSON_NODE_LIMIT) return null
      const branch = value && typeof value === 'object'
      if (!branch) {
        const row = el('div', 'nb-json-row')
        if (label != null) row.append(el('span', 'nb-json-key', `${label}: `))
        row.append(leaf(value))
        return row
      }
      const list = Array.isArray(value)
      const keys = list ? value.map((_, index) => index) : Object.keys(value)
      const node = document.createElement('details')
      node.className = 'nb-json-node'
      node.open = depth < JSON_OPEN_DEPTH
      const head = document.createElement('summary')
      if (label != null) head.append(el('span', 'nb-json-key', `${label}: `))
      head.append(el('span', 'nb-json-brace',
        list ? `[${keys.length}]` : `{${keys.length}}`))
      node.append(head)
      for (const key of keys) {
        const child = build(value[key], key, depth + 1)
        if (child) node.append(child)
      }
      return node
    }

    const tree = build(part.value, null, 0)
    if (tree) box.append(tree)
    if (drawn > JSON_NODE_LIMIT) {
      box.append(el('div', 'nb-elided', '… the rest of this value is in the file'))
    }
    return box
  }

  /**
   * Everything a cell has produced, up to what a page can hold.
   *
   * Streams merge in `applyOutput`, so a cell that reaches the limit is one
   * that displayed thousands of separate things — a plot inside a loop, a
   * table per iteration. Building all of them is a window that stops answering
   * while it does, and a reader who was never going to scroll past the
   * fiftieth. What is dropped is said, in the file's own count, so nobody
   * mistakes the ceiling for the whole.
   */
  /**
   * What one output was last drawn as.
   *
   * A running cell is repainted once a frame, and that rebuilt every one of its
   * outputs each time — decoding every recorded PNG again, putting every
   * DataFrame's HTML back through the sanitiser again, rebuilding every JSON
   * tree again — in order to change the last line of text. Sixty times a
   * second, for the whole of a run.
   *
   * `applyOutput` mints a new object only for the stream it just merged into
   * and for a display being replaced, so everything above those is the same
   * object it was a frame ago and can simply be moved into the new panel. Which
   * also keeps what the reader had done to it: an open `<details>` in a JSON
   * tree stayed open, where before it shut itself every frame.
   *
   * Keyed by the output object, so an output the notebook has let go of takes
   * its nodes with it. `epoch` is what invalidates the lot: KaTeX arriving
   * changes what a `text/latex` output draws as, and nothing about the output
   * itself says so.
   */
  const DRAWN = new WeakMap()   // output -> { epoch, nodes: Node[] }

  function nodesFor (output) {
    const had = DRAWN.get(output)
    if (had && had.epoch === drawEpoch) return had.nodes
    const nodes = outputParts(output).map(drawPart)
    DRAWN.set(output, { epoch: drawEpoch, nodes })
    return nodes
  }

  function drawOutputs (cell) {
    const wrap = el('div', 'nb-outputs')
    let drawn = 0
    let held = 0
    for (const output of cell.outputs) {
      for (const node of nodesFor(output)) {
        if (drawn >= OUTPUT_COUNT_LIMIT) { held++; continue }
        wrap.append(node)
        drawn++
      }
    }
    if (held) {
      wrap.append(el('div', 'nb-elided',
        `… ${held.toLocaleString()} more output${held === 1 ? '' : 's'} in the file`))
    }
    return wrap.childElementCount ? wrap : null
  }

  /* ------------------------------------------------------------- running

     A cell that is running changes two things on screen and nothing else: its
     prompt, and its outputs. Repainting the notebook for either would be the
     wrong tool — `paint()` rebuilds every textarea, which throws away the
     caret of whoever is typing in a different cell while this one runs.
     ================================================================== */

  /** Which cell a section is showing. `drawCell` writes the number down, so
   *  this is a field read rather than a walk of the column — which is what
   *  `dragover` was doing at the rate a pointer moves: copying three hundred
   *  children into an array and searching it, to draw one line. */
  function sectionIndex (section) {
    const at = Number(section?.dataset?.index)
    return Number.isInteger(at) && at >= 0 && at < cells.length ? at : -1
  }

  /** The section showing a cell right now, or null if it is not on screen. */
  function sectionFor (cell) {
    const index = cells.indexOf(cell)
    return index < 0 ? null : (column.children[index] || null)
  }

  /** Redraw just one cell's prompt and outputs, in place. */
  function repaintCell (cell) {
    const section = sectionFor(cell)
    if (!section) return

    /* A cell that grows while it is above the fold pushes everything below it
       down, and what is below it is what somebody is reading. So the height a
       cell entirely above the viewport gains — or loses, when its old output
       is cleared — is handed straight back to `scrollTop`, and the page under
       the reader does not move. Measured against the scroller's own box rather
       than `offsetTop`, which answers about whichever ancestor is positioned. */
    const fold = scroller.getBoundingClientRect().top
    const was = section.getBoundingClientRect()
    const above = was.bottom <= fold

    section.querySelector(':scope > .nb-gutter')?.replaceWith(drawGutter(cell))
    section.classList.toggle('is-running', isRunning(cell) || queued.has(cell))

    const body = section.querySelector('.nb-body')
    const outputs = body?.querySelector(':scope > .nb-outputs')
    if (body) {
      const next = (cell.type === 'code' && !outputsHidden(cell)) ? drawOutputs(cell) : null
      if (outputs && next) outputs.replaceWith(next)
      else if (outputs) outputs.remove()
      else if (next) body.append(next)

      /* The line a cell blocked on `input()` is answered on comes and goes
         with the run, so it is swapped here rather than waiting for a paint —
         which would throw away the caret of whoever is typing elsewhere. */
      const asking = runs.get(cell)?.asking
      const stdin = body.querySelector(':scope > .nb-stdin')
      if (asking && !stdin) body.append(drawStdin(cell, asking))
      else if (!asking && stdin) stdin.remove()
    }

    if (above) scroller.scrollTop += section.getBoundingClientRect().height - was.height
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
      /* `execute_input` is the kernel saying it has begun, which is the honest
         start of the clock: everything before it is queueing behind whatever
         the kernel was already doing, and calling that part of the cell's own
         time makes a fast cell look slow because a slow one ran first. */
      run.startedAt = Date.now()
      scheduleRepaint(cell)
      return
    }

    if (event.kind === 'input') {
      /* The kernel is blocked on `input()` and will stay blocked until this is
         answered. Drawn where the answer goes — under the cell that asked. */
      run.asking = { prompt: event.prompt, password: event.password }
      repaintNow(cell)
      focusInputRow(cell)
      return
    }

    if (event.kind === 'output') {
      const output = kernelOutput(event.msgType, event.content)
      if (!output) return
      run.state = applyOutput(run.state, output)
      cell.outputs = run.state.outputs
      /* Written into the cell, and the cell is the file — so a run makes the
         notebook dirty exactly as typing does, and the outputs are still there
         when it is opened again. A checkpoint rather than a save, because a
         cell that prints in a loop asks for one of these several times a
         second and each is a serialisation of the whole file — see
         `CHECKPOINT_DELAY`. The `done` below asks properly. */
      setDirty(true)
      queueCheckpoint()
      scheduleRepaint(cell)
      return
    }

    if (event.kind === 'done') {
      runs.delete(cell)
      byMsg.delete(event.msgId)
      inbox.delete(event.msgId)
      run.asking = null
      /* How long it took, into the file in the file's own spelling — so it is
         still there when the notebook is reopened, which is the whole reason
         `metadata.execution` exists. Only for a run that actually began: a
         cell that never reached the kernel has no duration, and writing one
         would be inventing it. */
      if (run.startedAt) setCellDuration(cell, run.startedAt, Date.now())
      if (event.error) {
        /* A run that ended without the kernel saying why still has to say
           something. Recorded as an error output rather than a dialog: it
           belongs to the cell it happened to. */
        run.state = applyOutput(run.state, {
          output_type: 'error', ename: 'Tulip', evalue: event.error, traceback: [event.error]
        })
        cell.outputs = run.state.outputs
      }
      setDirty(true)
      queueSave()
      run.settle?.({ status: event.status || 'ok' })
      repaintNow(cell)
      paintBar()
      onStatus()
    }
  }

  /**
   * Answer the `input()` a cell is waiting on.
   *
   * What was typed goes into the cell's output as well as to the kernel, the
   * way it appears in a terminal: the prompt and the answer are part of what
   * this run did, and a notebook reopened later should show the conversation
   * rather than a bare prompt with no reply.
   */
  function answerInput (cell, value) {
    const run = runs.get(cell)
    if (!run?.asking || !current) return
    const { prompt, password } = run.asking
    run.asking = null
    run.state = applyOutput(run.state, {
      output_type: 'stream',
      name: 'stdout',
      text: `${prompt}${password ? '········' : value}\n`
    })
    cell.outputs = run.state.outputs
    setDirty(true)
    queueCheckpoint()
    repaintNow(cell)
    kernel?.input?.(current.path, value)?.catch?.(() => {})
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

    const run = {
      msgId: null,
      state: { outputs: [], clearWhenNext: false },
      settle: null,
      /* Set when the kernel says it has begun, not here — see the `count`
         event. Null until then, and a run that never began records no time. */
      startedAt: 0,
      asking: null
    }
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
    if (queueTotal) return                 // one queue at a time
    queue = list.filter((cell) => cell.type === 'code' && cell.source.trim())
    queued.clear()
    for (const cell of queue) queued.add(cell)
    queueTotal = queue.length
    queueDone = 0
    queueStop = false
    paintBar()
    while (queue.length && !queueStop) {
      const cell = queue.shift()
      queued.delete(cell)
      // It may have been deleted while the cell above it was running.
      if (!cells.includes(cell)) { queueDone++; continue }
      /* The view does not follow the queue. Run all is pressed to get the
         outputs, not to be taken on a tour of them, and a page that scrolls
         itself is a page you have lost your place in — the cell being read
         when the button was pressed is the cell still on screen when the run
         is over. `repaintCell` keeps it there as the outputs land. */
      const result = await runCell(cell)
      queueDone++
      paintBar()
      if (result?.status === 'error' || result?.status === 'aborted') break
    }
    queue = []
    queued.clear()
    queueTotal = 0
    queueDone = 0
    queueStop = false
    paintBar()
  }

  const runAll = () => runCells([...cells])

  /* Where the reader is, for the two run commands that are relative to it.
     "Above" means up to but not including the cell you are on — you have just
     changed it and want its inputs rebuilt — and "below" means from it
     downward, including it, because that is the part you have changed. */
  const runAbove = () => runCells(cells.slice(0, Math.max(0, atCell())))
  const runBelow = () => runCells(cells.slice(Math.max(0, atCell())))

  function stopQueue () {
    queueStop = true
    queue = []
    queued.clear()
    queueTotal = 0
    queueDone = 0
  }

  /**
   * Give up on every cell that is waiting on the kernel.
   *
   * Forgetting a run is not the same as ending one. `runCell` hands back a
   * promise that settles when the kernel says it is done with the cell, and
   * `runCells` is sitting on that promise — so a restart or a kernel swap that
   * only emptied `runs` left Run all waiting on a cell whose answer was never
   * coming, for the rest of the session. The kernel these were waiting on has
   * just gone; saying so is what lets the queue unwind.
   */
  function abandonRuns () {
    for (const [, run] of runs) run.settle?.({ status: 'aborted' })
    runs.clear()
    byMsg.clear()
    inbox.clear()
  }

  async function interruptKernel () {
    stopQueue()
    if (kernelInfo) {
      try {
        await kernel.interrupt(current.path)
      } catch (err) {
        /* A cell that is still running after this is the honest picture, and
           the reader has to be told the stop did not land — silence here reads
           as "interrupted, and the cell is just slow to notice". */
        notify(`${kernelNamed() || 'The kernel'} could not be interrupted: ${err?.message || 'it did not answer'}.`)
      }
    }
    paintBar()
  }

  /**
   * Start the kernel again, with everything in it thrown away.
   *
   * Asked about first, which electron/kernel.js has always said this does and
   * which it did not: a restart is the one action here that destroys something
   * no undo can bring back — an hour of loaded data, a fitted model, a
   * connection — and it sat one unlabelled click away from Run all. The
   * confirmation is skipped where the kernel has nothing in it yet, because
   * there is then nothing to lose and a dialog about nothing is a dialog people
   * learn to dismiss without reading.
   */
  async function restartKernel ({ confirm = true } = {}) {
    if (!kernelInfo) return false
    if (confirm && ask && (anyRunning() || kernelInfo.state !== 'starting')) {
      const yes = await ask({
        title: `Restart ${kernelNamed() || 'the kernel'}?`,
        detail: 'Every variable, import and open file in this session is thrown ' +
          'away. The outputs already in the notebook stay where they are.',
        go: 'Restart'
      })
      if (!yes) return false
    }
    stopQueue()
    if (!kernelInfo) return false
    try {
      await kernel.restart(current.path)
    } catch (err) {
      /* The session is still there. Clearing the counts and abandoning the runs
         below would draw a notebook that had been restarted when nothing was —
         so none of it happens, and the reader is told why rather than being
         left to discover it from the next cell that still has state. */
      notify(`${kernelNamed() || 'The kernel'} could not be restarted: ${err?.message || 'it did not answer'}.`)
      paintBar()
      return false
    }
    /* Every number in the file describes a session that no longer exists. The
       outputs stay — they are what those runs printed, and deleting them is a
       separate thing the reader can ask for. */
    for (const cell of cells) {
      if (cell.type === 'code') cell.executionCount = null
    }
    abandonRuns()
    setDirty(true)
    queueSave()
    paint()
    return true
  }

  /**
   * The one that answers "why does this notebook not reproduce": every cell,
   * top to bottom, against a kernel with nothing in it.
   *
   * A notebook run out of order is a notebook whose outputs describe a session
   * nobody can get back to, and this is the only way to find out. Asked about
   * as one action rather than two, because that is what it is.
   */
  async function restartAndRunAll () {
    if (!canRun()) return
    if (kernelInfo) {
      if (ask) {
        const yes = await ask({
          title: 'Restart and run every cell?',
          detail: 'The session is emptied first, so the notebook runs from the top ' +
            'against nothing — which is what it will do for whoever opens it next.',
          go: 'Restart and run'
        })
        if (!yes) return
      }
      if (!await restartKernel({ confirm: false })) return
    }
    await runAll()
  }

  /**
   * Ask what kernels exist, once.
   *
   * A failure is said rather than swallowed, and this is why: the fallback list
   * is one entry, and so is the list on a machine with one kernel installed.
   * Silence made those two indistinguishable, and a picker that offers a single
   * choice looks like a working picker rather than a question that was never
   * asked. The ask is left re-askable, so opening the menu again retries.
   */
  function loadKernelSpecs () {
    if (kernelSpecs || specsAsked || !kernel?.specs) return
    specsAsked = kernel.specs()
      .then((reply) => {
        kernelSpecs = Array.isArray(reply?.specs) ? reply.specs : []
        if (kernelNotice.startsWith(SPECS_FAILED)) kernelNotice = ''
        paintBar()
      })
      .catch((err) => {
        kernelNotice = `${SPECS_FAILED} ${err?.message || err}`
        paintBar()
      })
      .finally(() => { specsAsked = null })
  }

  /**
   * Run this notebook on a different kernel.
   *
   * The choice is written into `kernelspec`, because that is the notebook's own
   * record of what it wants and the only part of it that outlives this window.
   * The running kernel goes rather than being restarted: a different kernel is
   * a different process, and the numbers in the file describe the old one.
   */
  async function useKernel (name) {
    const spec = kernelSpecs?.find((entry) => entry.name === name)
    if (!current || !spec) return
    const path = current.path

    stopQueue()
    if (kernelStarting) await kernelStarting.catch(() => {})
    if (current?.path !== path) return
    if (kernel?.shutdown) await kernel.shutdown(path).catch(() => {})
    if (current?.path !== path) return

    kernelInfo = null
    kernelStarting = null
    kernelNotice = ''
    abandonRuns()
    for (const cell of cells) {
      if (cell.type === 'code') cell.executionCount = null
    }

    shell = shell || {}
    shell.metadata = shell.metadata || {}
    shell.metadata.kernelspec = {
      name: spec.name,
      display_name: spec.displayName || spec.name,
      language: spec.language || ''
    }
    /* `language_info` was written by the kernel that ran, and that kernel is no
       longer this notebook's. Dropped rather than rewritten: the next kernel
       will say what it is, and a stale one colours the cells as the wrong
       language in the meantime. */
    delete shell.metadata.language_info
    language = notebookLanguage(shell)
    setDirty(true)
    queueSave()
    paint()

    // Started now rather than on the next run, so the bar can say it worked.
    if (canRun()) ensureKernel().catch(() => {})
  }

  /** Let go of this notebook's kernel. Called when it closes, so a Python
   *  process is not left holding a gigabyte for a pane nobody is looking at. */
  function releaseKernel () {
    const path = current?.path
    stopQueue()
    abandonRuns()
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

  /* Colouring waits for a cell to be looked at.

     A parse and a few thousand spans is nothing for the six cells on screen
     and a visible stall for the three hundred that are not — and `paint()`
     rebuilds all of them, so every add, delete, move, undo and view switch
     paid for the whole notebook. Deferring it is safe precisely because the
     `<pre>` already holds the right text at the right size: an uncoloured cell
     is the same shape as a coloured one, which is the arrangement the textarea
     sits on top of. Nothing moves when the colour arrives.

     A screenful of margin, so scrolling meets colour rather than following it.
     Where there is no observer — a test, a window built without one — every
     cell is coloured at once, which is what this did before. */
  /* A `Map` rather than a `WeakMap`, because a paint that keeps most of its
     sections has to hand back the ones it did not: an observer holds its
     targets, so a `<pre>` inside a discarded section would sit in it for the
     life of the window waiting to be scrolled to. `forget` is what empties
     both, and every path out of this — the callback, a rebuild, `close` —
     goes through it. */
  const waitingToColour = new Map()   // pre -> the colouring it is owed
  const viewport = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          viewport.unobserve(entry.target)
          const run = waitingToColour.get(entry.target)
          waitingToColour.delete(entry.target)
          run?.()
        }
      }, { root: scroller, rootMargin: '600px 0px' })
    : null

  function colourWhenSeen (pre, run) {
    if (!viewport) { run(); return }
    waitingToColour.set(pre, run)
    viewport.observe(pre)
  }

  /** A section is going: whatever it was still owed, it is not owed now. */
  function forget (section) {
    if (!viewport) return
    for (const pre of section.querySelectorAll?.('.nb-ink') || []) {
      if (!waitingToColour.delete(pre)) continue
      viewport.unobserve(pre)
    }
  }

  /** The grammar a cell's source is coloured with. */
  const tokenFor = (cell) =>
    cell.type === 'markdown' ? 'markdown' : cell.type === 'code' ? language : ''

  /* ------------------------------------------------- asking about the code

     Two questions a notebook can answer that a text editor cannot: what
     completes here, and what is this. Both are only answerable by the kernel,
     because the answer depends on what has already been run — `df.` completes
     to that DataFrame's columns, and no amount of reading the file would say
     so. That is the whole argument for having them here rather than leaving it
     to the highlighter.
     ================================================================== */

  /**
   * Where the caret is on screen, measured on the `<pre>` under the textarea.
   *
   * The `<pre>` mirrors the text exactly — that is the arrangement the whole
   * editor is built on — so a range at the caret's offset in it is a range at
   * the caret. Which saves the usual trick of building a hidden clone of the
   * textarea to measure in: there is already one, and it is visible.
   */
  function caretRect (pre, offset) {
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
    let seen = 0
    let node
    while ((node = walker.nextNode())) {
      const length = node.nodeValue.length
      if (seen + length >= offset) {
        const range = document.createRange()
        range.setStart(node, offset - seen)
        range.collapse(true)
        const rect = range.getBoundingClientRect()
        if (rect.top || rect.left) return rect
        break
      }
      seen += length
    }
    return pre.getBoundingClientRect()
  }

  /**
   * The one popup, shared by both questions.
   *
   * One rather than one per cell: only ever one can be open, and a per-cell
   * popup would be a node on every cell in the notebook waiting for a Tab that
   * will never come to most of them.
   */
  function makeHint () {
    const box = el('div', 'nb-hint')
    box.hidden = true
    const list = el('div', 'nb-hint-list')
    list.setAttribute('role', 'listbox')
    const doc = el('div', 'nb-hint-doc')
    box.append(list, doc)
    host.append(box)

    let open = null   // { input, matches, at, from, to } while completing
    let token = 0     // which ask is the current one, so a slow reply cannot win

    function close () {
      if (box.hidden) return
      box.hidden = true
      open = null
      list.replaceChildren()
      doc.replaceChildren()
      doc.hidden = true
    }

    /* Above the caret when there is no room below it — a completion list that
       runs off the bottom of the window is a completion list of one item. */
    function place (rect) {
      box.hidden = false
      const height = box.getBoundingClientRect().height
      const below = window.innerHeight - rect.bottom
      const top = (below < height + 12 && rect.top > height + 12)
        ? rect.top - height - 4
        : rect.bottom + 4
      box.style.top = `${Math.max(4, top)}px`
      box.style.left = `${Math.min(rect.left, window.innerWidth - box.offsetWidth - 8)}px`
    }

    function paintList () {
      for (let index = 0; index < list.children.length; index++) {
        const row = list.children[index]
        row.classList.toggle('is-at', index === open.at)
        row.setAttribute('aria-selected', index === open.at ? 'true' : 'false')
      }
      list.children[open.at]?.scrollIntoView({ block: 'nearest' })
    }

    function accept () {
      if (!open) return
      const { input, matches, at, from, to } = open
      const chosen = matches[at]
      close()
      if (chosen == null) return
      input.setRangeText(chosen, from, to, 'end')
      input.dispatchEvent(new Event('input'))
    }

    async function complete (cell, input, pre) {
      if (!kernel?.complete || !current) return
      const mine = ++token
      const reply = await kernel.complete(current.path, input.value, input.selectionStart)
        .catch(() => null)
      if (mine !== token || !reply || document.activeElement !== input) return

      const matches = Array.isArray(reply.matches) ? reply.matches.slice(0, 200) : []
      if (!matches.length) { close(); return }

      /* One answer is not a menu. Jupyter's own client takes the single match
         without asking, and so does every editor — a popup you dismiss by
         choosing its only row is a keystroke charged for nothing. */
      const from = Number.isInteger(reply.cursor_start) ? reply.cursor_start : input.selectionStart
      const to = Number.isInteger(reply.cursor_end) ? reply.cursor_end : input.selectionStart
      if (matches.length === 1) {
        input.setRangeText(matches[0], from, to, 'end')
        input.dispatchEvent(new Event('input'))
        return
      }

      open = { input, matches, at: 0, from, to }
      doc.hidden = true
      doc.replaceChildren()
      list.replaceChildren(...matches.map((match, index) => {
        const row = el('div', 'nb-hint-row', match)
        row.setAttribute('role', 'option')
        // `mousedown` rather than `click`: a click would blur the textarea
        // first, and the blur closes this.
        row.addEventListener('mousedown', (event) => {
          event.preventDefault()
          open.at = index
          accept()
        })
        return row
      }))
      paintList()
      place(caretRect(pre, from))
    }

    async function inspect (cell, input, pre) {
      if (!kernel?.inspect || !current) return
      const mine = ++token
      const at = input.selectionStart
      const reply = await kernel.inspect(current.path, input.value, at).catch(() => null)
      if (mine !== token || document.activeElement !== input) return
      const text = reply?.found ? cellText(reply?.data?.['text/plain']) : ''
      if (!text) { close(); return }

      open = null
      list.replaceChildren()
      doc.hidden = false
      /* The kernel's own colouring, kept: a signature that arrives with its
         argument names picked out is easier to read than the same text flat,
         and `ansiSpans` is already the thing that knows how. */
      doc.replaceChildren(textBlock(text, 'nb-hint-text'))
      place(caretRect(pre, at))
    }

    /** @returns true when the popup took the key and the cell must not. */
    function handleKey (event) {
      if (box.hidden) return false
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return true }
      if (!open) {
        // Documentation is dismissed by anything, and swallows nothing.
        close()
        return false
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        open.at = (open.at + 1) % open.matches.length
        paintList()
        return true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        open.at = (open.at - 1 + open.matches.length) % open.matches.length
        paintList()
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        accept()
        return true
      }
      return false
    }

    return { complete, inspect, close, handleKey }
  }

  const hint = makeHint()
  // Scrolling moves the caret out from under it; nothing else has to be true.
  scroller.addEventListener('scroll', () => hint.close(), { passive: true })

  /**
   * The editable source of one cell: a `<pre>` that holds the text and does
   * the layout, and a textarea over it with transparent ink. They must wrap
   * identically or the caret drifts from the letter under it — which is why
   * the `<pre>` is written synchronously on every keystroke and only its
   * colouring is deferred.
   */
  function drawSource (cell) {
    const wrap = el('div', 'nb-source')
    const pre = el('pre', 'nb-ink')
    pre.textContent = `${cell.source}\n`
    wrap.append(pre)
    colourWhenSeen(pre, () => colour(pre, cell.source, tokenFor(cell), { now: true }))

    if (!editable()) {
      if (!cell.source) wrap.classList.add('is-empty')
      return wrap
    }

    const input = document.createElement('textarea')
    input.className = 'nb-input'
    input.value = cell.source
    input.spellcheck = cell.type === 'markdown'
    input.wrap = 'soft'
    input.setAttribute('aria-label', `${cell.type} cell ${indexOf(cell) + 1}`)
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
      editingIndex = indexOf(cell)
      select(editingIndex)
      wrap.closest('.nb-cell')?.classList.add('is-editing')
    })
    /* And taken off again when the caret goes. A section outlives a paint now,
       so a class added on the way in and only ever removed by a rebuild is one
       that stays on a cell nobody is typing in. */
    input.addEventListener('blur', () => {
      wrap.closest('.nb-cell')?.classList.remove('is-editing')
    })

    input.addEventListener('keydown', (event) => {
      // The popup takes the arrows, Return and Escape while it is up.
      if (hint.handleKey(event)) return

      if (event.key === 'Enter' && (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)) {
        event.preventDefault()
        runFromCell(cell, cells.indexOf(cell), event, { enter: true })
        return
      }
      if (event.key === 'Escape') {
        event.stopPropagation()
        // A markdown cell goes back to being the prose it describes; anything
        // else simply hands the keys back to the window — where the command
        // keys are now listening, so the cell stays chosen.
        if (cell.type === 'markdown') { editingIndex = -1; paint() }
        scroller.focus({ preventScroll: true })
        return
      }
      /* Tab indents rather than leaving the cell — except after something
         worth completing, where it asks the kernel what comes next. That
         distinction is the whole of it: a Tab at the start of a line, or after
         whitespace, is indentation and always was; a Tab after `df.` is a
         question, and answering it needs the live kernel that already knows
         what `df` is. Shift-Tab is the way out of the cell, and — with
         something under the caret — the way to what it is.

         A code cell is the one place in this app where Tab means indentation,
         and a notebook whose Tab key jumped to the next cell would be one
         nobody could write Python in. */
      if (event.key === 'Tab' && !event.shiftKey) {
        if (cell.type === 'code' && canRun() && wordBefore(input)) {
          event.preventDefault()
          hint.complete(cell, input, pre)
          return
        }
        event.preventDefault()
        const { selectionStart: from, selectionEnd: to } = input
        input.setRangeText('    ', from, to, 'end')
        input.dispatchEvent(new Event('input'))
        return
      }
      if (event.key === 'Tab' && event.shiftKey && cell.type === 'code' &&
          canRun() && wordBefore(input)) {
        event.preventDefault()
        hint.inspect(cell, input, pre)
      }
    })

    /* Typing past a completion invalidates it. Rebuilding the list on every
       keystroke would be a round trip to Python per letter; dismissing and
       letting Tab ask again is both cheaper and less surprising. */
    input.addEventListener('input', () => hint.close())
    input.addEventListener('blur', () => hint.close())

    wrap.append(input)
    return wrap
  }

  /** What the caret is sitting just after, if it is a name. Empty for a caret
   *  at the start of a line or after whitespace, which is what tells Tab that
   *  it means indentation. */
  function wordBefore (input) {
    if (input.selectionStart !== input.selectionEnd) return ''
    const before = input.value.slice(0, input.selectionStart)
    return /[\w.\])'"]$/.test(before) ? before.match(/[\w.]*$/)?.[0] ?? '' : ''
  }

  /* ------------------------------------------------------------ the cells */

  /* `[*]` is Jupyter's own spelling for "this is running or waiting to", and
     the one thing a reader watching a slow cell is looking for. */
  const promptFor = (cell) => {
    if (cell.type !== 'code') return ''
    if (isRunning(cell) || queued.has(cell)) return '[*]'
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
  const COPY = `<path d="M9 9h9.5v9.5H9zM5.5 15V5.5H15" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  const GRIP = `<path d="M9.5 7h.01M14.5 7h.01M9.5 12h.01M14.5 12h.01M9.5 17h.01M14.5 17h.01"
      fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`
  const TAG = `<path d="M4.5 4.5h6.6l8.4 8.4-6.6 6.6-8.4-8.4zM8 8h.01" fill="none"
      stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  const CHEVRON = `<path d="M8 10.5 12 14.5l4-4" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`

  /** The controls that change one cell's shape — what kind it is, where it
   *  sits, whether it exists. Present only while the notebook is editable;
   *  Run is not among them, and lives in the gutter in both views. */
  function drawTools (cell) {
    const tools = el('div', 'nb-cell-tools')

    const type = dropdown({
      label: 'Cell type',
      className: 'nb-cell-type',
      value: cell.type,
      options: [
        { value: 'code', label: 'Code' },
        { value: 'markdown', label: 'Markdown' },
        { value: 'raw', label: 'Raw' }
      ],
      onChange: (wanted) => setCellType(indexOf(cell), wanted)
    })
    type.root.title = 'What kind of cell this is'
    tools.append(type.root)

    /* The handle, and the only part of a cell that is draggable. A cell that
       was draggable everywhere would be a cell you could not select text in:
       the browser starts a drag rather than a selection, and the source is the
       part people drag across most. */
    const grip = iconButton('Drag to move this cell', GRIP, () => {})
    grip.classList.add('nb-grip')
    grip.draggable = true
    grip.addEventListener('dragstart', (event) => {
      const index = indexOf(cell)
      dragFrom = index
      event.dataTransfer.effectAllowed = 'move'
      /* Something has to be set or Firefox refuses to start the drag, and the
         cell's first line is what a drop onto anything outside this notebook
         would sensibly paste. */
      event.dataTransfer.setData('text/plain', cell.source)
      event.dataTransfer.setDragImage(column.children[index] || grip, 12, 12)
    })
    grip.addEventListener('dragend', endDrag)
    tools.append(grip)

    tools.append(iconButton('Move up', ARROW_UP, () => moveCell(indexOf(cell), -1)))
    tools.append(iconButton('Move down', ARROW_DOWN, () => moveCell(indexOf(cell), 1)))
    tools.append(iconButton('Duplicate this cell', COPY, () => duplicateCell(indexOf(cell))))
    tools.append(iconButton('Add a cell below', PLUS, () => addCell(indexOf(cell) + 1)))
    tools.append(iconButton(
      cellTags(cell).length ? 'Edit this cell’s tags' : 'Tag this cell',
      TAG,
      () => editTags(cell)
    ))
    if (cell.type === 'code' && cell.outputs.length) {
      tools.append(iconButton('Clear this cell’s output', BROOM, () => change(() => {
        cell.outputs = []
        cell.executionCount = null
        setCellDuration(cell, null, null)
      })))
    }
    tools.append(iconButton('Delete this cell', TRASH, () => deleteCell(indexOf(cell))))
    return tools
  }

  /**
   * The tags a cell carries, edited where they are shown.
   *
   * Comma-separated in one field rather than chips you add one at a time,
   * because tags are typed in sets — `parameters`, `hide-input`, `skip` — and
   * because whoever is editing them knows exactly what they want to say. They
   * are read by papermill, by nbconvert and by every notebook CI there is, and
   * nothing here could show them at all: a cell tagged `skip` looked exactly
   * like a cell that was not.
   */
  function editTags (cell) {
    if (!editable()) return
    const index = indexOf(cell)
    const section = index < 0 ? null : column.children[index]
    if (!section) return
    const existing = section.querySelector('.nb-tag-edit')
    if (existing) { existing.focus(); return }

    const field = document.createElement('input')
    field.type = 'text'
    field.className = 'nb-tag-edit'
    field.value = cellTags(cell).join(', ')
    field.placeholder = 'tags, comma separated'
    field.setAttribute('aria-label', `Tags for cell ${index + 1}`)

    const commit = (keep) => {
      field.remove()
      if (!keep) return
      change(() => { setCellTags(cell, field.value.split(',')) })
    }
    field.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') { event.preventDefault(); commit(true) }
      if (event.key === 'Escape') { event.preventDefault(); commit(false) }
    })
    field.addEventListener('blur', () => commit(true))

    section.querySelector('.nb-body')?.prepend(field)
    field.focus()
    field.select()
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
      prompt.title = isRunning(cell) || queued.has(cell)
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
      const busy = isRunning(cell) || queued.has(cell)
      const run = iconButton(
        busy ? 'Interrupt' : 'Run this cell  (⇧⏎)',
        busy ? STOP : PLAY,
        () => { if (busy) interruptKernel(); else runCell(cell) }
      )
      run.classList.add('nb-run')
      gutter.append(run)
    }

    /* How long the last run took, under the prompt that says which run it was.
       Read from the file rather than from this session, so it survives being
       reopened — which is most of its value: "this cell takes four minutes" is
       something you want to know before you press Run, not after. */
    const took = formatDuration(cellDuration(cell))
    if (cell.type === 'code' && took && !isRunning(cell)) {
      const timing = el('div', 'nb-took', took)
      timing.title = 'How long this cell took the last time it ran'
      gutter.append(timing)
    }

    /* The fold, offered only where there is something to fold. It is in the
       gutter because that is the strip that belongs to the cell rather than to
       its content, and because it must be reachable in Reading view, where the
       hover toolbar is not there at all. */
    if (cell.type === 'code' && cell.outputs.length) {
      const shut = outputsHidden(cell)
      const fold = iconButton(
        shut ? 'Show this cell’s output  (o)' : 'Hide this cell’s output  (o)',
        CHEVRON,
        () => toggleHidden(cell, 'outputs')
      )
      fold.classList.add('nb-fold')
      fold.classList.toggle('is-shut', shut)
      fold.setAttribute('aria-expanded', shut ? 'false' : 'true')
      gutter.append(fold)
    }
    return gutter
  }

  /**
   * The line a cell waiting on `input()` is answered on.
   *
   * Under the outputs, where the prompt it is answering has just been printed —
   * which is where it is in a terminal, and the only place the two read as one
   * conversation.
   */
  function drawStdin (cell, asking) {
    const row = el('div', 'nb-stdin')
    const label = el('label', 'nb-stdin-label', asking.prompt || 'Input:')
    const field = document.createElement('input')
    field.type = asking.password ? 'password' : 'text'
    field.className = 'nb-stdin-input'
    field.setAttribute('aria-label', asking.prompt || 'Answer this cell’s input')
    label.append(field)
    field.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') { event.preventDefault(); answerInput(cell, field.value) }
    })
    row.append(label)
    return row
  }

  function drawCell (cell, index) {
    const section = el('section', `nb-cell is-${cell.type}`)
    section.dataset.index = String(index)
    if (isRunning(cell) || queued.has(cell)) section.classList.add('is-running')
    if (index === selected) section.classList.add('is-at')

    section.append(drawGutter(cell))

    const body = el('div', 'nb-body')

    const tags = cellTags(cell)
    if (tags.length) {
      const row = el('div', 'nb-tags')
      for (const tag of tags) row.append(el('span', 'nb-tag', tag))
      if (editable()) {
        row.title = 'Click to edit this cell’s tags'
        row.addEventListener('click', () => editTags(cell))
      }
      body.append(row)
    }

    const folded = sourceHidden(cell)
    if (folded) {
      /* A folded cell still says it is there and what it is, and opens on a
         click. Drawing nothing would be a notebook that had silently lost a
         cell — which is what honouring the flag without saying so amounts to. */
      const shut = el('button', 'nb-folded',
        cell.source.split('\n')[0].trim() || PLACEHOLDER[cell.type] || 'Hidden')
      shut.type = 'button'
      shut.title = 'This cell’s source is hidden — click to show it  (⇧O)'
      shut.addEventListener('click', () => toggleHidden(cell, 'source'))
      body.append(shut)
    } else if (cell.type === 'markdown' && editingIndex !== index) {
      /* A markdown cell is prose, so prose is what it shows — until it is asked
         for its source. A code cell is source either way: that is what the cell
         *is*, and there is nothing else of it to render. */
      const rendered = el('div', 'nb-md')
      if (cell.source.trim() && markdown?.render) {
        setProse(rendered, cell.source, cell.raw?.attachments)
      } else if (cell.source.trim()) {
        rendered.textContent = cell.source
      } else {
        rendered.append(el('p', 'nb-empty', PLACEHOLDER.markdown))
      }
      if (editable()) {
        rendered.title = 'Double-click to edit'
        rendered.addEventListener('dblclick', () => {
          const at = indexOf(cell)
          if (at < 0) return
          editingIndex = at
          paint()
          focusCell(at)
        })
      }
      body.append(rendered)
    } else {
      body.append(drawSource(cell))
    }

    const outputs = cell.type === 'code' && !outputsHidden(cell) ? drawOutputs(cell) : null
    if (outputs) body.append(outputs)
    else if (cell.type === 'code' && cell.outputs.length && outputsHidden(cell)) {
      const shut = el('button', 'nb-outputs-shut',
        `${cell.outputs.length} output${cell.outputs.length === 1 ? '' : 's'} hidden`)
      shut.type = 'button'
      shut.addEventListener('click', () => toggleHidden(cell, 'outputs'))
      body.append(shut)
    }

    const asking = runs.get(cell)?.asking
    if (asking) body.append(drawStdin(cell, asking))

    section.append(body)
    if (editable()) section.append(drawTools(cell))
    return section
  }

  /**
   * Everything `drawCell` reads about a cell, so that a paint can tell whether
   * the section it built last time still says the truth.
   *
   * Compared by identity, member by member — which is why `outputs` is the
   * array rather than anything derived from it: `applyOutput` returns a new one
   * for every message and every other path assigns a new one too, so the array
   * a cell is holding *is* the question "has anything been printed since".
   *
   * The index is deliberately not in here. A cell that has only moved is drawn
   * exactly as it was, and `place` below is what tells the section its new
   * number — the whole point of taking the index out of the handlers.
   */
  function signature (cell, index) {
    const asking = runs.get(cell)?.asking
    return [
      cell.type,
      cell.source,
      cell.outputs,
      cell.executionCount,
      cell.raw?.metadata?.tags,
      cell.raw?.attachments,
      /* Only a markdown cell is drawn differently for being edited — a code
         cell is its source either way. Asking the broader question here would
         rebuild a code cell every time the caret entered or left it, for a
         difference there is none of. */
      cell.type === 'markdown' && editingIndex === index,
      isRunning(cell) || queued.has(cell),
      sourceHidden(cell),
      outputsHidden(cell),
      cellDuration(cell),
      asking?.prompt ?? null,
      asking?.password ?? null,
      /* Not about the cell, but read while drawing one: the view it is drawn
         for, whether there is a kernel to run it on, what language it is
         coloured as, and whether KaTeX has landed since. */
      editable(),
      canRun(),
      language,
      drawEpoch
    ]
  }

  const unchanged = (a, b) =>
    a.length === b.length && a.every((each, at) => Object.is(each, b[at]))

  /** Tell a section which cell it is showing now. The two things in it that are
   *  about the number rather than the cell. */
  function place (section, index) {
    section.dataset.index = String(index)
    const input = section.querySelector('.nb-input')
    if (input) input.setAttribute('aria-label', `${cells[index].type} cell ${index + 1}`)
  }

  /* What each cell was last drawn as, by the key that survives an undo. */
  let drawnCells = new Map()   // cell.key -> { section, sig }

  /* --------------------------------------------------------- the structure */

  function addCell (at, type = 'code') {
    change(() => {
      cells.splice(at, 0, newCell(type, shell))
      editingIndex = type === 'markdown' ? at : -1
      selected = at
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
      // The cell that took its place, or the last one when it was the last one.
      selected = Math.min(index, cells.length - 1)
    })
  }

  function moveCell (index, by) {
    const to = index + by
    if (to < 0 || to >= cells.length) return
    change(() => {
      const [cell] = cells.splice(index, 1)
      cells.splice(to, 0, cell)
      if (editingIndex === index) editingIndex = to
      selected = to
    })
    focusCell(to)
  }

  /**
   * Move a cell to an index rather than by a step — what a drag ends in.
   *
   * `to` is read against the list *before* the cell is taken out of it, which
   * is what a drop position means: the gap the reader let go over. Taking it
   * out first would shift every gap below it up by one and drop the cell one
   * place short of where they aimed.
   */
  function moveCellTo (index, to) {
    if (index === to || to < 0 || to > cells.length) return
    change(() => {
      const [cell] = cells.splice(index, 1)
      const at = to > index ? to - 1 : to
      cells.splice(at, 0, cell)
      if (editingIndex === index) editingIndex = at
      selected = at
    })
  }

  /* ----------------------------------------------------------- the clipboard

     Cells, not text. Copying the source of a cell is what ⌘C in the textarea
     already does; this is the other thing — the cell with its type, its
     outputs, its tags and its metadata, so that reordering a notebook by
     cutting and pasting keeps everything that is not the words.
     ================================================================== */

  function copyCells (indexes) {
    const taken = indexes.map((index) => cells[index]).filter(Boolean)
    if (!taken.length) return false
    clipboard = taken.map((cell) => copyCell(cell, shell))
    return true
  }

  function cutCell (index) {
    if (!editable() || !copyCells([index])) return
    deleteCell(index)
  }

  /** Paste at `at`. The pasted cells are copied again on the way in, so the
   *  clipboard survives being pasted more than once. */
  function pasteCells (at) {
    if (!editable() || !clipboard.length) return
    const arriving = clipboard.map((cell) => copyCell(cell, shell))
    change(() => {
      cells.splice(at, 0, ...arriving)
      editingIndex = -1
      selected = at
    })
  }

  function duplicateCell (index) {
    const cell = cells[index]
    if (!editable() || !cell) return
    const copy = copyCell(cell, shell)
    change(() => {
      cells.splice(index + 1, 0, copy)
      editingIndex = -1
      selected = index + 1
    })
  }

  function setCellType (index, wanted) {
    const cell = cells[index]
    if (!cell || cell.type === wanted) return
    change(() => {
      cell.type = wanted
      /* Outputs belong to code that ran. A cell turned into prose has none,
         and turning it back does not bring them back — which is honest: they
         were never this cell's outputs once it stopped being that code. */
      if (wanted !== 'code') {
        cell.outputs = []
        cell.executionCount = null
        setCellDuration(cell, null, null)
      }
      editingIndex = wanted === 'markdown' ? -1 : index
      selected = index
    })
  }

  /** Put the caret in a cell, once the paint that built it has happened. */
  function focusCell (index) {
    select(index)
    const section = column.children[index]
    const input = section?.querySelector('.nb-input')
    if (input) input.focus()
    else section?.scrollIntoView({ block: 'nearest' })
  }

  /** The line a cell is waiting for an answer on, when it has one. */
  function focusInputRow (cell) {
    sectionFor(cell)?.querySelector('.nb-stdin-input')?.focus()
  }

  /**
   * The three Enters every notebook has, from wherever they were pressed.
   *
   * ⇧⏎ runs and moves on, which is how a notebook is read top to bottom; ⌘⏎
   * runs and stays, which is how one cell is worked on; ⌥⏎ runs and opens a
   * new cell under it. Markdown and raw cells have nothing to run, but ⇧⏎
   * still means "done with this one" — it renders the prose and moves on,
   * which is why the kernel is asked about only the running.
   *
   * `enter` is whether to put the caret in the cell moved to. From a textarea
   * yes: the reader is typing their way down the notebook. From the command
   * keys no: they have deliberately stepped out of the text, and being put
   * back in is the opposite of what Escape just did.
   */
  function runFromCell (cell, at, event, { enter = false } = {}) {
    if (!cell) return
    if (cell.type === 'code' && canRun()) void runCell(cell)

    if (event.metaKey || event.ctrlKey) {
      if (cell.type === 'markdown') { editingIndex = -1; paint() }
      return
    }
    if (event.altKey) { addCell(at + 1); return }
    if (cell.type === 'markdown') editingIndex = -1
    if (at === cells.length - 1 && editable()) { addCell(at + 1); return }
    paint()
    if (enter && at + 1 < cells.length) focusCell(at + 1)
    else select(Math.min(at + 1, cells.length - 1), { scroll: true })
  }

  /** Fold a cell's source or its outputs away, and write it down. Folding is
   *  a property of the notebook, not of this window — it is what
   *  `jupyter.source_hidden` is for, and it is why a notebook shared with a
   *  fifty-line setup cell at the top arrives with it already shut. */
  function toggleHidden (cell, which) {
    if (!cell) return
    if (which === 'source' && !cell.source) return
    if (which === 'outputs' && !cell.outputs.length) return
    const now = which === 'source' ? sourceHidden(cell) : outputsHidden(cell)
    change(() => {
      setHidden(cell, which, !now)
      if (which === 'source' && !now) editingIndex = -1
    }, { needs: 'open' })
  }

  /* ------------------------------------------------------- the command keys

     A notebook has two modes and always has: the caret is in a cell, or it is
     not and the keyboard is talking about cells. This half was missing
     entirely — Escape handed the keys to a scroller that listened for nothing,
     so moving between cells, adding one or deleting one all needed a mouse.

     The letters are Jupyter's, because a notebook is a thing people arrive at
     already knowing how to drive.
     ================================================================== */

  /* `d` twice deletes, and only when the two are close enough together to be
     one gesture. A `d` on its own does nothing, which is the point: delete is
     the one command here that throws work away, and it is worth two keys. */
  let lastD = 0
  const DOUBLE_KEY_MS = 700

  function commandKey (event) {
    if (!current) return
    // Typing goes to whatever is being typed into, not here.
    const target = event.target
    if (target !== scroller && (target?.closest?.('textarea, input, select, [contenteditable]'))) return
    if (event.metaKey || event.ctrlKey) {
      /* ⌘⏎ and its friends still run from out here — they are the same three
         gestures as inside a cell, and a reader who has just pressed Escape
         has not stopped wanting to run things. Everything else with a
         modifier belongs to the window. */
      if (event.key !== 'Enter') return
    }

    const at = atCell()
    const cell = cells[at]
    const key = event.key
    const took = () => { event.preventDefault(); event.stopPropagation() }

    /* The first arrow key chooses rather than moves. Otherwise a notebook
       nothing has been clicked in answers ↓ by jumping to the second cell,
       having silently decided the first one was already where you were. */
    const step = (by) => { took(); select(selected < 0 ? at : at + by, { scroll: true }) }
    if (key === 'ArrowDown' || key === 'j') { step(1); return }
    if (key === 'ArrowUp' || key === 'k') { step(-1); return }
    if (key === 'Home' && !event.shiftKey) { took(); select(0, { scroll: true }); return }
    if (key === 'End' && !event.shiftKey) { took(); select(cells.length - 1, { scroll: true }); return }

    if (key === 'Enter') {
      took()
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
        runFromCell(cell, at, event)
        return
      }
      // Plain Return is the way in, which is the one thing Escape needs.
      if (!editable()) return
      if (cell?.type === 'markdown') { editingIndex = at; paint() }
      focusCell(at)
      return
    }

    if (key === 'o') { took(); toggleHidden(cell, 'outputs'); return }
    if (key === 'O') { took(); toggleHidden(cell, 'source'); return }

    if (!editable()) return

    if (key === 'a') { took(); addCell(at); return }
    if (key === 'b') { took(); addCell(at + 1); return }
    if (key === 'm') { took(); setCellType(at, 'markdown'); return }
    if (key === 'y') { took(); setCellType(at, 'code'); return }
    if (key === 'r') { took(); setCellType(at, 'raw'); return }
    if (key === 'c') { took(); copyCells([at]); return }
    if (key === 'x') { took(); cutCell(at); return }
    if (key === 'v') { took(); pasteCells(at + 1); return }
    if (key === 'V') { took(); pasteCells(at); return }
    if (key === 'D') { took(); duplicateCell(at); return }
    if (key === 'd') {
      took()
      const now = Date.now()
      if (now - lastD < DOUBLE_KEY_MS) { lastD = 0; deleteCell(at) } else lastD = now
    }
  }

  scroller.addEventListener('keydown', commandKey)

  /* Clicking anywhere in a cell is choosing it — including the outputs and the
     prose, which is where a reader's mouse actually is. Listened for on the
     column rather than per cell, so a repaint cannot lose it. */
  column.addEventListener('mousedown', (event) => {
    const section = event.target?.closest?.('.nb-cell')
    if (!section || !column.contains(section)) return
    const index = sectionIndex(section)
    if (index >= 0) select(index)

    /* And the keyboard follows the click. Clicking a cell's output or its
       prose leaves focus wherever it was — often on nothing — so the command
       keys, which listen on the scroller, never heard a thing: choosing a cell
       with the mouse and then pressing ↓ did nothing at all. Not for a click
       that has its own target for the keys, which is every control and the
       textarea itself. */
    if (!event.target?.closest?.('textarea, input, select, button, a, [contenteditable]')) {
      scroller.focus({ preventScroll: true })
    }
  })

  /* ---------------------------------------------------------- dragging

     Moving a cell was ±1 per click, so putting one fifteen places up meant
     fifteen clicks and fifteen full repaints of the notebook. A drag is the
     gesture that means "put this there", and the only thing it needs is a line
     showing where "there" is.
     ================================================================== */

  let dragFrom = -1
  let dropAt = -1

  function endDrag () {
    dragFrom = -1
    dropAt = -1
    for (const section of column.children) {
      section.classList?.remove('is-drop-before', 'is-drop-after')
    }
  }

  /** Which gap in the list the pointer is over — the index the cell would take,
   *  read against the list as it is now. */
  function dropTarget (event) {
    const section = event.target?.closest?.('.nb-cell')
    if (!section || !column.contains(section)) return -1
    const index = sectionIndex(section)
    if (index < 0) return -1
    const box = section.getBoundingClientRect()
    return event.clientY < box.top + box.height / 2 ? index : index + 1
  }

  column.addEventListener('dragover', (event) => {
    if (dragFrom < 0) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const at = dropTarget(event)
    if (at < 0 || at === dropAt) return
    dropAt = at
    for (const section of column.children) {
      section.classList?.remove('is-drop-before', 'is-drop-after')
    }
    /* The line goes under the last cell when the drop is past the end, because
       there is no cell below it to draw it above. */
    if (at < column.children.length) column.children[at]?.classList.add('is-drop-before')
    else column.children[column.children.length - 1]?.classList.add('is-drop-after')
  })

  column.addEventListener('drop', (event) => {
    if (dragFrom < 0) return
    event.preventDefault()
    const at = dropTarget(event)
    const from = dragFrom
    endDrag()
    if (at >= 0) moveCellTo(from, at)
  })

  column.addEventListener('dragleave', (event) => {
    if (dragFrom < 0 || column.contains(event.relatedTarget)) return
    dropAt = -1
    for (const section of column.children) {
      section.classList?.remove('is-drop-before', 'is-drop-after')
    }
  })

  /* ------------------------------------------------------------- painting */

  /* Which kernel is *running*, when one is — the file's `kernelspec` is what
     the notebook asked for, and those are different facts the moment a notebook
     written elsewhere is opened here. */
  const kernelChosen = () => kernelInfo?.name || shell?.metadata?.kernelspec?.name || ''
  const kernelNamed = () => kernelInfo?.kernel || shell?.metadata?.kernelspec?.display_name || ''
  /* What the spec says the kernel speaks, which is not always what the cells
     are coloured as: `language` comes from `language_info` too, and that is
     written by whichever kernel last ran the file. The spec wins when there is
     one, because the mark stands beside the kernel's name. */
  const kernelLanguage = () =>
    kernelSpecs?.find((spec) => spec.name === kernelChosen())?.language ||
    shell?.metadata?.kernelspec?.language ||
    language

  /* The mark a language wears on a fenced block, at the size the bar's text
     wants. `label: false` because the kernel's name is already beside it — a
     chip spelling out "Python" next to "Python 3 (ipykernel)" says it twice. */
  function languageMark (token) {
    const mark = token ? languageChip(token, { label: false }) : null
    mark?.classList.add('nb-kernel-mark')
    return mark
  }

  /**
   * The kernel: a menu where one can be chosen, the name on its own where it
   * cannot. Every entry wears its own language's mark, so the list is scannable
   * by shape rather than by reading a column of near-identical names.
   */
  function paintKernelPick () {
    const chosen = kernelChosen()
    const named = kernelNamed()

    if (!canRun()) {
      kernelName.textContent = named
      const mark = languageMark(kernelLanguage())
      kernelSlot.replaceChildren(...(named ? [mark, kernelName].filter(Boolean) : []))
      return
    }
    /* Until the specs arrive there is one entry — the one this notebook is
       already on — so the menu opens saying something true rather than empty. */
    const listed = kernelSpecs?.length
      ? kernelSpecs.map((spec) => ({
          value: spec.name,
          label: spec.displayName || spec.name,
          icon: () => languageMark(spec.language)
        }))
      : (chosen
          ? [{ value: chosen, label: named || chosen, icon: () => languageMark(kernelLanguage()) }]
          : [])
    kernelPick.set(listed, chosen)
    kernelSlot.replaceChildren(kernelPick.root)
  }

  /**
   * What the kernel is, in a word and in a colour.
   *
   * The colour answers "can I run something right now", which is the question
   * the dot is glanced at for — so a kernel that is up is green whether it is
   * sitting idle or part-way through a cell, and everything before it is up is
   * amber. Red is the notice, the same fact the summary already turns red for:
   * a kernel that would not start, or one the file asked for and did not get.
   *
   * A notebook that cannot run at all — no kernel bridge, or a read-only
   * window — has no state and no dot, rather than a grey one standing for
   * nothing.
   *
   * The word is not drawn any more — three colours are the whole of what the
   * dot has to say, and "idle" spelled out beside a green light is the label
   * on a light that is already lit. It is still carried, because a colour is
   * not readable by everyone or by anything: it becomes the dot's tooltip and
   * its accessible name.
   */
  function kernelState () {
    if (!canRun()) return { tone: '', text: '' }
    if (kernelInfo) return { tone: kernelNotice ? 'error' : 'ready', text: anyRunning() ? 'busy' : 'idle' }
    if (kernelNotice) return { tone: 'error', text: 'no kernel' }
    return { tone: 'waiting', text: kernelStarting ? 'starting…' : 'not started' }
  }

  function paintBar () {
    const state = kernelState()
    paintKernelPick()
    /* No class at all when there is nothing to show, so the bar's own
       `:empty` rule takes the dot out along with its spacing — an element
       that is only ever a coloured disc has no text to go empty. */
    stateText.className = state.tone ? `nb-shape-state is-${state.tone}` : ''
    /* The notice when there is one: it is the longer answer to the same
       question, and the dot is what a reader points at to ask it. */
    stateText.title = kernelNotice || state.text
    stateText.setAttribute('aria-label', `Kernel: ${kernelNotice || state.text}`)
    barShape.title = kernelNotice || ''
    barShape.classList.toggle('is-notice', !!kernelNotice)

    barActions.replaceChildren()

    if (canRun()) {
      const runAllBtn = el('button', 'nb-btn', 'Run all')
      runAllBtn.type = 'button'
      runAllBtn.title = 'Run every code cell, top to bottom'
      runAllBtn.disabled = anyRunning()
      runAllBtn.addEventListener('click', () => { runAll() })
      barActions.append(runAllBtn)

      /* The rest of the run commands, behind one control rather than four
         buttons. Run all is the one anybody presses without thinking, so it
         stays a button; these are the ones you press having decided
         something. */
      runPick.set([
        { value: 'above', label: 'Run all above' },
        { value: 'below', label: 'Run all below' },
        { value: 'restart-all', label: 'Restart and run all' }
      ], '')
      barActions.append(runPick.root)

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

      /* How far through a Run all is. A disabled button was the whole of what
         this said before, which tells a reader that something is happening and
         nothing whatever about what or for how much longer. */
      if (queueTotal) {
        const progress = el('span', 'nb-progress',
          `${Math.min(queueDone + 1, queueTotal)} of ${queueTotal}`)
        progress.setAttribute('role', 'status')
        progress.title = 'Which cell of the run this is'
        barActions.append(progress)
      }
    }

    // Adding a cell changes the notebook's shape, which is the line Reading
    // view draws.
    if (editable()) {
      const add = el('button', 'nb-btn', 'Add cell')
      add.type = 'button'
      add.addEventListener('click', () => addCell(cells.length))
      barActions.append(add)
    }

    /* Clearing sits on the running side of that line, not the editing side. An
       output is not part of the notebook the way a cell is — it is what the
       last run printed, and whoever can start a run can throw away what the
       last one left. It stays offered without a kernel too, so a notebook full
       of somebody else's output can be emptied on a machine that cannot run
       a line of it. */
    if ((canRun() || editable()) && cells.some((cell) => cell.outputs.length)) {
      const clear = el('button', 'nb-btn', 'Clear all outputs')
      clear.type = 'button'
      clear.title = 'Remove every recorded output from this notebook'
      clear.addEventListener('click', () => change(() => {
        for (const cell of cells) {
          cell.outputs = []
          cell.executionCount = null
          setCellDuration(cell, null, null)
        }
      }, { needs: 'run' }))
      barActions.append(clear)
    }

    if (current) {
      exportPick.set([
        { value: 'script', label: `Export as ${scriptSuffix().slice(1)}` },
        { value: 'html', label: 'Export as HTML' }
      ], '')
      barActions.append(exportPick.root)
    }
  }

  /* ------------------------------------------------------------ taking it out

     A notebook is a bad thing to hand to anyone without Jupyter and a worse
     thing to put under review. Both exports land beside the notebook, because
     that is where the reader will look for them and because it needs no file
     dialog to say so.
     ================================================================== */

  /* What a script of this notebook's language is called. `.py` for the common
     case, and the kernel's own extension where `language_info` names one —
     writing a Julia notebook out as `.py` would be a file that lies about
     itself in its name. */
  const SCRIPT_SUFFIX = {
    python: '.py', julia: '.jl', r: '.R', ruby: '.rb',
    javascript: '.js', typescript: '.ts', rust: '.rs', scala: '.scala', sql: '.sql'
  }
  const scriptSuffix = () =>
    cellText(shell?.metadata?.language_info?.file_extension) ||
    SCRIPT_SUFFIX[notebookLanguage(shell)] || '.txt'

  async function exportAs (kind) {
    if (!current) return
    const base = current.path.replace(/\.ipynb$/i, '')
    const path = kind === 'html' ? `${base}.html` : `${base}${scriptSuffix()}`
    const text = kind === 'html'
      ? notebookToHtml(shell, cells, {
          title: base.split('/').pop() || 'Notebook',
          renderMarkdown: markdown?.render || null,
          sanitize: (markup) => sanitizeHtml(markup, () => null)
        })
      : notebookToScript(shell, cells)
    try {
      await file.write(path, text)
      notify(`Exported to ${path.split('/').pop()}`)
    } catch (err) {
      notify(err?.message || 'That notebook could not be exported.')
    }
  }

  /**
   * The notebook on screen.
   *
   * Every structural change comes through here — and so does ⇧⏎, which is the
   * key somebody holds down to read a notebook from the top. Rebuilding every
   * section for each of those meant setting every markdown cell's prose again,
   * KaTeX and all, and building every recorded plot, table and traceback in the
   * file again, for a change to one cell. On a few hundred cells that is the
   * window going quiet between one Return and the next.
   *
   * So a section is kept whenever nothing it was drawn from has changed — which
   * for adding, deleting, moving, folding, retyping or running one cell is
   * every section but one or two. What is rebuilt is what actually differs;
   * what has merely moved is told its new number by `place`.
   */
  function paint () {
    const at = scroller.scrollTop
    const was = drawnCells
    drawnCells = new Map()

    const built = []
    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index]
      const sig = signature(cell, index)
      const had = was.get(cell.key)
      if (had && unchanged(had.sig, sig)) {
        was.delete(cell.key)
        place(had.section, index)
        built.push(had.section)
        drawnCells.set(cell.key, had)
        continue
      }
      const section = drawCell(cell, index)
      built.push(section)
      drawnCells.set(cell.key, { section, sig })
    }
    /* Whatever is left is a section this paint has no use for — a cell that has
       gone, or one drawn again from scratch. Neither is owed a colouring. */
    for (const { section } of was.values()) forget(section)

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
    /* The ring, which `drawCell` draws on a section it built and a kept section
       is still wearing from last time. Either way `paintSelection` moves it to
       the one cell that should have it — but only once it has let go of a
       section that is no longer here. */
    if (atNode?.parentNode !== column) atNode = null
    paintSelection()
    paintBar()
    scroller.scrollTop = at
    // The cells the search was pointing at have just been rebuilt, and may not
    // be the same cells.
    refreshSearch()
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
      /* The top of the file. Not -1: a notebook you have just opened is a
         notebook the keyboard should already be able to walk down, and a
         command that has to be told where to start by a click first is a
         command nobody reaches for. */
      selected = 0
      history = []
      future = []
      search.value = ''
      hits = []
      hitAt = -1
      found.textContent = ''
      setDirty(false)

      /* The maths in this notebook, loaded before any of it is drawn: the
         renderer's markdown sets formulae synchronously, and a KaTeX that has
         not arrived yet is a notebook of `$\alpha$` as text.

         The prose and the `text/latex` outputs together, because both are set
         with it — a saved sympy result is as much maths as a formula somebody
         typed, and asking about only the prose left every reopened notebook
         showing its equations as source until something else needed KaTeX. */
      if (markdown?.prepare) {
        const maths = cells.flatMap((cell) => {
          if (cell.type === 'markdown') return [cell.source]
          return cell.outputs.map(outputLatex).filter(Boolean)
        })
        mathReady = await markdown.prepare(maths.join('\n\n')).catch(() => false)
        drawEpoch++
        if (current?.path !== path) return
      }

      paint()
      scroller.scrollTop = Number(place?.top) || 0
      onStatus()
    },

    save: saveFile,

    async close () {
      /* The last save this notebook will ever get: everything below throws the
         cells away. A full disk, a read-only vault or a volume that went away
         while the file was open all land here, and swallowing the error made
         the difference between "saved" and "silently discarded" invisible.
         Closing anyway is still right — refusing would strand the tab with no
         way out — but the reader is told which one happened. */
      const wrote = await saveFile({ flush: true }).then(() => true, (err) => {
        notify(`“${current?.path?.split('/').pop() || 'This notebook'}” could not be saved: ${err?.message || 'the write failed'}. Your changes were not written to disk.`)
        return false
      })
      if (!wrote && current) console.error('notebook close: save failed for', current.path)
      clearTimeout(saveTimer)
      saveTimer = null
      releaseKernel()
      hint.close()
      current = null
      shell = null
      cells = []
      history = []
      future = []
      editingIndex = -1
      selected = -1
      hits = []
      hitAt = -1
      search.value = ''
      found.textContent = ''
      latexAsked.clear()
      viewport?.disconnect()
      waitingToColour.clear()
      drawnCells = new Map()
      atNode = null
      column.replaceChildren()
      barActions.replaceChildren()
      stateText.className = ''
      stateText.removeAttribute('title')
      kernelSlot.replaceChildren()
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

    /**
     * The notebook moved — it was renamed, or dragged into another folder.
     *
     * Two things are filed under the path and neither was told: the file this
     * writes back to, and the kernel, which main keys by the notebook it
     * belongs to. Left alone, a rename mid-session meant the next save wrote
     * to a name that no longer exists, and the next Run started a second
     * kernel while the first sat there holding its memory under a name nothing
     * could interrupt or shut down again.
     */
    retarget (path) {
      if (!current || !path || path === current.path) return
      const from = current.path
      current.path = path
      kernel?.rename?.(from, path)?.catch?.(() => {})
    },

    focus () {
      /* The cell that was being typed into, not the first one that can be.
         Asking the column for a `.nb-input` answers with cell one every time,
         so coming back to a notebook from anywhere else — a tab, the file
         tree, the copilot — put the caret at the top of the file rather than
         where it was left. */
      const input = editingIndex >= 0
        ? column.children[editingIndex]?.querySelector('.nb-input')
        : null
      if (input) input.focus()
      /* Otherwise the scroller, which is where the command keys listen — so a
         notebook that comes back without a caret in it is still one the
         keyboard can drive. */
      else scroller.focus({ preventScroll: true })
    },

    place: () => ({ top: scroller.scrollTop }),
    dirty: () => dirty,

    /** ⌘F, routed here by the renderer while a notebook is the open document. */
    find () { search.focus(); search.select() },

    /** Running, for the window menu — the same things the bar offers, reachable
     *  from a keyboard shortcut rather than a click.
     *
     *  `cell` means the cell the notebook is at, which is not the same as the
     *  one being typed into: this read `editingIndex` and so did nothing at all
     *  in Reading view, where there are no textareas to have focused, and
     *  nothing after an Escape either. */
    run: {
      cell: () => {
        const cell = cells[atCell()]
        return cell ? runCell(cell) : Promise.resolve({ status: 'skipped' })
      },
      all: runAll,
      above: runAbove,
      below: runBelow,
      restartAll: restartAndRunAll,
      interrupt: interruptKernel,
      restart: restartKernel,
      busy: anyRunning
    },

    /** Taking the notebook out as something else — for the window menu, which
     *  is where an export belongs as much as a bar does. */
    exportAs,

    /** The window is going. Let go of the kernel and stop listening for what
     *  it says — this pane is mounted for the life of the window, so without
     *  this the process outlives everything that could show its output. */
    destroy () {
      releaseKernel()
      stopListening?.()
      viewport?.disconnect()
      waitingToColour.clear()
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
      const at = atCell()
      const text = cells.map((cell, index) => {
        /* Which cell the reader is on, and what each one is tagged. Both are
           things a model cannot see and both change the answer: "fix this" is
           about a cell, and a cell tagged `parameters` is one that is written
           over by whatever runs the notebook. */
        const marks = [
          `# %% [${index + 1}] ${cell.type}`,
          index === at ? '  ← the cell in view' : '',
          cellTags(cell).length ? `  tags: ${cellTags(cell).join(', ')}` : ''
        ].join('')
        return `${marks}\n${cell.source}`
      }).join('\n\n')
      return { text, cells: shape.cells, code: shape.code, language, at }
    }
  }
}
