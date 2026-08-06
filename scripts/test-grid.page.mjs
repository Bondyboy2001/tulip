/* The half of the grid test that runs in the page. See test-grid.mjs. */

import { mountCsv } from '../src/csv.js'

const FIXTURE = 'name,score,when\nAda,10,2026-01-02\nGrace,2,2025-12-31\nAlan,,2026-03-04\nBob,9,2026-02-01\n'

const wait = () => new Promise((resolve) => setTimeout(resolve, 0))

export async function run () {
  const host = document.getElementById('host')
  let onDisk = FIXTURE
  let writes = 0
  const status = []

  let selections = 0

  const grid = mountCsv({
    host,
    file: {
      read: async () => onDisk,
      write: async (_path, text) => { onDisk = text; writes++ }
    },
    onDirty: () => {},
    onSaved: () => {},
    onStatus: (message) => status.push(message),
    onSelection: () => { selections++ }
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

  // A whole column, heading included, from the keyboard a spreadsheet uses.
  click(cell(1, 1))
  key(' ', { ctrlKey: true })
  await wait()
  result.columnSelection = selected()

  /* ---------------------------------------------------------- the totals

     What a person selects a column of numbers in order to ask. The total
     follows the selection by a moment rather than being worked out on every
     row a drag passes over, so these wait for it to settle. */

  const settle = () => new Promise((resolve) => setTimeout(resolve, 140))

  click(cell(0, 1))
  click(cell(3, 1), { shiftKey: true })
  await settle()
  result.totalsSummary = grid.summary()

  // One cell has no arithmetic to report, so the line goes away again.
  click(cell(0, 1))
  await settle()
  result.singleCellSummary = grid.summary()

  /* A column of names is still a selection, and still says how big it is —
     there is simply nothing to total. */
  click(cell(0, 0))
  click(cell(3, 0), { shiftKey: true })
  await settle()
  result.wordsSummary = grid.summary()

  /* Scrolling does not move the selection, so it must not set the totals
     going again — the count here is the guard on that. */
  const before = selections
  scroller.scrollTop = 40
  scroller.dispatchEvent(new Event('scroll'))
  await settle()
  scroller.scrollTop = 0
  scroller.dispatchEvent(new Event('scroll'))
  await settle()
  result.selectionsFromScrolling = selections - before

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

  /* ---------------------------------------------------- fitting the columns */

  const widthOf = (c) => Math.round(Number.parseFloat(heading(c).style.width))
  /** Is anything in this column wider than the column? The question a fit is
   *  asked to answer, and the one a pixel count cannot: the advance width is
   *  the window's, not the test's. */
  const clipped = (c) => [...document.querySelectorAll(`.csv-cell[data-col="${c}"]`)]
    .some((cell) => cell.scrollWidth > cell.clientWidth)

  // Drag the first column out to something nothing in it needs...
  const grip = heading(0).querySelector('.csv-grip')
  mouse(grip, 'mousedown', { clientX: 100 })
  frame.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 260 }))
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  await wait()
  result.widthsAfterDrag = [widthOf(0), widthOf(1)]

  // ...and ask for every column at once.
  button('fit').click()
  await wait()
  result.widthsAfterFit = [widthOf(0), widthOf(1)]
  result.clippedAfterFit = [clipped(0), clipped(1)]

  // The same command from the keyboard, which is where it is quickest.
  mouse(grip, 'mousedown', { clientX: 100 })
  frame.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 260 }))
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  key('f', { metaKey: true, altKey: true })
  await wait()
  result.widthsAfterChord = [widthOf(0), widthOf(1)]
  await grid.save({ flush: true })
  result.fileAfterFitting = onDisk

  /* ----------------------------------------------------- the reading view

     The same grid with the editing taken out of it: everything that would
     write to the file has to be refused, and everything that is a way of
     looking at it has to keep working. */

  const fileBeforeReading = onDisk
  grid.setReadonly(true)
  await wait()
  result.readingClass = frame.classList.contains('is-reading')
  result.readingBarHidden = ['undo', 'redo', 'add-row', 'add-col'].map((act) => button(act).hidden)

  // Typing over a cell, which in Editing view opens it.
  click(cell(0, 0))
  key('Z')
  await wait()
  result.readingEditorOpen = !!document.querySelector('.csv-input')

  // Delete, paste and undo — each of them a write in Editing view.
  key('Backspace')
  const refused = new DataTransfer()
  refused.setData('text/plain', 'nope\tnope')
  scroller.dispatchEvent(new ClipboardEvent('paste', {
    bubbles: true, cancelable: true, clipboardData: refused
  }))
  grid.history(false)
  await wait()
  result.readingDirty = grid.dirty()
  await grid.save({ flush: true })
  result.fileAfterReadingAttempts = onDisk
  result.readingWroteNothing = onDisk === fileBeforeReading

  // A sort is a view, so it still sorts — and the button that would write it
  // into the file is not there to be pressed.
  click(heading(1))
  await wait()
  result.readingSorts = shown()
  result.readingApplySortHidden = button('apply-sort').hidden
  click(heading(1))
  click(heading(1))
  await wait()

  // Fitting is a way of looking too, so it is still on the bar and still works.
  result.readingFitOffered = !button('fit').hidden
  const grip1 = heading(0).querySelector('.csv-grip')
  mouse(grip1, 'mousedown', { clientX: 100 })
  frame.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 260 }))
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  button('fit').click()
  await wait()
  result.readingFitted = [widthOf(0), widthOf(1)]

  cell(0, 1).dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 40, clientY: 60
  }))
  await wait()
  result.readingMenuItems = [...document.querySelectorAll('.csv-menu-item')]
    .map((item) => item.textContent)
  mouse(scroller, 'mousedown')
  await wait()

  // And back: the editing chrome returns with the view.
  grid.setReadonly(false)
  await wait()
  result.editingBarBack = ['undo', 'redo', 'add-row', 'add-col'].map((act) => button(act).hidden)
  click(cell(0, 0))
  key('Y')
  await wait()
  result.editorOpenAgain = !!document.querySelector('.csv-input')
  key('Escape')
  await wait()

  /* ------------------------------------------- fitting to a very long cell

     The case a cap gets wrong. A column is measured to at most MAX_COL when
     the file opens, which is right — one paragraph in one cell must not open
     the table with everything else off screen. Asking for a fit is asking to
     see the column, so that cap has no business in the answer. */

  const LONG = '186: Alien vs. Predator (2004) & Aliens vs. Predator: Requiem'
  click(cell(0, 1))
  key('Z')
  document.querySelector('.csv-input').value = LONG
  key('Enter')
  await wait()
  button('fit').click()
  await wait()
  result.longFitWidth = widthOf(1)
  result.longFitClipped = clipped(1)

  grid.history(false)   // and the long value goes back out of the file
  button('fit').click()
  await wait()
  await grid.save({ flush: true })

  /* --------------------------------------------------------- the context */

  result.headings = [...document.querySelectorAll('.csv-head .csv-th .csv-th-label')]
    .map((label) => label.textContent)
  result.frameOk = !!frame
  result.status = status
  result.fileAtEnd = onDisk

  /* ------------------------------------------------- a column that starts late

     How many columns a file has is the longest row in it, and that is not a
     question a sample of the first few hundred rows can answer. This fixture
     is three columns wide until row 380, which has a fourth field. Taking the
     count from the sample left that field with no column to appear in: it
     could not be seen, selected or edited, and the writer went on emitting it
     — so a column deleted from the left silently changed which column it
     belonged to. */

  const raggedLines = ['a,b,c']
  for (let i = 0; i < 400; i++) raggedLines.push(i === 380 ? `r${i},x,y,late` : `r${i},x,y`)
  onDisk = raggedLines.join('\n') + '\n'

  await grid.open('Data/ragged.csv')
  await wait()
  result.raggedColumns = document.querySelectorAll('.csv-head .csv-th').length
  result.raggedSummary = grid.summary()

  /* And the field is reachable, not merely counted: filtering to the one row
     that carries it has to put it on screen in the fourth column. */
  search.value = 'late'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  button('filter').click()
  await wait()
  const lateRow = rowsOnScreen()[0]
  result.raggedFiltered = rowsOnScreen().length
  result.raggedLateCell = lateRow?.querySelector('.csv-cell[data-col="3"]')?.textContent

  button('filter').click()
  search.value = ''
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await wait()

  /* ------------------------------------------------ a file the extension lied about

     A `.csv` separated by semicolons, which is what a spreadsheet writes
     anywhere that spells decimals with a comma. Read with the comma the
     extension promises, the whole file is one column of unsplit lines. */

  const SEMI = 'id;name;price\nca1;Ada;1,50\nb2;Grace;2,75\n'
  onDisk = SEMI
  await grid.open('Data/euro.csv')
  await wait()

  const picker = document.querySelector('.csv-delimiter')
  result.semiHeadings = [...document.querySelectorAll('.csv-head .csv-th .csv-th-label')]
    .map((label) => label.textContent)
  result.semiFirstRow = shown(2)
  result.semiPickerShown = !!picker && !picker.hidden
  result.semiPickerValue = picker?.value

  /* And the file is written back with the delimiter it came with. A semicolon
     file resaved as a comma file is every line of it rewritten, and the
     decimals inside it silently turned into extra columns. */
  click(cell(0, 1))
  key('Z')
  document.querySelector('.csv-input').value = 'Zara'
  key('Enter')
  await grid.save({ flush: true })
  result.semiFileAfterEdit = onDisk

  /* A comma file says nothing about its delimiter, because there is nothing
     to say. */
  onDisk = FIXTURE
  await grid.open('Data/people.csv')
  await wait()
  result.commaPickerShown = !document.querySelector('.csv-delimiter').hidden

  /* ------------------------------------------------------- a wide export

     Two hundred columns and two hundred rows. Rows were virtual from the
     start; columns were not, so this used to build two hundred cells for
     every row in the band — forty thousand elements thrown away and remade on
     every tick of the scroll, for the dozen columns anybody could see. */

  const WIDE_COLS = 200
  const wideLines = [Array.from({ length: WIDE_COLS }, (_, c) => `c${c}`).join(',')]
  for (let r = 0; r < 200; r++) {
    wideLines.push(Array.from({ length: WIDE_COLS }, (_, c) => `r${r}f${c}`).join(','))
  }
  onDisk = wideLines.join('\n') + '\n'
  await grid.open('Data/wide.csv')
  await wait()

  const cellsPerRow = () => {
    const row = document.querySelector('.csv-row')
    return row ? row.querySelectorAll('.csv-cell').length : 0
  }
  const builtColumns = () => [...document.querySelectorAll('.csv-row .csv-cell')]
    .map((c) => Number(c.dataset.col))

  result.wideColumns = grid.summary()
  result.wideCellsPerRow = cellsPerRow()
  result.wideTotalWidth = scroller.scrollWidth

  /* Row recycling: a scroll of one row's worth must keep the rows that are
     still on screen as the very same elements, rather than rebuilding the
     band around them. */
  const rowFive = document.querySelector('.csv-row[data-row="5"]')
  scroller.scrollTop = 28
  scroller.dispatchEvent(new Event('scroll'))
  await wait()
  result.rowRecycled = document.querySelector('.csv-row[data-row="5"]') === rowFive
  result.widthHeldOnScroll = scroller.scrollWidth === result.wideTotalWidth

  // And scrolling sideways brings the far columns in, correctly labelled.
  scroller.scrollTop = 0
  scroller.scrollLeft = scroller.scrollWidth
  scroller.dispatchEvent(new Event('scroll'))
  await wait()
  const far = builtColumns()
  result.wideFarCellsPerRow = cellsPerRow()
  result.wideFarLastColumn = Math.max(...far)
  result.wideFarFirstColumn = Math.min(...far)
  result.wideFarHeadings = [...document.querySelectorAll('.csv-head .csv-th')]
    .map((th) => `${th.dataset.col}:${th.querySelector('.csv-th-label').textContent}`)
    .slice(-2)
  const lastRow = document.querySelector('.csv-row[data-row="0"]')
  result.wideFarCellText = lastRow
    ?.querySelector(`.csv-cell[data-col="${WIDE_COLS - 1}"]`)?.textContent

  /* ------------------------------------------------------ what a reader hears

     The grid was bare `div`s, which told a screen reader there was nothing
     here at all. These are the same facts the layout already gives the eye. */

  onDisk = FIXTURE
  await grid.open('Data/people.csv')
  await wait()
  click(cell(1, 1))
  await wait()

  const grid_ = document.querySelector('.csv-table')
  result.ariaRole = grid_?.getAttribute('role')
  // The whole file, not the band that happens to be built.
  result.ariaRowCount = grid_?.getAttribute('aria-rowcount')
  result.ariaColCount = grid_?.getAttribute('aria-colcount')
  result.ariaHeadingRole = heading(1)?.getAttribute('role')
  result.ariaCellRole = cell(1, 1)?.getAttribute('role')
  result.ariaGutterRole = document.querySelector('.csv-row .csv-gutter')?.getAttribute('role')
  // Row indices count the header as one, so the first body row is two.
  result.ariaFirstBodyRow = document.querySelector('.csv-row[data-row="0"]')
    ?.getAttribute('aria-rowindex')
  result.ariaColIndex = cell(1, 1)?.getAttribute('aria-colindex')
  result.ariaSelected = cell(1, 1)?.getAttribute('aria-selected')
  result.ariaUnselected = cell(0, 0)?.getAttribute('aria-selected')
  result.ariaActive = scroller.getAttribute('aria-activedescendant') === cell(1, 1)?.id

  click(heading(1))
  await wait()
  result.ariaSorted = heading(1)?.getAttribute('aria-sort')
  click(heading(1)); click(heading(1))
  await wait()

  return result
}
