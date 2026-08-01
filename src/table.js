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

import { EditorView, Decoration, ViewPlugin, WidgetType } from '@codemirror/view'
import { Facet, StateField } from '@codemirror/state'
import { MONEY_SOURCE, moneyNode } from './money.js'
import { findMath, renderMathInto } from './math.js'
import {
  findEmbeds, specForEmbed, renderEmbed, withEmbedSize,
  embedResizeGrip, wireEmbedResize
} from './assets.js'

const DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/** Whether the open note is a `.language.md` document. A function is carried
 *  rather than a captured boolean because the same editor opens many notes. */
export const languageTableMode = Facet.define({
  combine: (values) => values[0] || (() => false)
})

/** The attachment lookup shared with the rest of the live editor. Keeping the
 * resolver in a facet means a table widget always uses the current vault
 * index, including immediately after a pasted image has been filed. */
export const tableAssetResolver = Facet.define({
  combine: (values) => values[0] || (() => null)
})

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
function findTables (state) {
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

/**
 * The same answer for one document version, computed once.
 *
 * `findTables` reads every line in the note, and the callers are not occasional:
 * the state field rebuilds on each edit, and `locate` — which every keystroke
 * in a cell, every Tab and Enter, and every cell's `currentText` goes through —
 * asked the same question again each time. Typing one character in a cell cost
 * several passes over the whole document.
 *
 * Keyed on the `Text` object, which CodeMirror shares between states while the
 * document is unchanged, so the repeat callers within one version are free and
 * an edit still recomputes exactly once.
 */
let cache = { doc: null, tables: null }

function tablesIn (state) {
  if (cache.doc !== state.doc) cache = { doc: state.doc, tables: findTables(state) }
  return cache.tables
}

const tableAt = (state, pos) =>
  tablesIn(state).find((t) => pos >= t.from && pos <= t.to) || null

/* A cell's text has to survive the round trip through a pipe-delimited row. */
const encode = (text) => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()
const decode = (text) => text.replace(/\\\|/g, '|')

/* --------------------------------------------------------- cell contents */

/* An unfocused cell shows its formatting. A full inline parser here would
   duplicate markdown-it for very little gain.

   Money is on the end of the alternation, borrowed from money.js rather than
   spelled out again: a column of prices is most of what anyone puts a table
   round, and left as plain text it was the one thing in the editing view that
   did not look the way the reading view sets it. */
const CELL_PATTERN =
  '(\\*\\*|__)(.+?)\\1|(\\*|_)(.+?)\\3|`([^`]+)`|' +
  '\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]|\\[([^\\]]+)\\]\\(([^)]+)\\)|' +
  MONEY_SOURCE

/* Compiled once rather than per cell: a vocabulary table is a thousand cells,
   and the scan below already drives `lastIndex` by hand, so all a shared
   instance needs is to start from the top. */
const cellPattern = new RegExp(CELL_PATTERN, 'g')

function renderCell (td, text, {
  resolve = () => null,
  onReady = () => {},
  onResize = null
} = {}) {
  const pattern = cellPattern
  pattern.lastIndex = 0
  const embeds = findEmbeds(text)
  const maths = findMath(text)
  let embedIndex = 0
  let mathIndex = 0
  let last = 0
  let imageOnly = false

  td.replaceChildren()
  while (last < text.length) {
    const match = pattern.exec(text)
    const embed = embeds[embedIndex]
    /* A maths span the pattern already consumed past — `$x$` inside an inline
       code span — is not coming back. */
    while (maths[mathIndex] && maths[mathIndex].from < last) mathIndex++
    const math = maths[mathIndex]

    /* `![[picture.png]]` also contains a valid `[[wikilink]]`. Images win the
       tie, otherwise the link renderer would leave a literal `!` beside a
       filename and the picture would never be reached. */
    if (embed && (!match || embed.from <= match.index) && (!math || embed.from <= math.from)) {
      if (embed.from > last) td.append(text.slice(last, embed.from))
      const spec = specForEmbed(embed, { resolve })
      const media = renderEmbed(spec, onReady)

      if (spec.kind === 'image' && media instanceof HTMLImageElement) {
        const shell = document.createElement('span')
        shell.className = 'tk-table-image-shell'
        shell.contentEditable = 'false'
        if (spec.width || spec.height) shell.classList.add('is-sized')

        media.classList.add('tk-table-image')
        if (spec.width) media.style.width = `${spec.width}px`
        if (spec.height) media.style.height = `${spec.height}px`
        shell.append(media)

        if (onResize) {
          const grip = embedResizeGrip()
          wireEmbedResize(grip, {
            image: media,
            host: shell,
            /* An image-only cell is exactly as wide as its picture and the grid
               is `width: max-content`, so the table follows the drag. Past the
               frame it would follow it into a horizontal scrollbar appearing
               and disappearing under the pointer, so the drag stops there. */
            limit: () => (shell.closest('.tk-table-wrap')?.clientWidth ?? Infinity) - 32,
            commit: (width) => onResize(embed, width)
          })
          shell.append(grip)
        }
        td.append(shell)
        imageOnly = embeds.length === 1 && embed.from === 0 && embed.to === text.length
      } else {
        td.append(media)
      }

      last = embed.to
      embedIndex++
      pattern.lastIndex = last
      continue
    }

    /* Maths wins over anything the pattern found inside it — the money
       alternative would otherwise claim the `$1` of `$1\sigma$`, and the cell
       would disagree with the reading view about the same characters. The
       scanner is the one the whole app answers to, so what typesets here is
       exactly what typesets everywhere else. */
    if (math && (!match || math.from <= match.index)) {
      if (math.from > last) td.append(text.slice(last, math.from))
      const span = document.createElement('span')
      span.className = math.display ? 'tk-math tk-math-display' : 'tk-math'
      renderMathInto(span, math.tex, math.display)
      td.append(span)
      last = math.to
      mathIndex++
      pattern.lastIndex = last
      continue
    }

    if (!match) {
      td.append(text.slice(last))
      last = text.length
      break
    }
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
    } else if (match[10] !== undefined) {
      td.append(moneyNode(match[10]))
    }
    last = pattern.lastIndex
  }

  td.classList.toggle('has-image-only', imageOnly)
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

function renderTableCell (view, cell, text) {
  renderCell(cell, text, {
    resolve: view.state.facet(tableAssetResolver),
    onReady: () => view.requestMeasure(),
    onResize: (embed, width) => resizeCellImage(view, cell, embed, width)
  })
  /* What the cell was last drawn from, so a redraw of the table can leave the
     cells the edit did not touch alone — see updateDOM. */
  cell.dataset.src = text
}

function caretToEnd (cell) {
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(cell)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * The caret's character offset inside a cell, or null for a non-caret
 * selection — which is a collapsed selection and nothing more, so it is asked
 * of the same range measurement rather than of a second copy of it.
 */
function caretOffset (cell) {
  const at = selectionOffsets(cell)
  return at && at.from === at.to ? at.from : null
}

function selectionOffsets (cell) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount !== 1) return null
  const active = selection.getRangeAt(0)
  if (!cell.contains(active.startContainer) || !cell.contains(active.endContainer)) return null

  const offset = (node, at) => {
    const before = document.createRange()
    before.selectNodeContents(cell)
    before.setEnd(node, at)
    return before.toString().length
  }
  return {
    from: offset(active.startContainer, active.startOffset),
    to: offset(active.endContainer, active.endOffset)
  }
}

