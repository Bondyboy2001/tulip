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
  embedResizeGrip, wireEmbedResize, wireResizeHandle, fitImageCell
} from './assets.js'

const DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/* ------------------------------------------------------- column widths

   A dragged column has to be remembered somewhere, and GFM has no syntax for
   one: a table is pipes and dashes and nothing else. The width is written on
   the line above the table instead, as an HTML comment — valid Markdown that
   every other renderer ignores, so the note still opens as a plain table
   anywhere else, and so the width survives the round trip through disk and
   git the way an image's `|400` does.

   The line is hidden in both views: the editing view's block widget starts at
   the comment rather than at the header, and the reading view's raw-HTML
   sanitiser already drops comments (src/rawhtml.js) — the widths are read off
   the token before that happens.
   ================================================================== */

const WIDTHS = /^\s*<!--\s*tk-widths:\s*([\d\s.]*?)\s*-->\s*$/

/** The smallest a dragged column may be made — narrower than this and the
 *  padding alone fills it, so there is nowhere left for the text. */
const MIN_COLUMN_WIDTH = 44

/** The widths a marker line names, or null if the line is not one. A column
 *  the reader never dragged is written `0`, meaning "size to the content". */
function parseColumnWidths (text) {
  const found = WIDTHS.exec(text || '')
  if (!found) return null
  const widths = found[1].split(/\s+/).filter(Boolean).map(Number)
  return widths.every((w) => Number.isFinite(w) && w >= 0) ? widths : null
}

/** The marker line for a set of widths, or '' when every column is automatic
 *  again — the line is deleted rather than left saying nothing. */
function widthsSource (widths) {
  const kept = [...widths]
  // Trailing automatic columns say nothing, so they are not written; what is
  // left either ends in a real width or is empty.
  while (kept.length && !kept[kept.length - 1]) kept.pop()
  if (!kept.length) return ''
  return `<!-- tk-widths: ${kept.map((w) => Math.round(w) || 0).join(' ')} -->`
}

/** One column's width as CSS, in the one form both views write it. `0` is a
 *  column that was never dragged: no width at all, size to the content. */
const columnWidth = (width) => (width ? `${Math.round(width)}px` : '')

/** The change that rewrites an existing marker line — or takes it away, newline
 *  and all, when there are no widths left to write, so a table dragged back to
 *  its natural shape leaves the note exactly as it found it. */
function widthsChange (state, lineNumber, source) {
  const line = state.doc.line(lineNumber)
  return source
    ? { from: line.from, to: line.to, insert: source }
    : { from: line.from, to: Math.min(state.doc.length, line.to + 1) }
}

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

/**
 * The reading view's half of the same feature: the marker line above a table
 * is read off the token stream, hidden, and turned into the `<colgroup>` the
 * editing view draws from its own copy of the widths.
 *
 * A core rule rather than a pass over the rendered DOM, because the comment
 * does not survive that far — src/rawhtml.js drops every comment on its way
 * out, which is exactly why the marker is invisible everywhere else.
 */
export function columnWidthPlugin (md) {
  md.core.ruler.push('tk_column_widths', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length - 1; i++) {
      if (tokens[i].type !== 'html_block') continue
      const widths = parseColumnWidths(tokens[i].content)
      if (!widths) continue
      if (tokens[i + 1].type !== 'table_open') continue
      /* Emptied as well as hidden: `hidden` is honoured by markdown-it's own
         token renderer, and raw HTML has a rule of its own (src/rawhtml.js)
         that never sees the flag. */
      tokens[i].hidden = true
      tokens[i].content = ''
      tokens[i + 1].meta = { ...(tokens[i + 1].meta || {}), widths }
    }
  })

  const renderOpen = md.renderer.rules.table_open ||
    ((tokens, i, options, _env, self) => self.renderToken(tokens, i, options))

  md.renderer.rules.table_open = (tokens, i, options, env, self) => {
    const widths = tokens[i].meta?.widths
    if (!widths?.some(Boolean)) return renderOpen(tokens, i, options, env, self)
    tokens[i].attrJoin('class', 'has-column-widths')
    const cols = widths
      .map((w) => (w ? `<col style="width:${columnWidth(w)}">` : '<col>'))
      .join('')
    return `${renderOpen(tokens, i, options, env, self)}<colgroup>${cols}</colgroup>`
  }
}

