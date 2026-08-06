/* ================================================================== csv
   Separated values, shown as the table they are.

   A `.csv` is the one thing the vault holds that is text on disk but not a
   document: opening it in the editor shows the quoting rather than the data,
   and quoting is exactly what nobody wants to read. So it gets a viewer of its
   own, in the same shape as the whiteboard's — `open`, `save`, `close`,
   `focus`, `place`, `dirty` — and the renderer treats it as one more kind of
   tab.

   Three things drive the design:

   - The file is the model. Edits go into the parsed rows and the rows are
     serialized back on save; nothing is kept about a cell that the file cannot
     say. A spreadsheet's worth of state — formats, formulas, merged cells —
     has nowhere to live in a CSV, so there is none here.

   - A data file is routinely enormous. A 200k-row export is a normal thing to
     be handed and a hopeless thing to put in the DOM, so only the rows in view
     are built. Everything below assumes a fixed row height, which is what
     makes the mapping from scroll position to row index exact rather than
     measured.

   - Sorting and filtering are ways of *looking* at the file, not edits to it.
     They live in `order`, a list of source row indices, and every read and
     write goes through it. Sorting a hundred-thousand-row export and saving
     must not rewrite all hundred thousand lines because you wanted to see the
     largest first — so it doesn't, and the one case where you did mean it
     (Apply sort) is a button that says so and can be undone.

   What the grid can do, beyond showing the file:

     sorting       click a heading; asc → desc → off, blanks last either way
     filtering     one box that highlights matches, or hides the rows without
     selection     a rectangle — drag, shift-click, shift-arrows, whole rows
                   and columns, and the sum/average of whatever is in it
     clipboard     copy, cut and paste a rectangle as TSV, which is what a
                   spreadsheet puts on the clipboard and expects back
     structure     insert and delete rows and columns, rename headings, resize
                   and auto-fit columns, fill down
     undo          every edit above, as patches rather than snapshots of a file
                   that may be a hundred megabytes
   ================================================================== */

import { dataDelimiter } from './vault-paths.js'

/* Fixed, and in one place, because the virtual window's arithmetic depends on
   it: scroll position divided by this is the first row to build. A row that
   could grow to fit its content would make that division a lie, which is why
   cells clip rather than wrap. */
const ROW_HEIGHT = 28

/* Rows built above and below the viewport, so a fast scroll has something
   already there instead of a band of blank. */
const OVERSCAN = 8

const MIN_COL = 72
const MAX_COL = 420
/* The frozen strip of row numbers down the left. Part of the row's width, so
   the canvas is wide enough for it, and `position: sticky` inside the row is
   what keeps it against the left edge while the rest scrolls under it. */
const GUTTER = 58
/* Columns are sized from the widest cell in a sample rather than in the whole
   file: measuring a million cells to pick a width is time spent before the
   first row is on screen, and the first few hundred rows are what the width
   has to suit anyway. */
const WIDTH_SAMPLE = 250
const CHAR_WIDTH = 7.4
const CELL_PADDING = 18

/* Undo depth. Cell edits are patches and cost nothing to keep; the structural
   ones carry a shallow copy of the row list, which on a large file is real
   memory, so far fewer of those are kept. */
const HISTORY_LIMIT = 250
const SNAPSHOT_LIMIT = 30

/* Above this many cells the selection is summed lazily — never, in practice.
   Selecting a whole million-cell column to see its total is a fair thing to
   ask; recomputing it on every extra keystroke of a shift-arrow is not. */
const STATS_LIMIT = 400000

/* ------------------------------------------------------------- the format */

/**
 * Rows of fields, from separated text.
 *
 * RFC 4180 with the leniencies every real file needs: either line ending, a
 * final newline or not, and a doubled `""` inside a quoted field standing for
 * one quote. A quote appearing in the middle of an unquoted field is data —
 * spreadsheets write that and refusing it would mean refusing the file.
 *
 * Written as one pass over the characters rather than a split-and-repair,
 * because a delimiter or a newline *inside* quotes is the ordinary case in
 * exported data, and splitting on either first is what gets that wrong.
 */
export function parseSeparated (text, delimiter = ',') {
  // A byte-order mark is not part of the first heading.
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let started = false

  const endField = () => { row.push(field); field = ''; started = true }
  const endRow = () => { endField(); rows.push(row); row = []; started = false }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]

    if (quoted) {
      if (ch !== '"') { field += ch; continue }
      // `""` is one quote; a lone quote ends the quoted run.
      if (source[i + 1] === '"') { field += '"'; i++; continue }
      quoted = false
      continue
    }

    if (ch === '"' && field === '') { quoted = true; started = true; continue }
    if (ch === delimiter) { endField(); continue }
    if (ch === '\r') {
      // Swallow the LF of a CRLF; a bare CR is still a line ending.
      if (source[i + 1] === '\n') i++
      endRow()
      continue
    }
    if (ch === '\n') { endRow(); continue }
    field += ch
    started = true
  }

  /* Whatever is left is a final row without a line ending. A file that *did*
     end with one leaves nothing behind, and must not gain a blank row for it —
     which is the difference between a table of 100 rows and one of 101 whose
     last is empty. */
  if (started || field !== '' || row.length) endRow()

  return rows
}

/** Whether a field has to be quoted to survive the round trip. Leading and
 *  trailing spaces are included: readers differ on whether they keep them, and
 *  quoting is the only way to say the space is data. */
const needsQuotes = (value, delimiter) =>
  value.includes(delimiter) || value.includes('"') ||
  value.includes('\n') || value.includes('\r') ||
  value !== value.trim()

const quoteField = (value, delimiter) =>
  needsQuotes(value, delimiter) ? `"${value.replace(/"/g, '""')}"` : value

/**
 * Separated text, from rows of fields. The inverse of `parseSeparated` for
 * every file it can read.
 *
 * `newline` is the file's own, detected on open and handed back: a file
 * written with CRLF that came back LF is a diff against every line of it, from
 * an edit to one cell.
 */
export function formatSeparated (rows, delimiter = ',', newline = '\n') {
  const body = rows
    .map((row) => row.map((cell) => quoteField(String(cell ?? ''), delimiter)).join(delimiter))
    .join(newline)
  // A trailing newline, which is what every writer of these files emits.
  return rows.length ? body + newline : ''
}

/** The line ending the file already uses, so writing it back does not rewrite
 *  every line. Decided by the first ending in the file: a mixed file has to be
 *  normalised to something, and the one it opens with is the better guess. */
const detectNewline = (text) => {
  const at = String(text ?? '').indexOf('\n')
  return at > 0 && text[at - 1] === '\r' ? '\r\n' : '\n'
}

/* ------------------------------------------------------------ the reading

   What a cell *means*, which is not in the file: a CSV says `1,200` and
   `$1,200` and `(1,200)` and every one of them is the same number to the
   person who exported it. Sorting a column of prices alphabetically, or
   refusing to total a column because of its currency sign, is the failure this
   section exists to avoid. */

/**
 * A cell as a number, or NaN if it is not one.
 *
 * Thousands separators, a leading currency symbol, a trailing percent and
 * accounting's parenthesised negatives all read as the number they denote. A
 * percentage reads as what is written — `50%` is 50, not 0.5 — because the
 * column it is summed against is written the same way.
 */
export function numericValue (text) {
  let value = String(text ?? '').trim()
  if (!value) return NaN
  let sign = 1
  if (/^\(.*\)$/.test(value)) { sign = -1; value = value.slice(1, -1).trim() }
  value = value
    .replace(/^[+-]?[$£€¥₹]\s*/, (m) => (m.trim().startsWith('-') ? '-' : ''))
    .replace(/[\s,\u00A0’']/g, '')
    .replace(/%$/, '')
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return NaN
  return sign * Number(value)
}

/** A cell as a moment in time, or null. Deliberately narrow: only the two
 *  shapes that are unambiguously dates — ISO, and the slashed form — get
 *  parsed, because handing everything to `Date.parse` turns a product code
 *  into a year and sorts a column into nonsense. */
const dateValue = (text) => {
  const value = String(text ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value) && !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value)) {
    return null
  }
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : at
}

/**
 * The order two cells belong in: numbers as numbers, dates as dates, and
 * everything else by the locale's own collation with digit runs compared as
 * quantities — so `item2` comes before `item10`.
 *
 * Numbers sort before text when a column holds both, which is the only stable
 * answer: it puts the data together and the stray label at one end, rather
 * than interleaving them by their spelling.
 */