function focusCell (wrap, r, c) {
  const cell = wrap?.querySelector(`[data-row="${r}"][data-col="${c}"]`)
  if (!cell) return false
  cell.focus()
  caretToEnd(cell)
  return true
}

const selectedCells = (wrap) =>
  [...(wrap?.querySelectorAll('.tk-table-cell-selected') || [])]

function clearCellSelection (wrap) {
  for (const cell of selectedCells(wrap)) cell.classList.remove('tk-table-cell-selected')
}

function selectCellRectangle (wrap, from, to) {
  clearCellSelection(wrap)
  const top = Math.min(from.r, to.r)
  const bottom = Math.max(from.r, to.r)
  const left = Math.min(from.c, to.c)
  const right = Math.max(from.c, to.c)

  for (let r = top; r <= bottom; r++) {
    for (let c = left; c <= right; c++) {
      wrap.querySelector(
        `[data-row="${r}"][data-col="${c}"][contenteditable="plaintext-only"]`
      )?.classList.add('tk-table-cell-selected')
    }
  }
}

function replaceCellValues (view, assignments) {
  const changes = []
  for (const { cell, value } of assignments) {
    const found = locate(view, cell)
    if (!found?.span) continue
    const next = encode(value)
    const { from, to, blank } = found.span
    const insert = blank ? (next ? ` ${next} ` : ' ') : next
    if (insert === view.state.doc.sliceString(from, to)) continue
    changes.push({ from, to, insert })
    cell.textContent = decode(next)
  }
  if (!changes.length) return
  changes.sort((a, b) => a.from - b.from)
  view.dispatch({ changes, userEvent: 'input.table' })
}

