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
import { undo, redo } from '@codemirror/commands'
import { getSearchQuery, searchPanelOpen } from '@codemirror/search'
import { escapeHtml } from './dom.js'
import { MONEY_SOURCE, moneyNode } from './money.js'
import { findMath, renderMathInto } from './math.js'
import {
  findEmbeds, specForEmbed, renderEmbed, withEmbedSize,
  embedResizeGrip, wireEmbedResize, fitImageCell
} from './assets.js'

const DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/* ------------------------------------------------------- column widths

   A column that has been given a width has to be remembered somewhere, and
   GFM has no syntax for one: a table is pipes and dashes and nothing else. The
   width is written on the line above the table instead, as an HTML comment —
   valid Markdown that every other renderer ignores, so the note still opens as
   a plain table anywhere else, and so the width survives the round trip through
   disk and git the way an image's `|400` does.

   Widths are set by the Fit columns command (`fitAllColumns`) and carried along
   when a column is added, removed or moved. There is no drag: the header's
   right-hand seam used to be one, and the menu is the whole of it now.

   The line is hidden in both views: the editing view's block widget starts at
   the comment rather than at the header, and the reading view's raw-HTML
   sanitiser already drops comments (src/rawhtml.js) — the widths are read off
   the token before that happens.
   ================================================================== */

const WIDTHS = /^\s*<!--\s*tk-widths:\s*([\d\s.]*?)\s*-->\s*$/

/** The smallest a column may be made — narrower than this and the padding
 *  alone fills it, so there is nowhere left for the text. */
const MIN_COLUMN_WIDTH = 44

/** The widths a marker line names, or null if the line is not one. A column
 *  with no width of its own is written `0`, meaning "size to the content". */
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
 *  column with no width of its own: none at all, size to the content. */
const columnWidth = (width) => (width ? `${Math.round(width)}px` : '')

/** The change that rewrites an existing marker line — or takes it away, newline
 *  and all, when there are no widths left to write, so a table back at its
 *  natural shape leaves the note exactly as it found it. */
function widthsChange (state, lineNumber, source) {
  const line = state.doc.line(lineNumber)
  return source
    ? { from: line.from, to: line.to, insert: source }
    : { from: line.from, to: Math.min(state.doc.length, line.to + 1) }
}

/**
 * Whether the open note is a `.lang` document. A function is carried
 * rather than a captured boolean because the same editor opens many notes.
 *
 * It says nothing about how the grid may be edited. A language table is a
 * Markdown file with a Markdown table in it, and every table in this file is
 * edited the same way — headers and all. What it decides is presentation: a
 * document that exists to be a grid is given the pane rather than the measure.
 */
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

/** How many columns a token stream's table has, counted off its header row.
 *  The token stream is the only place the reading view can be asked. */
