/* The table's own behaviour, exercised against a real editor in a real
   document: the grid is a contenteditable inside a CodeMirror block widget, and
   almost everything worth testing about it — where focus lands, what the
   clipboard carries, what the caret was on when a key was pressed — only
   exists once both of those are real. Bundled and run inside Electron by
   scripts/test-table.mjs.

   Row numbers here are the grid's, not the file's: row 0 is the header, row 1
   is the first body row, and the delimiter line is not a row at all. So a
   four-line table is three rows, and its last body row is row 2. */

import { EditorView, keymap } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { search, openSearchPanel, setSearchQuery, SearchQuery } from '@codemirror/search'
import {
  tablePreview, tableCursorGuard, tableSearchHighlight,
  tableAssetResolver, languageTableMode, insertTable, fitAllColumns
} from '../src/table.js'
import { propertiesPreview, tagsPanel } from '../src/properties.js'
import { slashCommands } from '../src/slash.js'
import { CompletionContext } from '@codemirror/autocomplete'

const results = []

async function test (name, run) {
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

function mount (parent, doc, { language = false } = {}) {
  return new EditorView({
    doc,
    parent,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      search(),
      tableAssetResolver.of(() => null),
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
    await frame()
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
    await frame()
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

  // A language table's columns are its schema: a wide paste is clipped, and the
  // clipping is said out loud rather than silently dropped.
  await test('a wide paste into a language table is clipped and reported', async (parent) => {
    const view = mount(parent, TABLE, { language: true })
    let notice = ''
    view.dom.addEventListener('tulip:table-notice', (event) => { notice = event.detail.message })
    const cell = cellAt(view, 1, 0)
    cell.focus()
    paste(cell, { text: 'drei\tthree\textra' })
    await frame()
    equal(view.state.doc.line(3).text, '| drei | three |', 'the columns it has were filled')
    assert(notice.includes('2 columns'), `the reader was told: ${notice || '(nothing)'}`)
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

  // Fitting every column: the marker line goes, and the tables it did not
  // describe are left alone.
  await test('fitting all columns takes the widths off', async (parent) => {
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
    assert(!text.includes('tk-widths'), `no widths are left:\n${text}`)
    assert(text.startsWith('| A | B |'), `the marker line went with them:\n${text}`)
    assert(text.includes('| C | D |'), 'the other table is untouched')
    equal(fitAllColumns(view), false, 'and there is nothing left to do')
  })

  /* A dragged table still fills the frame drawn round it. The widths here add
     up to far less than the window, which is the shape the bug had: a band of
     empty paper down the right of a language table. */
  await test('a dragged table has no empty band beside it', async (parent) => {
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
    assert(grid.classList.contains('has-flexible-column'), 'the auto column is marked as such')
    const slack = wrap.clientWidth - grid.getBoundingClientRect().width
    assert(Math.abs(slack) < 2, `the grid reaches the frame (${slack}px short)`)

    const header = [...wrap.querySelectorAll('thead th')]
      .map((th) => Math.round(th.getBoundingClientRect().width))
    equal(header[0], 120, 'the first dragged column kept its width')
    equal(header[1], 140, 'and so did the second')
    equal(header[3], 90, 'and the last')
    // Every pixel the dragged columns did not claim went to the one that had
    // no width of its own, rather than being left as paper beside the grid.
    const spare = Math.round(wrap.clientWidth) - (120 + 140 + 90)
    assert(spare > 80, `the frame is wider than the dragged columns (${spare}px spare)`)
    assert(
      Math.abs(header[2] - spare) < 2,
      `the slack went to the column nobody dragged (${header[2]}px of ${spare}px)`
    )
  })

  // And when there is no such column, the frame comes in to meet the grid.
  await test('a fully dragged table draws its frame around itself', async (parent) => {
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
    assert(!grid.classList.contains('has-flexible-column'), 'every column is dragged')
    equal(Math.round(grid.getBoundingClientRect().width), 260, 'the grid is exactly its widths')
    const slack = wrap.clientWidth - grid.getBoundingClientRect().width
    assert(Math.abs(slack) < 2, `the frame came in to meet it (${slack}px of band)`)
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

  // Clearing a rectangle leaves a locked header alone.
  await test('a locked language header cannot be cleared', async (parent) => {
    const view = mount(parent, TABLE, { language: true })
    const cell = cellAt(view, 1, 0)
    cell.focus()
    key(cell, 'a', { metaKey: true })
    key(cell, 'a', { metaKey: true })
    key(cell, 'Backspace')
    await frame()
    equal(view.state.doc.line(1).text, '| Word | Meaning |', 'the header still names the columns')
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

  await test('the tags panel adds a tag and preserves other YAML', async (parent) => {
    const doc = '---\ntitle: Before\ntags: [one, two]\nscore: 1 # measured\n---\nA note.'
    const view = mount(parent, doc)
    const panel = tagsPanel(view)
    parent.append(panel)
    equal([...panel.querySelectorAll('.tag-chip-label')].map((chip) => chip.textContent),
      ['#one', '#two'], 'the existing tags were not shown')
    const input = panel.querySelector('.tag-input')
    input.value = 'three'
    key(input, 'Enter')
    await frame()
    const text = view.state.doc.toString()
    assert(text.includes('tags: [one, two, three]'), `the tag was not added:\n${text}`)
    assert(text.includes('title: Before'), 'a neighbouring property was changed')
    assert(text.includes('score: 1 # measured'), 'an inline comment was removed')
  })

  await test('the tags panel creates frontmatter only after a tag is entered', async (parent) => {
    const view = mount(parent, 'A note.')
    const panel = tagsPanel(view)
    parent.append(panel)
    equal(view.state.doc.toString(), 'A note.', 'opening the tag editor wrote placeholder YAML')
    const input = panel.querySelector('.tag-input')
    input.value = '#tulip'
    key(input, 'Enter')
    await frame()
    assert(view.state.doc.toString().startsWith('---\ntags: [tulip]\n---\n'),
      `the tag head was not created:\n${view.state.doc.toString()}`)
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

  /* ------------------------------------------------------- the slash menu */

  /** The menu as it would open at the cursor: the options, in order. */
  function slashOptions (view) {
    const pos = view.state.selection.main.head
    const result = slashCommands(new CompletionContext(view.state, pos, false))
    return result ? result.options : []
  }

  function choose (view, label) {
    const pos = view.state.selection.main.head
    const result = slashCommands(new CompletionContext(view.state, pos, false))
    const option = result?.options.find((one) => one.label === label)
    assert(option, `no ${label} in the menu`)
    option.apply(view, option, result.from, pos)
  }

  await test('the menu offers no syntax on the right of a row', async (parent) => {
    const view = mount(parent, '/')
    view.dispatch({ selection: { anchor: 1 } })
    const options = slashOptions(view)
    assert(options.length, 'the menu did not open')
    assert(options.every((one) => !one.detail),
      'a row still carries the syntax the menu exists to spare its reader')
  })

  await test('/table writes a grid and lands in it', async (parent) => {
    const view = mount(parent, '/')
    view.dispatch({ selection: { anchor: 1 } })
    choose(view, 'Table')
    await frame()
    assert(!view.state.doc.toString().startsWith('/'), 'the slash was left in the note')
    assert(view.state.doc.line(2).text.includes('---'), 'no delimiter row')
    assert(cellAt(view, 0, 0), 'the grid was not drawn')
  })

  await test('/tags opens the tag editor without placeholder YAML', async (parent) => {
    const view = mount(parent, 'A note.\n\n/')
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    let opened = false
    view.dom.addEventListener('tulip:tags', () => { opened = true })
    choose(view, 'Tags')
    await frame()
    const text = view.state.doc.toString()
    equal(text, 'A note.\n\n', `the command wrote metadata before a tag existed:\n${text}`)
    assert(opened, 'the tag editor was not asked to open')
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