function resizeCellImage (view, cell, rendered, width) {
  const source = decode(currentText(view, cell))
  const embeds = findEmbeds(source)
  const embed = embeds.find((candidate) =>
    candidate.from === rendered.from &&
    candidate.src === rendered.src
  ) || embeds.find((candidate) => candidate.src === rendered.src)
  if (!embed) return

  /* `withEmbedSize` is the one writer of the `|400` suffix, shared with the
     editor's own drag handle, so it speaks both embed syntaxes and keeps the
     alt text the cell was written with. */
  const next = source.slice(0, embed.from) + withEmbedSize(embed, width) + source.slice(embed.to)

  const found = locate(view, cell)
  if (!found?.span) return
  const { from, to, blank } = found.span
  const insert = blank ? ` ${encode(next)} ` : encode(next)
  if (insert === view.state.doc.sliceString(from, to)) return

  /* Written straight into the document rather than through `replaceCellValues`,
     and without a redraw afterwards. That path is for text edits: it puts the
     new source into the cell as plain text and rebuilds the cell from it, so
     the end of every drag flashed the raw `![[shot.png|400]]` and then a
     freshly decoded <img>. The picture on screen is already the size being
     written — claiming the new source here is enough to make `updateDOM` leave
     the cell, and the picture in it, exactly as the drag left them. */
  cell.dataset.src = next
  view.dispatch({ changes: { from, to, insert }, userEvent: 'input.table' })
  view.requestMeasure()
}

function clearSelectedCells (view, wrap) {
  replaceCellValues(
    view,
    selectedCells(wrap).map((cell) => ({ cell, value: '' }))
  )
}

/** Drag rectangles and exchange them with spreadsheet apps as TSV. */
function wireCellSelection (wrap, view) {
  let drag = null

  wrap.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return
    const cell = event.target.closest(
      '.tk-table [data-row][data-col][contenteditable="plaintext-only"]'
    )
    if (!cell) return
    event.preventDefault()

    const point = { r: Number(cell.dataset.row), c: Number(cell.dataset.col) }
    const saved = {
      r: Number(wrap.dataset.cellAnchorRow),
      c: Number(wrap.dataset.cellAnchorCol)
    }
    const anchor = event.shiftKey &&
      Number.isInteger(saved.r) && Number.isInteger(saved.c)
      ? saved
      : point

    drag = { anchor, point, cell, moved: false, extended: event.shiftKey }
    wrap.dataset.cellAnchorRow = String(anchor.r)
    wrap.dataset.cellAnchorCol = String(anchor.c)
    wrap.classList.add('is-selecting-cells')
    selectCellRectangle(wrap, anchor, point)

    document.addEventListener('mouseup', () => {
      if (!drag) return
      const finished = drag
      drag = null
      wrap.classList.remove('is-selecting-cells')
      if (!finished.moved && !finished.extended) {
        clearCellSelection(wrap)
      } else {
        selectCellRectangle(wrap, finished.anchor, finished.point)
      }
      finished.cell.focus()
      caretToEnd(finished.cell)
    }, { once: true })
  })

  wrap.addEventListener('mouseover', (event) => {
    if (!drag || !(event.buttons & 1)) return
    const cell = event.target.closest(
      '.tk-table [data-row][data-col][contenteditable="plaintext-only"]'
    )
    if (!cell) return
    const point = { r: Number(cell.dataset.row), c: Number(cell.dataset.col) }
    if (point.r === drag.point.r && point.c === drag.point.c) return
    event.preventDefault()
    drag.point = point
    drag.moved = true
    selectCellRectangle(wrap, drag.anchor, point)
  })

  wrap.addEventListener('copy', (event) => {
    const selected = selectedCells(wrap)
    if (selected.length < 2 || !event.clipboardData) return
    event.preventDefault()
    const rows = selected.map((cell) => Number(cell.dataset.row))
    const cols = selected.map((cell) => Number(cell.dataset.col))
    const top = Math.min(...rows)
    const bottom = Math.max(...rows)
    const left = Math.min(...cols)
    const right = Math.max(...cols)
    const lines = []
    for (let r = top; r <= bottom; r++) {
      const values = []
      for (let c = left; c <= right; c++) {
        values.push(
          wrap.querySelector(`[data-row="${r}"][data-col="${c}"]`)?.textContent || ''
        )
      }
      lines.push(values.join('\t'))
    }
    event.clipboardData.setData('text/plain', lines.join('\n'))
  })

  wrap.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain') || ''
    if (!text.includes('\t') && !/[\r\n]/.test(text)) return
    const active = event.target.closest('[data-row][data-col]')
    if (!active) return
    event.preventDefault()

    const matrix = text.replace(/\r/g, '').split('\n').map((row) => row.split('\t'))
    if (matrix.length > 1 && matrix.at(-1).every((value) => !value)) matrix.pop()
    const start = { r: Number(active.dataset.row), c: Number(active.dataset.col) }
    const assignments = []
    matrix.forEach((row, dr) => row.forEach((value, dc) => {
      const cell = wrap.querySelector(
        `[data-row="${start.r + dr}"][data-col="${start.c + dc}"]` +
        '[contenteditable="plaintext-only"]'
      )
      if (cell) assignments.push({ cell, value })
    }))
    replaceCellValues(view, assignments)
    if (assignments.length > 1) {
      const last = assignments.at(-1).cell
      selectCellRectangle(wrap, start, {
        r: Number(last.dataset.row),
        c: Number(last.dataset.col)
      })
    }
  })
}