function headerCells (tokens, open) {
  let cells = 0
  for (let at = open + 1; at < tokens.length; at++) {
    if (tokens[at].type === 'tr_close') break
    if (tokens[at].type === 'th_open') cells++
  }
  return cells
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
      /* Padded to the table's real width, so a marker written when the table
         was narrower still describes every column — and so the two views agree
         about which columns are content-sized, which is what decides whether
         the grid fills its frame. */
      tokens[i + 1].meta = {
        ...(tokens[i + 1].meta || {}),
        widths: padWidths(widths, Math.max(widths.length, headerCells(tokens, i + 1)))
      }
    }
  })

  const renderOpen = md.renderer.rules.table_open ||
    ((tokens, i, options, _env, self) => self.renderToken(tokens, i, options))

  md.renderer.rules.table_open = (tokens, i, options, env, self) => {
    const widths = tokens[i].meta?.widths
    if (!widths?.some(Boolean)) return renderOpen(tokens, i, options, env, self)
    tokens[i].attrJoin('class', 'has-column-widths')
    if (widths.some((width) => !width)) tokens[i].attrJoin('class', 'has-flexible-column')
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
  /* A cell is one line of Markdown, so `<br>` is the only line break it has —
     it is what Shift+Enter writes, and the reading view already breaks on it.
     Non-capturing, so the numbered groups below keep their numbers. */
  '(?:<br\\s*/?>)|' +
  '(\\*\\*|__)(.+?)\\1|(\\*|_)(.+?)\\3|`([^`]+)`|' +
  '\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]|\\[([^\\]]+)\\]\\(([^)]+)\\)|' +
  MONEY_SOURCE

/* Compiled once rather than per cell: a vocabulary table is a thousand cells,
   and the scan below already drives `lastIndex` by hand, so all a shared
   instance needs is to start from the top. */
const cellPattern = new RegExp(CELL_PATTERN, 'g')

/** The line break above, recognised again once the scanner has found one. */
const BREAK = /^<br\s*\/?>$/i

/* Every character that can begin anything the scanner below draws: emphasis,
   code, a link, an embed, a price, a break. A cell holding none of them is
   plain words, which in a vocabulary table is nearly every cell — and finding
   that out with one pass of a character class is worth it, because the
   alternative is two span-finders, a regex loop and a node-by-node rebuild for
   a string that was only ever going to be text. */
const MARKUP = /[*_`[\]($<]/

function renderCell (td, text, {
  resolve = () => null,
  onReady = () => {},
  onResize = null
} = {}) {
  if (!MARKUP.test(text)) {
    /* The same end state the loop below would reach, arrived at directly: one
       text node, no picture, no width of the cell's own. `textContent` on a
       cell that already holds exactly this text is a no-op in Chromium, which
       is the case on every keystroke in the *other* cells of the row. */
    if (td.firstChild?.nodeType !== Node.TEXT_NODE || td.childNodes.length !== 1) {
      td.replaceChildren(text)
    } else if (td.firstChild.data !== text) {
      td.firstChild.data = text
    }
    td.classList.remove('has-image-only')
    if (td.style.width) td.style.width = ''
    return
  }

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

    if (BREAK.test(match[0])) {
      td.append(document.createElement('br'))
    } else if (match[2] !== undefined) {
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
  selectCellContents(cell)
  window.getSelection()?.collapseToEnd()
}

/** Select-all inside a cell means that cell's text, not the note around it. */
function selectCellContents (cell) {
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(cell)
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

/**
 * A grid's rows, header first, in the order their `data-row` numbers them.
 *
 * The `colgroup` a sized table carries is skipped for free: it holds `col`
 * elements and no `tr`.
 */
const gridRows = (wrap) => wrap?.querySelectorAll(':scope > table > * > tr') || []

/**
 * One cell out of that list, by position.
 *
 * Indexed rather than matched: rows and cells are already in document order, so
 * this is two property reads where a `[data-row][data-col]` selector is a walk
 * of the whole grid. That is the difference between a rectangle costing a few
 * hundred node visits and costing a million — ⌘A over a vocabulary table asks
 * this question once per cell.
 */
function cellAt (rows, r, c, editableOnly = true) {
  const cell = rows[r]?.children[c]
  if (!cell) return null
  return !editableOnly || cell.getAttribute('contenteditable') === 'plaintext-only'
    ? cell
    : null
}

const cellIn = (wrap, r, c, editableOnly = true) =>
  cellAt(gridRows(wrap), r, c, editableOnly)

function focusCell (wrap, r, c) {
  const cell = cellIn(wrap, r, c, false)
  if (!cell) return false
  cell.focus()
  caretToEnd(cell)
  return true
}

/** Whether the browser's selection already covers the whole cell, which is
 *  what makes a second ⌘A mean something wider than the first. */
function cellFullySelected (cell) {
  const at = selectionOffsets(cell)
  return Boolean(at) && at.from === 0 && at.to === (cell.textContent || '').length &&
         at.to > at.from
}

/**
 * Where a cell rectangle is being drawn from.
 *
 * Kept on the wrap rather than in a variable because the widget is rebuilt on
 * every keystroke: the element holding a closure would be replaced mid-drag,
 * and the dataset survives that the way every other piece of grid state does.
 */
function setCellAnchor (wrap, { r, c }) {
  if (!wrap) return
  wrap.dataset.cellAnchorRow = String(r)
  wrap.dataset.cellAnchorCol = String(c)
}

function savedCellAnchor (wrap) {
  const r = Number(wrap?.dataset.cellAnchorRow)
  const c = Number(wrap?.dataset.cellAnchorCol)
  return Number.isInteger(r) && Number.isInteger(c) ? { r, c } : null
}

/** The four arrows as a step, so every handler that moves by one agrees. */
const STEPS = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1]
}

/**
 * Type text into a cell at the caret.
 *
 * `execCommand` because it is still the only call that inserts into a
 * `contenteditable` *and* leaves the browser's own caret and undo where they
 * should be; the manual path behind it is for the day it is finally gone.
 */
function insertIntoCell (view, cell, text) {
  if (document.execCommand?.('insertText', false, text)) return
  const current = cell.textContent || ''
  const at = selectionOffsets(cell) || { from: current.length, to: current.length }
  cell.textContent = current.slice(0, at.from) + text + current.slice(at.to)
  writeCell(view, cell)
  const range = document.createRange()
  const node = cell.firstChild || cell
  range.setStart(node, Math.min(at.from + text.length, (node.textContent || '').length))
  range.collapse(true)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
}

const selectedCells = (wrap) =>
  [...(wrap?.querySelectorAll('.tk-table-cell-selected') || [])]

function clearCellSelection (wrap) {
  for (const cell of selectedCells(wrap)) cell.classList.remove('tk-table-cell-selected')
  // Whatever `selectCellRectangle` believed is lit, nothing is now.
  SELECTED_RECTANGLE.delete(wrap)
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
    /* The app's context menu lives outside the grid, but pressing one of its
       commands is still the gesture that began inside the selected cells.
       Clearing here, before the button's click handler runs, leaves a
       multi-cell command with only the right-clicked cell to act on. */
    if (event.target instanceof Element && event.target.closest('#ctx')) return
    for (const wrap of document.querySelectorAll('.tk-table-wrap')) {
      if (!wrap.contains(event.target)) clearCellSelection(wrap)
    }
  }, true)
}

/* What each grid is currently showing as selected. Keyed by the frame, which is
   replaced whenever the widget is rebuilt — so a rebuilt grid, whose cells have
   lost the class with the rest of their DOM, is simply one this has never heard
   of and gets painted in full. */
const SELECTED_RECTANGLE = new WeakMap()

/**
 * Light the cells between two corners, and put out the ones that fell outside.
 *
 * Written as a difference rather than a repaint. A drag reports a rectangle per
 * pointer move, and each one used to clear every lit cell — found by searching
 * the whole grid — and then light every cell of the new rectangle: two class
 * changes per cell per frame, for a rectangle that had usually grown by a
 * single row. Over a vocabulary table that is most of the cost of dragging.
 *
 * Only the cells that changed side are touched now: extending a 40-row
 * selection by one row is four class changes rather than three hundred and
 * twenty, and no search at all.
 */
function selectCellRectangle (wrap, from, to) {
  const next = {
    top: Math.min(from.r, to.r),
    bottom: Math.max(from.r, to.r),
    left: Math.min(from.c, to.c),
    right: Math.max(from.c, to.c)
  }
  const had = SELECTED_RECTANGLE.get(wrap)
  SELECTED_RECTANGLE.set(wrap, next)

  const rows = gridRows(wrap)
  const light = (r, c, on) =>
    cellAt(rows, r, c)?.classList.toggle('tk-table-cell-selected', on)

  if (!had) {
    for (let r = next.top; r <= next.bottom; r++) {
      for (let c = next.left; c <= next.right; c++) light(r, c, true)
    }
    return
  }

  const inside = (rect, r, c) =>
    r >= rect.top && r <= rect.bottom && c >= rect.left && c <= rect.right

  /* Every row either rectangle covers. A row both of them cover has at most a
     band of columns to change; a row only one of them covers is that row's
     whole width either way. */
  for (let r = Math.min(had.top, next.top); r <= Math.max(had.bottom, next.bottom); r++) {
    const was = r >= had.top && r <= had.bottom
    const is = r >= next.top && r <= next.bottom
    if (!was && !is) continue
    const left = was && is ? Math.min(had.left, next.left) : (is ? next.left : had.left)
    const right = was && is ? Math.max(had.right, next.right) : (is ? next.right : had.right)
    for (let c = left; c <= right; c++) {
      const lit = was && inside(had, r, c)
      const wanted = is && inside(next, r, c)
      if (lit !== wanted) light(r, c, wanted)
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
    // A language table's header names its columns and is not editable by hand;
    // a rectangle that happens to cover it must not empty it either.
    selectedCells(wrap)
      .filter((cell) => !cell.dataset.locked)
      .map((cell) => ({ cell, value: '' }))
  )
}

/** A browser caret at one screen point, but only when it belongs to `cell`. */
function caretInCellAt (cell, x, y) {
  const caret = document.caretRangeFromPoint?.(x, y)
  if (!caret || !cell.contains(caret.startContainer)) return null
  return { node: caret.startContainer, offset: caret.startOffset }
}

/** Put the native contenteditable caret at a hit-tested position. */
function placeCaret (caret) {
  if (!caret?.node?.isConnected) return false
  const selection = window.getSelection()
  const range = document.createRange()
  range.setStart(caret.node, caret.offset)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

/**
 * The grid position under a screen point — or the nearest one, when the point
 * is off the table.
 *
 * A drag that runs past the last visible row still means "down to here", so it
 * has to keep naming a cell after the pointer has left the grid: over the note
 * below it, or off the bottom of the window entirely while the page scrolls.
 */
function cellPointNear (wrap, x, y) {
  const under = document.elementFromPoint(x, y)?.closest?.(
    '.tk-table [data-row][data-col][contenteditable="plaintext-only"]'
  )
  if (under && wrap.contains(under)) {
    return { r: Number(under.dataset.row), c: Number(under.dataset.col) }
  }

  const rows = gridRows(wrap)
  if (!rows.length) return null
  const r = nearestIndex(rows, y, 'top', 'bottom')
  return { r, c: nearestIndex(rows[r].children, x, 'left', 'right') }
}

/**
 * Which of a line of boxes `at` falls in, or the nearest one either side.
 *
 * The two ends are asked first, and they are the answer nearly every time this
 * is asked at all: the point is off the grid because a drag has run past the
 * last row, and a table of a few hundred words should not have to be measured
 * from the top to say so.
 */
function nearestIndex (boxes, at, low, high) {
  const last = boxes.length - 1
  const boxOf = (i) => boxes[i].getBoundingClientRect()
  if (at <= boxOf(0)[low]) return 0
  if (at >= boxOf(last)[high]) return last

  let best = 0
  let gap = Infinity
  for (let i = 0; i <= last; i++) {
    const box = boxOf(i)
    const away = Math.max(box[low] - at, at - box[high], 0)
    if (away < gap) { gap = away; best = i }
    if (!away) break
  }
  return best
}

/**
 * What a drag can pull against, measured once at the press.
 *
 * `pane` is the ancestor that scrolls the note up and down, clamped to the
 * window — a pane taller than the screen must still pull from the edge the
 * pointer can actually reach. `side` is the grid's own frame, and only when the
 * table is wider than the note it sits in. Neither of them moves while a button
 * is held, so asking per frame was a style recalc and a layout read for nothing.
 */
function dragBounds (wrap) {
  let pane = null
  for (let node = wrap.parentElement; node && !pane; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight + 1) continue
    const flow = getComputedStyle(node).overflowY
    if (flow !== 'auto' && flow !== 'scroll' && flow !== 'overlay') continue
    const box = node.getBoundingClientRect()
    pane = {
      el: node,
      near: Math.max(box.top, 0),
      far: Math.min(box.bottom, window.innerHeight)
    }
  }
  let side = null
  if (wrap.scrollWidth > wrap.clientWidth + 1) {
    const box = wrap.getBoundingClientRect()
    side = { el: wrap, near: box.left, far: box.right }
  }
  return { pane, side }
}

/* How wide the pull-strip along each edge is, and how far one frame moves when
   the pointer is buried in it. Ramped rather than fixed so easing into the edge
   creeps and running past it races. */
const DRAG_EDGE = 44
const DRAG_STEP = 20

/**
 * One axis of the pull, by however much the pointer is into that edge.
 *
 * Answers whether the page actually moved: a pane already at its end has
 * nothing more to give, and the rectangle under a still pointer is then already
 * as far as it goes.
 */
function pullEdge (band, axis, at) {
  if (!band) return false
  let speed = 0
  if (at < band.near + DRAG_EDGE) {
    speed = -Math.min(1, (band.near + DRAG_EDGE - at) / DRAG_EDGE) * DRAG_STEP
  } else if (at > band.far - DRAG_EDGE) {
    speed = Math.min(1, (at - (band.far - DRAG_EDGE)) / DRAG_EDGE) * DRAG_STEP
  }
  if (!speed) return false

  const was = band.el[axis]
  band.el[axis] = was + speed
  return band.el[axis] !== was
}

/** Drag rectangles and exchange them with spreadsheet apps as TSV. */
function wireCellSelection (wrap, view) {
  let drag = null
  let frame = 0
  watchForPressesAway()

  /* Grow the rectangle to whatever the pointer stands over now. Kept apart
     from the move handler because the auto-scroll below runs it again on a
     pointer that has not moved: the page slid underneath it, so a different
     row is under the same coordinates. */
  const extendTo = (x, y) => {
    if (!drag) return
    const point = cellPointNear(wrap, x, y)
    if (!point) return
    if (point.r === drag.point.r && point.c === drag.point.c) return
    drag.point = point
    if (!drag.selectingCells) {
      drag.selectingCells = true
      wrap.classList.add('is-selecting-cells')
      /* The native range that began in the first cell must not remain painted
         underneath the cell rectangle or be copied instead of its TSV. */
      window.getSelection()?.removeAllRanges()
    }
    selectCellRectangle(wrap, drag.anchor, point)
  }

  /**
   * Hold the pointer at an edge and the page comes to it.
   *
   * A rectangle is drawn against a note that is taller than the window, so the
   * rows being asked for are usually the ones still below the fold. Without
   * this the selection simply stopped at the last row that happened to be on
   * screen, because a still pointer sends no more move events and nothing else
   * was going to scroll.
   */
  const autoScroll = () => {
    if (!drag) { frame = 0; return }
    /* A note put away mid-drag takes its grid with it, and a drag that ends on
       a detached wrap never hears the mouseup that would have stopped this
       loop. Letting go of it here is what keeps the editor it holds from
       outliving the note. */
    if (!wrap.isConnected) { endDrag(); return }

    frame = requestAnimationFrame(autoScroll)
    if (!drag.selectingCells) return

    const { x, y } = drag.at
    let slid = pullEdge(drag.bounds.pane, 'scrollTop', y)
    // A table wider than the note scrolls sideways inside its own frame.
    if (pullEdge(drag.bounds.side, 'scrollLeft', x)) slid = true
    if (slid) extendTo(x, y)
  }

  /** Take the drag down and hand back what it had reached. */
  const endDrag = () => {
    document.removeEventListener('mousemove', onMove)
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    const finished = drag
    drag = null
    wrap.classList.remove('is-selecting-cells')
    return finished
  }

  /* On the document, not the wrap: past the last row the pointer is over the
     note, the pane, or nothing at all, and a listener on the grid stops
     hearing about a drag exactly when it leaves the grid. */
  const onMove = (event) => {
    if (!drag || !(event.buttons & 1)) return
    drag.at = { x: event.clientX, y: event.clientY }

    if (!drag.selectingCells) {
      const point = cellPointNear(wrap, event.clientX, event.clientY)
      if (point && point.r === drag.anchor.r && point.c === drag.anchor.c) {
        const anchor = caretInCellAt(drag.cell, drag.down.x, drag.down.y)
        const head = caretInCellAt(drag.cell, event.clientX, event.clientY)
        if (!anchor || !head) return
        event.preventDefault()
        /* A contenteditable cell is nested through CodeMirror's non-editable
           block widget. Chromium focuses and edits that cell correctly, but it
           does not begin a native drag range through the widget boundary. Make
           the same range explicitly from the browser's hit-tested carets. */
        window.getSelection()?.setBaseAndExtent(
          anchor.node, anchor.offset, head.node, head.offset
        )
        drag.selectingText = !window.getSelection()?.isCollapsed
        return
      }
    }

    event.preventDefault()
    extendTo(event.clientX, event.clientY)
  }

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

    /* A drag that stays inside one cell belongs to the text: make an ordinary
       character selection so Copy gets exactly the highlighted words. Only
       once the pointer crosses into a second cell does the gesture become the
       spreadsheet-style rectangle.

       Shift is the explicit exception. It extends the saved cell rectangle,
       so it has to claim the press immediately rather than beginning a native
       text selection that will be discarded a moment later. */
    const extended = event.shiftKey
    /* The browser cannot place its own caret because this handler claims the
       press for same-cell text drags and cross-cell rectangles. Reveal the
       cell's Markdown now, then ask Chromium which character is under the
       pointer in that editable source. Previously mouse-up always called
       `caretToEnd`, making direct placement impossible. */
    let pressedCaret = null
    if (!extended) {
      cell.focus({ preventScroll: true })
      pressedCaret = caretInCellAt(cell, event.clientX, event.clientY)
      placeCaret(pressedCaret)
    }
    drag = {
      anchor,
      point,
      cell,
      pressedCaret,
      down: { x: event.clientX, y: event.clientY },
      at: { x: event.clientX, y: event.clientY },
      bounds: dragBounds(wrap),
      selectingCells: extended,
      selectingText: false
    }
    setCellAnchor(wrap, anchor)
    if (extended) {
      event.preventDefault()
      wrap.classList.add('is-selecting-cells')
      selectCellRectangle(wrap, anchor, point)
    } else {
      clearCellSelection(wrap)
    }

    document.addEventListener('mousemove', onMove)
    if (!frame) frame = requestAnimationFrame(autoScroll)

    document.addEventListener('mouseup', () => {
      const finished = endDrag()
      if (!finished) return
      if (finished.selectingCells) {
        selectCellRectangle(wrap, finished.anchor, finished.point)
        /* The cell the drag ended on, so Shift+Arrow carries on growing the
           same rectangle — and without a scroll, because the page is where the
           drag left it and focusing the far corner would yank it back. */
        const last = cellIn(wrap, finished.point.r, finished.point.c) || finished.cell
        last.focus({ preventScroll: true })
        caretToEnd(last)
      } else if (!finished.selectingText) {
        /* A click still enters the cell for editing; a drag leaves its text
           range intact so the following Copy command can use it. */
        finished.cell.focus({ preventScroll: true })
        if (!placeCaret(finished.pressedCaret)) caretToEnd(finished.cell)
      }
    }, { once: true })
  })

  /* Cut is copy and then clear, and it has to be said here: the grid is a
     `contenteditable="false"` widget, so the browser's own cut has nothing to
     take out of it and a rectangle disappeared into a no-op. */
  wrap.addEventListener('copy', (event) => copySelection(wrap, event))
  wrap.addEventListener('cut', (event) => {
    if (!copySelection(wrap, event)) return
    clearSelectedCells(view, wrap)
  })

  wrap.addEventListener('paste', (event) => {
    const matrix = clipboardMatrix(event.clipboardData)
    if (!matrix) return
    const active = event.target.closest('[data-row][data-col]')
    if (!active) return
    event.preventDefault()
    pasteMatrix(view, wrap, active, matrix)
  })
}

/* ------------------------------------------------------------ clipboard */

/**
 * Put the selected rectangle on the clipboard, as tab-separated text and as an
 * HTML table.
 *
 * Both, because the two answer different questions. TSV is what a text editor
 * and this grid's own paste want; the HTML table is what a spreadsheet or a
 * document wants, and without it a block of cells arrived in Excel as one long
 * line of text with tabs in it.
 */
function copySelection (wrap, event) {
  const selected = selectedCells(wrap)
  if (selected.length < 2 || !event.clipboardData) return false
  event.preventDefault()

  /* The selection is a rectangle, so its bounds are its extremes — and the
     cells inside it are the elements already in hand, keyed by where they sit.
     Asking the DOM for each of them again is a subtree walk per cell. */
  const held = new Map()
  let top = Infinity
  let bottom = -Infinity
  let left = Infinity
  let right = -Infinity
  for (const cell of selected) {
    const r = Number(cell.dataset.row)
    const c = Number(cell.dataset.col)
    held.set(`${r}:${c}`, cell.textContent || '')
    top = Math.min(top, r)
    bottom = Math.max(bottom, r)
    left = Math.min(left, c)
    right = Math.max(right, c)
  }

  const grid = []
  for (let r = top; r <= bottom; r++) {
    const values = []
    for (let c = left; c <= right; c++) values.push(held.get(`${r}:${c}`) || '')
    grid.push(values)
  }

  event.clipboardData.setData('text/plain', grid.map((row) => row.join('\t')).join('\n'))
  event.clipboardData.setData(
    'text/html',
    '<table>' + grid.map((row) =>
      '<tr>' + row.map((value) => `<td>${escapeHtml(value)}</td>`).join('') + '</tr>'
    ).join('') + '</table>'
  )
  return true
}

/** A pasted HTML table as a grid of plain values, or null if there is no table
 *  in it — which is most HTML, and must fall through to the ordinary paste. */
function htmlMatrix (html) {
  if (!/<t[dhr]\b/i.test(html)) return null
  const table = new DOMParser().parseFromString(html, 'text/html').querySelector('table')
  const rows = [...(table?.querySelectorAll('tr') || [])]
    .map((tr) => [...tr.querySelectorAll('th, td')]
      .map((td) => td.textContent.replace(/\s+/g, ' ').trim()))
    .filter((row) => row.length)
  return rows.length ? rows : null
}

/** A pasted Markdown table as a grid — pasting one into a cell used to land the
 *  pipes themselves in that cell, one row per line. */
function markdownMatrix (text) {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2 || !DELIMITER.test(lines[1]) || !lines[1].includes('-')) return null
  if (!lines.every((line) => line.includes('|'))) return null
  return lines
    .filter((_, at) => at !== 1)
    .map((line) => splitRow(line).map(({ text: value }) => decode(value)))
}

/**
 * What is on the clipboard, as a grid — or null when it is not a grid at all
 * and the browser's own paste into the cell should be left alone.
 *
 * HTML first: a spreadsheet writes both flavours, and only the HTML one keeps
 * a cell that contains a line break in one cell.
 */
function clipboardMatrix (data) {
  if (!data) return null
  const matrix = htmlMatrix(data.getData('text/html') || '')
  if (matrix) return matrix

  const text = data.getData('text/plain') || ''
  const markdown = markdownMatrix(text)
  if (markdown) return markdown
  if (!text.includes('\t') && !/[\r\n]/.test(text)) return null

  const rows = text.replace(/\r/g, '').split('\n').map((row) => row.split('\t'))
  if (rows.length > 1 && rows.at(-1).every((value) => !value)) rows.pop()
  return rows
}

/**
 * Paste a grid in at a cell, growing the table if the grid runs past its edge.
 *
 * Growing is the whole point: the old paste wrote into the cells that happened
 * to exist and dropped the rest on the floor, so forty rows of vocabulary
 * pasted into a five-row table lost thirty-five of them without saying so.
 *
 * A paste that fits still goes through `replaceCellValues`, which addresses
 * each cell's own span and so leaves everyone else's padding and escaped pipes
 * exactly as they were. Only a paste that changes the shape of the table earns
 * the whole-grid rewrite.
 */
function pasteMatrix (view, wrap, active, matrix) {
  const table = tableAt(view.state, view.posAtDOM(wrap))
  if (!table) return
  const start = { r: Number(active.dataset.row), c: Number(active.dataset.col) }
  const width = Math.max(...matrix.map((row) => row.length))
  const needRows = start.r + matrix.length
  const needCols = start.c + width

  const cols = Math.max(table.cols, needCols)
  const many = matrix.length > 1 || width > 1

  if (needRows <= table.rows.length && cols === table.cols) {
    const assignments = []
    matrix.forEach((row, dr) => row.forEach((value, dc) => {
      const cell = cellIn(wrap, start.r + dr, start.c + dc)
      if (cell) assignments.push({ cell, value })
    }))
    replaceCellValues(view, assignments)
    if (many && assignments.length) {
      const last = assignments.at(-1).cell
      selectCellRectangle(wrap, start, {
        r: Number(last.dataset.row),
        c: Number(last.dataset.col)
      })
    }
    return
  }

  const cells = tableMatrix(table)
  for (const row of cells) while (row.length < cols) row.push('')
  while (cells.length < needRows) cells.push(Array.from({ length: cols }, () => ''))

  matrix.forEach((row, dr) => row.forEach((value, dc) => {
    const c = start.c + dc
    if (c >= cols) return
    cells[start.r + dr][c] = encode(value)
  }))

  const index = tablesIn(view.state).indexOf(table)
  const end = { r: needRows - 1, c: Math.min(needCols, cols) - 1 }
  writeTable(view, table, cells)

  requestAnimationFrame(() => {
    const grown = view.dom.querySelectorAll('.tk-table-wrap')[index]
    if (!grown) return
    if (many) selectCellRectangle(grown, start, end)
    focusCell(grown, end.r, end.c)
  })
}

const rowSource = (cells) => `| ${cells.join(' | ')} |`

/** A row with nothing in it, in the one spelling the whole file uses. */
const blankRow = (cols) => '|' + ' |'.repeat(cols)

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

/* --------------------------------------------------- whole-grid rewrites

   Sorting, moving a row or a column, and growing a table to fit a paste are
   not edits to a cell: they change which cell a value is in. Spelled as "here
   is the table now" rather than as a splice per line, they share one writer —
   which is also the one place that has to remember the delimiter and the width
   marker move with the grid.

   Padding is normalised in the process, the same trade `rewriteColumns` makes:
   the alternative is splicing around escaped pipes and ragged rows in three
   independent lists and hoping they stay in step.
   ================================================================== */

/** Every cell of a table as encoded source text, padded to the full width. */
function tableMatrix (table) {
  return table.rows.map((row) => {
    const texts = cellText(row.cells)
    while (texts.length < table.cols) texts.push('')
    return texts
  })
}

/** Alignments as long as the table is wide, for a grid that just grew. */
const padAligns = (aligns, cols) =>
  Array.from({ length: cols }, (_, c) => aligns[c] ?? null)

/**
 * Where a table's widths are written — as changes rather than as a dispatch,
 * so a rewrite of the grid can carry them in its own transaction.
 *
 * The one place that knows the marker line sits above the table and has to be
 * made when a table without one acquires a width. Both callers come through
 * here — the fit command and the splice that follows a column being added or
 * removed — because when the question was spelled separately in each of them
 * they had already drifted over padding.
 *
 * No padding of its own: `widthsSource` drops trailing automatic columns, so a
 * short array and a padded one write the same line.
 */
function widthChanges (view, table, widths) {
  const source = widthsSource(widths || [])
  if (table.widthsLine != null) {
    const line = view.state.doc.line(table.widthsLine)
    return line.text === source ? [] : [widthsChange(view.state, table.widthsLine, source)]
  }
  return source ? [{ from: table.from, insert: `${source}\n` }] : []
}

/**
 * Replace a whole table with the grid it should now hold, in one transaction.
 *
 * One transaction because the alternative is a history the reader has to undo
 * twice to put a sorted table back, and a frame in between where the delimiter
 * says one width and the rows say another — which is a table markdown-it will
 * not parse at all.
 *
 * Every caller hands over a rectangular grid — `tableMatrix` pads to the
 * table's width, and the paste that grows one pads as it grows — so the width
 * of the new table is the width of its header.
 */
function writeTable (view, table, cells, aligns = table.aligns, widths = table.widths) {
  const cols = cells[0].length
  const lines = [rowSource(cells[0])]
  lines.push(rowSource(padAligns(aligns, cols).map(delimiterSource)))
  for (let r = 1; r < cells.length; r++) lines.push(rowSource(cells[r]))

  view.dispatch({
    changes: [
      { from: table.from, to: table.to, insert: lines.join('\n') },
      ...widthChanges(view, table, widths)
    ],
    userEvent: 'input.table'
  })
}

/**
 * Put the caret back in a named cell once a rewrite has redrawn the grid.
 *
 * A whole-table rewrite replaces the widget, so the element that had focus is
 * gone by the time the transaction lands. The table is found again by its
 * position in the document — index rather than element, for the same reason
 * `setColumnAlign` and `deleteRow` do it that way.
 */
function refocus (view, tableIndex, r, c) {
  requestAnimationFrame(() => {
    const wrap = view.dom.querySelectorAll('.tk-table-wrap')[tableIndex]
    focusCell(wrap, r, c)
  })
}

/**
 * Move a body row up or down.
 *
 * The header does not move and nothing moves through it: row 0 is the one row
 * whose position means something to the format.
 */
function moveRow (view, cell, delta) {
  const found = locate(view, cell)
  if (!found) return
  const { table } = found
  const from = Number(cell.dataset.row)
  const to = from + delta
  if (from < 1 || to < 1 || to >= table.rows.length) return

  const cells = tableMatrix(table)
  ;[cells[from], cells[to]] = [cells[to], cells[from]]
  const index = tablesIn(view.state).indexOf(table)
  const col = Number(cell.dataset.col)
  cell.blur()
  writeTable(view, table, cells)
  refocus(view, index, to, col)
}

/**
 * Put a column somewhere else in the table — with its alignment and its width,
 * which are written elsewhere and would otherwise stay behind and land on its
 * neighbour.
 *
 * A move rather than a swap: dragging a column three places left puts it there
 * and shuffles the three it passed one place right, which is what dropping a
 * column into a gap means. Between neighbours the two are the same operation,
 * so the menu's "Move left" is this with `to = from - 1`.
 *
 * Alignments and widths are padded to the table's width first. Both are stored
 * short — a delimiter row can name fewer columns than the header, and the width
 * marker drops trailing automatic ones — and splicing a short array moves the
 * wrong entry, which put a column's alignment on the column beside it.
 */
function reorderColumn (view, table, from, to, focusRow = 0) {
  if (from === to || from < 0 || to < 0 || from >= table.cols || to >= table.cols) return false

  const shift = (list) => {
    const next = [...list]
    next.splice(to, 0, ...next.splice(from, 1))
    return next
  }
  const cells = tableMatrix(table).map(shift)
  const aligns = shift(padAligns(table.aligns, table.cols))
  const widths = table.widths ? shift(padWidths(table.widths, table.cols)) : null

  const index = tablesIn(view.state).indexOf(table)
  writeTable(view, table, cells, aligns, widths)
  refocus(view, index, focusRow, to)
  return true
}

/** One place at a time, which is the whole of what the menu and alt-arrow ask
 *  for. `reorderColumn` below does the splicing. */
function moveColumn (view, cell, delta) {
  const found = locate(view, cell)
  if (!found) return
  const from = Number(cell.dataset.col)
  const row = Number(cell.dataset.row)
  cell.blur()
  reorderColumn(view, found.table, from, from + delta, row)
}

/* Sorting reads the value a reader sees, not the source behind it: `**dog**`
   files under D, and a wikilink under the note it names. */
const sortKey = (text) => decode(text || '')
  .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
  .replace(/[*_`]/g, '')
  .trim()

