/* Does the table behave like a table?
 *
 * The parser and the comparators are checked in test-csv.mjs, which needs no
 * browser. This is the other half: a real grid in a real Chromium window,
 * driven with the events a person's mouse and keyboard send, asserting what
 * ends up on screen and — the part that matters — what ends up in the file.
 *
 * The rule the whole viewer is built on is the one most worth a test: sorting
 * and filtering are ways of looking at a file, not edits to it. A hundred
 * thousand lines must not be rewritten because somebody wanted to see the
 * largest first, and the one case where they did mean it (Apply sort) has to
 * be an ordinary undoable edit.
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
  .csv-head { display: flex; height: 30px; overflow: hidden; }
  .csv-scroller { flex: 1 1 auto; min-height: 0; overflow: auto; }
  .csv-canvas, .csv-window { position: relative; }
  .csv-row { position: absolute; left: 0; display: flex; height: 28px; }
  .csv-cell, .csv-gutter { flex: 0 0 auto; height: 100%; white-space: pre; overflow: hidden; }
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
  const win = new BrowserWindow({ width: 760, height: 460, show: true })
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
  assert.match(r.rectangleStats, /^3 × 2/)
})

ok('a rectangle of numbers says what they come to', () => {
  assert.match(r.columnStats, /sum 21/)   // 10 + 2 + 9, with the blank skipped
  assert.match(r.columnStats, /avg 7/)
  assert.match(r.columnStats, /1 empty/)
})

ok('⌃space takes the whole column, heading and all', () => {
  assert.equal(r.columnSelection, 5, 'four rows and the heading')
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

/* ------------------------------------------------------------ the finding */

ok('the find box counts the rows holding what was typed', () => {
  assert.match(r.matchesShown, /3 matching rows/)   // Ada, Grace, Alan
  assert.ok(r.highlighted > 0, 'and marks the cells themselves')
})

ok('hiding the other rows leaves only the matches', () => {
  assert.deepEqual(r.filteredRows, ['Ada', 'Grace', 'Alan'])
  assert.deepEqual(r.filteredGutters, ['2', '3', '4'])
  assert.match(r.summaryFiltered, /showing 3/)
})

ok('the copilot is handed the table as it is being looked at', () => {
  assert.equal(r.contextFiltered,
    'name,score,when\nAda,10,2026-01-02\nGrace,2,2025-12-31\nAlan,,2026-03-04\n')
})

ok('turning the filter off brings the file back', () => {
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

console.log(`\n${passed} checks passed`)