export function compareCells (a, b) {
  const x = String(a ?? '')
  const y = String(b ?? '')
  if (x === y) return 0

  const nx = numericValue(x)
  const ny = numericValue(y)
  if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx === ny ? 0 : (nx < ny ? -1 : 1)
  if (!Number.isNaN(nx)) return -1
  if (!Number.isNaN(ny)) return 1

  const dx = dateValue(x)
  const dy = dateValue(y)
  if (dx !== null && dy !== null) return dx === dy ? 0 : (dx < dy ? -1 : 1)

  const spelled = x.localeCompare(y, undefined, { numeric: true, sensitivity: 'variant' })
  return spelled || (x < y ? -1 : 1)
}

/**
 * `base` reordered by one column.
 *
 * Blanks go last in both directions — a descending sort that opened with a
 * screen of empty cells would be answering a question nobody asked — and ties
 * keep the order they came in, so sorting by one column and then another
 * leaves the first sort as the tiebreak.
 *
 * @param rows  every row of the file, in file order
 * @param base  the view's current row indices — filtered or not
 * @param col   which column to sort on
 * @param dir   'asc' or 'desc'
 */
export function sortedOrder (rows, base, col, dir) {
  const sign = dir === 'desc' ? -1 : 1
  const keyed = base.map((index, at) => ({ index, at, text: String(rows[index]?.[col] ?? '') }))
  keyed.sort((p, q) => {
    const pe = p.text.trim() === ''
    const qe = q.text.trim() === ''
    if (pe || qe) return pe && qe ? p.at - q.at : (pe ? 1 : -1)
    return sign * compareCells(p.text, q.text) || p.at - q.at
  })
  return keyed.map((k) => k.index)
}

/** The rows of `base` holding `query` anywhere in them, case-insensitively. An
 *  empty query is every row: the filter box being empty is not a filter. */
export function filterOrder (rows, base, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (!needle) return base.slice()
  return base.filter((index) => {
    const row = rows[index] || []
    for (const cell of row) {
      if (String(cell ?? '').toLowerCase().includes(needle)) return true
    }
    return false
  })
}

/**
 * What the status strip says about a selection: how much is in it, and — for
 * the cells that are numbers — the total, the mean and the range. The
 * spreadsheet's one genuinely irreplaceable readout.
 */
export function selectionStats (values) {
  let count = 0
  let filled = 0
  let numbers = 0
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    count++
    const text = String(value ?? '')
    if (!text.trim()) continue
    filled++
    const n = numericValue(text)
    if (Number.isNaN(n)) continue
    numbers++
    sum += n
    if (n < min) min = n
    if (n > max) max = n
  }
  return {
    count,
    filled,
    empty: count - filled,
    numbers,
    sum: numbers ? sum : 0,
    average: numbers ? sum / numbers : 0,
    min: numbers ? min : 0,
    max: numbers ? max : 0
  }
}

/** Two corners as the rectangle between them. */
export function normalRect (a, b) {
  return {
    r0: Math.min(a.r, b.r),
    r1: Math.max(a.r, b.r),
    c0: Math.min(a.c, b.c),
    c1: Math.max(a.c, b.c)
  }
}

/* --------------------------------------------------------- the clipboard

   Tab-separated, because that is what every spreadsheet puts on the clipboard
   and the only thing all of them read back. A cell holding a tab or a newline
   is quoted the same way the file quotes one, which is what Excel and Numbers
   and Sheets all do with theirs. */

export function gridToClipboard (grid) {
  return grid
    .map((row) => row
      .map((cell) => {
        const value = String(cell ?? '')
        return /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
      })
      .join('\t'))
    .join('\n')
}

/**
 * Clipboard text as a grid. Tabs win where there are any — that is a
 * spreadsheet's copy — and commas are read as a delimiter only in their
 * absence, which is what makes pasting a snippet of CSV work.
 */
export function parseClipboardGrid (text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (!source) return [['']]
  const delimiter = source.includes('\t') ? '\t' : (source.includes(',') ? ',' : '\t')
  const grid = parseSeparated(source, delimiter)
  return grid.length ? grid : [['']]
}

/* --------------------------------------------------------------- the grid */

const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 })
const showNumber = (n) => (Number.isFinite(n) ? NUMBER_FORMAT.format(n) : '—')

/**
 * Mount the grid into `host`. One instance for the life of the window; `open`
 * points it at a file and `close` lets go of one.
 *
 * @param file       the renderer's `api.file` — `read` and `write`
 * @param onDirty    told whenever the unsaved state changes
 * @param onSaved    told when a save lands clean
 * @param onStatus   told when something worth a line of status happened
 */