/** A cell's value as a number, or null when it is not one. Prices and counts
 *  are what tables hold, so the usual dressing comes off first. */
function asNumber (text) {
  if (!/\d/.test(text)) return null
  const bare = text.replace(/[\s,$£€¥]/g, '')
  if (!/^[-+]?\d*\.?\d+%?$/.test(bare)) return null
  return Number(bare.replace('%', ''))
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** One body row cannot be out of order, so there is nothing to offer. The menu
 *  and the sort itself ask the same question of the same object. */
const canSort = (table) => table.rows.length > 2

/**
 * Sort the body rows by one column.
 *
 * Numbers sort as numbers when the whole column is numbers — a text sort puts
 * 10 before 9, and a column of prices is exactly the column someone reaches
 * for this on. Blank cells go last whichever way the sort runs: they are rows
 * with nothing to say about this column, not rows that come before everything.
 * Equal keys keep the order they had, so sorting by one column and then by
 * another leaves the first sort standing inside the second.
 */
function sortRows (view, cell, direction, { restoreFocus = true } = {}) {
  const found = locate(view, cell)
  if (!found || !canSort(found.table)) return
  const { table } = found
  const col = Number(cell.dataset.col)
  const cells = tableMatrix(table)

  const body = cells.slice(1).map((row, at) => ({ row, at, key: sortKey(row[col]) }))
  const numeric = body.some((entry) => entry.key) &&
                  body.every((entry) => !entry.key || asNumber(entry.key) !== null)

  const sign = direction === 'desc' ? -1 : 1
  body.sort((a, b) => {
    if (Boolean(a.key) !== Boolean(b.key)) return a.key ? -1 : 1
    const order = numeric
      ? asNumber(a.key) - asNumber(b.key)
      : collator.compare(a.key, b.key)
    return (sign * order) || a.at - b.at
  })

  const was = Number(cell.dataset.row) - 1
  const lands = body.findIndex((entry) => entry.at === was)
  const index = tablesIn(view.state).indexOf(table)
  cell.blur()
  writeTable(view, table, [cells[0], ...body.map((entry) => entry.row)])
  if (restoreFocus) refocus(view, index, lands < 0 ? 1 : lands + 1, col)
}

/**
 * Double-clicking a heading sorts the rows beneath it. The direction belongs
 * to the live heading rather than the Markdown: reopening a note starts with
 * the unsurprising first gesture, ascending, while a second gesture reverses
 * the order. `aria-sort` both records that state and tells assistive software
 * which column currently orders the table.
 */
function wireHeaderSort (cell, view) {
  cell.addEventListener('dblclick', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const direction = cell.getAttribute('aria-sort') === 'ascending' ? 'desc' : 'asc'
    const wrap = cell.closest('.tk-table-wrap')
    const col = Number(cell.dataset.col)

    sortRows(view, cell, direction, { restoreFocus: false })

    /* A whole-table rewrite is applied synchronously by CodeMirror and keeps
       this widget when its shape is unchanged. Resolve the headings again so
       this remains correct if a later widget policy replaces the DOM. */
    requestAnimationFrame(() => {
      const headings = wrap?.querySelectorAll('thead th') || []
      for (const heading of headings) heading.removeAttribute('aria-sort')
      const heading = headings[col]
      if (!heading) return
      heading.setAttribute('aria-sort', direction === 'desc' ? 'descending' : 'ascending')
      heading.title = `Double-click to sort ${direction === 'desc' ? 'ascending' : 'descending'}`
    })
  })
}

