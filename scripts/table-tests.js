/* The table's own behaviour, exercised against a real editor in a real
   document: the grid is a contenteditable inside a CodeMirror block widget, and
   almost everything worth testing about it — where focus lands, what the
   clipboard carries, what the caret was on when a key was pressed — only
   exists once both of those are real. Bundled and run inside Electron by
   scripts/test-table.mjs.

   Row numbers here are the grid's, not the file's: row 0 is the header, row 1
   is the first body row, and the delimiter line is not a row at all. So a
   four-line table is three rows, and its last body row is row 2. */

import { EditorView, keymap, tooltips } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { search, openSearchPanel, setSearchQuery, SearchQuery } from '@codemirror/search'
import {
  tablePreview, tableCursorGuard, tableSearchHighlight,
  tableAssetResolver, languageTableMode,
  insertTable, fitAllColumns
} from '../src/table.js'
import { propertiesPreview } from '../src/properties.js'
import { slashEmbed, slashCommands, embedChoices as embedChoicesFacet } from '../src/slash.js'
import { CompletionContext, autocompletion } from '@codemirror/autocomplete'
import { completionTooltipSize } from '../src/completion-tooltip.js'
import { markdown } from '@codemirror/lang-markdown'

const results = []

async function test (name, run) {
  /* What the harness watches to tell a stalled test from a starved renderer,
     and what it names when it gives up. Without it a suite that stops has
     nothing to say but "never finished". */
  window.__tableProgress = { name, done: results.length }
  const parent = document.createElement('div')
  document.body.append(parent)
  try {
    await run(parent)
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: `${error.message}\n${error.stack}` })
  }
  parent.remove()
}

function assert (ok, message) {
  if (!ok) throw new Error(message || 'assertion failed')
}