export function mountCsv ({ host, file, onDirty, onSaved, onStatus = () => {} }) {
  const frame = document.createElement('div')
  frame.className = 'csv-frame'

  /* ------------------------------------------------------------- the bar */

  const bar = document.createElement('div')
  bar.className = 'csv-bar'

  const search = document.createElement('input')
  search.className = 'csv-search'
  search.type = 'search'
  search.placeholder = 'Find in table'
  search.spellcheck = false

  const filterToggle = button('Hide other rows', 'filter', 'Show only the rows that match')
  filterToggle.classList.add('csv-toggle')
  const found = document.createElement('span')
  found.className = 'csv-found'

  const stats = document.createElement('span')
  stats.className = 'csv-stats'

  const sortChip = button('Apply sort to file', 'apply-sort', 'Write the rows in this order — undoable, and saved')
  sortChip.hidden = true
  const clearSort = button('Clear sort', 'clear-sort', 'Back to the file’s own order')
  clearSort.hidden = true

  const undoBtn = button('↶', 'undo', 'Undo (⌘Z)')
  const redoBtn = button('↷', 'redo', 'Redo (⇧⌘Z)')
  const addRow = button('+ Row', 'add-row', 'Add a row below the cursor (⌘⏎)')
  const addCol = button('+ Column', 'add-col', 'Add a column after this one')

  const gap = document.createElement('span')
  gap.className = 'csv-bar-gap'

  bar.append(search, filterToggle, found, sortChip, clearSort, gap, stats,
    undoBtn, redoBtn, addRow, addCol)

  function button (label, act, title) {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'csv-btn'
    element.dataset.act = act
    element.textContent = label
    element.title = title
    return element
  }

  /* ------------------------------------------------------------ the grid */

  const headRow = document.createElement('div')
  headRow.className = 'csv-head'

  const scroller = document.createElement('div')
  scroller.className = 'csv-scroller'
  /* In the tab order, because it is the grid: the keys that move the cursor
     are handled here, and a table only a mouse can reach is not one. */
  scroller.tabIndex = 0

  /* The full height of the table, whether or not those rows exist in the DOM —
     this is what gives the scrollbar its true size. The rows in view are
     positioned inside it. */
  const canvas = document.createElement('div')
  canvas.className = 'csv-canvas'
  const window_ = document.createElement('div')
  window_.className = 'csv-window'
  canvas.append(window_)
  scroller.append(canvas)

  const menu = document.createElement('div')
  menu.className = 'csv-menu'
  menu.hidden = true

  frame.append(bar, headRow, scroller, menu)
  host.replaceChildren(frame)

  let current = null          // { path, delimiter, newline }
  let rows = []               // the body: every row after the header
  let header = []
  let widths = []
  let numeric = []            // per column: does it read as numbers?
  /* The view. Every display position is an index into this, and every index in
     it is a row of `rows` — which stays in the file's own order throughout. */
  let order = []
  let sort = null             // { col, dir }
  let query = ''
  let filtering = false
  let dirty = false
  let saving = null
  let flushRequested = false
  let cursor = { r: 0, c: 0 } // view coordinates; -1 row means the header
  let anchor = { r: 0, c: 0 }
  let editing = null          // { r, c, input } while a cell is open
  let firstBuilt = -1
  let lastBuilt = -1
  let dragging = null         // 'cells' | 'rows' while a drag-select is on
  let history = []
  let future = []
  /* What the sort was before the click that may turn out to be a double one —
     see the heading's `dblclick`, which has to put back the sort its own first
     click performed. */
  let sortBeforeClick = null

  /* One command, two ways in.

     Cut, copy, paste, undo and redo can each arrive twice: once as the
     keystroke this file handles, and once as the window menu's item firing a
     DOM clipboard event or calling back through the renderer. Which of the two
     turns up depends on the platform's menu, so both are wired — and the
     second one is dropped. Without this, one ⌘V pastes twice.

     The suppression is one-directional on purpose. A keystroke always runs;
     it is the *other* path that stands down if a key just did the same thing.
     A guard that dropped any repeat inside the window would have swallowed
     every keystroke after the first of a held-down ⌘Z, which repeats every
     thirtieth of a second. */
  let lastKeyCommand = { name: '', at: 0 }
  const fromKey = (name, run) => {
    lastKeyCommand = { name, at: Date.now() }
    run()
  }
  const unlessKey = (name, run) => {
    if (lastKeyCommand.name === name && Date.now() - lastKeyCommand.at < 150) return
    run()
  }

  const columns = () => widths.length
  const viewRows = () => order.length
  const bodyWidth = () => widths.reduce((sum, w) => sum + w, GUTTER)
  const sourceOf = (r) => (r === -1 ? -1 : order[r] ?? -1)
  const plainOrder = () => !sort && !(filtering && query.trim())

  const setDirty = (next) => {
    if (dirty === next) return
    dirty = next
    onDirty(next)
  }

  /* ------------------------------------------------------------ measuring */

  const measure = () => {
    const count = Math.max(header.length, ...rows.slice(0, WIDTH_SAMPLE).map((r) => r.length), 1)
    widths = new Array(count).fill(MIN_COL)
    numeric = new Array(count).fill(false)
    const seen = new Array(count).fill(0)
    const numbers = new Array(count).fill(0)
    const consider = (row, body) => {
      for (let c = 0; c < count; c++) {
        const text = String(row[c] ?? '')
        const wanted = Math.min(MAX_COL, Math.max(MIN_COL, text.length * CHAR_WIDTH + CELL_PADDING))
        if (wanted > widths[c]) widths[c] = Math.round(wanted)
        if (!body || !text.trim()) continue
        seen[c]++
        if (!Number.isNaN(numericValue(text))) numbers[c]++
      }
    }
    consider(header, false)
    for (let i = 0; i < Math.min(rows.length, WIDTH_SAMPLE); i++) consider(rows[i], true)
    /* A column is a number column when nearly all of it is numbers — "nearly"
       because one `n/a` in a column of prices does not make it prose, and
       right-aligning the other nine hundred is what makes them readable. */
    for (let c = 0; c < count; c++) numeric[c] = seen[c] > 0 && numbers[c] / seen[c] >= 0.8
  }

  /** One column, as wide as its widest cell in the sample. Double-clicking the
   *  divider asks for this; so does the heading's menu. */
  const fitColumn = (c) => {
    let wanted = String(header[c] ?? '').length * CHAR_WIDTH + CELL_PADDING + 22
    const limit = Math.min(order.length, WIDTH_SAMPLE * 2)
    for (let i = 0; i < limit; i++) {
      const text = String(rows[order[i]]?.[c] ?? '')
      wanted = Math.max(wanted, text.length * CHAR_WIDTH + CELL_PADDING)
    }
    widths[c] = Math.round(Math.min(MAX_COL, Math.max(MIN_COL, wanted)))
    paint()
  }

  /* ------------------------------------------------------------- the view */

  /** Recompute `order` from the filter and the sort. Everything structural
   *  ends here, because both of them are functions of the rows. */
  const rebuildOrder = ({ keepSource = null } = {}) => {
    let next = rows.map((_, i) => i)
    if (filtering && query.trim()) next = filterOrder(rows, next, query)
    if (sort && sort.col < columns()) next = sortedOrder(rows, next, sort.col, sort.dir)
    order = next
    if (keepSource !== null) {
      const at = order.indexOf(keepSource)
      if (at >= 0) cursor = { ...cursor, r: at }
    }
    clampCursor()
  }

  const clampCursor = () => {
    const lastRow = viewRows() - 1
    const lastCol = Math.max(0, columns() - 1)
    cursor = {
      r: Math.max(-1, Math.min(lastRow, cursor.r)),
      c: Math.max(0, Math.min(lastCol, cursor.c))
    }
    anchor = {
      r: Math.max(-1, Math.min(lastRow, anchor.r)),
      c: Math.max(0, Math.min(lastCol, anchor.c))
    }
  }

  /* ------------------------------------------------------------- painting */

  const cellStyle = (element, c) => {
    element.style.width = `${widths[c]}px`
    element.style.minWidth = `${widths[c]}px`
  }

  const gutterCell = (label, r) => {
    const cell = document.createElement('div')
    cell.className = 'csv-gutter'
    cell.dataset.row = String(r)
    cell.textContent = label
    return cell
  }

  const paintHead = () => {
    const frag = document.createDocumentFragment()
    const corner = gutterCell('', -2)
    corner.classList.add('csv-corner')
    corner.title = 'Select the whole table (⌘A)'
    frag.append(corner)
    for (let c = 0; c < columns(); c++) {
      const cell = document.createElement('div')
      cell.className = 'csv-cell csv-th'
      if (numeric[c]) cell.classList.add('csv-num')
      cell.dataset.col = String(c)
      cell.dataset.row = '-1'
      cell.title = 'Click to sort · ⌘-click to select the column · double-click to rename'

      const label = document.createElement('span')
      label.className = 'csv-th-label'
      label.textContent = header[c] ?? ''
      const mark = document.createElement('span')
      mark.className = 'csv-sort'
      mark.textContent = sort && sort.col === c ? (sort.dir === 'asc' ? '▲' : '▼') : ''
      const grip = document.createElement('span')
      grip.className = 'csv-grip'
      grip.dataset.grip = String(c)
      grip.title = 'Drag to resize · double-click to fit'

      cell.append(label, mark, grip)
      cellStyle(cell, c)
      frag.append(cell)
    }
    headRow.replaceChildren(frag)
  }

  /* The heading strip cannot be `position: sticky` over a body whose rows do
     not all exist, so it is a second clipped strip kept level with the body by
     hand. Its own width is the pane's; the cells inside overflow it and are
     clipped, which is what makes this scroll rather than stretch. */
  const syncHeadScroll = () => { headRow.scrollLeft = scroller.scrollLeft }

  /** The rows that should exist right now, given where the scroller is. */
  const visibleRange = () => {
    const top = scroller.scrollTop
    const height = scroller.clientHeight || 400
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN)
    const last = Math.min(viewRows(), Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN)
    return { first, last }
  }

  const buildRow = (r) => {
    const line = document.createElement('div')
    /* Striped from the row's own index rather than from its position among the
       elements that happen to exist: with only the visible band built, a
       `:nth-child(even)` rule would make the stripes swap places every time
       the window scrolled past a row. */
    line.className = `csv-row${r % 2 ? ' is-odd' : ''}`
    line.dataset.row = String(r)
    line.style.top = `${r * ROW_HEIGHT}px`
    /* The file's own line number, not the view's: with a sort or a filter on,
       "row 4" has to keep meaning the fourth line of the file, or the number
       is decoration. */
    line.append(gutterCell(String(sourceOf(r) + 2), r))
    const source = rows[sourceOf(r)] || []
    for (let c = 0; c < columns(); c++) {
      const cell = document.createElement('div')
      cell.className = 'csv-cell'
      if (numeric[c]) cell.classList.add('csv-num')
      cell.dataset.row = String(r)
      cell.dataset.col = String(c)
      cell.textContent = source[c] ?? ''
      cellStyle(cell, c)
      line.append(cell)
    }
    return line
  }

  const paintRows = ({ force = false } = {}) => {
    const { first, last } = visibleRange()
    if (!force && first === firstBuilt && last === lastBuilt) return
    /* An open editor is a live element inside the band about to be replaced.
       Commit it first: rebuilding the DOM around a focused input drops both
       the focus and, on a scroll that outran the keystroke, the edit. */
    if (editing) commitEdit()
    firstBuilt = first
    lastBuilt = last
    const frag = document.createDocumentFragment()
    for (let r = first; r < last; r++) frag.append(buildRow(r))
    window_.replaceChildren(frag)
    window_.style.width = `${bodyWidth()}px`
    decorate()
  }

  const paint = () => {
    canvas.style.height = `${Math.max(viewRows() * ROW_HEIGHT, 1)}px`
    canvas.style.width = `${bodyWidth()}px`
    paintHead()
    paintRows({ force: true })
    paintBar()
  }

  /** Repaint one cell in place — what an edit needs, instead of rebuilding the
   *  band around it. */
  const repaintCell = (r, c) => {
    const selector = `.csv-cell[data-row="${r}"][data-col="${c}"]`
    const cell = r === -1 ? headRow.querySelector(selector) : window_.querySelector(selector)
    if (!cell || cell.querySelector('input')) return
    if (r === -1) {
      const label = cell.querySelector('.csv-th-label')
      if (label) label.textContent = header[c] ?? ''
      return
    }
    cell.textContent = rows[sourceOf(r)]?.[c] ?? ''
  }

  /* ---------------------------------------------------------- the selection

     One rectangle, from an anchor to the cursor. A whole column is that
     rectangle with the heading at one corner and the last row at the other,
     which is why `-1` is a row here rather than a special case. */

  const rect = () => normalRect(anchor, cursor)
  const singleCell = () => anchor.r === cursor.r && anchor.c === cursor.c

  /** Selection, cursor and search-match classes over whatever is built. Cheap
   *  because only the visible band exists to walk. */
  function decorate () {
    const box = rect()
    const needle = query.trim().toLowerCase()
    for (const cell of frame.querySelectorAll('.csv-cell')) {
      const r = Number(cell.dataset.row)
      const c = Number(cell.dataset.col)
      const inside = r >= box.r0 && r <= box.r1 && c >= box.c0 && c <= box.c1
      const isCursor = r === cursor.r && c === cursor.c
      cell.classList.toggle('is-sel', inside && !isCursor)
      cell.classList.toggle('is-cursor', isCursor)
      cell.classList.toggle('is-match',
        !!needle && !filtering && cell.textContent.toLowerCase().includes(needle))
    }
    for (const cell of frame.querySelectorAll('.csv-gutter')) {
      const r = Number(cell.dataset.row)
      cell.classList.toggle('is-active', r >= box.r0 && r <= box.r1)
    }
    for (const cell of headRow.querySelectorAll('.csv-th')) {
      const c = Number(cell.dataset.col)
      cell.classList.toggle('is-active', c >= box.c0 && c <= box.c1)
    }
    paintStats()
  }

  /** Every value in the selection, row by row. The header counts as a row when
   *  the selection reaches it, so copying a column copies its name. */
  const rectValues = () => {
    const box = rect()
    const grid = []
    for (let r = box.r0; r <= box.r1; r++) {
      const line = []
      for (let c = box.c0; c <= box.c1; c++) line.push(valueAt(r, c))
      grid.push(line)
    }
    return grid
  }

  const paintStats = () => {
    const box = rect()
    const wide = box.c1 - box.c0 + 1
    const tall = box.r1 - box.r0 + 1
    if (singleCell()) { stats.textContent = ''; return }
    if (wide * tall > STATS_LIMIT) {
      stats.textContent = `${tall.toLocaleString()} × ${wide}`
      return
    }
    const summary = selectionStats(rectValues().flat())
    const parts = [`${tall.toLocaleString()} × ${wide}`]
    if (summary.numbers > 1) {
      parts.push(`sum ${showNumber(summary.sum)}`)
      parts.push(`avg ${showNumber(summary.average)}`)
      parts.push(`min ${showNumber(summary.min)}`)
      parts.push(`max ${showNumber(summary.max)}`)
    } else if (summary.numbers === 1) {
      parts.push(`sum ${showNumber(summary.sum)}`)
    }
    if (summary.empty) parts.push(`${summary.empty.toLocaleString()} empty`)
    stats.textContent = parts.join(' · ')
  }

  const paintBar = () => {
    const active = !!query.trim()
    filterToggle.classList.toggle('is-on', filtering)
    filterToggle.disabled = !active && !filtering
    sortChip.hidden = !sort
    clearSort.hidden = !sort
    undoBtn.disabled = !history.length
    redoBtn.disabled = !future.length
    if (!active) {
      found.textContent = ''
    } else if (filtering) {
      found.textContent = `${viewRows().toLocaleString()} of ${rows.length.toLocaleString()} rows`
    } else {
      const hits = countMatches()
      found.textContent = hits ? `${hits.toLocaleString()} matching ${hits === 1 ? 'row' : 'rows'}` : 'no matches'
      found.classList.toggle('is-empty', !hits)
    }
    paintStats()
  }

  const countMatches = () => filterOrder(rows, rows.map((_, i) => i), query).length

  /* Bring the cursor into view, vertically by row arithmetic and horizontally
     by the column offsets — neither needs the cell to exist in the DOM, which
     is what lets ⌘↓ jump to row 400,000. */
  const revealCursor = () => {
    if (cursor.r >= 0) {
      const top = cursor.r * ROW_HEIGHT
      const height = scroller.clientHeight
      if (top < scroller.scrollTop) scroller.scrollTop = top
      else if (top + ROW_HEIGHT > scroller.scrollTop + height) {
        scroller.scrollTop = top + ROW_HEIGHT - height
      }
    }
    let left = GUTTER
    for (let c = 0; c < cursor.c; c++) left += widths[c]
    const width = widths[cursor.c] || MIN_COL
    // The frozen gutter covers the left edge, so "in view" starts after it.
    if (left - GUTTER < scroller.scrollLeft) scroller.scrollLeft = left - GUTTER
    else if (left + width > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = left + width - scroller.clientWidth
    }
  }

  /**
   * Put the cursor somewhere.
   *
   * @param extend  keep the anchor where it is — a shift-click or shift-arrow,
   *                which is what turns a cursor into a rectangle
   */
  const moveTo = (r, c, { extend = false } = {}) => {
    if (editing) commitEdit()
    cursor = {
      r: Math.max(-1, Math.min(viewRows() - 1, r)),
      c: Math.max(0, Math.min(columns() - 1, c))
    }
    if (!extend) anchor = { ...cursor }
    revealCursor()
    paintRows()
    decorate()
  }

  const selectAll = () => {
    anchor = { r: -1, c: 0 }
    cursor = { r: viewRows() - 1, c: Math.max(0, columns() - 1) }
    paintRows()
    decorate()
  }

  const selectColumn = (c) => {
    anchor = { r: -1, c }
    cursor = { r: Math.max(-1, viewRows() - 1), c }
    revealCursor()
    paintRows()
    decorate()
  }

  const selectRow = (r) => {
    anchor = { r, c: 0 }
    cursor = { r, c: Math.max(0, columns() - 1) }
    revealCursor()
    paintRows()
    decorate()
  }

  /* ------------------------------------------------------------- the file */

  const valueAt = (r, c) => (r === -1 ? header[c] : rows[sourceOf(r)]?.[c]) ?? ''

  /**
   * Write one cell, by *source* row — which is what every patch and every
   * undo entry is in terms of, because the view can be sorted out from under
   * one between an edit and its undo.
   *
   * Copy-on-write: the row is replaced rather than mutated, so a snapshot
   * taken before this still describes what the file looked like then. That is
   * the whole reason undo can afford to keep snapshots at all.
   */
  const writeSource = (src, c, value) => {
    if (src === -1) {
      if ((header[c] ?? '') === value && c < header.length) return false
      const next = header.slice()
      while (next.length <= c) next.push('')
      next[c] = value
      header = next
      return true
    }
    const row = rows[src]
    if (!row) return false
    if ((row[c] ?? '') === value && c < row.length) return false
    const next = row.slice()
    // Short rows are legal in these files; fill so the column lands in place.
    while (next.length <= c) next.push('')
    next[c] = value
    rows[src] = next
    return true
  }

  /* ------------------------------------------------------------- the undo

     Two kinds of entry. A cell patch is a list of before-and-afters and costs
     a few words; a snapshot is a shallow copy of the row list and costs one
     pointer per row, which on a large file is worth keeping few of. Structural
     changes — a column inserted, a thousand rows deleted — are the only ones
     that take a snapshot. */

  const snapshot = () => ({
    kind: 'snapshot',
    header: header.slice(),
    rows: rows.slice(),
    widths: widths.slice(),
    numeric: numeric.slice(),
    sort: sort && { ...sort },
    cursor: { ...cursor },
    anchor: { ...anchor }
  })

  const record = (patch) => {
    history.push(patch)
    future.length = 0
    if (history.length > HISTORY_LIMIT) history.shift()
    let snapshots = history.reduce((n, p) => n + (p.kind === 'snapshot' ? 1 : 0), 0)
    while (snapshots > SNAPSHOT_LIMIT) {
      const at = history.findIndex((p) => p.kind === 'snapshot')
      history.splice(at, 1)
      snapshots--
    }
    paintBar()
  }

  /** Apply a patch and hand back the one that undoes it. */
  const applyPatch = (patch) => {
    if (patch.kind === 'cells') {
      const inverse = {
        kind: 'cells',
        edits: patch.edits.map((e) => ({ src: e.src, c: e.c, before: e.after, after: e.before }))
      }
      for (const edit of patch.edits) writeSource(edit.src, edit.c, edit.before)
      rebuildOrder()
      paint()
      return inverse
    }
    const inverse = snapshot()
    header = patch.header.slice()
    rows = patch.rows.slice()
    widths = patch.widths.slice()
    numeric = patch.numeric.slice()
    sort = patch.sort && { ...patch.sort }
    cursor = { ...patch.cursor }
    anchor = { ...patch.anchor }
    rebuildOrder()
    paint()
    return inverse
  }

  const stepHistory = (redo) => {
    if (editing) commitEdit()
    const stack = redo ? future : history
    const patch = stack.pop()
    if (!patch) { onStatus(`Nothing to ${redo ? 'redo' : 'undo'}`); return false }
    const inverse = applyPatch(patch)
    ;(redo ? history : future).push(inverse)
    setDirty(true)
    queueSave()
    revealCursor()
    paintBar()
    return true
  }

  /* ------------------------------------------------------------- editing */

  function beginEdit (seed = null) {
    if (editing) commitEdit()
    if (cursor.r >= 0 && !rows[sourceOf(cursor.r)]) return
    const selector = `.csv-cell[data-row="${cursor.r}"][data-col="${cursor.c}"]`
    const cell = cursor.r === -1 ? headRow.querySelector(selector) : window_.querySelector(selector)
    if (!cell) return
    const input = document.createElement('input')
    input.className = 'csv-input'
    input.value = seed === null ? valueAt(cursor.r, cursor.c) : seed
    cell.replaceChildren(input)
    editing = { r: cursor.r, c: cursor.c, input }
    input.focus()
    if (seed === null) input.select()
    else input.setSelectionRange(input.value.length, input.value.length)
  }

  /** Take what is in the open editor, if anything is open. Safe to call at any
   *  time — closing, scrolling and moving all do. */
  function commitEdit ({ cancel = false } = {}) {
    if (!editing) return
    const { r, c, input } = editing
    const value = input.value
    const src = sourceOf(r)
    editing = null
    /* The field goes before the cell is repainted, not after. `repaintCell`
       refuses to write over a cell with an editor in it — which is right for
       every other cell, and exactly wrong for this one: leaving it in place
       made the guard fire on the cell being committed, so an edited cell
       showed blank until something else rebuilt the row. */
    input.remove()
    if (!cancel) {
      const before = valueAt(r, c)
      if (writeSource(src, c, value)) {
        record({ kind: 'cells', edits: [{ src, c, before, after: value }] })
        setDirty(true)
        /* A sorted column whose cell just changed has moved that row. Rebuild
           the view and follow the row rather than the position: the cursor
           belongs to the thing that was edited. */
        if (sort && sort.col === c) { rebuildOrder({ keepSource: src }); paint() }
      }
    }
    /* A heading's cell holds its label, its sort mark and its resize grip, and
       the editor replaced all three. Rebuilding the strip is cheaper than
       reassembling one cell by hand, and there are only ever a few columns. */
    if (r === -1) paintHead()
    else repaintCell(r, c)
    decorate()
    if (!cancel) queueSave()
  }

  /* --------------------------------------------------------------- saving */

  let saveTimer = null
  const queueSave = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveFile().catch(() => {}) }, 900)
  }

  const saveFile = async ({ flush = false } = {}) => {
    if (flush) flushRequested = true
    if (saving) return saving
    saving = (async () => {
      do {
        if (editing) commitEdit()
        if (!current || !dirty) break
        clearTimeout(saveTimer)
        /* `rows` and not the view: a sort is a way of looking at the file, and
           saving one must not rewrite every line of it. */
        const text = formatSeparated([header, ...rows], current.delimiter, current.newline)
        await file.write(current.path, text)
        setDirty(false)
        onSaved()
      } while (flushRequested && dirty)
      flushRequested = false
      return true
    })()
    try { return await saving } finally { saving = null }
  }

  /* --------------------------------------------------------- the structure */

  const blankRow = () => new Array(Math.max(1, columns())).fill('')

  const insertRows = (atView, count = 1) => {
    record(snapshot())
    const made = Array.from({ length: count }, blankRow)
    if (plainOrder()) {
      const at = Math.max(0, Math.min(rows.length, atView))
      rows.splice(at, 0, ...made)
      rebuildOrder()
      cursor = { r: at, c: cursor.c }
    } else {
      /* Sorted or filtered, a new row has no place in the file's order to be
         born into, so it goes at the end of the file and where you asked for
         it on screen — and stays there until the next re-sort. */
      const start = rows.length
      rows.push(...made)
      order.splice(Math.max(0, Math.min(order.length, atView)), 0,
        ...made.map((_, i) => start + i))
      cursor = { r: atView, c: cursor.c }
    }
    anchor = { ...cursor }
    setDirty(true)
    paint()
    revealCursor()
    queueSave()
  }

  const deleteRows = (fromView, toView) => {
    const first = Math.max(0, Math.min(fromView, toView))
    const last = Math.min(viewRows() - 1, Math.max(fromView, toView))
    if (last < first || !viewRows()) return
    record(snapshot())
    const kill = new Set()
    for (let r = first; r <= last; r++) kill.add(order[r])
    rows = rows.filter((_, i) => !kill.has(i))
    rebuildOrder()
    cursor = { r: Math.min(first, viewRows() - 1), c: cursor.c }
    anchor = { ...cursor }
    clampCursor()
    setDirty(true)
    paint()
    revealCursor()
    queueSave()
    onStatus(`Deleted ${kill.size.toLocaleString()} ${kill.size === 1 ? 'row' : 'rows'}`)
  }

  const insertColumn = (at) => {
    record(snapshot())
    const where = Math.max(0, Math.min(columns(), at))
    header = header.slice()
    while (header.length < where) header.push('')
    header.splice(where, 0, '')
    rows = rows.map((row) => {
      const next = row.slice()
      while (next.length < where) next.push('')
      next.splice(where, 0, '')
      return next
    })
    widths.splice(where, 0, MIN_COL)
    numeric.splice(where, 0, false)
    cursor = { r: cursor.r, c: where }
    anchor = { ...cursor }
    setDirty(true)
    paint()
    revealCursor()
    queueSave()
  }

  const deleteColumn = (at) => {
    if (columns() <= 1) { onStatus('A table keeps at least one column'); return }
    record(snapshot())
    header = header.slice()
    header.splice(at, 1)
    rows = rows.map((row) => {
      if (at >= row.length) return row
      const next = row.slice()
      next.splice(at, 1)
      return next
    })
    widths.splice(at, 1)
    numeric.splice(at, 1)
    if (sort) {
      if (sort.col === at) sort = null
      else if (sort.col > at) sort = { ...sort, col: sort.col - 1 }
    }
    clampCursor()
    anchor = { ...cursor }
    rebuildOrder()
    setDirty(true)
    paint()
    queueSave()
  }

  const duplicateRows = (fromView, toView) => {
    const first = Math.max(0, Math.min(fromView, toView))
    const last = Math.min(viewRows() - 1, Math.max(fromView, toView))
    if (last < first) return
    record(snapshot())
    const copies = []
    for (let r = first; r <= last; r++) copies.push((rows[order[r]] || []).slice())
    if (plainOrder()) {
      rows.splice(order[last] + 1, 0, ...copies)
      rebuildOrder()
    } else {
      const start = rows.length
      rows.push(...copies)
      order.splice(last + 1, 0, ...copies.map((_, i) => start + i))
    }
    cursor = { r: last + 1, c: cursor.c }
    anchor = { ...cursor }
    setDirty(true)
    paint()
    revealCursor()
    queueSave()
  }

  /* ---------------------------------------------------------- the sorting */

  const sortBy = (col, dir) => {
    const keep = sourceOf(cursor.r)
    sort = dir ? { col, dir } : null
    rebuildOrder({ keepSource: keep >= 0 ? keep : null })
    anchor = { ...cursor }
    paint()
    revealCursor()
  }

  /** The next state of a heading that was clicked: ascending, then descending,
   *  then back to the file's own order. */
  const cycleSort = (col) => {
    if (!sort || sort.col !== col) return sortBy(col, 'asc')
    if (sort.dir === 'asc') return sortBy(col, 'desc')
    return sortBy(col, null)
  }

  /** Make the sort real: write the rows in the order they are being shown in.
   *  The one destructive thing sorting can do, so it is a button and an undo
   *  entry rather than a side effect of looking. */
  const applySort = () => {
    if (!sort) return
    record(snapshot())
    // Over every row, not just the filtered ones: applying a sort must not
    // silently drop what the filter is hiding.
    const full = sortedOrder(rows, rows.map((_, i) => i), sort.col, sort.dir)
    const keep = sourceOf(cursor.r)
    const moved = new Map(full.map((src, at) => [src, at]))
    rows = full.map((i) => rows[i])
    sort = null
    if (keep >= 0 && moved.has(keep)) cursor = { ...cursor, r: moved.get(keep) }
    anchor = { ...cursor }
    rebuildOrder()
    setDirty(true)
    paint()
    revealCursor()
    queueSave()
    onStatus('Sort written into the file')
  }

  /* ------------------------------------------------------- the find box */

  const setQuery = (text, { rebuild = true } = {}) => {
    query = text
    if (rebuild && filtering) {
      const keep = sourceOf(cursor.r)
      rebuildOrder({ keepSource: keep >= 0 ? keep : null })
      paint()
    } else {
      paintBar()
      decorate()
    }
  }

  const toggleFilter = () => {
    filtering = !filtering
    const keep = sourceOf(cursor.r)
    rebuildOrder({ keepSource: keep >= 0 ? keep : null })
    anchor = { ...cursor }
    paint()
    revealCursor()
  }

  /** The next cell holding the query, wrapping once. Enter in the find box,
   *  and ⌘G is the same thing from the grid. */
  const findNext = (back = false) => {
    const needle = query.trim().toLowerCase()
    if (!needle || !viewRows()) return
    const total = viewRows() * columns()
    const at = Math.max(0, cursor.r) * columns() + cursor.c
    for (let step = 1; step <= total; step++) {
      const index = ((at + (back ? -step : step)) % total + total) % total
      const r = Math.floor(index / columns())
      const c = index % columns()
      if (String(valueAt(r, c)).toLowerCase().includes(needle)) {
        moveTo(r, c)
        scroller.focus({ preventScroll: true })
        return
      }
    }
    onStatus('No match')
  }

  /* ------------------------------------------------------- the clipboard */

  const copySelection = async ({ cut = false } = {}) => {
    const grid = rectValues()
    const text = gridToClipboard(grid)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* No clipboard permission is the one failure worth saying out loud: the
         alternative is a ⌘C that silently does nothing. */
      onStatus('Could not reach the clipboard')
      return
    }
    if (cut) clearSelection()
    else onStatus(`Copied ${grid.length.toLocaleString()} × ${grid[0]?.length || 0}`)
  }

  const clearSelection = () => {
    const box = rect()
    const edits = []
    for (let r = box.r0; r <= box.r1; r++) {
      const src = sourceOf(r)
      for (let c = box.c0; c <= box.c1; c++) {
        const before = valueAt(r, c)
        if (before === '') continue
        edits.push({ src, c, before, after: '' })
      }
    }
    if (!edits.length) return
    for (const edit of edits) writeSource(edit.src, edit.c, '')
    record({ kind: 'cells', edits })
    setDirty(true)
    if (sort) { rebuildOrder(); paint() } else paintRows({ force: true })
    decorate()
    queueSave()
  }

  /**
   * Paste a grid at the cursor, growing the table if it does not fit — which
   * is what a spreadsheet does and what makes pasting a fresh export into an
   * empty file work at all.
   */
  const pasteGrid = (grid) => {
    if (!grid.length) return
    const wide = Math.max(...grid.map((row) => row.length))
    const startRow = cursor.r
    const needRows = startRow === -1 ? grid.length - 1 : startRow + grid.length
    const needCols = cursor.c + wide
    const grows = needCols > columns() || needRows > viewRows()

    if (grows) record(snapshot())

    if (needCols > columns()) {
      while (header.length < needCols) header.push('')
      while (widths.length < needCols) { widths.push(MIN_COL); numeric.push(false) }
    }
    if (needRows > viewRows()) {
      const extra = needRows - viewRows()
      const start = rows.length
      for (let i = 0; i < extra; i++) rows.push(blankRow())
      for (let i = 0; i < extra; i++) order.push(start + i)
    }

    const edits = []
    for (let i = 0; i < grid.length; i++) {
      const r = startRow + i
      if (r >= viewRows()) break
      const src = sourceOf(r)
      for (let c = 0; c < grid[i].length; c++) {
        const col = cursor.c + c
        if (col >= columns()) break
        const before = valueAt(r, col)
        const after = String(grid[i][c] ?? '')
        if (before === after) continue
        edits.push({ src, c: col, before, after })
        writeSource(src, col, after)
      }
    }
    if (!grows && edits.length) record({ kind: 'cells', edits })
    if (edits.length || grows) setDirty(true)
    anchor = { r: startRow, c: cursor.c }
    cursor = {
      r: Math.min(viewRows() - 1, startRow + grid.length - 1),
      c: Math.min(columns() - 1, cursor.c + wide - 1)
    }
    if (sort) rebuildOrder()
    paint()
    revealCursor()
    queueSave()
  }

  const pasteFromClipboard = async () => {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      onStatus('Could not read the clipboard')
      return
    }
    if (!text) return
    pasteGrid(parseClipboardGrid(text))
  }

  /** ⌘D: the top row of the selection, copied over the rest of it. */
  const fillDown = () => {
    const box = rect()
    if (box.r1 <= box.r0) return
    const edits = []
    for (let c = box.c0; c <= box.c1; c++) {
      const value = valueAt(box.r0, c)
      for (let r = box.r0 + 1; r <= box.r1; r++) {
        const src = sourceOf(r)
        const before = valueAt(r, c)
        if (before === value) continue
        edits.push({ src, c, before, after: value })
        writeSource(src, c, value)
      }
    }
    if (!edits.length) return
    record({ kind: 'cells', edits })
    setDirty(true)
    if (sort) rebuildOrder()
    paint()
    queueSave()
  }

  /* ------------------------------------------------------- the right-click */

  const closeMenu = () => { menu.hidden = true; menu.replaceChildren() }

  const openMenu = (x, y, items) => {
    const frag = document.createDocumentFragment()
    for (const item of items) {
      if (item === '-') {
        const rule = document.createElement('div')
        rule.className = 'csv-menu-rule'
        frag.append(rule)
        continue
      }
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'csv-menu-item'
      row.textContent = item.label
      row.disabled = !!item.disabled
      row.addEventListener('click', () => { closeMenu(); item.run() })
      frag.append(row)
    }
    menu.replaceChildren(frag)
    menu.hidden = false
    const box = frame.getBoundingClientRect()
    const width = menu.offsetWidth || 200
    const height = menu.offsetHeight || 220
    menu.style.left = `${Math.min(x - box.left, box.width - width - 8)}px`
    menu.style.top = `${Math.min(y - box.top, box.height - height - 8)}px`
  }

  const cellMenu = (event, r, c) => {
    const box = rect()
    const many = box.r1 > box.r0
    openMenu(event.clientX, event.clientY, [
      { label: 'Copy', run: () => copySelection() },
      { label: 'Cut', run: () => copySelection({ cut: true }) },
      { label: 'Paste', run: () => pasteFromClipboard() },
      { label: 'Clear contents', run: () => clearSelection() },
      '-',
      { label: 'Insert row above', run: () => insertRows(Math.max(0, box.r0)) },
      { label: 'Insert row below', run: () => insertRows(Math.max(0, box.r1) + 1) },
      {
        label: many ? `Duplicate ${box.r1 - box.r0 + 1} rows` : 'Duplicate row',
        disabled: r < 0,
        run: () => duplicateRows(box.r0, box.r1)
      },
      {
        label: many ? `Delete ${box.r1 - box.r0 + 1} rows` : 'Delete row',
        disabled: r < 0,
        run: () => deleteRows(Math.max(0, box.r0), box.r1)
      },
      '-',
      { label: 'Insert column left', run: () => insertColumn(c) },
      { label: 'Insert column right', run: () => insertColumn(c + 1) },
      { label: 'Delete column', run: () => deleteColumn(c) },
      '-',
      { label: 'Select column', run: () => selectColumn(c) },
      { label: 'Select row', disabled: r < 0, run: () => selectRow(r) },
      { label: 'Fill down', disabled: !many, run: () => fillDown() }
    ])
  }

  const headMenu = (event, c) => {
    openMenu(event.clientX, event.clientY, [
      { label: 'Sort A → Z', run: () => sortBy(c, 'asc') },
      { label: 'Sort Z → A', run: () => sortBy(c, 'desc') },
      { label: 'Clear sort', disabled: !sort, run: () => sortBy(c, null) },
      { label: 'Write this order into the file', disabled: !sort, run: () => applySort() },
      '-',
      { label: 'Rename heading', run: () => { moveTo(-1, c); beginEdit() } },
      { label: 'Fit column width', run: () => fitColumn(c) },
      { label: 'Select column', run: () => selectColumn(c) },
      '-',
      { label: 'Insert column left', run: () => insertColumn(c) },
      { label: 'Insert column right', run: () => insertColumn(c + 1) },
      { label: 'Delete column', run: () => deleteColumn(c) }
    ])
  }

  /* ------------------------------------------------------------ resizing */

  let resize = null

  const startResize = (event, c) => {
    resize = { c, x: event.clientX, from: widths[c] }
    frame.classList.add('is-resizing')
    event.preventDefault()
  }

  const onResizeMove = (event) => {
    if (!resize) return
    const next = Math.round(Math.max(MIN_COL, Math.min(MAX_COL * 2,
      resize.from + (event.clientX - resize.x))))
    if (next === widths[resize.c]) return
    widths[resize.c] = next
    for (const cell of frame.querySelectorAll(`.csv-cell[data-col="${resize.c}"]`)) {
      cellStyle(cell, resize.c)
    }
    canvas.style.width = `${bodyWidth()}px`
    window_.style.width = `${bodyWidth()}px`
  }

  const endResize = () => {
    if (!resize) return
    resize = null
    frame.classList.remove('is-resizing')
  }

  /* ------------------------------------------------------------ the wiring */

  scroller.addEventListener('scroll', () => {
    syncHeadScroll()
    paintRows()
  }, { passive: true })

  bar.addEventListener('click', (event) => {
    const act = event.target.closest?.('.csv-btn')?.dataset.act
    switch (act) {
      case 'filter': toggleFilter(); break
      case 'apply-sort': applySort(); break
      case 'clear-sort': sortBy(sort?.col ?? 0, null); break
      case 'undo': stepHistory(false); break
      case 'redo': stepHistory(true); break
      case 'add-row': insertRows(Math.max(0, cursor.r) + 1); break
      case 'add-col': insertColumn(cursor.c + 1); break
      default: return
    }
    if (act !== 'filter') scroller.focus({ preventScroll: true })
  })

  search.addEventListener('input', () => setQuery(search.value))
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); findNext(event.shiftKey) }
    else if (event.key === 'Escape') {
      event.preventDefault()
      search.value = ''
      setQuery('')
      scroller.focus({ preventScroll: true })
    }
  })

  headRow.addEventListener('mousedown', (event) => {
    const grip = event.target.closest?.('.csv-grip')
    if (grip) { startResize(event, Number(grip.dataset.grip)); return }
    const cell = event.target.closest?.('.csv-th')
    if (!cell) return
    const c = Number(cell.dataset.col)
    event.preventDefault()
    if (event.metaKey || event.ctrlKey) { selectColumn(c); return }
    if (event.shiftKey) { moveTo(cursor.r, c, { extend: true }); return }
    if (event.detail > 1) return  // the double-click handler renames it
    sortBeforeClick = sort && { ...sort }
    cycleSort(c)
    scroller.focus({ preventScroll: true })
  })

  /**
   * The element of `kind` this event is about.
   *
   * `event.target` first, and the element under the pointer as the fallback:
   * clicking a heading sorts, which rebuilds the whole strip, so by the time
   * the *second* click of a double-click arrives its predecessor is gone from
   * the document and the browser reports the two clicks' common ancestor
   * instead. Without this, double-clicking a heading to rename it silently did
   * nothing on every column that had been clicked once.
   */
  const eventTarget = (event, kind) => {
    const direct = event.target.closest?.(kind)
    if (direct) return direct
    return document.elementFromPoint(event.clientX, event.clientY)?.closest?.(kind) || null
  }

  headRow.addEventListener('dblclick', (event) => {
    const grip = event.target.closest?.('.csv-grip')
    if (grip) { fitColumn(Number(grip.dataset.grip)); return }
    const cell = eventTarget(event, '.csv-th')
    if (!cell) return
    const c = Number(cell.dataset.col)
    /* The first click of this double-click sorted the column on its way here.
       Renaming a heading is not a request to reorder the table, so the sort
       goes back to whatever it was before that click. */
    sortBy(sortBeforeClick ? sortBeforeClick.col : c, sortBeforeClick?.dir ?? null)
    moveTo(-1, c)
    beginEdit()
  })

  headRow.addEventListener('contextmenu', (event) => {
    const cell = eventTarget(event, '.csv-th')
    if (!cell) return
    event.preventDefault()
    headMenu(event, Number(cell.dataset.col))
  })

  scroller.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return
    if (event.target.tagName === 'INPUT') return
    const corner = event.target.closest?.('.csv-corner')
    if (corner) { selectAll(); scroller.focus({ preventScroll: true }); return }
    const gutter = event.target.closest?.('.csv-gutter')
    if (gutter) {
      const r = Number(gutter.dataset.row)
      if (event.shiftKey) moveTo(r, columns() - 1, { extend: true })
      else selectRow(r)
      dragging = 'rows'
      scroller.focus({ preventScroll: true })
      return
    }
    const cell = event.target.closest?.('.csv-cell')
    if (!cell) return
    const r = Number(cell.dataset.row)
    const c = Number(cell.dataset.col)
    moveTo(r, c, { extend: event.shiftKey })
    dragging = 'cells'
    scroller.focus({ preventScroll: true })
  })

  frame.addEventListener('mousemove', (event) => {
    if (resize) { onResizeMove(event); return }
    if (!dragging) return
    const target = dragging === 'rows'
      ? event.target.closest?.('.csv-gutter, .csv-cell')
      : event.target.closest?.('.csv-cell')
    if (!target) return
    const r = Number(target.dataset.row)
    if (Number.isNaN(r)) return
    const c = dragging === 'rows' ? columns() - 1 : Number(target.dataset.col)
    if (r === cursor.r && c === cursor.c) return
    moveTo(r, Number.isNaN(c) ? cursor.c : c, { extend: true })
  })

  window.addEventListener('mouseup', () => { dragging = null; endResize() })

  scroller.addEventListener('dblclick', (event) => {
    if (event.target.closest?.('.csv-gutter')) return
    if (eventTarget(event, '.csv-cell')) beginEdit()
  })

  scroller.addEventListener('contextmenu', (event) => {
    const cell = event.target.closest?.('.csv-cell')
    const gutter = event.target.closest?.('.csv-gutter')
    if (gutter) {
      const r = Number(gutter.dataset.row)
      // Right-clicking outside the selection moves it there first, the way
      // every list in the app does.
      const box = rect()
      if (r < box.r0 || r > box.r1) selectRow(r)
      event.preventDefault()
      cellMenu(event, r, cursor.c)
      return
    }
    if (!cell) return
    const r = Number(cell.dataset.row)
    const c = Number(cell.dataset.col)
    const box = rect()
    if (r < box.r0 || r > box.r1 || c < box.c0 || c > box.c1) moveTo(r, c)
    event.preventDefault()
    cellMenu(event, r, c)
  })

  frame.addEventListener('mousedown', (event) => {
    if (!menu.hidden && !event.target.closest?.('.csv-menu')) closeMenu()
  }, true)

  /* Keys on the frame rather than on each cell: the cells come and go with the
     scroll, and a handler per cell would be a handler per row of a file with a
     million of them. */
  frame.addEventListener('keydown', (event) => {
    // The find box is a text field and owns everything typed into it.
    if (event.target.closest?.('.csv-bar')) return

    // While a cell is open, the input owns almost everything typed into it.
    if (editing) {
      if (event.key === 'Enter') {
        event.preventDefault()
        commitEdit()
        moveTo(cursor.r + (event.shiftKey ? -1 : 1), cursor.c)
        scroller.focus({ preventScroll: true })
      } else if (event.key === 'Escape') {
        event.preventDefault()
        commitEdit({ cancel: true })
        scroller.focus({ preventScroll: true })
      } else if (event.key === 'Tab') {
        event.preventDefault()
        commitEdit()
        moveTo(cursor.r, cursor.c + (event.shiftKey ? -1 : 1))
        scroller.focus({ preventScroll: true })
      }
      return
    }

    const mod = event.metaKey || event.ctrlKey
    const extend = event.shiftKey
    const lastRow = viewRows() - 1

    if (mod) {
      const key = event.key.toLowerCase()
      switch (key) {
        case 'a': event.preventDefault(); selectAll(); return
        case 'c': event.preventDefault(); fromKey('copy', () => copySelection()); return
        case 'x': event.preventDefault(); fromKey('cut', () => copySelection({ cut: true })); return
        case 'v': event.preventDefault(); fromKey('paste', () => pasteFromClipboard()); return
        case 'd': event.preventDefault(); fillDown(); return
        case 'f': event.preventDefault(); search.focus(); search.select(); return
        case 'g': event.preventDefault(); findNext(extend); return
        case 'z': event.preventDefault(); fromKey(extend ? 'redo' : 'undo', () => stepHistory(extend)); return
        case 'y': event.preventDefault(); fromKey('redo', () => stepHistory(true)); return
        default: break
      }
    }

    /* ⌃Space and ⇧Space, which is what a spreadsheet's own keyboard says for
       "this whole column" and "this whole row". */
    if (event.key === ' ' && event.ctrlKey) { event.preventDefault(); selectColumn(cursor.c); return }
    if (event.key === ' ' && extend) { event.preventDefault(); selectRow(cursor.r); return }

    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); moveTo(mod ? lastRow : cursor.r + 1, cursor.c, { extend }); return
      case 'ArrowUp': event.preventDefault(); moveTo(mod ? -1 : cursor.r - 1, cursor.c, { extend }); return
      case 'ArrowLeft': event.preventDefault(); moveTo(cursor.r, mod ? 0 : cursor.c - 1, { extend }); return
      case 'ArrowRight': event.preventDefault(); moveTo(cursor.r, mod ? columns() - 1 : cursor.c + 1, { extend }); return
      case 'PageDown': {
        event.preventDefault()
        moveTo(cursor.r + Math.floor(scroller.clientHeight / ROW_HEIGHT), cursor.c, { extend })
        return
      }
      case 'PageUp': {
        event.preventDefault()
        moveTo(cursor.r - Math.floor(scroller.clientHeight / ROW_HEIGHT), cursor.c, { extend })
        return
      }
      case 'Home': event.preventDefault(); moveTo(mod ? -1 : cursor.r, 0, { extend }); return
      case 'End': event.preventDefault(); moveTo(mod ? lastRow : cursor.r, columns() - 1, { extend }); return
      case 'Tab': event.preventDefault(); moveTo(cursor.r, cursor.c + (event.shiftKey ? -1 : 1)); return
      case 'F2': event.preventDefault(); beginEdit(); return
      case 'Enter': {
        event.preventDefault()
        // ⌘⏎ makes a row rather than editing one — the spreadsheet reflex.
        if (mod) insertRows(Math.max(0, cursor.r) + 1)
        else if (extend) moveTo(cursor.r - 1, cursor.c)
        else beginEdit()
        return
      }
      case 'Backspace':
      case 'Delete': {
        event.preventDefault()
        if (mod) {
          const box = rect()
          deleteRows(Math.max(0, box.r0), Math.max(0, box.r1))
          return
        }
        clearSelection()
        return
      }
      case 'Escape': {
        if (!menu.hidden) { event.preventDefault(); closeMenu(); return }
        // A rectangle collapses back to its cursor before esc means anything
        // to the window behind the grid.
        if (!singleCell()) { event.preventDefault(); moveTo(cursor.r, cursor.c); return }
        if (query) { event.preventDefault(); search.value = ''; setQuery('') }
        return
      }
      default: break
    }

    /* Typing over a cell replaces it, the way it does in every grid. Only
       single printable characters, so shortcuts on their way to the window
       are not swallowed as text. */
    if (!mod && !event.altKey && event.key.length === 1) {
      event.preventDefault()
      beginEdit(event.key)
    }
  })

  /* The clipboard, the other way round: a ⌘C routed through the window menu
     arrives as an event rather than as a keystroke, so both paths are wired
     and both end in the same place. */
  frame.addEventListener('copy', (event) => {
    if (editing || event.target.closest?.('.csv-bar')) return
    event.preventDefault()
    /* The data goes on the clipboard either way — setting it twice with the
       same text is harmless. The guard is on the *effect*: cut clearing the
       cells twice, or paste landing twice. */
    event.clipboardData?.setData('text/plain', gridToClipboard(rectValues()))
  })

  frame.addEventListener('cut', (event) => {
    if (editing || event.target.closest?.('.csv-bar')) return
    event.preventDefault()
    event.clipboardData?.setData('text/plain', gridToClipboard(rectValues()))
    unlessKey('cut', () => clearSelection())
  })

  frame.addEventListener('paste', (event) => {
    if (editing || event.target.closest?.('.csv-bar')) return
    const text = event.clipboardData?.getData('text/plain')
    if (!text) return
    event.preventDefault()
    unlessKey('paste', () => pasteGrid(parseClipboardGrid(text)))
  })

  /* Focus leaving the grid entirely — clicking a tab, opening the copilot —
     has to take the open cell with it, or the edit is lost with the element. */
  frame.addEventListener('focusout', (event) => {
    if (!editing) return
    if (frame.contains(event.relatedTarget)) return
    commitEdit()
  })

  return {
    async open (path, place = null) {
      const text = await file.read(path)
      const delimiter = dataDelimiter(path)
      const parsed = parseSeparated(text, delimiter)
      /* The first row is the header. Not a guess about the file so much as the
         only useful reading of one: a CSV with no header row is a CSV whose
         first row is its own labels, and showing it as the header costs
         nothing but a row that reads oddly. */
      header = parsed.length ? parsed[0] : ['']
      rows = parsed.slice(1)
      current = { path, delimiter, newline: detectNewline(text) }
      cursor = { r: rows.length ? 0 : -1, c: 0 }
      anchor = { ...cursor }
      editing = null
      firstBuilt = -1
      lastBuilt = -1
      sort = null
      history = []
      future = []
      setDirty(false)
      measure()
      rebuildOrder()
      paint()
      scroller.scrollTop = Number(place?.top) || 0
      scroller.scrollLeft = Number(place?.left) || 0
      syncHeadScroll()
      paintRows({ force: true })
      decorate()
    },

    save: saveFile,

    async close () {
      await saveFile({ flush: true })
      clearTimeout(saveTimer)
      current = null
      rows = []
      header = []
      order = []
      history = []
      future = []
      sort = null
      editing = null
      closeMenu()
      window_.replaceChildren()
      headRow.replaceChildren()
    },

    focus () { scroller.focus({ preventScroll: true }) },
    place: () => ({ top: scroller.scrollTop, left: scroller.scrollLeft }),
    dirty: () => dirty,

    /** ⌘F, routed here by the renderer while a table is the open document. */
    find () { search.focus(); search.select() },

    /** ⌘Z and ⇧⌘Z, which arrive through the window menu rather than as keys. */
    history (redo) {
      let stepped = false
      unlessKey(redo ? 'redo' : 'undo', () => { stepped = stepHistory(!!redo) })
      return stepped
    },

    /** What the status bar says about the table: its shape, and what is being
     *  done to the view of it. */
    summary () {
      if (!current) return ''
      const r = rows.length
      const c = columns()
      const parts = [
        `${r.toLocaleString()} ${r === 1 ? 'row' : 'rows'} · ${c} ${c === 1 ? 'column' : 'columns'}`
      ]
      if (sort) parts.push(`sorted by ${header[sort.col] || `column ${sort.col + 1}`} ${sort.dir === 'asc' ? '↑' : '↓'}`)
      if (filtering && query.trim()) parts.push(`showing ${viewRows().toLocaleString()}`)
      return parts.join(' · ')
    },

    /** The table as text, for the copilot: it cannot see the grid, and the
     *  quoted source is what it would have been handed for any other file.
     *  What it gets is what is on screen — sorted and filtered as the reader
     *  has it — because a question about "the top rows" is about those. */
    context () {
      if (!current) return { text: '', rows: rows.length, columns: columns() }
      const shown = order.slice(0, 50).map((i) => rows[i])
      return {
        text: formatSeparated([header, ...shown], current.delimiter, '\n'),
        rows: rows.length,
        columns: columns()
      }
    },

    /** The grid is laid out in pixels against the scroller's width; a pane
     *  opening beside it changes that without a window resize. */
    resize () { paintRows({ force: true }) }
  }
}