/**
 * Insert an empty body row beside the current one, then land in it.
 *
 * `col` is which cell of the new row to land in. The menu items start at the
 * beginning of the row; Enter keeps the column it was pressed in, so filling a
 * table down one column stays in that column.
 */
function insertRow (view, cell, after, col = 0) {
  const found = locate(view, cell)
  if (!found) return
  const { table } = found
  const current = Number(cell.dataset.row)
  const blank = blankRow(table.cols)
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
  if (!focusCell(wrap, row, col)) requestAnimationFrame(() => focusCell(wrap, row, col))
}

/** Append is what Enter and Tab past the last cell mean. */
function addRow (view, cell, col = 0) {
  const found = locate(view, cell)
  if (!found) return
  const last = found.table.rows.length - 1
  const anchor = cell.closest('.tk-table-wrap')
    ?.querySelector(`[data-row="${last}"][data-col="0"]`) || cell
  insertRow(view, anchor, true, col)
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
  if (!found) return { rows: [], table: null }
  const wrap = cell.closest('.tk-table-wrap')
  const selectedRows = new Set(
    selectedCells(wrap).map((selected) => Number(selected.dataset.row))
  )
  if (selectedRows.size < 2) {
    selectedRows.clear()
    selectedRows.add(Number(cell.dataset.row))
  }

  // Bottom of the selection first, so selecting every body row keeps the
  // earliest one when the table's one-row minimum prevents the final deletion.
  const candidates = [...selectedRows].sort((a, b) => b - a)
  // The header is the one row whose position means something to the format, so
  // a table always keeps it.
  const room = Math.max(0, found.table.rows.length - 1)
  return { rows: candidates.slice(0, room), table: found.table }
}

