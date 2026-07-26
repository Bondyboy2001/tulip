/* ============================================================== tables
   A GFM table stays rendered in the editing view and is typed into directly:
   the cells are editable, and every keystroke is written back into the pipes
   behind them.

   The rest of the live preview steps aside when the cursor arrives — show the
   markup, edit the markup — but a table is the one construct where that trade
   is bad. Its source is a grid of pipes that has to be re-aligned by hand, and
   reading it is the hard part. So the table holds its shape, and only the cell
   you are actually in reveals its own markdown, so `**bold**` round-trips
   exactly as written. Raw view (⌘3) still gives you the whole thing as text.

   The decoration is block-level, so it is served from a StateField. CodeMirror
   rejects block decorations that come from a ViewPlugin.
   ================================================================== */

import { EditorView, Decoration, WidgetType } from '@codemirror/view'
import { StateField } from '@codemirror/state'

const DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/**
 * Split a row on unescaped pipes, keeping each cell's span in the document.
 * The span covers the trimmed text, so writing to it leaves the author's
 * padding either side untouched.
 */
function splitRow (text, lineFrom = 0) {
  const bounds = []
  let start = 0

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue }
    if (text[i] !== '|') continue
    bounds.push([start, i])
    start = i + 1
  }
  bounds.push([start, text.length])

  if (bounds.length && !text.slice(...bounds[0]).trim()) bounds.shift()
  if (bounds.length && !text.slice(...bounds[bounds.length - 1]).trim()) bounds.pop()

  return bounds.map(([from, to]) => {
    const raw = text.slice(from, to)
    const trimmed = raw.trim()
    const lead = raw.length - raw.trimStart().length
    const start = lineFrom + from + lead
    /* A blank cell has no text to trim around, and trimming from both ends of
       "  " would cross the bounds over each other — a change running backwards,
       which CodeMirror rejects outright. It takes the whole run instead, so
       writing into it can restore the padding either side. */
    if (!trimmed) return { text: '', from: lineFrom + from, to: lineFrom + to, blank: true }

    return {
      text: trimmed,
      from: start,
      to: lineFrom + to - (raw.length - raw.trimEnd().length)
    }
  })
}

const cellText = (row) => row.map((c) => c.text)