const rowSource = (cells) => `| ${cells.join(' | ')} |`

function delimiterSource (align) {
  if (align === 'center') return ':---:'
  if (align === 'right') return '---:'
  if (align === 'left') return ':---'
  return '---'
}

/**
 * Rewrite a table after a column mutation. Structural edits are deliberately
 * normalised: changing the grid already touches every row, and one predictable
 * pipe shape is safer than trying to splice around escaped pipes and ragged
 * padding independently.
 */
function rewriteColumns (view, table, mutateCells, mutateAligns) {
  const changes = table.rows.map((row) => {
    const cells = cellText(row.cells)
    while (cells.length < table.cols) cells.push('')
    mutateCells(cells)
    const line = view.state.doc.line(row.line)
    return { from: line.from, to: line.to, insert: rowSource(cells) }
  })

  const delimiter = view.state.doc.line(table.rows[0].line + 1)
  const aligns = [...table.aligns]
  mutateAligns(aligns)
  changes.push({
    from: delimiter.from,
    to: delimiter.to,
    insert: rowSource(aligns.map(delimiterSource))
  })

  view.dispatch({ changes, userEvent: 'input.table' })
}

/** Insert an empty body row beside the current one, then land in it. */
function insertRow (view, cell, after) {
  const found = locate(view, cell)
  if (!found) return
  const { table } = found
  const current = Number(cell.dataset.row)
  const blank = '|' + ' |'.repeat(table.cols)
  let row
  let changes

  if (current === 0) {
    // A table's delimiter must stay directly beneath its header. "After" the
    // header therefore means the first body row, below that delimiter.
    const delimiter = view.state.doc.line(table.rows[0].line + 1)
    row = 1
    changes = { from: delimiter.to, insert: `\n${blank}` }
  } else {
    const line = view.state.doc.line(found.row.line)
    row = after ? current + 1 : current
    changes = after
      ? { from: line.to, insert: `\n${blank}` }
      : { from: line.from, insert: `${blank}\n` }
  }

  view.dispatch({
    changes,
    userEvent: 'input.table'
  })

  const wrap = cell.closest('.tk-table-wrap')
  if (!focusCell(wrap, row, 0)) requestAnimationFrame(() => focusCell(wrap, row, 0))
}

/** Append is what Enter, Tab and the edge control mean. */
function addRow (view, cell) {
  const found = locate(view, cell)
  if (!found) return
  const last = found.table.rows.length - 1
  const anchor = cell.closest('.tk-table-wrap')
    ?.querySelector(`[data-row="${last}"][data-col="0"]`) || cell
  insertRow(view, anchor, true)
}

/** Insert an empty column beside the current one, then land in its header. */
function insertColumn (view, cell, after) {
  const found = locate(view, cell)
  if (!found) return
  const tableIndex = tablesIn(view.state).indexOf(found.table)
  const col = Number(cell.dataset.col) + (after ? 1 : 0)

  cell.blur()
  rewriteColumns(
    view,
    found.table,
    (cells) => cells.splice(col, 0, ''),
    (aligns) => aligns.splice(col, 0, null)
  )

  requestAnimationFrame(() => {
    const wrap = view.dom.querySelectorAll('.tk-table-wrap')[tableIndex]
    focusCell(wrap, 0, col)
  })
}

