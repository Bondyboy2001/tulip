/* The half of the grid test that runs in the page. See test-grid.mjs. */

import { mountCsv } from '../src/csv.js'

const FIXTURE = 'name,score,when\nAda,10,2026-01-02\nGrace,2,2025-12-31\nAlan,,2026-03-04\nBob,9,2026-02-01\n'

const wait = () => new Promise((resolve) => setTimeout(resolve, 0))

export async function run () {
  const host = document.getElementById('host')
  let onDisk = FIXTURE
  let writes = 0
  const status = []

  const grid = mountCsv({
    host,
    file: {
      read: async () => onDisk,
      write: async (_path, text) => { onDisk = text; writes++ }
    },
    onDirty: () => {},
    onSaved: () => {},
    onStatus: (message) => status.push(message)
  })

  await grid.open('Data/people.csv')
  await wait()

  /* ------------------------------------------------------------ helpers */

  const frame = document.querySelector('.csv-frame')
  const scroller = document.querySelector('.csv-scroller')
  const head = document.querySelector('.csv-head')
  const search = document.querySelector('.csv-search')

  const rowsOnScreen = () => [...document.querySelectorAll('.csv-row')]
    .sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row))

  /** The first column, as shown — which is the whole point of a sort test. */
  const shown = (col = 0) => rowsOnScreen()
    .map((row) => row.querySelector(`.csv-cell[data-col="${col}"]`)?.textContent)

  /** The file line numbers down the gutter, which must keep saying where a row
   *  came from however the view is ordered. */
  const gutters = () => rowsOnScreen().map((row) => row.querySelector('.csv-gutter').textContent)

  const cell = (r, c) => document.querySelector(`.csv-cell[data-row="${r}"][data-col="${c}"]`)
  const heading = (c) => head.querySelector(`.csv-th[data-col="${c}"]`)

  const mouse = (target, type, init = {}) =>
    target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: 10, clientY: 10, detail: 1, ...init
    }))

  const key = (name, init = {}) =>
    (document.querySelector('.csv-input') || scroller).dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))

  const click = (target, init) => { mouse(target, 'mousedown', init); mouse(target, 'mouseup', init) }

  const selected = () => document.querySelectorAll('.csv-cell.is-sel, .csv-cell.is-cursor').length
  const stats = () => document.querySelector('.csv-stats').textContent
  const button = (act) => document.querySelector(`.csv-btn[data-act="${act}"]`)

  const result = {}

  /* -------------------------------------------------------- the sorting */

  click(heading(1))
  await wait()
  result.sortAsc = shown()
  result.sortAscGutters = gutters()

  click(heading(1))
  await wait()
  result.sortDesc = shown()

  click(heading(1))
  await wait()
  result.sortOff = shown()

  /* A sort is a view. Saving one must not rewrite a line of the file. */
  click(heading(1))
  await grid.save({ flush: true })
  result.writesAfterSorting = writes
  result.fileAfterSorting = onDisk

  /* Until it is asked for, and then it is an edit like any other. */
  button('apply-sort').click()
  await grid.save({ flush: true })
  result.fileAfterApply = onDisk
  result.summaryAfterApply = grid.summary()

  grid.history(false)   // undo the applied sort
  await grid.save({ flush: true })
  result.fileAfterUndo = onDisk
  /* Undo put back the whole view, sort included — so the rows are ascending by
     score again. Two more clicks (descending, then off) and the table is back
     in the file's own order for everything below. */
  result.sortSurvivesUndo = shown()
  click(heading(1))
  click(heading(1))
  await wait()
  result.sortCleared = shown()

  /* ------------------------------------------------------ the selection */

  click(cell(0, 0))
  click(cell(2, 1), { shiftKey: true })
  await wait()
  result.rectangle = selected()
  result.rectangleStats = stats()

  // A whole column, heading included, from the keyboard a spreadsheet uses.
  click(cell(1, 1))
  key(' ', { ctrlKey: true })
  await wait()
  result.columnSelection = selected()
  result.columnStats = stats()

  /* --------------------------------------------------------- the typing */

  click(cell(0, 0))
  key('Z')
  await wait()
  result.editorOpen = !!document.querySelector('.csv-input')
  document.querySelector('.csv-input').value = 'Zara'
  key('Enter')
  await wait()
  result.afterTyping = shown()
  result.cursorMovedDown = cell(1, 0)?.classList.contains('is-cursor')

  await grid.save({ flush: true })
  result.fileAfterTyping = onDisk

  grid.history(false)
  await grid.save({ flush: true })
  result.fileAfterTypingUndone = onDisk

  /* ------------------------------------------------------ the clipboard */

  click(cell(0, 1))
  const data = new DataTransfer()
  data.setData('text/plain', '111\t2026-09-09\n222\t2026-10-10')
  scroller.dispatchEvent(new ClipboardEvent('paste', {
    bubbles: true, cancelable: true, clipboardData: data
  }))
  await wait()
  result.afterPaste = [shown(1), shown(2)]

  await grid.save({ flush: true })
  result.fileAfterPaste = onDisk
  grid.history(false)
  await grid.save({ flush: true })
  result.fileAfterPasteUndone = onDisk

  /* A paste bigger than the table grows it rather than being clipped. */
  click(cell(3, 2))
  const wide = new DataTransfer()
  wide.setData('text/plain', 'a\tb\nc\td')
  scroller.dispatchEvent(new ClipboardEvent('paste', {
    bubbles: true, cancelable: true, clipboardData: wide
  }))
  await wait()
  result.grownColumns = document.querySelectorAll('.csv-head .csv-th').length
  result.grownRows = rowsOnScreen().length
  await grid.save({ flush: true })
  result.fileAfterGrowth = onDisk
  grid.history(false)
  await wait()
  result.afterGrowthUndone = {
    columns: document.querySelectorAll('.csv-head .csv-th').length,
    rows: rowsOnScreen().length
  }

  /* ------------------------------------------------------- the structure */

  click(cell(0, 0))
  button('add-row').click()
  await wait()
  result.rowsAfterInsert = rowsOnScreen().length

  key('Backspace', { metaKey: true })
  await wait()
  result.rowsAfterDelete = rowsOnScreen().length

  button('add-col').click()
  await wait()
  result.columnsAfterInsert = document.querySelectorAll('.csv-head .csv-th').length
  await grid.save({ flush: true })
  result.fileAfterColumn = onDisk

  grid.history(false)
  await grid.save({ flush: true })
  result.fileAfterColumnUndone = onDisk

  /* ---------------------------------------------------------- the filter */

  search.value = 'a'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await wait()
  result.matchesShown = document.querySelector('.csv-found').textContent
  result.highlighted = document.querySelectorAll('.csv-cell.is-match').length

  button('filter').click()
  await wait()
  result.filteredRows = shown()
  result.filteredGutters = gutters()
  result.summaryFiltered = grid.summary()
  result.contextFiltered = grid.context().text

  button('filter').click()
  search.value = ''
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await wait()
  result.unfilteredRows = rowsOnScreen().length

  /* ------------------------------------------------------- the headings */

  const box = heading(2).getBoundingClientRect()
  const middle = { clientX: Math.round(box.left + 20), clientY: Math.round(box.top + box.height / 2) }
  mouse(heading(2), 'mousedown', middle)
  mouse(heading(2), 'mouseup', middle)
  /* On the strip rather than on the cell, and with real coordinates: that
     first click sorted the column and rebuilt the heading, so the browser
     reports the two clicks' common ancestor — which is exactly the case the
     viewer has to survive. */
  head.dispatchEvent(new MouseEvent('dblclick', {
    bubbles: true, cancelable: true, detail: 2, ...middle
  }))
  await wait()
  result.renaming = !!head.querySelector('.csv-input')
  head.querySelector('.csv-input').value = 'date'
  key('Enter')
  await wait()
  result.renamedHeadings = [...document.querySelectorAll('.csv-head .csv-th .csv-th-label')]
    .map((label) => label.textContent)
  // Renaming is not a request to reorder: the sort the first click of that
  // double-click performed has to have been put back.
  result.orderAfterRenaming = shown()
  await grid.save({ flush: true })
  result.fileAfterRenaming = onDisk

  /* -------------------------------------------------------- the fill down */

  click(cell(0, 1))
  click(cell(2, 1), { shiftKey: true })
  key('d', { metaKey: true })
  await wait()
  result.filled = shown(1)

  /* ------------------------------------------------------ the right-click */

  cell(0, 1).dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 40, clientY: 60
  }))
  await wait()
  const items = [...document.querySelectorAll('.csv-menu-item')]
  result.menuOpen = !document.querySelector('.csv-menu').hidden
  result.menuItems = items.map((item) => item.textContent)
  items.find((item) => item.textContent === 'Delete column').click()
  await wait()
  result.menuClosed = document.querySelector('.csv-menu').hidden
  result.columnsAfterMenuDelete = document.querySelectorAll('.csv-head .csv-th').length
  await grid.save({ flush: true })
  result.fileAfterMenuDelete = onDisk

  /* --------------------------------------------------------- the context */

  result.headings = [...document.querySelectorAll('.csv-head .csv-th .csv-th-label')]
    .map((label) => label.textContent)
  result.frameOk = !!frame
  result.status = status
  result.fileAtEnd = onDisk
  return result
}