/** Widths as long as the table is wide: a marker written for a narrower table
 *  — or one a column was added to since — still answers for every column. */
const padWidths = (widths, cols) =>
  Array.from({ length: cols }, (_, c) => widths[c] || 0)

/** Every table in the document, as line ranges plus their parsed contents. */
function findTables (state) {
  const tables = []
  const total = state.doc.lines

  /* Which fence the scan is inside, if any. Without this a table written
     *inside* a code block became a live editable grid in the editing view
     while the reading view — where markdown-it's fence rule has already
     swallowed the interior — correctly showed it as code. Typing in one of
     those cells wrote table edits into the body of the fence. Tracked the same
     way `headings` tracks it, and by the same rule: a fence closes only on its
     own character, so ``` does not end a ~~~ block. */
  let fence = null

  for (let n = 1; n < total; n++) {
    const head = state.doc.line(n)

    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(head.text)
    if (marker) {
      if (!fence) fence = marker[1][0]
      else if (marker[1][0] === fence) fence = null
      continue
    }
    if (fence) continue

    if (!head.text.includes('|')) continue
    /* Four spaces in is an indented code block, which markdown-it's table rule
       refuses for the same reason — the delimiter pattern below allows leading
       whitespace and would otherwise take one. */
    if (/^ {4,}|^\t/.test(head.text)) continue

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
      // A fence opening ends the table, whatever else is on the line: the rest
      // of it is code, and the reading view stops the table here too.
      if (/^\s{0,3}(`{3,}|~{3,})/.test(row.text)) break
      rows.push({ line: m, cells: splitRow(row.text, row.from) })
      last = m
    }

    /* A width marker counts as part of this table only when it sits directly
       on the line above the header. `from` still points at the header, because
       every structural rewrite below addresses the table by it and would
       otherwise write rows over the marker; `deco` is where the widget — and
       so the hiding of the comment — begins. */
    const above = n > 1 ? state.doc.line(n - 1) : null
    const widths = above ? parseColumnWidths(above.text) : null

    tables.push({
      from: head.from,
      to: state.doc.line(last).to,
      deco: widths ? above.from : head.from,
      widths: widths ? padWidths(widths, header.length) : null,
      widthsLine: widths ? n - 1 : null,
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

/* Measured from `deco`, not from `from`: a table with a width marker is a
   widget that starts a line higher, and `locate` asks this question with the
   widget's own position — which is the marker's. */
const tableAt = (state, pos) =>
  tablesIn(state).find((t) => pos >= t.deco && pos <= t.to) || null

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
  /* The picture of a picture-only cell, kept for the width hint the cell is
     given at the end — see `fitImageCell`. */
  let onlyImage = null
  /* Decided before the picture is dressed rather than after it: a picture that
     is the whole cell fills the cell, and a filling picture is one that carries
     no width of its own — so the `|140` has to be kept off it, not taken off it
     afterwards. */
  const fillsCell = embeds.length === 1 &&
                    embeds[0].from === 0 && embeds[0].to === text.length

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
        if (!fillsCell) {
          if (spec.width) media.style.width = `${spec.width}px`
          if (spec.height) media.style.height = `${spec.height}px`
        }
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
            commit: (width) => {
              /* The drag is over, and in a picture-only cell what it sized is
                 the cell — the picture goes back to filling it. What the drag
                 painted on the picture comes off, and the number it painted
                 goes on the cell instead: `resizeCellImage` deliberately does
                 not redraw the cell (the picture on screen is already the size
                 being written), so nothing else is going to do either. */
              if (fillsCell) {
                media.style.width = ''
                media.style.height = ''
                fitImageCell(td, media, width)
              }
              onResize(embed, width)
            }
          })
          shell.append(grip)
        }
        td.append(shell)
        imageOnly = embeds.length === 1 && embed.from === 0 && embed.to === text.length
        onlyImage = imageOnly ? { media, width: spec.width || null } : null
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
  /* A picture-only cell is filled by its picture, so the width the note asked
     for becomes the *cell's* — the reading view says the same thing in
     `markImageCells`. */
  td.style.width = ''
  if (onlyImage) fitImageCell(td, onlyImage.media, onlyImage.width)
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

/**
 * Put the editor's own cursor in the source behind the cell being typed into.
 *
 * A cell is a `contenteditable` inside a widget, so the caret you see is the
 * browser's and not CodeMirror's — and CodeMirror's own selection stays
 * wherever it was last put, which after opening a note is the very start of the
 * document. That matters for one reason: the history stores the selection
 * alongside each change, so undoing an edit made in a table restored a cursor
 * at position 0 and scrolled the whole note to the top, leaving the reader
 * hunting for the table they had been working in.
 *
 * Moving it here, when a cell takes focus, means the position recorded against
 * every later edit is inside that table. There is nothing to see: the caret is
 * hidden whenever the selection sits in a table (`tableCursorGuard` puts
 * `has-table-source-selection` on the editor for exactly this), and the cell's
 * own caret is the browser's, which this does not touch.
 */
function anchorSelectionTo (view, cell) {
  const found = locate(view, cell)
  const at = found?.span?.from ?? found?.row?.cells?.[0]?.from
  if (!Number.isInteger(at)) return
  const head = view.state.selection.main.head
  // Already in this table: leave it, so a click from one cell to the next does
  // not fill the history with selection-only transactions.
  if (tableAt(view.state, head) === found.table) return
  view.dispatch({
    selection: { anchor: Math.min(at, view.state.doc.length) },
    // Not scrolled to: the table is already on screen — the reader just
    // clicked it — and asking for it would fight their own scroll position.
    scrollIntoView: false
  })
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

/**
 * A press anywhere outside a grid lets that grid's selection go.
 *
 * A block of cells is a selection like any other, and every other selection in
 * the app ends when you click somewhere else. Without this the highlight stayed
 * lit while the caret was three paragraphs down the note, claiming a state the
 * next keystroke would not act on.
 *
 * One listener for the document, installed once, rather than one per table:
 * widgets are rebuilt on every keystroke, and a listener per widget is a
 * listener to take down again. The capture phase, so it runs before the grid's
 * own `mousedown` and cannot undo a selection that press is making — the wrap
 * the press landed in is the one wrap it skips.
 */
let watchingAway = false
function watchForPressesAway () {
  if (watchingAway) return
  watchingAway = true
  document.addEventListener('mousedown', (event) => {
    for (const wrap of document.querySelectorAll('.tk-table-wrap')) {
      if (!wrap.contains(event.target)) clearCellSelection(wrap)
    }
  }, true)
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
  watchForPressesAway()

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
 * Which columns an alignment applies to: every one the selection touches, or
 * the clicked cell's own when nothing is selected.
 *
 * Alignment is a property of a column — it lives in the delimiter row and
 * nowhere else — so selecting a block of cells and asking for centring means
 * centring the columns those cells are in. Reading only the clicked cell, as
 * this used to, silently applied it to one column and left the rest as they
 * were, which looks exactly like the command half-working.
 */
function selectedColumns (cell) {
  const wrap = cell.closest('.tk-table-wrap')
  const chosen = selectedCells(wrap)
  const cells = chosen.includes(cell) && chosen.length > 1 ? chosen : [cell]
  const cols = new Set()
  for (const one of cells) {
    const col = Number(one.dataset.col)
    if (Number.isInteger(col) && col >= 0) cols.add(col)
  }
  return [...cols]
}

/**
 * Set — or clear — a column's alignment.
 *
 * Alignment lives in the delimiter row and nowhere else, so unlike the column
 * mutations below this rewrites one line and leaves every cell alone: nobody's
 * padding or escaped pipes are touched to change how a column reads. Asking
 * for the alignment a column already has clears it back to the default, which
 * is what makes the three menu entries a set of switches rather than a
 * one-way trip.
 */
function setColumnAlign (view, cell, align) {
  const found = locate(view, cell)
  if (!found) return
  const { table } = found
  const col = Number(cell.dataset.col)
  if (!Number.isInteger(col) || col < 0 || col >= table.aligns.length) return

  const targets = selectedColumns(cell).filter((c) => c < table.aligns.length)
  if (!targets.length) return

  const aligns = [...table.aligns]
  /* The three menu entries are switches, so asking for an alignment a column
     already has clears it. Across several columns that has to be all-or-
     nothing, or one click would centre some and un-centre others: it clears
     only when every column named already reads that way. */
  const allHave = targets.every((c) => aligns[c] === align)
  for (const c of targets) aligns[c] = allHave ? null : align

  const tableIndex = tablesIn(view.state).indexOf(table)
  const row = Number(cell.dataset.row)
  const delimiter = view.state.doc.line(table.rows[0].line + 1)
  /* The widget is rebuilt by the dispatch — its `eq` compares alignments — so
     the cell being edited is about to be replaced by a new element. Blurring
     first and landing in the fresh one keeps the caret where the click was. */
  cell.blur()
  view.dispatch({
    changes: {
      from: delimiter.from,
      to: delimiter.to,
      insert: rowSource(aligns.map(delimiterSource))
    },
    userEvent: 'input.table'
  })
  requestAnimationFrame(() => {
    const wrap = view.dom.querySelectorAll('.tk-table-wrap')[tableIndex]
    focusCell(wrap, row, col)
  })
}

/**
 * Add or remove one column, everywhere the table records one.
 *
 * A column is four things written in four places — a cell in every row, an
 * alignment in the delimiter, and a width in the marker line — and inserting
 * or deleting it is the same splice at the same index in all of them, so it is
 * spelled once here rather than as a callback per list.
 *
 * Structural edits are deliberately normalised: changing the grid already
 * touches every row, and one predictable pipe shape is safer than trying to
 * splice around escaped pipes and ragged padding independently.
 */
function rewriteColumns (view, table, col, insert) {
  /* What a new column holds in each of the three lists. Deleting takes one
     out and hands back nothing. */
  const splice = (list, blank) =>
    (insert ? list.splice(col, 0, blank) : list.splice(col, 1), list)

  const changes = table.rows.map((row) => {
    const cells = cellText(row.cells)
    while (cells.length < table.cols) cells.push('')
    const line = view.state.doc.line(row.line)
    return { from: line.from, to: line.to, insert: rowSource(splice(cells, '')) }
  })

  const delimiter = view.state.doc.line(table.rows[0].line + 1)
  changes.push({
    from: delimiter.from,
    to: delimiter.to,
    insert: rowSource(splice([...table.aligns], null).map(delimiterSource))
  })

  /* A column added or removed moves every width after it. Rewritten in the
     same transaction, or the note would keep saying the old table's widths and
     the columns would appear to shuffle sideways. */
  if (table.widths && table.widthsLine != null) {
    changes.push(widthsChange(
      view.state,
      table.widthsLine,
      widthsSource(splice([...table.widths], 0))
    ))
  }

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

/** Append is what Enter and Tab past the last cell mean. */
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
  rewriteColumns(view, found.table, col, true)

  requestAnimationFrame(() => {
    const wrap = view.dom.querySelectorAll('.tk-table-wrap')[tableIndex]
    focusCell(wrap, 0, col)
  })
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
  rewriteColumns(view, found.table, col, false)
  view.focus()
}

/* ------------------------------------------------------ column resizing */

/**
 * Put a table's widths on it, or take them off.
 *
 * A `<colgroup>` rather than a width on every cell: `table-layout: fixed`
 * reads the first row and the column elements and nothing else, so this is one
 * write per column instead of one per cell — which on a vocabulary table of a
 * few hundred rows is the difference between a drag that follows the pointer
 * and one that does not.
 */
function syncColumnWidths (table, widths) {
  /* Every keystroke in a cell rebuilds the widget and arrives here, almost
     always with the widths the table already has. One string compare answers
     that, in place of a selector match, an array allocation and a style write
     per column. */
  const signature = widths?.some(Boolean) ? widths.join(' ') : ''
  if (table.dataset.widths === signature) return
  table.dataset.widths = signature

  table.classList.toggle('has-column-widths', Boolean(signature))

  let group = table.querySelector(':scope > colgroup')
  if (!signature) { group?.remove(); return }
  if (!group) {
    group = document.createElement('colgroup')
    table.prepend(group)
  }
  while (group.children.length > widths.length) group.lastElementChild.remove()
  while (group.children.length < widths.length) group.append(document.createElement('col'))
  ;[...group.children].forEach((col, c) => {
    col.style.width = columnWidth(widths[c])
  })
}

/** What every column currently measures, as the drag's starting point. Read
 *  from the header row, which is the row `table-layout: fixed` sizes from and
 *  the row that says how many columns there are. */
function measuredWidths (wrap) {
  return [...wrap.querySelectorAll('thead th')]
    .map((head) => Math.round(head.getBoundingClientRect().width))
}

/**
 * Write a table's column widths into the note, as the marker line above it.
 *
 * The first drag records *every* column, not just the one dragged: the grid
 * switches to `table-layout: fixed` the moment any width exists, and under
 * fixed layout a column with nothing to say takes a share of the leftover
 * rather than its own content's width — so the other columns would jump the
 * first time one of them was touched. Measured and written down, they stay
 * exactly where the reader last saw them.
 */
function commitColumnWidths (view, wrap, widths) {
  const table = tableAt(view.state, view.posAtDOM(wrap))
  if (!table) return
  const source = widthsSource(padWidths(widths, table.cols))

  if (table.widthsLine != null) {
    const line = view.state.doc.line(table.widthsLine)
    if (line.text === source) return
    view.dispatch({
      changes: widthsChange(view.state, table.widthsLine, source),
      userEvent: 'input.table'
    })
    return
  }
  if (!source) return
  view.dispatch({
    changes: { from: table.from, insert: `${source}\n` },
    userEvent: 'input.table'
  })
}

/**
 * The handle on a column's right edge, and the drag behind it.
 *
 * It lives inside the header cell, which is `contenteditable`, so it is marked
 * as not editable and carries no text: `writeCell` reads the cell's text back
 * into the note, and anything with characters in it would be typed into the
 * document. It is re-attached after every redraw of the cell for the same
 * reason the cell is redrawn at all — `renderCell` replaces the children.
 */
function ensureColumnGrip (cell, view) {
  // The grip is appended last and nothing follows it, so this is the whole
  // question — asked once per header cell per keystroke, which is why it is a
  // property read rather than a selector match.
  if (cell.lastElementChild?.classList.contains('tk-col-grip')) return

  const grip = document.createElement('span')
  grip.className = 'tk-col-grip'
  grip.contentEditable = 'false'
  grip.setAttribute('role', 'separator')
  grip.setAttribute('aria-orientation', 'vertical')
  grip.setAttribute('aria-label', 'Resize column')
  grip.title = 'Drag to set this column’s width · double-click to fit the content'
  cell.append(grip)

  /* The drag itself is the shared one — pointer capture, pacing, cancelling —
     so a column and a picture are dragged by the same gesture. All this has to
     add is what a column's width means. */
  let live = null

  wireResizeHandle(grip, {
    begin: () => {
      const wrap = cell.closest('.tk-table-wrap')
      const grid = wrap?.querySelector('table')
      if (!grid) return null

      const widths = measuredWidths(wrap)
      const col = Number(cell.dataset.col)
      if (!widths.length || !(col in widths)) return null

      /* Resolved once, not per frame: the class and the column elements are
         the same for the length of the drag, and re-deriving them was a
         selector match and an array allocation at 120Hz. */
      syncColumnWidths(grid, widths)
      live = {
        wrap,
        grid,
        widths,
        col,
        columns: [...grid.querySelector(':scope > colgroup').children]
      }
      wrap.classList.add('is-resizing-column')

      return {
        from: widths[col],
        min: MIN_COLUMN_WIDTH,
        // Horizontal only: a column has one dimension, and the row height is
        // the tallest cell's business.
        read: (dx) => dx
      }
    },
    paint: (width) => {
      live.widths[live.col] = width
      live.columns[live.col].style.width = columnWidth(width)
      // The grid's record of what it is wearing, kept true so the sync that
      // follows the drag can still tell whether anything changed.
      live.grid.dataset.widths = live.widths.join(' ')
    },
    commit: () => commitColumnWidths(view, live.wrap, live.widths),
    restore: () => {
      // The drag was taken away: back to whatever the note says.
      const table = tableAt(view.state, view.posAtDOM(live.wrap))
      syncColumnWidths(live.grid, table?.widths)
    },
    // Double-click hands the column back to its content, the way
    // double-clicking a picture's grip hands it back its natural size.
    reset: () => {
      const wrap = cell.closest('.tk-table-wrap')
      const widths = measuredWidths(wrap)
      if (!widths.length) return
      widths[Number(cell.dataset.col)] = 0
      commitColumnWidths(view, wrap, widths)
    },
    settle: () => {
      live?.wrap.classList.remove('is-resizing-column')
      live = null
    }
  })
}

function wire (cell, view, source) {
  /* Entering a cell swaps it to its own markdown: what you edit is what is in
     the file, so `**bold**` cannot be flattened by a round trip through the
     DOM. The flag records that the swap has happened, because the formatted
     text and the source are often identical and there is no telling them apart
     by looking. */
  const reveal = () => {
    view.dom.classList.add('has-table-cell-focus')
    anchorSelectionTo(view, cell)
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
    // Typing in a header replaced its children with its own source, the grip
    // among them; the redraw above is where it comes back.
    if (cell.dataset.row === '0') ensureColumnGrip(cell, view)
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
        /* Which way the chosen columns read now, so the menu can show the
           three alignments as a set with the current one ticked. Null when
           they disagree: a tick against "Center" while only half the selection
           is centred would be a claim the table does not support. */
        align: (() => {
          const cols = selectedColumns(cell)
          const first = found.table.aligns[cols[0]] || null
          return cols.every((c) => (found.table.aligns[c] || null) === first) ? first : null
        })(),
        clearSelected: () => clearSelectedCells(view, wrap),
        addRowBefore: () => insertRow(view, cell, false),
        addRowAfter: () => insertRow(view, cell, true),
        addColumnBefore: () => insertColumn(view, cell, false),
        addColumnAfter: () => insertColumn(view, cell, true),
        deleteRow: () => deleteRow(view, cell),
        deleteColumn: () => deleteColumn(view, cell),
        setAlign: (align) => setColumnAlign(view, cell, align)
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
    // Already padded to the table's width by `findTables`, and null when the
    // note names no widths at all.
    this.widths = table.widths
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
    for (let c = 0; c < this.cols; c++) {
      if ((other.widths?.[c] || 0) !== (this.widths?.[c] || 0)) return false
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
    syncColumnWidths(table, this.widths)

    const thead = document.createElement('thead')
    thead.append(this.buildRow(view, 0))
    table.append(thead)

    const tbody = document.createElement('tbody')
    for (let r = 1; r < this.cells.length; r++) tbody.append(this.buildRow(view, r))
    table.append(tbody)

    wrap.append(table)
    wireCellSelection(wrap, view)

    /* Nothing hangs off the edges of the table. Growing one is what the right
       button offers — insert row above/below, column left/right — and Tab past
       the last cell already appends. Two hover buttons saying a third time
       what those two say was chrome sitting over the note. */
    box.append(wrap)
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
      // Every column is draggable, including a locked language-table header:
      // the width of a column is not its contents.
      if (r === 0) ensureColumnGrip(cell, view)
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

    syncColumnWidths(table, this.widths)

    const rows = [table.querySelector('thead tr'), ...tbody.children]
    rows.forEach((tr, r) => {
      tr.dataset.row = String(r)
      ;[...tr.children].forEach((cell, c) => {
        cell.dataset.row = String(r)
        cell.dataset.col = String(c)
        cell.style.textAlign = this.aligns[c] || ''
        /* Typing one character rebuilds the widget, but only the cell that was
           typed in has changed. Redrawing the rest tore down and rebuilt their
           DOM — embeds, links and all — on every keystroke, which on a
           vocabulary table of a few hundred rows is the whole cost of editing
           it. */
        const source = decode(this.cells[r]?.[c] ?? '')
        const stale = cell !== document.activeElement && !cell.dataset.editing &&
                      cell.dataset.src !== source
        if (stale) renderTableCell(view, cell, source)
        /* After the redraw, not before: `renderCell` replaces the cell's
           children, and the grip is one of them. */
        if (r === 0) ensureColumnGrip(cell, view)
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
        // From `deco`: the width marker above the table is the widget's first
        // line, which is what keeps the comment off the page.
        .range(table.deco, table.to)
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
    deco: map(t.deco),
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