function equal (actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message || 'not equal'}\n  actual:   ${a}\n  expected: ${b}`)
}

function mount (parent, doc, {
  language = false,
  resolve = () => null
} = {}) {
  return new EditorView({
    doc,
    parent,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      search(),
      tableAssetResolver.of(resolve),
      languageTableMode.of(() => language),
      tablePreview,
      tableCursorGuard,
      tableSearchHighlight,
      /* The real editor loads this beside the grid — and both of them have an
         opinion about a note's head, which is the whole reason it is here. */
      propertiesPreview
    ]
  })
}

const frame = () => new Promise((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(resolve)))

/**
 * Wait for something to become true, rather than for a fixed number of frames.
 *
 * Two frames is how long CodeMirror's measure phase takes when the machine is
 * idle, and a test that assumes it will always be two fails on a loaded one for
 * no better reason than that the redraw had not happened yet — which is a
 * flake, not a finding. Frames are still what is waited on, so this stays in
 * step with the redraw; only the number of them is allowed to vary.
 *
 * @param {() => any} ready  checked after every frame
 * @param {number} frames    how many to allow before giving up
 */
async function until (ready, frames = 60) {
  for (let i = 0; i < frames && !ready(); i++) await frame()
  return ready()
}

const cellAt = (view, r, c) =>
  view.dom.querySelector(`.tk-table-wrap [data-row="${r}"][data-col="${c}"]`)

const key = (target, name, options = {}) => target.dispatchEvent(
  new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options })
)

function clipboard ({ text, html } = {}) {
  const data = new DataTransfer()
  if (text != null) data.setData('text/plain', text)
  if (html != null) data.setData('text/html', html)
  return data
}

const paste = (target, payload) => target.dispatchEvent(
  new ClipboardEvent('paste', {
    clipboardData: clipboard(payload), bubbles: true, cancelable: true
  })
)

/** Type into a focused cell the way the browser does: change the text, then
 *  say so. `input` is what the cell's write-back listens for. */
function type (cell, text) {
  cell.textContent = text
  cell.dispatchEvent(new InputEvent('input', { bubbles: true }))
}

/** The menu the right button would put up, caught on its way to the app. */
const menuFor = (cell, view) => new Promise((resolve) => {
  view.dom.addEventListener('tulip:table-contextmenu', (event) => resolve(event.detail), { once: true })
  cell.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 10, clientY: 10
  }))
})

const selectedCount = (view) =>
  view.dom.querySelectorAll('.tk-table-cell-selected').length

function caretOffsetIn (cell) {
  const selection = window.getSelection()
  assert(selection?.rangeCount === 1 && selection.isCollapsed, 'the cell has a caret')
  const active = selection.getRangeAt(0)
  assert(cell.contains(active.startContainer), 'the caret belongs to the cell')
  const before = document.createRange()
  before.selectNodeContents(cell)
  before.setEnd(active.startContainer, active.startOffset)
  return before.toString().length
}

const TABLE = [
  '| Word | Meaning |',
  '| --- | --- |',
  '| eins | one |',
  '| zwei | two |'
].join('\n')

/* --------------------------------------------------------------- tests

   In a function rather than at the top level: the bundle is loaded from a
   file:// page, where a module script is blocked outright, and an ordinary
   script cannot await. */

async function run () {
  // Enter keeps the column it was pressed in, including off the last row.
  await test('Enter stays in the same column', async (parent) => {
    const view = mount(parent, TABLE)
    cellAt(view, 1, 1).focus()
    key(cellAt(view, 1, 1), 'Enter')
    await frame()
    equal(document.activeElement.dataset.col, '1', 'moving down a row kept the column')

    key(document.activeElement, 'Enter')
    await frame()
    equal(document.activeElement.dataset.col, '1', 'appending a row kept the column')
    equal(view.state.doc.lines, 5, 'a row was appended')
  })

  // ⌘A takes the cell, then the table — never the note.
  await test('select-all escalates cell then table', async (parent) => {
    const view = mount(parent, TABLE)
    const cell = cellAt(view, 2, 0)
    cell.focus()
    key(cell, 'a', { metaKey: true })
    equal(window.getSelection().toString(), 'zwei', 'the cell text is selected')
    equal(selectedCount(view), 0, 'no cell rectangle yet')

    key(cell, 'a', { metaKey: true })
    equal(selectedCount(view), 6, 'the whole grid is selected')
  })

  // A normal click uses its character position; entering a rendered cell must
  // not force the caret to the end of its source.
  await test('clicking text places the caret between characters', async (parent) => {
    const view = mount(parent, '| Word | Meaning |\n| --- | --- |\n| alphabet | letters |')
    const cell = cellAt(view, 1, 0)
    await frame()
    const text = cell.firstChild
    assert(text?.nodeType === Node.TEXT_NODE, 'the test cell is plain text')
    const point = document.createRange()
    point.setStart(text, 3)
    point.collapse(true)
    const box = point.getBoundingClientRect()
    point.setStart(text, 4)
    point.collapse(true)
    const next = point.getBoundingClientRect()
    const cellBox = cell.getBoundingClientRect()
    /* A quarter of the way into the fourth character, not exactly on the
       boundary before it: on the boundary the hit test rounds either way with
       the font, and a hosted runner's font is not this machine's. */
    const x = box.x + Math.max(1, (next.x - box.x) / 4)
    const y = cellBox.top + cellBox.height / 2

    cell.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y
    }))
    document.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, button: 0, buttons: 0, clientX: x, clientY: y
    }))

    /* Between characters near the click, and not at either end — which is
       the claim. The exact boundary is the font's to decide: a hosted runner
       without this machine's font puts the same pixel a character over. */
    const offset = caretOffsetIn(cell)
    assert(offset >= 2 && offset <= 4, `the caret landed at ${offset}, not between the characters near the click`)
  })

  // A paste taller than the table grows it instead of dropping the overflow.
  await test('paste grows the table to fit', async (parent) => {
    const view = mount(parent, TABLE)
    const cell = cellAt(view, 1, 0)
    cell.focus()
    paste(cell, { text: 'drei\tthree\nvier\tfour\nfünf\tfive\nsechs\tsix' })
    await frame()
    const text = view.state.doc.toString()
    assert(text.includes('| sechs | six |'), `the last pasted row survived:\n${text}`)
    equal(view.state.doc.lines, 6, 'the table grew to hold every pasted row')
  })

  // A paste wider than the table grows it sideways, delimiter included.
  await test('paste grows the table sideways', async (parent) => {
    const view = mount(parent, TABLE)
    const cell = cellAt(view, 1, 1)
    cell.focus()
    paste(cell, { text: 'one\teins-again\tnoted' })
    await frame()
    equal(view.state.doc.line(2).text, '| --- | --- | --- | --- |', 'the delimiter grew with it')
    equal(
      view.state.doc.line(3).text, '| eins | one | eins-again | noted |',
      'the pasted row runs into the new columns'
    )
    equal(view.state.doc.line(4).text, '| zwei | two |  |  |', 'the other rows grew too')
  })

  // A paste that fits leaves everyone else's source alone.
  await test('paste that fits keeps the source as written', async (parent) => {
    const view = mount(parent, '| A | B |\n| --- | --- |\n|   x   | y |\n| p | q |')
    const cell = cellAt(view, 1, 0)
    cell.focus()
    paste(cell, { text: 'one\ttwo' })
    await frame()
    equal(
      view.state.doc.line(3).text, '|   one   | two |',
      'the author’s padding survived a paste into that cell'
    )
  })

  // Cut copies the rectangle and clears it.
  await test('cut takes a rectangle out', async (parent) => {
    const view = mount(parent, TABLE)
    const cell = cellAt(view, 1, 0)
    cell.focus()
    key(cell, 'ArrowDown', { shiftKey: true })
    key(document.activeElement, 'ArrowRight', { shiftKey: true })
    equal(selectedCount(view), 4, 'shift-arrows drew a 2×2 rectangle')

    const data = clipboard({ text: '' })
    cell.dispatchEvent(new ClipboardEvent('cut', {
      clipboardData: data, bubbles: true, cancelable: true
    }))
    await frame()
    equal(data.getData('text/plain'), 'eins\tone\nzwei\ttwo', 'the rectangle was copied as TSV')
    assert(data.getData('text/html').includes('<td>zwei</td>'), 'and as an HTML table')
    equal(view.state.doc.line(3).text, '|  |  |', 'the cells it took are empty')
  })

  // An HTML table on the clipboard pastes as a grid.
  await test('pasting an HTML table fills cells', async (parent) => {
    const view = mount(parent, TABLE)
    const cell = cellAt(view, 1, 0)
    cell.focus()
    paste(cell, {
      text: 'ignored',
      html: '<table><tr><td>drei</td><td>three</td></tr><tr><td>vier</td><td>four</td></tr></table>'
    })
    await frame()
    equal(view.state.doc.line(3).text, '| drei | three |', 'the first HTML row landed')
    equal(view.state.doc.line(4).text, '| vier | four |', 'and the second')
  })

  // So does a Markdown table.
  await test('pasting a Markdown table fills cells', async (parent) => {
    const view = mount(parent, TABLE)
    const cell = cellAt(view, 1, 0)
    cell.focus()
    paste(cell, { text: '| drei | three |\n| --- | --- |\n| vier | four |' })
    await frame()
    equal(view.state.doc.line(3).text, '| drei | three |', 'the header row landed as values')
    equal(view.state.doc.line(4).text, '| vier | four |', 'the delimiter was dropped')
  })

  // A plain word still pastes as text, not as a grid.
  await test('a plain paste is left to the browser', async (parent) => {
    const view = mount(parent, TABLE)
    const cell = cellAt(view, 2, 0)
    cell.focus()
    const claimed = !paste(cell, { text: 'drei' })
    assert(!claimed, 'the grid did not claim a one-word paste')
  })

  // ⌘-arrow crosses the table.
  await test('⌘-arrow jumps to the edge', async (parent) => {
    const view = mount(parent, TABLE)
    const cell = cellAt(view, 1, 0)
    cell.focus()
    key(cell, 'ArrowDown', { metaKey: true })
    await frame()
    equal(document.activeElement.dataset.row, '2', 'landed on the last row')
    key(document.activeElement, 'ArrowRight', { metaKey: true })
    await frame()
    equal(document.activeElement.dataset.col, '1', 'landed on the last column')
  })

  // Alt-arrow moves a row, and the header stays put.
  await test('alt-arrow moves a row', async (parent) => {
    const view = mount(parent, TABLE)
    const cell = cellAt(view, 2, 0)
    cell.focus()
    key(cell, 'ArrowUp', { altKey: true })
    // The move is a document change and a redraw; focus follows the redraw,
    // which on a loaded machine is not always two frames away.
    await until(() => document.activeElement?.dataset.row === '1')
    equal(view.state.doc.line(3).text, '| zwei | two |', 'the row moved up')
    equal(view.state.doc.line(1).text, '| Word | Meaning |', 'the header stayed')
    equal(document.activeElement.dataset.row, '1', 'focus followed the row')

    key(document.activeElement, 'ArrowUp', { altKey: true })
    await frame()
    equal(view.state.doc.line(1).text, '| Word | Meaning |', 'nothing moves through the header')
  })

  // Alt-arrow moves a column, with its alignment and its width.
  await test('alt-arrow moves a column with its alignment and width', async (parent) => {
    const view = mount(parent, '<!-- tk-widths: 120 300 -->\n| A | B |\n| :--- | ---: |\n| 1 | 2 |')
    const cell = cellAt(view, 0, 0)
    cell.focus()
    key(cell, 'ArrowRight', { altKey: true })
    await frame()
    const text = view.state.doc.toString()
    assert(text.includes('| B | A |'), `the header swapped:\n${text}`)
    assert(text.includes('| ---: | :--- |'), `the alignments came with them:\n${text}`)
    assert(text.includes('tk-widths: 300 120'), `so did the widths:\n${text}`)
  })

  // Sorting, from the menu the right button puts up.
  await test('sorting orders the body rows', async (parent) => {
    const view = mount(parent, '| W | N |\n| --- | --- |\n| pear | 9 |\n| apple | 10 |\n| fig | 2 |')
    const menu = await menuFor(cellAt(view, 1, 0), view)
    equal(menu.columnName, 'W', 'the menu names the column it would sort by')
    menu.sortAscending()
    await frame()
    equal(
      [3, 4, 5].map((n) => view.state.doc.line(n).text),
      ['| apple | 10 |', '| fig | 2 |', '| pear | 9 |'],
      'text sorted alphabetically'
    )
  })

  // A column of numbers sorts as numbers, not as text.
  await test('a numeric column sorts numerically', async (parent) => {
    const view = mount(parent, '| W | N |\n| --- | --- |\n| pear | 9 |\n| apple | 10 |\n| fig | 2 |')
    const menu = await menuFor(cellAt(view, 1, 1), view)
    menu.sortDescending()
    await frame()
    equal(
      [3, 4, 5].map((n) => view.state.doc.line(n).text),
      ['| apple | 10 |', '| pear | 9 |', '| fig | 2 |'],
      '10 sorts above 9'
    )
  })

  // Blank cells go last whichever way the sort runs.
  await test('blank cells sort last both ways', async (parent) => {
    const view = mount(parent, '| W |\n| --- |\n| b |\n|  |\n| a |')
    const menu = await menuFor(cellAt(view, 1, 0), view)
    menu.sortDescending()
    await frame()
    equal(
      [3, 4, 5].map((n) => view.state.doc.line(n).text),
      ['| b |', '| a |', '|  |'],
      'the empty row is still at the bottom'
    )
  })

  // The header itself is the direct sorting control: first ascending, then
  // descending, with every other cell travelling with its row.
  await test('double-clicking a heading toggles whole-row sorting', async (parent) => {
    const view = mount(parent, '| W | N |\n| --- | --- |\n| pear | 9 |\n| apple | 10 |\n| fig | 2 |')
    cellAt(view, 0, 0).dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true, cancelable: true
    }))
    await frame()
    equal(
      [3, 4, 5].map((n) => view.state.doc.line(n).text),
      ['| apple | 10 |', '| fig | 2 |', '| pear | 9 |'],
      'the first double-click sorts ascending and keeps rows together'
    )
    equal(cellAt(view, 0, 0).getAttribute('aria-sort'), 'ascending', 'the heading records ascending')

    cellAt(view, 0, 0).dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true, cancelable: true
    }))
    await frame()
    equal(
      [3, 4, 5].map((n) => view.state.doc.line(n).text),
      ['| pear | 9 |', '| fig | 2 |', '| apple | 10 |'],
      'the second double-click reverses the same whole rows'
    )
    equal(cellAt(view, 0, 0).getAttribute('aria-sort'), 'descending', 'the heading records descending')
  })

  // Images use the app-level image menu, not the surrounding cell menu. The
  // table relays the resolved path explicitly across the CodeMirror widget.
  await test('right-clicking a cell image requests the image menu', async (parent) => {
    const view = mount(parent, '| Picture |\n| --- |\n| ![Cat](cat.png) |', {
      resolve: (path) => path
    })
    const image = view.dom.querySelector('.tk-table-image[data-vault-image="cat.png"]')
    assert(image, 'the cell contains a resolved vault image')
    const request = new Promise((resolve) => {
      view.dom.addEventListener('tulip:image-contextmenu', (event) => resolve(event.detail), { once: true })
    })
    const claimed = !image.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 37, clientY: 52
    }))
    equal(await request, { path: 'cat.png', x: 37, y: 52 }, 'the image path and menu position were relayed')
    assert(claimed, 'the table suppressed the native context menu')
  })

  // Shift+Enter writes the only line break a Markdown cell has.
  await test('shift-enter inserts a break', async (parent) => {
    const view = mount(parent, TABLE)
    const cell = cellAt(view, 2, 1)
    cell.focus()
    key(cell, 'Enter', { shiftKey: true })
    await frame()
    assert(
      view.state.doc.line(4).text.includes('<br>'),
      `the break reached the note: ${view.state.doc.line(4).text}`
    )
    cell.blur()
    /* Blurring hands the cell back to the renderer, which draws the break as a
       <br>. Waited for rather than counted in frames: on a loaded machine that
       redraw is late, not absent, and the difference is what a flake is made
       of. */
    await until(() => cellAt(view, 2, 1)?.querySelector('br'))
    assert(
      cellAt(view, 2, 1).querySelector('br'),
      `and renders as a break, not as text: ${cellAt(view, 2, 1).innerHTML}`
    )
  })

  // Undo while a cell has focus undoes the document, not the DOM.
  await test('undo works from inside a cell', async (parent) => {
    const view = mount(parent, TABLE)
    const before = view.state.doc.toString()
    const cell = cellAt(view, 2, 0)
    cell.focus()
    type(cell, 'drei')
    assert(view.state.doc.toString().includes('drei'), 'the edit reached the note')

    key(cell, 'z', { metaKey: true })
    await frame()
    equal(view.state.doc.toString(), before, 'the note is back as it was')
    equal(document.activeElement?.dataset?.row, '2', 'and the caret is back in the cell')
  })

  // Row and column selection, on the keys every spreadsheet uses.
  await test('ctrl-space and shift-space select column and row', async (parent) => {
    const view = mount(parent, TABLE)
    const cell = cellAt(view, 1, 0)
    cell.focus()
    key(cell, ' ', { ctrlKey: true })
    equal(selectedCount(view), 3, 'the column, header included')

    key(cell, ' ', { shiftKey: true })
    equal(selectedCount(view), 2, 'the row')
  })

  // The same two from the context menu.
  await test('the menu selects a row and a column', async (parent) => {
    const view = mount(parent, TABLE)
    const menu = await menuFor(cellAt(view, 2, 1), view)
    menu.selectColumn()
    equal(selectedCount(view), 3, 'a column')
    menu.selectRow()
    equal(selectedCount(view), 2, 'a row')
  })

  // A find match inside a table is painted by the table.
  await test('find paints its matches inside the grid', async (parent) => {
    const view = mount(parent, TABLE)
    openSearchPanel(view)
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'zwei' })) })
    await frame()
    const marks = view.dom.querySelectorAll('.tk-table mark.tk-cell-match')
    equal(marks.length, 1, 'the match is marked')
    equal(marks[0].textContent, 'zwei', 'and it is the right text')

    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) })
    await frame()
    equal(view.dom.querySelectorAll('mark.tk-cell-match').length, 0, 'clearing takes the paint off')
  })

  // Making a table at all.
  await test('⌘⌥T inserts a table and lands in it', async (parent) => {
    const view = mount(parent, 'Some prose.')
    insertTable(view, { rows: 2, cols: 2 })
    await frame()
    const text = view.state.doc.toString()
    assert(text.includes('| Column 1 | Column 2 |'), `a table was written:\n${text}`)
    assert(text.startsWith('Some prose.\n\n'), `the paragraph is still a paragraph:\n${text}`)
    equal(document.activeElement?.dataset?.row, '0', 'the caret is in its first cell')
  })

  /* A language table's columns used to be a fixed schema, and a paste wider
     than it was clipped to fit. It is a Markdown table like any other now, so
     a wide paste grows it. */
  await test('a wide paste into a language table grows it', async (parent) => {
    const view = mount(parent, TABLE, { language: true })
    const cell = cellAt(view, 1, 0)
    cell.focus()
    paste(cell, { text: 'drei\tthree\textra' })
    await frame()
    equal(view.state.doc.line(3).text, '| drei | three | extra |',
      'the paste brought a column with it')
    equal(view.state.doc.line(1).text, '| Word | Meaning |  |',
      'and the header grew to match')
  })

  // The grid a screen reader sees.
  await test('the grid carries its structure', async (parent) => {
    const view = mount(parent, TABLE)
    const table = view.dom.querySelector('table.tk-table')
    equal(table.getAttribute('aria-rowcount'), '3', 'rows are counted')
    equal(table.getAttribute('aria-colcount'), '2', 'columns are counted')
    equal(cellAt(view, 0, 1).getAttribute('scope'), 'col', 'headers say what they head')
    equal(cellAt(view, 2, 1).getAttribute('aria-rowindex'), '3', 'cells know where they are')
  })

  // Fitting writes the content widths instead of making one automatic column
  // absorb all the unused width in the pane.
  await test('fitting all columns writes compact content widths', async (parent) => {
    const view = mount(parent, [
      '<!-- tk-widths: 120 300 -->',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '| C | D |',
      '| --- | --- |',
      '| 3 | 4 |'
    ].join('\n'), { language: true })

    equal(fitAllColumns(view), true, 'there was something to fit')
    const text = view.state.doc.toString()
    const markers = text.match(/<!-- tk-widths: ([\d ]+) -->/g) || []
    equal(markers.length, 2, `each table has fitted widths:\n${text}`)
    assert(markers.every((marker) => !/(?:^| )0(?: |$)/.test(marker)),
      `every fitted column has an exact width:\n${text}`)
    equal(fitAllColumns(view), false, 'and there is nothing left to do')
  })

  /* A fitted width has to be the width the column actually needs, and every
     type size in the grid is relative to the editor's own — the grid is `.92em`
     of the scroller, a header `.82em` of that. Measured against the page around
     the editor instead, the numbers came back a few per cent short, and a
     column whose header was its widest thing wrapped that header onto two
     lines. */
  await test('fitted widths are measured in the editor’s own type', async (parent) => {
    parent.style.width = '900px'
    const view = mount(parent, [
      // Headers wider than anything under them: what wrapped, in the shape it
      // wrapped in.
      '| Word | Notes | Example |',
      '| --- | --- | --- |',
      '| ναι | yes | ok |'
    ].join('\n'))
    /* The editor carries its own type size on the scroller (17px in the app)
       while the page around it is left at the 16px default. Exaggerated here so
       a fit taken in the wrong one is unmistakable rather than marginal. */
    view.scrollDOM.style.fontSize = '21px'
    await frame()

    equal(fitAllColumns(view), true, 'there was something to fit')
    await frame()
    const written = (view.state.doc.line(1).text.match(/\d+/g) || []).map(Number)
    equal(written.length, 3, `a width per column:\n${view.state.doc.line(1).text}`)

    /* What each column needs, measured the way the eye does: the same grid, in
       the same place, with nothing allowed to wrap. */
    const probe = view.dom.querySelector('.tk-table').cloneNode(true)
    probe.querySelector(':scope > colgroup')?.remove()
    probe.classList.remove('has-column-widths')
    Object.assign(probe.style, {
      position: 'fixed', left: '-100000px', top: '0', width: 'max-content',
      minWidth: '0', tableLayout: 'auto', visibility: 'hidden'
    })
    view.scrollDOM.append(probe)
    const needed = [...probe.querySelectorAll('thead th')]
      .map((head) => head.getBoundingClientRect().width)
    probe.remove()

    needed.forEach((need, c) => assert(written[c] >= need - 1,
      `column ${c} was written ${written[c]}px for content needing ${Math.ceil(need)}px`))
  })

  /* Only the tables near the viewport are built, so a note's tables and the
     grids on screen are not the same list — and read as though they were, the
     first table was given the second one's measurements or none at all. */
  await test('fitting reaches a table below the viewport', async (parent) => {
    const filler = Array.from({ length: 3000 }, (_, n) => `line ${n}`).join('\n')
    const view = mount(parent, [
      '<!-- tk-widths: 120 300 -->',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      filler,
      '',
      '<!-- tk-widths: 90 90 -->',
      '| Word | Notes |',
      '| --- | --- |',
      '| ναι | yes |'
    ].join('\n'))
    await frame()
    equal(view.dom.querySelectorAll('.tk-table-wrap').length, 1,
      'only the first grid was built')

    equal(fitAllColumns(view), true, 'there was something to fit')
    const markers = view.state.doc.toString().match(/<!-- tk-widths: ([\d ]+) -->/g) || []
    equal(markers.length, 2, 'both tables still name their widths')
    assert(markers[0] !== '<!-- tk-widths: 120 300 -->', 'the drawn table was fitted')
    assert(markers[1] !== '<!-- tk-widths: 90 90 -->', 'so was the one off screen')
    equal(fitAllColumns(view), false, 'and there is nothing left to do')
  })

  /* ------------------------------------------------ moving a column

     The header seam and the drag bar are gone; a column is moved from the menu
     the right button puts up, or with alt-arrow (tested above). These are the
     assertions the drag used to make, asked of the menu instead — what a move
     has to carry with it is a property of the move, not of the gesture. */

  const WIDE = [
    '<!-- tk-widths: 120 140 90 -->',
    '| A | B | C |',
    '| --- | :---: | ---: |',
    '| 1 | 2 | 3 |',
    '| 4 | 5 | 6 |'
  ].join('\n')

  /** Move column `from` one place at a time until it sits at `to`, each step
   *  through the menu entry a reader would pick. */
  async function moveColumnTo (view, from, to) {
    const step = to > from ? 1 : -1
    for (let col = from; col !== to; col += step) {
      const menu = await menuFor(cellAt(view, 0, col), view)
      const run = step > 0 ? menu.moveColumnRight : menu.moveColumnLeft
      assert(run, `column ${col} can be moved`)
      run()
      await frame()
    }
  }

  await test('moving a column right takes its rows with it', async (parent) => {
    const view = mount(parent, WIDE)
    await frame()
    await moveColumnTo(view, 0, 2)
    const doc = view.state.doc.toString().split('\n')
    equal(doc[1], '| B | C | A |', 'the header ended where it was sent')
    equal(doc[3], '| 2 | 3 | 1 |', 'and every row beneath it followed')
    equal(doc[4], '| 5 | 6 | 4 |', 'all of them')
  })

  /* A move, not a swap: the two columns it passed each came back one place
     rather than one of them jumping to the far end. */
  await test('moving a column left shuffles the ones it passed', async (parent) => {
    const view = mount(parent, WIDE)
    await frame()
    await moveColumnTo(view, 2, 0)
    equal(view.state.doc.line(2).text, '| C | A | B |', 'C went to the front')
  })

  /* Alignment and width are written elsewhere — the delimiter row and the
     marker line above the table — so a move that forgot them left a column's
     shape behind on its neighbour. */
  await test('a moved column keeps its alignment and its width', async (parent) => {
    const view = mount(parent, WIDE)
    await frame()
    await moveColumnTo(view, 1, 0)
    const doc = view.state.doc.toString().split('\n')
    equal(doc[0], '<!-- tk-widths: 140 120 90 -->', 'the widths moved with the columns')
    equal(doc[2], '| :---: | --- | ---: |', 'and so did the alignments')
  })

  /* The ends of the row have nowhere further to go, and the menu says so rather
     than offering a move that would do nothing. */
  await test('the outermost columns cannot be moved past the edge', async (parent) => {
    const view = mount(parent, WIDE)
    await frame()
    const first = await menuFor(cellAt(view, 0, 0), view)
    assert(!first.canMoveColumnLeft, 'the first column has no left')
    assert(first.canMoveColumnRight, 'but it can go right')
    const last = await menuFor(cellAt(view, 0, 2), view)
    assert(last.canMoveColumnLeft, 'the last can go left')
    assert(!last.canMoveColumnRight, 'and no further right')
  })

  await test('a language table column can be moved too', async (parent) => {
    const view = mount(parent, TABLE, { language: true })
    await frame()
    await moveColumnTo(view, 0, 1)
    equal(view.state.doc.line(1).text, '| Meaning | Word |', 'the fixed schema is gone')
  })

  /* A table with widths on it still fills the frame drawn round it. The widths
     here add up to far less than the window, which is the shape the bug had: a
     band of empty paper down the right of a language table. */
  await test('a sized table has no empty band beside it', async (parent) => {
    parent.style.width = '900px'
    const view = mount(parent, [
      '<!-- tk-widths: 120 140 0 90 -->',
      '| Word | English | Example | Notes |',
      '| --- | --- | :---: | --- |',
      '| ναι | yes |  |  |'
    ].join('\n'), { language: true })
    await frame()

    const wrap = view.dom.querySelector('.tk-table-wrap')
    const grid = wrap.querySelector('table.tk-table')
    const slack = wrap.clientWidth - grid.getBoundingClientRect().width
    assert(Math.abs(slack) < 2, `the grid reaches the frame (${slack}px short)`)

    const header = [...wrap.querySelectorAll('thead th')]
      .map((th) => Math.round(th.getBoundingClientRect().width))
    equal(header[0], 120, 'the first sized column kept its width')
    equal(header[1], 140, 'and so did the second')
    equal(header[3], 90, 'and the last')
    // Every pixel the sized columns did not claim went to the one that had no
    // width of its own, rather than being left as paper beside the grid.
    const spare = Math.round(wrap.clientWidth) - (120 + 140 + 90)
    assert(spare > 80, `the frame is wider than the sized columns (${spare}px spare)`)
    assert(
      Math.abs(header[2] - spare) < 2,
      `the slack went to the column with no width of its own (${header[2]}px of ${spare}px)`
    )
  })

  /* And when there is no such column, the grid still fills its frame — the
     widths are shared out in proportion instead of leaving a band of paper.
     A table always spans its row; the numbers say how the row is divided, not
     how much of it is used. */
  await test('a fully sized table still fills its frame', async (parent) => {
    parent.style.width = '900px'
    const view = mount(parent, [
      '<!-- tk-widths: 120 140 -->',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |'
    ].join('\n'))
    await frame()

    const wrap = view.dom.querySelector('.tk-table-wrap')
    const grid = wrap.querySelector('table.tk-table')
    const slack = wrap.clientWidth - grid.getBoundingClientRect().width
    assert(Math.abs(slack) < 2, `the grid reaches the frame (${slack}px of band)`)

    const header = [...wrap.querySelectorAll('thead th')]
      .map((th) => th.getBoundingClientRect().width)
    assert(Math.abs(header[1] / header[0] - 140 / 120) < .05,
      `the columns kept their proportions (${Math.round(header[0])}:${Math.round(header[1])})`)
  })

  /* A rectangle drawn towards the bottom of the window takes the page with it.
     The rows being asked for are the ones still below the fold, so a drag held
     against the edge has to scroll and keep selecting; before, it stopped at
     the last row that happened to be on screen. */
  await test('a drag past the bottom edge scrolls and keeps selecting', async (parent) => {
    parent.style.height = '150px'
    const rows = Array.from({ length: 24 }, (_, i) => `| w${i} | m${i} |`)
    const view = mount(parent, ['| Word | Meaning |', '| --- | --- |', ...rows].join('\n'))
    await frame()

    const scroller = view.dom.querySelector('.cm-scroller')
    assert(
      scroller.scrollHeight > scroller.clientHeight + 1,
      'the note is taller than the pane it is being read in'
    )

    const start = cellAt(view, 1, 0)
    const box = start.getBoundingClientRect()
    const at = (type, x, y, extra = {}) => document.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, ...extra
    }))
    start.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      clientX: box.left + 4, clientY: box.top + 4
    }))

    // Held below the pane and not moved again: from here on it is the page that
    // has to come to the pointer.
    const below = scroller.getBoundingClientRect().bottom + 20
    at('mousemove', box.left + 4, below, { buttons: 1 })

    const last = () => view.dom.querySelector('[data-row="24"][data-col="0"]')
    for (let i = 0; i < 90 && !last()?.classList.contains('tk-table-cell-selected'); i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    const scrolled = scroller.scrollTop
    at('mouseup', box.left + 4, below)

    assert(scrolled > 0, `the pane scrolled down (scrollTop ${scrolled})`)
    assert(
      last()?.classList.contains('tk-table-cell-selected'),
      'the drag reached the last row, which was never on screen'
    )
    // The pointer never left the first column, so neither did the rectangle.
    equal(selectedCount(view), 24, 'and took every cell of that column between')
    equal(scroller.scrollTop, scrolled, 'letting go did not throw the page back')
  })

  await test('a language table header can be edited', async (parent) => {
    const view = mount(parent, TABLE, { language: true })
    const header = cellAt(view, 0, 0)
    equal(header.contentEditable, 'plaintext-only', 'the custom header is editable')
    header.focus()
    type(header, 'Letter')
    await frame()
    equal(view.state.doc.line(1).text, '| Letter | Meaning |', 'the new header was saved')
  })

  await test('the menu deletes the active row', async (parent) => {
    const view = mount(parent, TABLE, { language: true })
    const cell = cellAt(view, 2, 0)
    cell.focus()
    const menu = await menuFor(cell, view)
    assert(menu.canDeleteRow, 'the row entry is available')
    menu.deleteRow()
    await frame()
    assert(!view.state.doc.toString().includes('zwei'), 'the active row was deleted')
    equal(view.dom.querySelectorAll('tbody tr').length, 1, 'one body row remains')
  })

  await test('the menu deletes a custom table column', async (parent) => {
    const view = mount(parent, TABLE, { language: true })
    const cell = cellAt(view, 1, 1)
    cell.focus()
    const menu = await menuFor(cell, view)
    assert(menu.canDeleteColumn, 'the custom column entry is available')
    menu.deleteColumn()
    await frame()
    equal(view.dom.querySelector('table').getAttribute('aria-colcount'), '1', 'one column remains')
    equal(view.state.doc.line(1).text, '| Word |', 'the active column was deleted')
  })

  /* A language table is a Markdown file with a Markdown table in it, and every
     table is edited the same way. Vocabulary used to hold a fixed study schema
     its columns could not be added to, removed from or moved. */
  await test('a language table has no fixed columns', async (parent) => {
    const view = mount(parent, TABLE, { language: true })
    const cell = cellAt(view, 1, 1)
    cell.focus()
    const menu = await menuFor(cell, view)
    assert(menu.canDeleteColumn, 'a column can be deleted')
    assert(menu.canAddColumn, 'and one can be added')
    assert(menu.canMoveColumnLeft, 'and this one can be moved left')
  })

  /* In a language document the grid is the document, and the frontmatter is
     settings about the table rather than text in it — which columns the cards
     come from, which kinds of card to make. It stays in the file and is still
     what anything reading the note off disk sees; it is only not drawn. */
  const WITH_FRONTMATTER = ['---', 'study-stages: f', 'lang: el', '---', TABLE].join('\n')

  await test('a language table hides its frontmatter', async (parent) => {
    const view = mount(parent, WITH_FRONTMATTER, { language: true })
    await frame()
    assert(!view.contentDOM.textContent.includes('study-stages'),
      'the settings were drawn above the grid')
    assert(view.state.doc.toString().includes('study-stages: f'),
      'and yet they must still be in the document')
    assert(cellAt(view, 1, 0), 'the grid is still there')
  })

  /* The head is metadata, and metadata is shown in the Info pane — not at the
     top of the page, in either view. It is still in the file. */
  await test('an ordinary note hides its frontmatter', async (parent) => {
    const view = mount(parent, WITH_FRONTMATTER)
    await frame()
    assert(!view.contentDOM.textContent.includes('study-stages'),
      'the head was drawn in the note')
    assert(!view.dom.querySelector('.tags-editor'),
      'and no form of it stands there either')
    assert(view.state.doc.toString().includes('study-stages: f'),
      'and yet it must still be in the document')
  })

  await test('a note that is only frontmatter still has a cursor', async (parent) => {
    for (const doc of ['---\nlang: el\n---', '---\nlang: el\n---\n']) {
      const view = mount(parent, doc)
      await frame()
      view.dispatch({ selection: { anchor: view.state.doc.length } })
      view.focus()
      assert(view.state.selection.main.head === view.state.doc.length,
        `no home for the cursor in ${JSON.stringify(doc)}`)
      view.destroy()
    }
  })

  /* ------------------------------------------------------- the slash key

     `/` at the start of a line makes an embed placeholder instead of opening
     a menu; the chip it leaves is clickable, and `![[` targets answer typing
     with an inline ghost. The old suite for the completion-menu version of
     this (its options, /table, /tags) tested a surface this one removed. */

  /** Type one character the way the browser would. */
  const typeChar = (view, char) => view.dispatch({
    changes: { from: view.state.selection.main.head, insert: char },
    selection: { anchor: view.state.selection.main.head + char.length },
    userEvent: 'input.type'
  })

  /** What the slash menu offers with the caret at the end of the document —
   *  the labels in the order they would be listed, or null for no menu. */
  const slashMenu = (view) => {
    const result = slashCommands(
      new CompletionContext(view.state, view.state.selection.main.head, false))
    return result ? result.options.map((o) => o.label) : null
  }

  /** The editor the slash behaviour lives in: the placeholder field, the
   *  ghost, and a small vault to complete against. */
  function slashMount (parent, doc, choices = [], extra = []) {
    return new EditorView({
      doc,
      parent,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        search(),
        embedChoicesFacet.of(() => choices),
        ...slashEmbed,
        ...extra
      ]
    })
  }

  const ghostText = (view) =>
    view.dom.querySelector('.tk-embed-ghost')?.textContent ?? null

  await test('typing / at the start of a line opens the menu', async (parent) => {
    const view = slashMount(parent, '')
    typeChar(view, '/')
    await frame()
    equal(view.state.doc.toString(), '/', 'the slash stayed in the text for the menu to filter')
    const labels = slashMenu(view)
    assert(labels?.includes('Table') && labels.includes('Code block'),
      `the menu did not offer its commands: ${JSON.stringify(labels)}`)
  })

  await test('typing after the slash narrows the menu', async (parent) => {
    const view = slashMount(parent, '')
    for (const char of '/tab') typeChar(view, char)
    await frame()
    equal(slashMenu(view), ['Table'], 'the query left only the command it names')

    const flashcard = slashMount(parent, '')
    for (const char of '/f') typeChar(flashcard, char)
    equal(slashMenu(flashcard), ['Flashcard'],
      'a short query prefers the visible command label over a hidden alias')

    const bookmark = slashMount(parent, '')
    for (const char of '/book') typeChar(bookmark, char)
    equal(slashMenu(bookmark), ['Bookmark'], '/book finds the Bookmark command')
  })

  await test('choosing Bookmark clears the slash and asks the app to bookmark', async (parent) => {
    const view = slashMount(parent, 'above\n')
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    for (const char of '/bookmark') typeChar(view, char)
    let asked = 0
    parent.addEventListener('tulip:bookmark', () => { asked++ })
    const result = slashCommands(
      new CompletionContext(view.state, view.state.selection.main.head, false))
    const option = result.options.find((o) => o.label === 'Bookmark')
    option.apply(view, option, result.from, view.state.doc.length)
    await frame()
    equal(view.state.doc.toString(), 'above\n', 'the slash text was cleared before the bookmark was asked for')
    equal(asked, 1, 'the request reached the renderer once')
  })

  await test('the menu answers to a command’s aliases', async (parent) => {
    const view = slashMount(parent, '')
    for (const char of '/img') typeChar(view, char)
    equal(slashMenu(view), ['Image or file'], 'an alias found its command')
    const warn = slashMount(parent, '/warn')
    warn.dispatch({ selection: { anchor: warn.state.doc.length } })
    equal(slashMenu(warn), ['Callout'], 'a callout kind found the Callout command')
    const fence = slashMount(parent, '/fence')
    fence.dispatch({ selection: { anchor: fence.state.doc.length } })
    equal(slashMenu(fence), ['Code block'], 'a longer alias still finds its command')
  })

  await test('a filtered slash menu is only as tall as its rows', async (parent) => {
    /* The caret sits a little way above the bottom of the window, so the full
       menu does not fit below it and CodeMirror squeezes the tooltip to the
       space there. Narrowing the list must let the box shrink with it. */
    const low = document.createElement('div')
    low.style.cssText = 'position:fixed;left:0;right:0;top:200px;height:300px'
    parent.append(low)
    /* Told the room it has directly, rather than left to the window: 50px
       above the caret's line and 120px below, so the menu neither fits nor
       has a roomier side to flip to. */
    const room = tooltips({ tooltipSpace: (view) => {
      const caret = view.coordsAtPos(view.state.selection.main.head) || { top: 250, bottom: 270 }
      return { top: caret.top - 50, bottom: caret.bottom + 120, left: 0, right: window.innerWidth }
    } })
    const tooltipOf = (view) => view.dom.querySelector('.cm-tooltip-autocomplete')
    const settle = async () => { for (let i = 0; i < 6; i++) await frame() }

    const mount = (extra) => {
      const view = slashMount(low, '', [], [
        room, autocompletion({ override: [slashCommands], icons: false, activateOnTypingDelay: 0 }), ...extra])
      view.focus()
      return view
    }
    const plain = mount([])
    for (const char of '/call') { typeChar(plain, char); await settle() }
    assert(tooltipOf(plain)?.style.height,
      `the control was not squeezed, so the test proves nothing: ${tooltipOf(plain)?.getAttribute('style') ?? 'no tooltip'}`)
    plain.destroy()

    const sized = mount([completionTooltipSize])
    for (const char of '/call') { typeChar(sized, char); await settle() }
    const tooltip = tooltipOf(sized)
    assert(tooltip, 'the menu did not open')
    equal(tooltip.style.height, '', 'the tooltip was still held at its squeezed height')
    const rows = tooltip.querySelectorAll('li').length
    equal(rows, 1, 'the filter left more than the Callout row')
    const height = tooltip.getBoundingClientRect().height
    const row = tooltip.querySelector('li').getBoundingClientRect().height
    assert(height < row * 3, `one row sits in a box ${Math.round(height)}px tall`)
    sized.destroy()
    low.remove()
  })

  await test('choosing a command replaces the slash and its query', async (parent) => {
    const view = slashMount(parent, '')
    for (const char of '/tab') typeChar(view, char)
    const result = slashCommands(
      new CompletionContext(view.state, view.state.selection.main.head, false))
    equal(result.from, 0, 'the completion replaces from the slash itself')
    result.options[0].apply(view, result.options[0], result.from, view.state.doc.length)
    await frame()
    assert(!view.state.doc.toString().includes('/'), 'the slash was left behind in the note')
    assert(view.state.doc.toString().includes('|'), 'the table was not written')
  })

  await test('a slash mid-sentence opens nothing', async (parent) => {
    const view = slashMount(parent, 'and/or')
    view.dispatch({ selection: { anchor: 4 } })
    equal(slashMenu(view), null, 'a prose slash is not a command')
  })

  await test('a slash inside a code fence opens nothing', async (parent) => {
    const view = slashMount(parent, '```\n/usr', [], [markdown()])
    view.dispatch({ selection: { anchor: 5 } })
    equal(slashMenu(view), null, 'a code slash is not a command')
  })

  await test('an empty embed still renders its chip', async (parent) => {
    const view = slashMount(parent, '![[ ]]')
    await frame()
    assert(view.dom.querySelector('.tk-embed-placeholder'), 'no chip rendered for the placeholder')
  })

  await test('the ghost completes an embed target and Tab takes it', async (parent) => {
    const view = slashMount(parent, '![[di', [{ label: 'diagram.png', name: 'diagram.png' }])
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    await frame()
    equal(view.state.doc.toString(), '![[di', 'the target so far')
    equal(ghostText(view), 'agram.png]]', 'the ghost shows the rest of the first match')
    key(view.contentDOM, 'Tab')
    await frame()
    equal(view.state.doc.toString(), '![[diagram.png]]', 'Tab wrote the ghost and closed the embed')
    equal(ghostText(view), null, 'nothing left to complete')
  })

  await test('a hand-written ![[ target autocompletes the same way', async (parent) => {
    const view = slashMount(parent, '![[di', [{ label: 'diagram.png', name: 'diagram.png' }])
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    await frame()
    equal(ghostText(view), 'agram.png]]', 'no slash needed for the inline ghost')
  })

  await test('backspace takes the whole placeholder in one press', async (parent) => {
    const view = slashMount(parent, '![[ ]]')
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    key(view.contentDOM, 'Backspace')
    await frame()
    equal(view.state.doc.toString(), '', 'one backspace removed the whole placeholder')
  })

  await test('the picker offers the vault’s files and a choice embeds it', async (parent) => {
    const view = slashMount(parent, '![[ ]]', [
      { label: 'img/diagram.png', name: 'img/diagram.png' },
      { label: 'Spanish', name: 'Spanish' }
    ])
    await frame()
    view.dom.querySelector('.tk-embed-placeholder').click()
    await frame()
    const menu = document.querySelector('.dd-menu')
    assert(menu, 'the picker did not open')
    const labels = [...menu.querySelectorAll('.dd-option-name')].map((n) => n.textContent)
    equal(labels, ['Add website URL…', 'Add YouTube video…', 'img/diagram.png', 'Spanish'],
      'the picker lists the URL actions and every embeddable file')
    ;[...menu.querySelectorAll('.dd-option')]
      .find((b) => b.textContent.includes('diagram.png')).click()
    await frame()
    equal(view.state.doc.toString(), '![[img/diagram.png]]', 'the choice became the embed')
    assert(!document.querySelector('.dd-menu'), 'the picker closed itself')
  })

  await test('the URL actions leave a skeleton to finish', async (parent) => {
    const view = slashMount(parent, '![[ ]]')
    await frame()
    view.dom.querySelector('.tk-embed-placeholder').click()
    await frame()
    ;[...document.querySelectorAll('.dd-option')]
      .find((b) => b.textContent.includes('website')).click()
    await frame()
    equal(view.state.doc.toString(), '![[https://', 'the website skeleton')
    equal(view.state.selection.main.head, '![[https://'.length, 'the caret waits inside the target')
    typeChar(view, 'e')
    equal(view.state.doc.toString(), '![[https://e', 'typing continues the URL')
  })

  await test('a language table that is only frontmatter still has a cursor', async (parent) => {
    const view = mount(parent, '---\nlang: el\n---', { language: true })
    await frame()
    assert(view.contentDOM.textContent.includes('lang: el'),
      'a replacement covering every line would leave nothing to type in')
  })
}

run().then(
  () => { window.__tableTests = results },
  (error) => {
    results.push({ name: 'the suite itself', ok: false, error: String(error?.stack || error) })
    window.__tableTests = results
  }
)