function deleteRow (view, cell) {
  const { rows, table } = rowsToDelete(view, cell)
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
    const nextRow = Math.max(0, Math.min(firstDeleted, remaining.length - 1))
    focusCell(nextWrap, nextRow, Number(cell.dataset.col))
  })
}

const deletableRowCount = (view, cell) => rowsToDelete(view, cell).rows.length

function deleteColumn (view, cell) {
  const found = locate(view, cell)
  if (!found || found.table.cols <= 1) return
  const tableIndex = tablesIn(view.state).indexOf(found.table)
  const col = Number(cell.dataset.col)
  const row = Number(cell.dataset.row)
  cell.blur()
  rewriteColumns(view, found.table, col, false)
  requestAnimationFrame(() => {
    const wrap = view.dom.querySelectorAll('.tk-table-wrap')[tableIndex]
    focusCell(wrap, row, Math.max(0, col - 1))
  })
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
  /* Whether anything in this table can still take up slack. A column nobody
     dragged is written `0` and sized by its content — under fixed layout it is
     also the column that absorbs the space between the dragged widths and the
     frame, one column at its own width rather than every column stretched in
     proportion. Either way the grid fills its frame; this only says how. */
  table.classList.toggle(
    'has-flexible-column',
    Boolean(signature) && widths.some((width) => !width)
  )

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

/** Measure the grid at its natural, unwrapped width without flashing it on
 *  screen. This is what "fit" means; making a column automatic merely lets the
 *  table's 100% minimum distribute spare pane width back into it. */
function fittedWidths (wrap, host = wrap?.closest('.cm-scroller')) {
  const table = wrap?.querySelector('table')
  if (!table || !host) return []

  const probe = table.cloneNode(true)
  probe.querySelector(':scope > colgroup')?.remove()
  probe.classList.remove('has-column-widths', 'has-flexible-column')
  Object.assign(probe.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    width: 'max-content',
    minWidth: '0',
    tableLayout: 'auto',
    visibility: 'hidden',
    pointerEvents: 'none'
  })
  /* Measured under the editor's own scroller, not on `document.body`. Every
     type size in the table is relative — the grid is `.92em` of the scroller's
     17px, a header is `.82em` of that — so a probe parented to the body
     inherits the 16px page default instead and measures a header ~6% narrower
     than the one on screen. The width written down was then a few pixels short
     of the text it was fitted to, and a one-word header like NOTES came back
     wrapped.

     The scroller rather than the grid itself, near as that is: the grid lives
     inside a block widget, and a node appended under `contentDOM` — even one
     taken away in the same breath — is a mutation CodeMirror answers by
     rebuilding the widget, which would throw away the caret mid-measure. The
     scroller is outside what the editor watches and carries the same
     inherited type. */
  host.append(probe)
  const widths = [...probe.querySelectorAll('thead th')]
    .map((head) => Math.max(MIN_COLUMN_WIDTH, Math.ceil(head.getBoundingClientRect().width)))
  probe.remove()
  return widths
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
    /* Draw from the document we just wrote, not from the editable DOM. A blank
       Markdown cell owns the padding between its pipes; Chromium preserves
       that padding when the first word is inserted, so reading the DOM back
       here made a newly learned word appear indented until it was entered a
       second time. The document span is the canonical, padding-free value. */
    renderTableCell(view, cell, decode(currentText(view, cell)))
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
    /* Images have their own vault-level menu. A contenteditable nested inside
       CodeMirror is not a dependable route for letting a native contextmenu
       bubble all the way to the stage, so hand the resolved path over through
       the same explicit custom-event boundary the cell menu uses below. */
    const image = event.target instanceof Element &&
                  event.target.closest('.embed-img[data-vault-image]')
    if (image) {
      event.preventDefault()
      event.stopPropagation()
      cell.dispatchEvent(new CustomEvent('tulip:image-contextmenu', {
        bubbles: true,
        detail: {
          path: image.dataset.vaultImage,
          x: event.clientX,
          y: event.clientY
        }
      }))
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const found = locate(view, cell)
    if (!found) return
    const wrap = cell.closest('.tk-table-wrap')
    const row = Number(cell.dataset.row)
    const col = Number(cell.dataset.col)
    const rows = wrap?.querySelectorAll('tr').length || 1
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
        canAddColumn: true,
        canDeleteColumn: found.table.cols > 1,
        /* Which way the chosen columns read now, so the menu can show the
           three alignments as a set with the current one ticked. Null when
           they disagree: a tick against "Center" while only half the selection
           is centred would be a claim the table does not support. */
        align: (() => {
          const cols = selectedColumns(cell)
          const first = found.table.aligns[cols[0]] || null
          return cols.every((c) => (found.table.aligns[c] || null) === first) ? first : null
        })(),
        /* What the row and column commands are allowed to do from here. The
           header neither moves nor moves through, so the menu says so rather
           than offering an entry that quietly does nothing. */
        canMoveRowUp: row > 1,
        canMoveRowDown: row > 0 && row < rows - 1,
        canMoveColumnLeft: col > 0,
        canMoveColumnRight: col < found.table.cols - 1,
        canSort: canSort(found.table),
        columnName: sortKey(found.table.rows[0]?.cells[col]?.text || '') ||
                    `column ${col + 1}`,
        clearSelected: () => clearSelectedCells(view, wrap),
        selectRow: () => {
          setCellAnchor(wrap, { r: row, c: 0 })
          selectCellRectangle(wrap, { r: row, c: 0 }, { r: row, c: found.table.cols - 1 })
        },
        selectColumn: () => {
          setCellAnchor(wrap, { r: 0, c: col })
          selectCellRectangle(wrap, { r: 0, c: col }, { r: rows - 1, c: col })
        },
        addRowBefore: () => insertRow(view, cell, false),
        addRowAfter: () => insertRow(view, cell, true),
        addColumnBefore: () => insertColumn(view, cell, false),
        addColumnAfter: () => insertColumn(view, cell, true),
        moveRowUp: () => moveRow(view, cell, -1),
        moveRowDown: () => moveRow(view, cell, 1),
        moveColumnLeft: () => moveColumn(view, cell, -1),
        moveColumnRight: () => moveColumn(view, cell, 1),
        sortAscending: () => sortRows(view, cell, 'asc'),
        sortDescending: () => sortRows(view, cell, 'desc'),
        deleteRow: () => deleteRow(view, cell),
        deleteColumn: () => deleteColumn(view, cell),
        setAlign: (align) => setColumnAlign(view, cell, align)
      }
    }))
  })

}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value))