/** Append is what the edge control means. */
function addColumn (view, cell) {
  const found = locate(view, cell)
  if (!found) return
  const last = found.table.cols - 1
  const anchor = cell.closest('.tk-table-wrap')
    ?.querySelector(`[data-row="0"][data-col="${last}"]`) || cell
  insertColumn(view, anchor, true)
}

/**
 * Which rows a delete would actually take, given what is selected and the
 * table's own minimum.
 *
 * One answer for both the deletion and the menu item that offers it: they were
 * two copies of this arithmetic, so "Delete 3 rows" could name a number the
 * delete would not go through with.
 */
function rowsToDelete (view, cell) {
  const found = locate(view, cell)
  if (!found) return { rows: [], language: false, table: null }
  const wrap = cell.closest('.tk-table-wrap')
  const language = wrap?.dataset.language === 'true'
  const selectedRows = new Set(
    selectedCells(wrap).map((selected) => Number(selected.dataset.row))
  )
  if (selectedRows.size < 2) {
    selectedRows.clear()
    selectedRows.add(Number(cell.dataset.row))
  }

  // Bottom of the selection first, so selecting every body row keeps the
  // earliest one when the table's one-row minimum prevents the final deletion.
  const candidates = [...selectedRows]
    .filter((row) => !language || row > 0)
    .sort((a, b) => b - a)
  const minimum = language ? 2 : 1 // header + one body row for language tables
  const room = Math.max(0, found.table.rows.length - minimum)
  return { rows: candidates.slice(0, room), language, table: found.table }
}

function deleteRow (view, cell) {
  const { rows, language, table } = rowsToDelete(view, cell)
  if (!table) return

  const deleting = new Set(rows)
  if (!deleting.size) return

  const remaining = table.rows.filter((_, row) => !deleting.has(row))
  const lines = remaining.map((row) => {
    const cells = cellText(row.cells)
    while (cells.length < table.cols) cells.push('')
    return rowSource(cells)
  })
  lines.splice(1, 0, rowSource(table.aligns.map(delimiterSource)))

  const tableIndex = tablesIn(view.state).indexOf(table)
  const firstDeleted = Math.min(...deleting)
  cell.blur()
  view.dispatch({
    changes: { from: table.from, to: table.to, insert: lines.join('\n') },
    userEvent: 'input.table'
  })

  requestAnimationFrame(() => {
    const nextWrap = view.dom.querySelectorAll('.tk-table-wrap')[tableIndex]
    const nextRow = Math.max(language ? 1 : 0, Math.min(firstDeleted, remaining.length - 1))
    focusCell(nextWrap, nextRow, Number(cell.dataset.col))
  })
}

const deletableRowCount = (view, cell) => rowsToDelete(view, cell).rows.length

function deleteColumn (view, cell) {
  const found = locate(view, cell)
  const language = cell.closest('.tk-table-wrap')?.dataset.language === 'true'
  if (!found || language || found.table.cols <= 1) return
  const col = Number(cell.dataset.col)
  cell.blur()
  rewriteColumns(
    view,
    found.table,
    (cells) => cells.splice(col, 1),
    (aligns) => aligns.splice(col, 1)
  )
  view.focus()
}