function alignments (delimiterRow) {
  return splitRow(delimiterRow).map(({ text }) => {
    const left = text.startsWith(':')
    const right = text.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

/** Every table in the document, as line ranges plus their parsed contents. */
export function findTables (state) {
  const tables = []
  const total = state.doc.lines

  for (let n = 1; n < total; n++) {
    const head = state.doc.line(n)
    if (!head.text.includes('|')) continue

    const delimiter = state.doc.line(n + 1)
    if (!DELIMITER.test(delimiter.text) || !delimiter.text.includes('-')) continue

    const header = splitRow(head.text, head.from)
    const aligns = alignments(delimiter.text)
    if (!header.length || aligns.length !== header.length) continue

    // Row 0 is the header; the delimiter is not data and never appears here.
    const rows = [{ line: n, cells: header }]
    let last = n + 1
    for (let m = n + 2; m <= total; m++) {
      const row = state.doc.line(m)
      if (!row.text.includes('|') || !row.text.trim()) break
      rows.push({ line: m, cells: splitRow(row.text, row.from) })
      last = m
    }

    tables.push({
      from: head.from,
      to: state.doc.line(last).to,
      aligns,
      rows,
      cols: header.length,
      lastLine: last
    })
    n = last
  }

  return tables
}

const tableAt = (state, pos) =>
  findTables(state).find((t) => pos >= t.from && pos <= t.to) || null

/* A cell's text has to survive the round trip through a pipe-delimited row. */
const encode = (text) => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()
const decode = (text) => text.replace(/\\\|/g, '|')

/* --------------------------------------------------------- cell contents */

/* An unfocused cell shows its formatting. A full inline parser here would
   duplicate markdown-it for very little gain. */
function renderCell (td, text) {
  const pattern = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|`([^`]+)`|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)]+)\)/g
  let last = 0
  let match

  td.replaceChildren()
  while ((match = pattern.exec(text))) {
    if (match.index > last) td.append(text.slice(last, match.index))

    if (match[2] !== undefined) {
      const strong = document.createElement('strong')
      strong.textContent = match[2]
      td.append(strong)
    } else if (match[4] !== undefined) {
      const em = document.createElement('em')
      em.textContent = match[4]
      td.append(em)
    } else if (match[5] !== undefined) {
      const code = document.createElement('code')
      code.className = 'tk-inline-code'
      code.textContent = match[5]
      td.append(code)
    } else if (match[6] !== undefined) {
      const link = document.createElement('span')
      link.className = 'tk-wikilink'
      link.dataset.wikilink = match[6].trim()
      link.textContent = match[7] || match[6]
      td.append(link)
    } else if (match[8] !== undefined) {
      const link = document.createElement('span')
      link.className = 'tk-link'
      link.textContent = match[8]
      td.append(link)
    }
    last = pattern.lastIndex
  }

  if (last < text.length) td.append(text.slice(last))
}

/* ---------------------------------------------------------- write-back */

/** Where does this cell's text live in the document, right now? */
function locate (view, cell) {
  const wrap = cell.closest('.tk-table-wrap')
  if (!wrap) return null
  const table = tableAt(view.state, view.posAtDOM(wrap))
  if (!table) return null
  const row = table.rows[Number(cell.dataset.row)]
  return row ? { table, row, span: row.cells[Number(cell.dataset.col)] || null } : null
}

function writeCell (view, cell) {
  const found = locate(view, cell)
  if (!found) return
  const next = encode(cell.textContent || '')

  /* A ragged row has fewer cells than the header, so the cell being typed in
     may have no source to replace. Rebuilding that one line is the only way to
     grow it, and it is the only case where padding is normalised. */
  if (!found.span) {
    const line = view.state.doc.line(found.row.line)
    const texts = cellText(found.row.cells)
    while (texts.length <= Number(cell.dataset.col)) texts.push('')
    texts[Number(cell.dataset.col)] = next
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: `| ${texts.join(' | ')} |` },
      userEvent: 'input.table'
    })
    return
  }

  const { from, to, blank } = found.span
  // Filling a blank cell puts its padding back, so the pipes stay readable in
  // the source. Once it holds text the span is the text itself, and the
  // author's own spacing is left alone from then on.
  const insert = blank ? (next ? ` ${next} ` : ' ') : next
  if (insert === view.state.doc.sliceString(from, to)) return
  view.dispatch({ changes: { from, to, insert }, userEvent: 'input.table' })
}

function caretToEnd (cell) {
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(cell)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

function focusCell (wrap, r, c) {
  const cell = wrap?.querySelector(`[data-row="${r}"][data-col="${c}"]`)
  if (!cell) return false
  cell.focus()
  caretToEnd(cell)
  return true
}

/** Append an empty row, then land in its first cell. */
function addRow (view, cell) {
  const found = locate(view, cell)
  if (!found) return
  const { table } = found
  const line = view.state.doc.line(table.lastLine)
  const row = table.rows.length

  view.dispatch({
    changes: { from: line.to, insert: '\n|' + ' |'.repeat(table.cols) },
    userEvent: 'input.table'
  })

  const wrap = cell.closest('.tk-table-wrap')
  if (!focusCell(wrap, row, 0)) requestAnimationFrame(() => focusCell(wrap, row, 0))
}

function wire (cell, view, source) {
  /* Entering a cell swaps it to its own markdown: what you edit is what is in
     the file, so `**bold**` cannot be flattened by a round trip through the
     DOM. The flag records that the swap has happened, because the formatted
     text and the source are often identical and there is no telling them apart
     by looking. */
  const reveal = () => {
    if (cell.dataset.editing) return
    cell.dataset.editing = '1'
    cell.textContent = decode(source())
    caretToEnd(cell)
  }

  cell.addEventListener('focus', reveal)

  /* A focus event only fires when the window itself has focus, so a cell can
     become the active element without one — coming back to a background
     window, most often. Swallowing that first keystroke costs one character in
     a corner case; typing over rendered text would cost the formatting. */
  cell.addEventListener('beforeinput', (event) => {
    if (cell.dataset.editing) return
    event.preventDefault()
    reveal()
  })

  cell.addEventListener('input', () => writeCell(view, cell))

  cell.addEventListener('blur', () => {
    writeCell(view, cell)
    delete cell.dataset.editing
    renderCell(cell, decode(cell.textContent || ''))
  })

  cell.addEventListener('keydown', (event) => {
    const wrap = cell.closest('.tk-table-wrap')
    const r = Number(cell.dataset.row)
    const c = Number(cell.dataset.col)
    const cols = Number(wrap?.dataset.cols || 1)
    const rows = wrap?.querySelectorAll('tr').length || 1

    if (event.key === 'Tab') {
      event.preventDefault()
      let nr = r
      let nc = c + (event.shiftKey ? -1 : 1)
      if (nc >= cols) { nc = 0; nr++ }
      if (nc < 0) { nc = cols - 1; nr-- }
      if (nr < 0) return
      // Tab off the last cell grows the table, which is the cheapest way to add
      // a row and the one every spreadsheet has trained people to expect.
      if (nr >= rows) addRow(view, cell)
      else focusCell(wrap, nr, nc)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      if (r + 1 >= rows) addRow(view, cell)
      else focusCell(wrap, r + 1, c)
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      const found = locate(view, cell)
      cell.blur()
      view.focus()
      if (found) {
        view.dispatch({ selection: { anchor: Math.min(found.table.to, view.state.doc.length) } })
      }
    }
  })
}

/* ---------------------------------------------------------- the widget */

class TableWidget extends WidgetType {
  constructor (table) {
    super()
    this.aligns = table.aligns
    this.cols = table.cols
    this.cells = table.rows.map((row) => {
      const texts = cellText(row.cells)
      while (texts.length < table.cols) texts.push('')   // ragged rows pad out
      return texts
    })
    this.key = JSON.stringify([this.aligns, this.cells])
  }

  eq (other) { return other.key === this.key }

  toDOM (view) {
    const wrap = document.createElement('div')
    wrap.className = 'tk-table-wrap'
    wrap.contentEditable = 'false'
    wrap.dataset.cols = String(this.cols)

    const table = document.createElement('table')
    table.className = 'tk-table'

    const thead = document.createElement('thead')
    thead.append(this.buildRow(view, 0))
    table.append(thead)

    const tbody = document.createElement('tbody')
    for (let r = 1; r < this.cells.length; r++) tbody.append(this.buildRow(view, r))
    table.append(tbody)

    wrap.append(table)
    return wrap
  }

  buildRow (view, r) {
    const tr = document.createElement('tr')
    for (let c = 0; c < this.cols; c++) {
      const cell = document.createElement(r === 0 ? 'th' : 'td')
      cell.contentEditable = 'plaintext-only'
      cell.spellcheck = false
      cell.dataset.row = String(r)
      cell.dataset.col = String(c)
      if (this.aligns[c]) cell.style.textAlign = this.aligns[c]
      renderCell(cell, decode(this.cells[r]?.[c] ?? ''))
      // The source is read at focus time, not captured here: by then the widget
      // may be several edits old.
      wire(cell, view, () => currentText(view, cell))
      tr.append(cell)
    }
    return tr
  }

  /**
   * Patch rather than rebuild. Every keystroke changes the document, which
   * makes a new widget, and swapping the DOM would take the caret with it.
   * Returning true keeps the element; the cell being typed in is left alone
   * because its DOM is already the truth.
   */
  updateDOM (dom, view) {
    if (!(dom instanceof HTMLElement) || dom.dataset.cols !== String(this.cols)) return false

    const table = dom.querySelector('table')
    const tbody = table?.querySelector('tbody')
    if (!table || !tbody) return false

    while (tbody.children.length > this.cells.length - 1) tbody.lastElementChild.remove()
    while (tbody.children.length < this.cells.length - 1) {
      tbody.append(this.buildRow(view, tbody.children.length + 1))
    }

    const rows = [table.querySelector('thead tr'), ...tbody.children]
    rows.forEach((tr, r) => {
      [...tr.children].forEach((cell, c) => {
        cell.dataset.row = String(r)
        cell.dataset.col = String(c)
        cell.style.textAlign = this.aligns[c] || ''
        if (cell === document.activeElement || cell.dataset.editing) return
        renderCell(cell, decode(this.cells[r]?.[c] ?? ''))
      })
    })
    return true
  }

  /* Everything inside the widget is handled here; CodeMirror must not read the
     document out of it or treat a click in a cell as a click in the text. */
  ignoreEvent () { return true }
}

/** The cell's text as it currently stands in the document. */
function currentText (view, cell) {
  const found = locate(view, cell)
  return found?.span ? view.state.doc.sliceString(found.span.from, found.span.to) : ''
}

/* ------------------------------------------------------- the extension */

function buildTables (state) {
  const ranges = []
  for (const table of findTables(state)) {
    ranges.push(
      Decoration.replace({ widget: new TableWidget(table), block: true })
        .range(table.from, table.to)
    )
  }
  return Decoration.set(ranges, true)
}

export const tablePreview = StateField.define({
  create: (state) => buildTables(state),
  update (value, tr) {
    if (!tr.docChanged) return value
    return buildTables(tr.state)
  },
  provide: (field) => EditorView.decorations.from(field)
})