/**
 * The grid's keymap.
 *
 * One listener on the wrap rather than one per cell. Keydown bubbles, so a
 * three-hundred-row table installed twelve hundred copies of this closure and
 * re-derived the grid's shape from the DOM in each of them; here the shape is
 * measured once per keystroke, and only by the branches that need it — every
 * plain character typed into a cell passes through on its way to the browser.
 */
function wireGridKeys (wrap, view) {
  wrap.addEventListener('keydown', (event) => {
    const cell = event.target.closest?.(
      '[data-row][data-col][contenteditable="plaintext-only"]'
    )
    if (!cell) return

    const r = Number(cell.dataset.row)
    const c = Number(cell.dataset.col)
    const cols = Number(wrap.dataset.cols || 1)
    const mod = event.metaKey || event.ctrlKey

    // Both of these are DOM queries over the whole grid, and most keystrokes
    // ask for neither.
    let rowMemo = 0
    const rowCount = () => rowMemo || (rowMemo = gridRows(wrap).length || 1)
    let cellMemo = null
    const selected = () => cellMemo || (cellMemo = selectedCells(wrap))

    if (event.key === 'Backspace' || event.key === 'Delete') {
      if (selected().length < 2) return
      event.preventDefault()
      clearSelectedCells(view, wrap)
      return
    }

    /* Escape lets go of one thing at a time: the rectangle if one is lit, and
       otherwise the grid itself. */
    if (event.key === 'Escape') {
      event.preventDefault()
      if (selected().length > 1) { clearCellSelection(wrap); return }
      const found = locate(view, cell)
      cell.blur()
      view.focus()
      if (found) {
        view.dispatch({ selection: { anchor: Math.min(found.table.to, view.state.doc.length) } })
      }
      return
    }

    /* Select-all belongs to the cell being edited — left to the editor it takes
       the whole note, table and all. Pressing it again, once the cell is
       already taken, widens to the table: the escalation the browser's own
       select-all has, without ever landing on "the note". */
    if (mod && event.key.toLowerCase() === 'a' && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      if (selected().length < 2 && !cellFullySelected(cell)) {
        clearCellSelection(wrap)
        selectCellContents(cell)
        return
      }
      window.getSelection()?.removeAllRanges()
      const from = { r: 0, c: 0 }
      setCellAnchor(wrap, from)
      selectCellRectangle(wrap, from, { r: rowCount() - 1, c: cols - 1 })
      return
    }

    /* Undo while a cell has focus. Without this the keystroke reaches the
       browser's own undo for the `contenteditable`, which knows about the
       characters in this cell and nothing about the document behind them — so
       it put text back that the note no longer said. */
    if (mod && event.key.toLowerCase() === 'z' && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      const found = locate(view, cell)
      const index = found ? tablesIn(view.state).indexOf(found.table) : -1
      cell.blur()
      ;(event.shiftKey ? redo : undo)(view)
      if (index >= 0) refocus(view, index, r, c)
      return
    }

    /* Excel's own two: the column of the cell you are in, and its row. */
    if (event.key === ' ' && (event.ctrlKey || event.shiftKey) && !event.altKey && !event.metaKey) {
      event.preventDefault()
      const from = event.ctrlKey ? { r: 0, c } : { r, c: 0 }
      const to = event.ctrlKey ? { r: rowCount() - 1, c } : { r, c: cols - 1 }
      setCellAnchor(wrap, from)
      selectCellRectangle(wrap, from, to)
      return
    }

    const step = STEPS[event.key]
    if (step) {
      const [dr, dc] = step

      // Alt is "bring this row or column with you".
      if (event.altKey && !mod) {
        event.preventDefault()
        if (dr) moveRow(view, cell, dr)
        else moveColumn(view, cell, dc)
        return
      }

      /* Vertical arrows always mean the geometrically adjacent cell. Native
         contenteditable movement otherwise escapes the table and can re-enter
         at the bottom-left cell. Horizontal arrows keep editing text until the
         caret reaches an edge, then cross one cell without wrapping rows — but
         only while they mean the caret at all: with Shift they are drawing a
         rectangle, and with ⌘ they are crossing the whole table. */
      if (dc && !event.shiftKey && !mod) {
        const offset = caretOffset(cell)
        const atEdge = dc < 0 ? offset === 0 : offset === (cell.textContent || '').length
        if (!atEdge) return
      }

      event.preventDefault()
      // A ⌘-arrow is the same step taken far enough that the clamp below lands
      // it on the edge, rather than a second set of edge arithmetic.
      const reach = mod ? Math.max(rowCount(), cols) : 1
      const target = {
        r: clamp(r + dr * reach, 0, rowCount() - 1),
        c: clamp(c + dc * reach, 0, cols - 1)
      }

      if (event.shiftKey) {
        // The rectangle grows from where it started, so a run of Shift+Down
        // extends one selection rather than pairing up cells two at a time.
        const anchor = (selected().length > 1 && savedCellAnchor(wrap)) || { r, c }
        setCellAnchor(wrap, anchor)
        selectCellRectangle(wrap, anchor, target)
        focusCell(wrap, target.r, target.c)
        return
      }
      if (target.r === r && target.c === c) return
      clearCellSelection(wrap)
      focusCell(wrap, target.r, target.c)
      return
    }

    if (event.key === 'Tab') {
      event.preventDefault()
      let nr = r
      let nc = c + (event.shiftKey ? -1 : 1)
      if (nc >= cols) { nc = 0; nr++ }
      if (nc < 0) { nc = cols - 1; nr-- }
      if (nr < 0) return
      // Tab off the last cell grows the table, which is the cheapest way to add
      // a row and the one every spreadsheet has trained people to expect.
      if (nr >= rowCount()) addRow(view, cell)
      else focusCell(wrap, nr, nc)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      /* A Markdown cell is one line, so the only line break it has is the one
         it can write down. Shift+Enter is where every editor puts that. */
      if (event.shiftKey) {
        insertIntoCell(view, cell, '<br>')
        return
      }
      if (r + 1 >= rowCount()) addRow(view, cell, c)
      else focusCell(wrap, r + 1, c)
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
    // Ragged rows pad out — the same grid the rewrites work on, so the widget
    // and the writer cannot disagree about what the table holds.
    this.cells = tableMatrix(table)
  }

  /* Compared field by field rather than through a serialised key. The widget is
     rebuilt on every document change, so building the key was a string the size
     of the table per keystroke — and the comparison it fed stops at the first
     cell that differs anyway. */
  eq (other) {
    if (other.language !== this.language ||
        other.cols !== this.cols) return false
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
    /* A real <table> with real <th scope="col"> cells is most of what a screen
       reader needs; the counts and indices are the rest, and they are what let
       it say "row 4 of 300" inside a grid whose cells are contenteditable
       divs rather than a form control it recognises. */
    table.setAttribute('aria-rowcount', String(this.cells.length))
    table.setAttribute('aria-colcount', String(this.cols))
    syncColumnWidths(table, this.widths)

    const thead = document.createElement('thead')
    thead.append(this.buildRow(view, 0))
    table.append(thead)

    const tbody = document.createElement('tbody')
    for (let r = 1; r < this.cells.length; r++) tbody.append(this.buildRow(view, r))
    table.append(tbody)

    wrap.append(table)
    wireCellSelection(wrap, view)
    wireGridKeys(wrap, view)

    box.append(wrap)
    return box
  }

  buildRow (view, r) {
    const tr = document.createElement('tr')
    tr.dataset.row = String(r)
    for (let c = 0; c < this.cols; c++) {
      const cell = document.createElement(r === 0 ? 'th' : 'td')
      cell.contentEditable = 'plaintext-only'
      cell.spellcheck = false
      cell.dataset.row = String(r)
      cell.dataset.col = String(c)
      if (r === 0) cell.scope = 'col'
      cell.setAttribute('aria-rowindex', String(r + 1))
      cell.setAttribute('aria-colindex', String(c + 1))
      if (this.aligns[c]) cell.style.textAlign = this.aligns[c]
      renderTableCell(view, cell, decode(this.cells[r]?.[c] ?? ''))
      if (r === 0) {
        cell.title = 'Double-click to sort · right-click for the column\u2019s menu'
        wireHeaderSort(cell, view)
      }
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

    // The column count cannot have changed — the shape check above returned
    // false if it had — and the row count changes only when the loop above did
    // something. Written on change rather than on every keystroke.
    if (table.getAttribute('aria-rowcount') !== String(this.cells.length)) {
      table.setAttribute('aria-rowcount', String(this.cells.length))
    }

    const rows = [table.querySelector('thead tr'), ...tbody.children]
    rows.forEach((tr, r) => {
      /* Where a row sits only changes when rows were added or taken away just
         above it, and the bail-out above means a cell never changes column. One
         string compare per row keeps the numbering — and the aria attributes,
         which the accessibility tree subscribes to — off the typing path. */
      const moved = tr.dataset.row !== String(r)
      if (moved) tr.dataset.row = String(r)
      ;[...tr.children].forEach((cell, c) => {
        if (moved) {
          cell.dataset.row = String(r)
          cell.dataset.col = String(c)
          cell.setAttribute('aria-rowindex', String(r + 1))
          cell.setAttribute('aria-colindex', String(c + 1))
        }
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
  if (!found?.span) return ''
  /* A blank span covers all whitespace between its pipes so writeCell can
     replace it in one change. That whitespace is source padding, not content:
     putting it into contenteditable shifts the first word to the right. */
  return found.span.blank
    ? ''
    : view.state.doc.sliceString(found.span.from, found.span.to)
}

/* ------------------------------------------------------- the extension */

/* A note's head is hidden by src/properties.js, in every note alike. This
   field used to hide it again in a language document, from a second block
   replacement over the same lines — which is why properties.js stood down
   there. One curtain now, so a language note's `study-front:` is edited in
   the Info pane exactly like any other note's frontmatter. */

function buildTables (state) {
  const ranges = []
  const language = Boolean(state.facet(languageTableMode)())

  for (const [index, table] of tablesIn(state).entries()) {
    ranges.push(
      Decoration.replace({
        widget: new TableWidget(
          table,
          language && index === 0
        ),
        block: true
      })
        // From `deco`: the width marker above the table is the widget's first
        // line, which is what keeps the comment off the page.
        .range(table.deco, table.to)
    )
  }
  return Decoration.set(ranges, true)
}

/* --------------------------------------------------- finding in a table

   ⌘F selects its match in the document, and the document behind a table is
   replaced by a widget — so a match inside a table was found, counted, and
   scrolled to, with nothing on screen to show for it. The editor cannot paint
   into a widget, so the widget paints for it: the same query, applied to the
   text the cells are showing.
   ================================================================== */

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A search query as a pattern, or null when it is not one worth painting. */
function searchPattern (query) {
  if (!query?.search || !query.valid) return null
  const flags = query.caseSensitive ? 'g' : 'gi'
  const body = query.regexp ? query.search : escapeRegex(query.search)
  try {
    return new RegExp(query.wholeWord ? `\\b(?:${body})\\b` : body, flags)
  } catch {
    return null
  }
}

/** Take the paint off, leaving the cell's own nodes as they were. */
function unmarkCell (cell) {
  const marks = cell.querySelectorAll('mark.tk-cell-match')
  if (!marks.length) return
  for (const mark of marks) mark.replaceWith(...mark.childNodes)
  cell.normalize()
}

/** Whether a cell owns its own DOM at the moment — the one being typed in is
 *  showing its own source, and nothing else may put elements in it. */
const cellIsEditing = (cell) =>
  Boolean(cell.dataset.editing) || cell === document.activeElement

function markCell (cell, pattern) {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)

  for (const node of nodes) {
    const text = node.nodeValue
    pattern.lastIndex = 0
    const pieces = document.createDocumentFragment()
    let at = 0
    let found

    while ((found = pattern.exec(text))) {
      // A pattern that can match nothing would otherwise never leave this loop.
      if (!found[0]) { pattern.lastIndex++; continue }
      if (found.index > at) pieces.append(text.slice(at, found.index))
      const hit = document.createElement('mark')
      hit.className = 'tk-cell-match'
      hit.textContent = found[0]
      pieces.append(hit)
      at = found.index + found[0].length
    }

    if (!at) continue
    if (at < text.length) pieces.append(text.slice(at))
    node.replaceWith(pieces)
  }
}

export const tableSearchHighlight = ViewPlugin.fromClass(class {
  constructor (view) {
    this.view = view
    /* The query object as the state last handed it over. CodeMirror keeps the
       same one while nothing about the search changes, so an identity compare
       answers "is this the query I already built a pattern for" without
       building a second one. */
    this.query = null
    this.pattern = null
    /* Exactly the cells carrying paint. Taking it off is then a walk of what
       was marked rather than of every cell in the note — on a vocabulary table
       that is a handful of elements instead of a thousand. */
    this.marked = new Set()
    this.paint(view)
  }

  /** The pattern for a state, rebuilt only when the search itself changed. */
  patternFor (state) {
    const query = searchPanelOpen(state) ? getSearchQuery(state) : null
    if (query !== this.query) {
      this.query = query
      this.pattern = query && searchPattern(query)
    }
    return this.pattern
  }

  update (update) {
    const before = this.pattern
    const pattern = this.patternFor(update.state)

    /* While nothing is being searched for this is one state read per update and
       no more: the cells are touched only when there is a query to paint, or
       paint left over from one that has just been closed. */
    if (!pattern && !this.marked.size) return
    if (pattern === before && !update.docChanged && !update.viewportChanged) return
    this.paint(update.view, pattern)
  }

  paint (view, pattern = this.patternFor(view.state)) {
    for (const cell of this.marked) unmarkCell(cell)
    this.marked.clear()
    if (!pattern) return

    for (const cell of view.dom.querySelectorAll('.tk-table-wrap [data-row][data-col]')) {
      /* The text the cell was drawn from answers "is there anything in here to
         mark" for the price of a regex test — no tree walk and no allocation,
         and it is already kept up to date for `updateDOM`'s staleness check.
         The cell being typed in owns its own DOM and is left out of it. */
      pattern.lastIndex = 0
      if (cellIsEditing(cell) || !pattern.test(cell.dataset.src || '')) continue
      markCell(cell, pattern)
      this.marked.add(cell)
    }
  }

  destroy () {
    this.paint(this.view, null)
  }
})

/**
 * Fit every column in the note to its widest cell.
 *
 * A column's width is a fixed number written into the note, and a fixed width
 * does not follow what is typed into it: a vocabulary table that was sized once
 * and added to fifty times ends up with words cut off in a column that was the
 * right size in March. This is the way back, for the whole note at once — and,
 * since the header seam stopped being a drag, the only thing that writes a
 * width at all. Everything else merely carries the widths already there along
 * when a column is added, removed or moved.
 *
 * Fit writes exact widths. Removing them would make the table's 100% minimum
 * share the pane's spare width between columns, which is automatic layout but
 * is not a content fit.
 *
 * Every table in the note, not every table on the screen. The editor only
 * builds widgets for the part of the document near the viewport, so a note with
 * a table at the top and another two screens down usually has one grid in the
 * DOM — and pairing the note's tables to that list by position in it handed the
 * first table the second one's measurements, or no measurements at all, which
 * erased the widths it already had. A table nobody has scrolled to is built for
 * the measurement and thrown away.
 */
export function fitAllColumns (view) {
  const language = Boolean(view.state.facet(languageTableMode)())

  /* Which grid on screen is which table, asked of the document rather than of
     the order the two lists happen to be in. */
  const drawn = new Map()
  for (const wrap of view.dom.querySelectorAll('.tk-table-wrap')) {
    const table = tableAt(view.state, view.posAtDOM(wrap))
    if (table) drawn.set(table.from, wrap)
  }

  const changes = tablesIn(view.state).flatMap((table, index) => {
    const wrap = drawn.get(table.from)
    /* Off screen: the same widget the editor would have built, measured
       detached and against the scroller's type. Pictures in it have not
       loaded, so a picture column is measured from the width hint the cell
       carries — which is what sizes it on screen too. */
    const widths = wrap
      ? fittedWidths(wrap)
      : fittedWidths(
        new TableWidget(table, language && index === 0)
          .toDOM(view).querySelector('.tk-table-wrap'),
        view.scrollDOM
      )
    return widths.length ? widthChanges(view, table, padWidths(widths, table.cols)) : []
  })
  if (!changes.length) return false
  view.dispatch({ changes, userEvent: 'input.table' })
  return true
}

/* ------------------------------------------------------ making a table */

/**
 * Put a new table where the cursor is, and land in its first cell.
 *
 * Typing the pipes and the dashes by hand is how you make a table anywhere
 * else in Markdown, and it is a poor way to start the one construct in this
 * editor that is never shown as source.
 */
export function insertTable (view, { rows = 3, cols = 3 } = {}) {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  const block = [
    rowSource(Array.from({ length: cols }, (_, c) => `Column ${c + 1}`)),
    rowSource(Array.from({ length: cols }, () => delimiterSource(null))),
    ...Array.from({ length: rows }, () => blankRow(cols))
  ]

  /* A table has to start its own block: written straight under a line of prose
     it is read as more of that paragraph, pipes and all. */
  const lead = line.text.trim() ? '\n\n' : ''
  const at = line.text.trim() ? line.to : line.from

  view.dispatch({
    changes: { from: at, insert: `${lead}${block.join('\n')}\n` },
    selection: { anchor: at + lead.length },
    userEvent: 'input.table'
  })

  const index = tablesIn(view.state).findIndex((table) => table.from >= at)
  if (index >= 0) refocus(view, index, 0, 0)
  return true
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
    view.dom.classList.toggle('has-table-source-selection', Boolean(tableAt(view.state, head)))
  }

  destroy () {
    this.view.dom.classList.remove('has-table-source-selection')
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
