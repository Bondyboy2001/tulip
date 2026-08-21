/* Does the table behave like a table?
 *
 * The parser and the comparators are checked in test-csv.mjs, which needs no
 * browser. This is the other half: a real grid in a real Chromium window,
 * driven with the events a person's mouse and keyboard send, asserting what
 * ends up on screen and — the part that matters — what ends up in the file.
 *
 * The rule the whole viewer is built on is the one most worth a test: sorting
 * is a way of looking at a file, not an edit to it. A hundred thousand lines
 * must not be rewritten because somebody wanted to see the largest first, and
 * the one case where they did mean it — the heading menu's "Write this order
 * into the file" — has to be an ordinary undoable edit.
 *
 * A small window appears for a moment: headless Electron pauses the frames a
 * layout needs. Same harness as test-agent-diff.mjs.
 */

import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

await mkdir('node_modules/.cache', { recursive: true })
await esbuild.build({
  entryPoints: ['scripts/test-grid.page.mjs'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: 'node_modules/.cache/grid-page.js',
  logLevel: 'error'
})

/* Only the layout the virtual window depends on: a scroller with a height, a
   row that is absolutely positioned at a fixed one, and cells that do not
   wrap. The app's own stylesheet says more, but nothing the arithmetic here
   rests on. */
await writeFile('node_modules/.cache/grid-page.html', `<!doctype html>
<meta charset="utf-8">
<style>
  :root { --line: #ddd; --line-soft: #eee; --sunk: #f6f6f6; --paper: #fff;
          --surface: #fff; --ink: #222; --ink-soft: #666; --sel: #dde3f0;
          --accent: #3056d3; --accent-dim: #e3e9fa;
          --font-ui: sans-serif; --font-mono: monospace; }
  body { margin: 0; }
  #host { position: relative; width: 720px; height: 420px; }
  .csv-frame { display: flex; flex-direction: column; height: 100%; }
  .csv-table { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
  .csv-head { display: flex; height: 30px; overflow: hidden; }
  .csv-scroller { flex: 1 1 auto; min-height: 0; overflow: auto; }
  .csv-canvas, .csv-window { position: relative; }
  .csv-row { position: absolute; left: 0; display: flex; height: 28px; }
  .csv-cell, .csv-gutter, .csv-pad { flex: 0 0 auto; height: 100%; white-space: pre; overflow: hidden; }
  .csv-gutter { width: 58px; min-width: 58px; }
  .csv-menu[hidden] { display: none; }
</style>
<div id="host"></div>
<script type="module">
  window.__done = import('./grid-page.js').then((mod) => mod.run())
</script>`)

await writeFile('node_modules/.cache/grid-main.mjs', `
import electron from 'electron'
const { app, BrowserWindow } = electron
const say = (payload) => { console.log(JSON.stringify(payload)); app.exit(payload.error ? 1 : 0) }
app.whenReady().then(async () => {
  /* backgroundThrottling off because this window will not always be the one in
     front: the suite runs in parallel now (scripts/run-tests.mjs), and Chromium
     stops servicing rAF and clamps timers in a window that is behind another.
     A grid measuring its own layout in a throttled window measures a paused
     one — it does not fail cleanly, it waits out the poll below. */
  const win = new BrowserWindow({
    width: 760, height: 460, show: true, webPreferences: { backgroundThrottling: false }
  })
  try {
    await win.loadFile(${JSON.stringify(path.resolve('node_modules/.cache/grid-page.html'))})
    for (let wait = 0; wait < 120; wait++) {
      const probe = await win.webContents.executeJavaScript(\`
        (async () => {
          if (!window.__done) return null
          try { return { result: await window.__done } }
          catch (err) { return { error: String(err && err.stack || err) } }
        })()\`)
      if (probe) { win.destroy(); return say(probe) }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    say({ error: 'timed out waiting for the grid scenario' })
  } catch (err) {
    say({ error: String(err && err.stack || err) })
  }
})`)

const run = spawnSync('node_modules/.bin/electron', ['node_modules/.cache/grid-main.mjs'],
  { encoding: 'utf8' })
const line = run.stdout.trim().split('\n').filter(Boolean).pop() || ''
let probe
try { probe = JSON.parse(line) } catch {
  console.error(run.stdout)
  console.error(run.stderr)
  throw new Error(`grid harness produced no result (exit ${run.status})`)
}
if (probe.error) throw new Error(probe.error)
const r = probe.result

const FIXTURE = 'name,score,when\nAda,10,2026-01-02\nGrace,2,2025-12-31\nAlan,,2026-03-04\nBob,9,2026-02-01\n'

let passed = 0
const ok = (what, fn) => { fn(); passed++; console.log(`ok - ${what}`) }

/* ------------------------------------------------------------ the sorting */

ok('a heading sorts its column by what the numbers mean', () => {
  // 2, 9, 10 — not 10, 2, 9, which is what a text sort of a score column gives.
  assert.deepEqual(r.sortAsc, ['Grace', 'Bob', 'Ada', 'Alan'])
})

ok('the blank sorts last however the column is pointed', () => {
  assert.deepEqual(r.sortDesc, ['Ada', 'Bob', 'Grace', 'Alan'])
})

ok('a third click gives the file back its own order', () => {
  assert.deepEqual(r.sortOff, ['Ada', 'Grace', 'Alan', 'Bob'])
})

ok('the gutter keeps saying which line of the file a row is', () => {
  // Sorted by score: Grace is line 3 of the file, Bob line 5, Ada line 2.
  assert.deepEqual(r.sortAscGutters, ['3', '5', '2', '4'])
})

ok('sorting does not touch the file', () => {
  assert.equal(r.writesAfterSorting, 0, 'a view was saved as though it were an edit')
  assert.equal(r.fileAfterSorting, FIXTURE)
})

ok('applying the sort writes the rows in that order', () => {
  assert.equal(r.fileAfterApply,
    'name,score,when\nGrace,2,2025-12-31\nBob,9,2026-02-01\nAda,10,2026-01-02\nAlan,,2026-03-04\n')
})

ok('and applying it leaves nothing sorted to say', () => {
  // The order is the file's now, so the status line stops claiming a sort.
  assert.ok(!r.summaryAfterApply.includes('sorted'), r.summaryAfterApply)
})

ok('undo takes the applied sort back out of the file', () => {
  assert.equal(r.fileAfterUndo, FIXTURE)
  // And puts back the view it was applied from, rather than leaving the rows
  // in an order the file no longer has.
  assert.deepEqual(r.sortSurvivesUndo, ['Grace', 'Bob', 'Ada', 'Alan'])
  assert.deepEqual(r.sortCleared, ['Ada', 'Grace', 'Alan', 'Bob'])
})

/* ---------------------------------------------------------- the selection */

ok('shift-click makes a rectangle of the cells between', () => {
  assert.equal(r.rectangle, 6, 'three rows by two columns')
})

ok('⌃space takes the whole column, heading and all', () => {
  assert.equal(r.columnSelection, 5, 'four rows and the heading')
})

/* ------------------------------------------------------------- the totals */

ok('a selected column says what it comes to', () => {
  /* Four cells of the score column: 10, 2, a blank and 9. The blank is not a
     number, so the average is over the three that are. */
  assert.ok(r.totalsSummary.includes('4 selected'), r.totalsSummary)
  assert.ok(r.totalsSummary.includes('sum 21'), r.totalsSummary)
  assert.ok(r.totalsSummary.includes('avg 7'), r.totalsSummary)
})

ok('one cell has no arithmetic to report', () => {
  assert.ok(!r.singleCellSummary.includes('selected'), r.singleCellSummary)
  // The shape of the table is still there — only the totals went.
  assert.ok(r.singleCellSummary.includes('rows'), r.singleCellSummary)
})

ok('a column of words says how big it is and totals nothing', () => {
  assert.ok(r.wordsSummary.includes('4 selected'), r.wordsSummary)
  assert.ok(!r.wordsSummary.includes('sum'), r.wordsSummary)
})

ok('scrolling does not set the totals going again', () => {
  /* `decorate` runs on every scroll tick, and the totals hang off it. Keyed on
     the rectangle so that a scroll — which moves no selection — is recognised
     as the same one, which is what keeps a whole-column total off the scroll
     path. */
  assert.equal(r.selectionsFromScrolling, 0,
    'scrolling recomputed a total for a selection that had not moved')
})

/* ------------------------------------------------------------- the typing */

ok('typing over a cell replaces it', () => {
  assert.equal(r.editorOpen, true, 'a printable key opens the cell')
  assert.deepEqual(r.afterTyping, ['Zara', 'Grace', 'Alan', 'Bob'])
  assert.equal(r.cursorMovedDown, true, 'return moves down, as every grid does')
})

ok('the edit reaches the file, quoting nothing that does not need it', () => {
  assert.equal(r.fileAfterTyping, FIXTURE.replace('Ada,10', 'Zara,10'))
})

ok('and undo takes it back out', () => {
  assert.equal(r.fileAfterTypingUndone, FIXTURE)
})

/* ---------------------------------------------------------- the clipboard */

ok('a spreadsheet\'s tab-separated paste lands as a rectangle', () => {
  assert.deepEqual(r.afterPaste, [
    ['111', '222', '', '9'],
    ['2026-09-09', '2026-10-10', '2026-03-04', '2026-02-01']
  ])
})

ok('the paste is one undoable edit', () => {
  assert.equal(r.fileAfterPaste,
    'name,score,when\nAda,111,2026-09-09\nGrace,222,2026-10-10\nAlan,,2026-03-04\nBob,9,2026-02-01\n')
  assert.equal(r.fileAfterPasteUndone, FIXTURE)
})

ok('a paste that does not fit grows the table', () => {
  assert.equal(r.grownColumns, 4, 'a column was added for the overhanging cell')
  assert.equal(r.grownRows, 5, 'and a row for the overhanging line')
  /* The rows the paste did not touch keep the width they had. Padding them out
     would mean rewriting lines nobody edited, which is the one thing this
     viewer promises not to do. */
  assert.equal(r.fileAfterGrowth,
    'name,score,when,\nAda,10,2026-01-02\nGrace,2,2025-12-31\nAlan,,2026-03-04\nBob,9,a,b\n,,c,d\n')
})

ok('undoing a growing paste takes the new row and column with it', () => {
  assert.deepEqual(r.afterGrowthUndone, { columns: 3, rows: 4 })
})

/* --------------------------------------------------------- the structure */

ok('a row can be added and taken away again', () => {
  assert.equal(r.rowsAfterInsert, 5)
  assert.equal(r.rowsAfterDelete, 4)
})

ok('a column can be added, and it is a column in the file', () => {
  assert.equal(r.columnsAfterInsert, 4)
  assert.equal(r.fileAfterColumn,
    'name,,score,when\nAda,,10,2026-01-02\nGrace,,2,2025-12-31\nAlan,,,2026-03-04\nBob,,9,2026-02-01\n')
  assert.equal(r.fileAfterColumnUndone, FIXTURE)
})

ok('a row inserted under a sort lands beside the row it was asked for', () => {
  // Ascending by score: Grace 2, Bob 9, Ada 10, then the blank. The new row
  // goes below Grace on screen *and* below her line in the file, so the line
  // numbers below it all move up by one rather than the new row claiming the
  // last number in the file.
  assert.deepEqual(r.sortedInsertNames, ['Grace', '', 'Bob', 'Ada', 'Alan'])
  assert.deepEqual(r.sortedInsertGutters, ['3', '4', '6', '2', '5'])
  assert.equal(r.fileAfterSortedInsert,
    'name,score,when\nAda,10,2026-01-02\nGrace,2,2025-12-31\n,,\nAlan,,2026-03-04\nBob,9,2026-02-01\n')
})

ok('and undoing it takes the line back out', () => {
  assert.equal(r.fileAfterSortedInsertUndone, FIXTURE)
})

/* ------------------------------------------------------------ the finding */

ok('the find box counts the rows holding what was typed', () => {
  assert.match(r.matchesShown, /3 matching rows/)   // Ada, Grace, Alan
  assert.ok(r.highlighted > 0, 'and marks the cells themselves')
})

ok('finding marks the matches without taking a row off the screen', () => {
  assert.equal(r.rowsWhileFinding, 4)
})

ok('clearing the box leaves the file as it was', () => {
  assert.equal(r.unfilteredRows, 4)
})

/* ---------------------------------------------------------- the headings */

ok('a heading opens for renaming, and the new name is the file\'s', () => {
  assert.equal(r.renaming, true)
  assert.deepEqual(r.renamedHeadings, ['name', 'score', 'date'])
  assert.equal(r.fileAfterRenaming, FIXTURE.replace('when', 'date'))
})

ok('renaming is not a request to reorder the table', () => {
  // The first click of the double-click sorted the column; opening the name
  // for editing has to put that back.
  assert.deepEqual(r.orderAfterRenaming, ['Ada', 'Grace', 'Alan', 'Bob'])
})

ok('fill down carries the top of the selection through it', () => {
  assert.deepEqual(r.filled, ['10', '10', '10', '9'])
})

/* -------------------------------------------------------- the right-click */

ok('the right-click menu offers what can be done here', () => {
  assert.equal(r.menuOpen, true)
  for (const label of ['Copy', 'Cut', 'Paste', 'Clear contents', 'Insert row above',
    'Insert column left', 'Delete column', 'Fill down', 'Select column']) {
    assert.ok(r.menuItems.includes(label), `the menu should offer ${label}`)
  }
  // The menu counts what it is about to act on rather than saying "row" over a
  // selection of three of them.
  assert.ok(r.menuItems.includes('Delete 3 rows'), r.menuItems.join(', '))
})

ok('and the item it was opened for does what it says', () => {
  assert.equal(r.menuClosed, true)
  assert.equal(r.columnsAfterMenuDelete, 2)
  assert.equal(r.fileAfterMenuDelete,
    'name,date\nAda,2026-01-02\nGrace,2025-12-31\nAlan,2026-03-04\nBob,2026-02-01\n')
})

ok('the table is what everything above left behind', () => {
  assert.deepEqual(r.headings, ['name', 'date'])
  assert.equal(r.fileAtEnd, r.fileAfterMenuDelete)
})

/* ------------------------------------------------ a column that starts late */

ok('a field no sample would have seen still gets a column', () => {
  /* The fixture is three columns wide for its first three hundred and eighty
     rows. The fourth column exists because one row, far past anything a width
     sample reads, has a fourth field — and a field the file contains has to be
     a field the grid shows. */
  assert.equal(r.raggedColumns, 4, 'the late field was left without a column')
  assert.ok(r.raggedSummary.includes('4 columns'), r.raggedSummary)
})

ok('and that field can be reached, not merely counted', () => {
  assert.match(r.raggedFound, /1 matching row/, 'the one row holding it should be counted')
  assert.equal(r.raggedLateCell, 'late', 'the late field never made it onto the screen')
})

/* ---------------------------------------------- a file the extension lied about */

ok('a semicolon .csv opens as a table rather than one long column', () => {
  /* What the extension promises is a comma. What a spreadsheet writes in every
     country that spells decimals with a comma is this — and read with a comma
     it is one column of unsplit lines: every row intact, entirely unusable,
     and nothing on screen saying why. */
  assert.deepEqual(r.semiHeadings, ['id', 'name', 'price'])
  assert.deepEqual(r.semiFirstRow, ['1,50', '2,75'], 'the decimals stayed in their cells')
})

ok('and the grid says what it decided, because the extension disagreed', () => {
  assert.equal(r.semiPickerShown, true, 'nothing said why the file split that way')
  assert.equal(r.semiPickerValue, 'Semicolon')
})

ok('a file is written back with the delimiter it came with', () => {
  /* Resaving a semicolon file as a comma file is a diff against every line of
     it, and turns each decimal into an extra column on the way. */
  assert.equal(r.semiFileAfterEdit, 'id;name;price\nca1;Zara;1,50\nb2;Grace;2,75\n')
})

ok('and an ordinary comma file says nothing about its delimiter', () => {
  assert.equal(r.commaPickerShown, false, 'the bar explained something with nothing to explain')
})

/* ---------------------------------------------------------- a wide export */

ok('a wide table builds the columns in view rather than all of them', () => {
  assert.ok(r.wideColumns.includes('200 columns'), r.wideColumns)
  /* The pane is 720px against columns of at least 72, so a dozen or so fit.
     What matters is that it is a fraction of two hundred rather than two
     hundred: this used to build every column of every row in the band. */
  assert.ok(r.wideCellsPerRow > 0, 'no cells were built at all')
  assert.ok(r.wideCellsPerRow < 40,
    `built ${r.wideCellsPerRow} cells per row for a pane that fits about a dozen`)
})

ok('and the table is still as wide as all of them', () => {
  /* The spacers standing in for the columns off screen keep the row its full
     width. Without them the scrollbar would shrink to the built band and jump
     under the reader's hand on every scroll. */
  assert.ok(r.wideTotalWidth > 200 * 72,
    `the canvas is ${r.wideTotalWidth}px, narrower than two hundred columns`)
  assert.equal(r.widthHeldOnScroll, true, 'the table changed width when it scrolled')
})

ok('scrolling by a row keeps the rows that are still on screen', () => {
  /* The band used to be discarded and rebuilt to move by one line, which on a
     wide table is thousands of elements for a scroll of 28 pixels. */
  assert.equal(r.rowRecycled, true, 'a row still in view was rebuilt rather than kept')
})

ok('scrolling sideways brings the far columns in, under their own headings', () => {
  assert.equal(r.wideFarLastColumn, 199, 'the last column never arrived')
  assert.ok(r.wideFarFirstColumn > 100,
    `column ${r.wideFarFirstColumn} was still built at the far right of the table`)
  assert.ok(r.wideFarCellsPerRow < 40, 'the far end built the whole table again')
  // The heading strip is virtual on the same axis and has to move with it.
  assert.deepEqual(r.wideFarHeadings, ['198:c198', '199:c199'])
  assert.equal(r.wideFarCellText, 'r0f199', 'the far cell holds another column\'s value')
})

/* ------------------------------------------------------ what a reader hears */

ok('the grid says it is a grid, and how big it really is', () => {
  assert.equal(r.ariaRole, 'grid')
  /* Four body rows and the header. The point of saying it here is that only
     the rows in view exist to be walked — without this a reader is told the
     table is as big as the window. */
  assert.equal(r.ariaRowCount, '5')
  assert.equal(r.ariaColCount, '3')
})

ok('the headings, the line numbers and the cells each say what they are', () => {
  assert.equal(r.ariaHeadingRole, 'columnheader')
  assert.equal(r.ariaGutterRole, 'rowheader')
  assert.equal(r.ariaCellRole, 'gridcell')
  assert.equal(r.ariaFirstBodyRow, '2', 'the header is row one')
  assert.equal(r.ariaColIndex, '2')
})

ok('and which cell is selected, and which one the keyboard is on', () => {
  assert.equal(r.ariaSelected, 'true')
  assert.equal(r.ariaUnselected, 'false')
  assert.equal(r.ariaActive, true, 'the grid did not point at the cursor cell')
})

ok('a sorted column says which way it is pointed', () => {
  // The mark beside the label is a triangle, and a triangle reads as nothing.
  assert.equal(r.ariaSorted, 'ascending')
})

/* -------------------------------------------------- a selection in pieces

   The thing a rectangle cannot say: these two columns, out of thirty, and not
   the twenty-eight between them. */

ok('⌘-clicking a heading adds the column to the one already picked', () => {
  assert.equal(r.twoColumns, 10, 'two columns of four rows, each with a heading')
  assert.ok(r.twoColumnsSummary.includes('10 selected in 2 blocks'), r.twoColumnsSummary)
})

ok('the picked columns copy as columns, side by side', () => {
  /* The one that was skipped is not on the clipboard. A selection in pieces
     that pasted the pieces back with the gap filled in would be handing over
     data nobody asked for. */
  assert.equal(r.twoColumnsCopied, [
    'name\twhen',
    'Ada\t2026-01-02',
    'Grace\t2025-12-31',
    'Alan\t2026-03-04',
    'Bob\t2026-02-01'
  ].join('\n'))
})

ok('⌘-clicking it again puts the column back', () => {
  assert.equal(r.afterUnpicking, 5, 'the second column left, the first stayed')
})

ok('two rows with another between them select and copy as the two of them', () => {
  assert.equal(r.twoRows, 6, 'two rows of three columns')
  assert.ok(r.twoRowsSummary.includes('6 selected in 2 blocks'), r.twoRowsSummary)
  assert.equal(r.twoRowsCopied, 'Ada\t10\t2026-01-02\nAlan\t\t2026-03-04')
})

ok('deleting rows takes every row picked, not the block the cursor is in', () => {
  assert.deepEqual(r.afterDeletingPickedRows, ['Grace', 'Bob'])
  assert.deepEqual(r.afterDeletingUndone, ['Ada', 'Grace', 'Alan', 'Bob'],
    'undo did not put both rows back')
})

ok('cells nowhere near each other still add up', () => {
  // 10 and 9, with the blank score between them left out of it.
  assert.ok(r.twoCellsSummary.includes('2 selected in 2 blocks'), r.twoCellsSummary)
  assert.ok(r.twoCellsSummary.includes('sum 19'), r.twoCellsSummary)
  assert.ok(r.twoCellsSummary.includes('avg 9.5'), r.twoCellsSummary)
})

ok('a plain click is still "this one instead"', () => {
  assert.equal(r.afterPlainClick, 1, 'the blocks outlived the click that replaced them')
  assert.ok(!r.afterPlainClickSummary.includes('selected'), r.afterPlainClickSummary)
})

/* ------------------------------------------------------------- filtering

   Show me only these — the question a column of categories is for, and the one
   thing a find box that highlights cannot answer. */

ok('a column offers its values, counted, with the funnel in its heading', () => {
  assert.equal(r.filterOpened, true, 'the funnel opened nothing')
  assert.deepEqual(r.filterValues, ['Ada 1', 'Alan 1', 'Bob 1', 'Grace 1'])
})

ok('unticking values takes their rows off the screen', () => {
  assert.deepEqual(r.filtered, ['Ada', 'Alan'])
  // The rows that are left still say which lines of the file they are.
  assert.deepEqual(r.filteredGutters, ['2', '4'])
  assert.equal(r.filteredHeading, true, 'the filtered column did not say so')
  assert.ok(r.filteredSummary.includes('showing 2 of 4, filtered by name'), r.filteredSummary)
})

ok('filtering is a way of looking, so it writes nothing', () => {
  assert.equal(r.fileAfterFiltering, true, 'a filter rewrote the file')
  assert.equal(r.dirtyAfterFiltering, false, 'a filter marked the file unsaved')
})

ok('Escape closes the panel and leaves the filter as the ticks left it', () => {
  assert.equal(r.filterClosed, true)
  assert.deepEqual(r.stillFiltered, ['Ada', 'Alan'])
})

ok('Clear filters brings every row back', () => {
  assert.deepEqual(r.afterClearing, ['Ada', 'Grace', 'Alan', 'Bob'])
})

ok('the find box hides what it does not match, but only when asked', () => {
  assert.deepEqual(r.whileFinding, ['Ada', 'Grace', 'Alan', 'Bob'],
    'finding took rows away on its own')
  assert.deepEqual(r.onlyMatches, ['Ada'])
  assert.ok(r.onlyMatchesSummary.includes('showing 1 of 4'), r.onlyMatchesSummary)
  assert.deepEqual(r.afterOnlyMatchesOff, ['Ada', 'Grace', 'Alan', 'Bob'])
})

/* ------------------------------------------------------------ alignment */

ok('a column reads the way its content implies until somebody says otherwise', () => {
  assert.ok(!r.alignByContent.text.cell.includes('csv-num'), r.alignByContent.text.cell)
  assert.ok(r.alignByContent.numbers.cell.includes('csv-num'), r.alignByContent.numbers.cell)
})

ok('the heading menu points a column left, centre or right', () => {
  assert.ok(r.alignedRight.cell.includes('csv-right'), r.alignedRight.cell)
  assert.ok(r.alignedRight.head.includes('csv-right'), r.alignedRight.head)
})

ok('and points every selected column at once', () => {
  assert.equal(r.alignManyLabel, 'Align centre (2 columns)')
  for (const shape of r.alignedMany) {
    assert.ok(shape.cell.includes('csv-center'), shape.cell)
    assert.ok(shape.head.includes('csv-center'), shape.head)
  }
  // Reopened over those columns, the menu ticks the alignment they are in.
  assert.equal(r.alignTicked, '✓ Align centre (2 columns)')
})

ok('“automatically” hands the columns back to their content', () => {
  for (const shape of r.alignedAuto) {
    assert.ok(!shape.cell.includes('csv-center'), shape.cell)
    assert.ok(!shape.cell.includes('csv-right'), shape.cell)
  }
})

ok('and none of it is an edit to the file', () => {
  assert.equal(r.writesFromAligning, 0, 'aligning a column wrote the file')
  assert.equal(r.fileAfterAligning,
    'name,score,when\nAda,10,2026-01-02\nGrace,2,2025-12-31\nAlan,,2026-03-04\nBob,9,2026-02-01\n')
})

console.log(`\n${passed} checks passed`)