function wire (cell, view, source) {
  /* Entering a cell swaps it to its own markdown: what you edit is what is in
     the file, so `**bold**` cannot be flattened by a round trip through the
     DOM. The flag records that the swap has happened, because the formatted
     text and the source are often identical and there is no telling them apart
     by looking. */
  const reveal = () => {
    view.dom.classList.add('has-table-cell-focus')
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
    renderTableCell(view, cell, decode(cell.textContent || ''))
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (!active || !view.dom.contains(active) || !active.closest?.('.tk-table-wrap')) {
        view.dom.classList.remove('has-table-cell-focus')
      }
    })
  })

  /* The renderer owns attachment I/O, while this module owns the cell's source
     range. A synchronous request captures the insertion point before the file
     write; the callback is invoked with the finished wiki embed afterwards. */
  cell.addEventListener('tulip:table-attachment-paste', (event) => {
    const detail = event.detail
    if (!detail || detail.insert) return
    const existing = decode(currentText(view, cell))
    const selected = selectionOffsets(cell)
    const from = selected?.from ?? existing.length
    const to = selected?.to ?? from

    detail.insert = (markdown) => {
      const current = decode(currentText(view, cell))
      const start = Math.min(from, current.length)
      const end = Math.min(Math.max(start, to), current.length)
      const gapBefore = start > 0 && !/\s$/.test(current.slice(0, start)) ? ' ' : ''
      const gapAfter = end < current.length && !/^\s/.test(current.slice(end)) ? ' ' : ''
      const insertion = `${gapBefore}${markdown}${gapAfter}`
      const next = current.slice(0, start) + insertion + current.slice(end)

      cell.dataset.editing = '1'
      replaceCellValues(view, [{ cell, value: next }])
      /* A pasted picture is an object, so show the object immediately. Keeping
         the cell in source mode made the successful paste look like a line of
         wiki markup until the user clicked elsewhere. A programmatic blur of a
         plaintext-only cell does not consistently deliver a blur event in
         Chromium, so the cleanup and render are explicit after it. */
      if (document.activeElement === cell) cell.blur()
      delete cell.dataset.editing
      renderTableCell(view, cell, next)
    }
  })

  cell.addEventListener('contextmenu', (event) => {
    /* Images have their own vault-level menu. Let that gesture reach the
       renderer instead of replacing it with the surrounding cell's menu. */
    if (event.target instanceof Element &&
        event.target.closest('.embed-img[data-vault-image]')) return
    event.preventDefault()
    event.stopPropagation()
    const found = locate(view, cell)
    if (!found) return
    const wrap = cell.closest('.tk-table-wrap')
    const language = wrap?.dataset.language === 'true'
    const row = Number(cell.dataset.row)
    if (!cell.classList.contains('tk-table-cell-selected')) clearCellSelection(wrap)
    const selection = selectedCells(wrap)
    const deleteRowCount = deletableRowCount(view, cell)
    cell.dispatchEvent(new CustomEvent('tulip:table-contextmenu', {
      bubbles: true,
      detail: {
        x: event.clientX,
        y: event.clientY,
        selectedCount: selection.length,
        deleteRowCount,
        canDeleteRow: deleteRowCount > 0,
        canAddRowBefore: row > 0,
        canAddColumn: !language,
        canDeleteColumn: !language && found.table.cols > 1,
        clearSelected: () => clearSelectedCells(view, wrap),
        addRowBefore: () => insertRow(view, cell, false),
        addRowAfter: () => insertRow(view, cell, true),
        addColumnBefore: () => insertColumn(view, cell, false),
        addColumnAfter: () => insertColumn(view, cell, true),
        deleteRow: () => deleteRow(view, cell),
        deleteColumn: () => deleteColumn(view, cell)
      }
    }))
  })

  cell.addEventListener('keydown', (event) => {
    const wrap = cell.closest('.tk-table-wrap')
    const r = Number(cell.dataset.row)
    const c = Number(cell.dataset.col)
    const cols = Number(wrap?.dataset.cols || 1)
    const rows = wrap?.querySelectorAll('tr').length || 1
    const firstEditableRow = wrap?.dataset.language === 'true' ? 1 : 0
    const selection = selectedCells(wrap)

    if ((event.key === 'Backspace' || event.key === 'Delete') && selection.length > 1) {
      event.preventDefault()
      clearSelectedCells(view, wrap)
      return
    }

    if (event.key === 'Escape' && selection.length > 1) {
      event.preventDefault()
      clearCellSelection(wrap)
      return
    }

    /* Vertical arrows always mean the geometrically adjacent cell. Native
       contenteditable movement otherwise escapes the table and can re-enter at
       the bottom-left cell. Horizontal arrows keep editing text until the
       caret reaches an edge, then cross one cell without wrapping rows. */
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const nr = r + (event.key === 'ArrowUp' ? -1 : 1)
      event.preventDefault()
      if (nr < firstEditableRow || nr >= rows) return
      focusCell(wrap, nr, c)
      return
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const offset = caretOffset(cell)
      const atEdge = event.key === 'ArrowLeft'
        ? offset === 0
        : offset === (cell.textContent || '').length
      if (!atEdge) return
      const nc = c + (event.key === 'ArrowLeft' ? -1 : 1)
      event.preventDefault()
      if (nc < 0 || nc >= cols) return
      focusCell(wrap, r, nc)
      return
    }

    if (event.key === 'Tab') {
      event.preventDefault()
      let nr = r
      let nc = c + (event.shiftKey ? -1 : 1)
      if (nc >= cols) { nc = 0; nr++ }
      if (nc < 0) { nc = cols - 1; nr-- }
      if (nr < firstEditableRow) return
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
  constructor (table, language = false) {
    super()
    this.language = language
    this.aligns = table.aligns
    this.cols = table.cols
    this.cells = table.rows.map((row) => {
      const texts = cellText(row.cells)
      while (texts.length < table.cols) texts.push('')   // ragged rows pad out
      return texts
    })
  }

  /* Compared field by field rather than through a serialised key. The widget is
     rebuilt on every document change, so building the key was a string the size
     of the table per keystroke — and the comparison it fed stops at the first
     cell that differs anyway. */
  eq (other) {
    if (other.language !== this.language || other.cols !== this.cols) return false
    if (other.aligns.length !== this.aligns.length) return false
    if (other.cells.length !== this.cells.length) return false
    for (let c = 0; c < this.aligns.length; c++) {
      if (other.aligns[c] !== this.aligns[c]) return false
    }
    for (let r = 0; r < this.cells.length; r++) {
      const mine = this.cells[r]
      const theirs = other.cells[r]
      if (mine.length !== theirs.length) return false
      for (let c = 0; c < mine.length; c++) if (mine[c] !== theirs[c]) return false
    }
    return true
  }

  toDOM (view) {
    /* The room above and below the table is padding on this box rather than a
       margin on the frame inside it. A block widget's margins are invisible to
       the editor — it measures the element, not the space around it — so a
       margin here left every line below the table a line adrift from where it
       was drawn, and clicks landed on the wrong one. */
    const box = document.createElement('div')
    box.className = 'tk-table-box'

    const wrap = document.createElement('div')
    wrap.className = 'tk-table-wrap'
    wrap.contentEditable = 'false'
    wrap.dataset.cols = String(this.cols)
    wrap.dataset.language = String(this.language)

    const table = document.createElement('table')
    table.className = 'tk-table'

    const thead = document.createElement('thead')
    thead.append(this.buildRow(view, 0))
    table.append(thead)

    const tbody = document.createElement('tbody')
    for (let r = 1; r < this.cells.length; r++) tbody.append(this.buildRow(view, r))
    table.append(tbody)

    wrap.append(table)
    wireCellSelection(wrap, view)

    const addControl = (kind, label, run) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `tk-table-add is-${kind}`
      button.contentEditable = 'false'
      button.setAttribute('aria-label', `Add ${kind}`)
      button.innerHTML = `<span class="tk-table-add-plus" aria-hidden="true">+</span>` +
        `<span class="tk-table-add-label">${label}</span>`
      // Keep the current cell alive until the click decides where focus goes.
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', run)
      return button
    }

    const firstCell = () => wrap.querySelector('[data-row="0"][data-col="0"]')
    const addRowButton = addControl('row', 'Row', () => {
      const cell = firstCell()
      if (cell) addRow(view, cell)
    })
    const addColumnButton = addControl('column', 'Column', () => {
      const cell = firstCell()
      if (cell) addColumn(view, cell)
    })

    box.append(wrap, addRowButton)
    if (!this.language) box.append(addColumnButton)
    return box
  }

  buildRow (view, r) {
    const tr = document.createElement('tr')
    tr.dataset.row = String(r)
    for (let c = 0; c < this.cols; c++) {
      const cell = document.createElement(r === 0 ? 'th' : 'td')
      const locked = this.language && r === 0
      cell.contentEditable = locked ? 'false' : 'plaintext-only'
      cell.spellcheck = false
      cell.dataset.row = String(r)
      cell.dataset.col = String(c)
      if (locked) {
        cell.classList.add('is-locked')
        cell.dataset.locked = 'true'
        cell.setAttribute('aria-readonly', 'true')
        cell.title = 'Language table columns are fixed'
      }
      if (this.aligns[c]) cell.style.textAlign = this.aligns[c]
      renderTableCell(view, cell, decode(this.cells[r]?.[c] ?? ''))
      // The source is read at focus time, not captured here: by then the widget
      // may be several edits old.
      if (!locked) wire(cell, view, () => currentText(view, cell))
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
    if (!(dom instanceof HTMLElement)) return false

    /* `toDOM` returns the outer sizing box; the grid metadata lives on its
       inner wrapper. Reading `dom.dataset.cols` therefore always failed and
       made CodeMirror replace the whole widget after every character. That
       detached the active contenteditable cell, so only the first character
       survived. Keep the existing grid when its shape and mode still match. */
    const wrap = dom.querySelector('.tk-table-wrap')
    if (!wrap ||
        wrap.dataset.cols !== String(this.cols) ||
        wrap.dataset.language !== String(this.language)) return false

    const table = wrap.querySelector('table')
    const tbody = table?.querySelector('tbody')
    if (!table || !tbody) return false

    while (tbody.children.length > this.cells.length - 1) tbody.lastElementChild.remove()
    while (tbody.children.length < this.cells.length - 1) {
      tbody.append(this.buildRow(view, tbody.children.length + 1))
    }

    const rows = [table.querySelector('thead tr'), ...tbody.children]
    rows.forEach((tr, r) => {
      tr.dataset.row = String(r)
      ;[...tr.children].forEach((cell, c) => {
        cell.dataset.row = String(r)
        cell.dataset.col = String(c)
        cell.style.textAlign = this.aligns[c] || ''
        if (cell === document.activeElement || cell.dataset.editing) return
        /* Typing one character rebuilds the widget, but only the cell that was
           typed in has changed. Redrawing the rest tore down and rebuilt their
           DOM — embeds, links and all — on every keystroke, which on a
           vocabulary table of a few hundred rows is the whole cost of editing
           it. */
        const source = decode(this.cells[r]?.[c] ?? '')
        if (cell.dataset.src === source) return
        renderTableCell(view, cell, source)
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
  const language = Boolean(state.facet(languageTableMode)())
  for (const [index, table] of tablesIn(state).entries()) {
    ranges.push(
      Decoration.replace({ widget: new TableWidget(table, language && index === 0), block: true })
        .range(table.from, table.to)
    )
  }
  return Decoration.set(ranges, true)
}

/** A replaced table still owns a source range, so CodeMirror may leave its
 * document cursor at that hidden boundary even when no contenteditable cell
 * currently has focus. Track that state independently of DOM focus and keep
 * the source caret and active-line paint out of the rendered grid. */
export const tableCursorGuard = ViewPlugin.fromClass(class {
  constructor (view) {
    this.view = view
    this.sync(view)
  }

  update (update) { this.sync(update.view) }

  sync (view) {
    const head = view.state.selection.main.head
    const language = Boolean(view.state.facet(languageTableMode)())
    view.dom.classList.toggle('is-language-table-editor', language)
    view.dom.classList.toggle('has-table-source-selection', Boolean(tableAt(view.state, head)))
  }

  destroy () {
    this.view.dom.classList.remove('has-table-source-selection', 'is-language-table-editor')
  }
})

/**
 * Could this transaction do nothing to the document's tables but slide them?
 *
 * Only when every change stays inside one line, types no pipe and no newline,
 * and lands with no `|` on its own line or the lines either side — a table
 * cannot begin without a pipe in its header line, so an edit that far from any
 * pipe can neither make one, break one, nor extend one. Everything else (which
 * includes all typing inside a table) takes the full walk. Line numbers cannot
 * move here — no newline is made or unmade — which is what lets the cached
 * tables be slid rather than re-found.
 */
function shiftOnly (tr) {
  const doc = tr.state.doc
  let ok = true

  tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
    if (!ok) return
    if (/[|\n]/.test(inserted.toString())) { ok = false; return }
    const before = tr.startState.doc.lineAt(fromA)
    if (toA > before.to) { ok = false; return }
    // The line as it stood matters as much as the line as it stands: deleting
    // a pipe can end a table whose neighbours never held one.
    if (before.text.includes('|')) { ok = false; return }

    const n = doc.lineAt(fromB).number
    for (let m = Math.max(1, n - 1); m <= Math.min(doc.lines, n + 1); m++) {
      if (doc.line(m).text.includes('|')) { ok = false; return }
    }
  })

  return ok
}

/** The cached tables, slid through a change that cannot have altered them. */
function shiftTables (tables, changes) {
  const map = (pos) => changes.mapPos(pos)
  return tables.map((t) => ({
    ...t,
    from: map(t.from),
    to: map(t.to),
    rows: t.rows.map((row) => ({
      line: row.line,
      cells: row.cells.map((c) => ({ ...c, from: map(c.from), to: map(c.to) }))
    }))
  }))
}

export const tablePreview = StateField.define({
  create: (state) => buildTables(state),
  update (value, tr) {
    if (!tr.docChanged) return value

    /* Typing prose nowhere near a pipe used to walk every line of the note —
       once for this field and again for the version cache behind locate().
       Both are slid instead; the cache is refilled here so the next locate()
       finds the new doc already answered. */
    if (cache.doc === tr.startState.doc && shiftOnly(tr)) {
      cache = { doc: tr.state.doc, tables: shiftTables(cache.tables, tr.changes) }
      return value.map(tr.changes)
    }
    return buildTables(tr.state)
  },
  provide: (field) => EditorView.decorations.from(field)
})
