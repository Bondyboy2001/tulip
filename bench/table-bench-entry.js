/* The grid, timed against a real editor in a real document.

   Everything the table costs is DOM work inside a CodeMirror block widget, so
   none of it can be measured under Node: the numbers here are Chromium's, taken
   in the same window the tests run in. The workload is the one the comments in
   src/table.js keep pointing at — a vocabulary table of a few hundred rows,
   which is where every per-cell cost is multiplied by a thousand.

   Reported: how long a table takes to appear, what one keystroke in a cell
   costs, and what a change elsewhere in the note costs a table that is only
   watching. Run it with `npm run bench:table`. */

import { EditorView, keymap } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { search } from '@codemirror/search'
import {
  tablePreview, tableCursorGuard, tableSearchHighlight,
  tableAssetResolver, languageTableMode
} from '../src/table.js'

const ROWS = 400
const COLUMNS = 4

const HEADER = '| Word | Meaning | Example | Notes |'
const DELIMITER = '| --- | --- | --- | --- |'
const row = (n) => `| wort-${n} | meaning ${n} | *ein* satz ${n} | note ${n} |`

const table = [HEADER, DELIMITER, ...Array.from({ length: ROWS }, (_, n) => row(n))].join('\n')
const note = `# Vocabulary\n\nA paragraph before it.\n\n${table}\n\nAnd one after.\n`

const frame = () => new Promise((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(resolve)))

function mount (parent) {
  return new EditorView({
    doc: note,
    parent,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      search(),
      tableAssetResolver.of(() => null),
      languageTableMode.of(() => false),
      tablePreview,
      tableCursorGuard,
      tableSearchHighlight
    ]
  })
}

/** The median of several runs, because one run of anything in a browser is a
 *  measurement of what else the browser was doing.
 *
 *  Nothing here awaits a frame inside the timed part: waiting for rAF measures
 *  the display's refresh rate, which is 16.7ms whatever the code does — the
 *  first cut of this benchmark reported exactly that for every line. What is
 *  timed is the work plus the layout it forces, which is what a keystroke
 *  actually costs the person typing. */
function time (runs, run, settle = () => {}) {
  const taken = []
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    run(i)
    layout()
    taken.push(performance.now() - started)
    settle(i)
  }
  taken.sort((a, b) => a - b)
  return taken[taken.length >> 1]
}

/* Chromium does the work lazily and would otherwise hand back a number that
   says only how long it took to schedule it. Reading a geometric property is
   what makes it happen now. */
let sink = 0
const layout = () => { sink += document.body.offsetHeight }

async function main () {
  const parent = document.createElement('div')
  parent.style.width = '900px'
  parent.style.height = '700px'
  document.body.append(parent)

  const results = {}

  /* A note with a big table in it, opened. This is what "clicking a note does
     nothing for a moment" is made of. */
  let built = null
  results.build = time(5, () => { built = mount(parent) }, () => { built.destroy() })
  {
    const js = []; const paint = []
    for (let i = 0; i < 5; i++) {
      const a = performance.now()
      const view = mount(parent)
      const b = performance.now()
      layout()
      const c = performance.now()
      js.push(b - a); paint.push(c - b)
      view.destroy()
    }
    js.sort((x, y) => x - y); paint.sort((x, y) => x - y)
    results.buildJs = js[2]; results.buildLayout = paint[2]
  }

  const view = mount(parent)
  await frame()
  const wrap = view.dom.querySelector('.tk-table-wrap')
  const cell = (r, c) => wrap.querySelector(`[data-row="${r}"][data-col="${c}"]`)

  results.rows = wrap.querySelectorAll('tbody tr').length
  results.cells = wrap.querySelectorAll('td, th').length

  /* One keystroke in a cell. The widget is rebuilt or updated for every one of
     them, and every cell of the table is visited on the way. */
  const typing = cell(1, 0)
  typing.focus()
  await frame()
  results.keystroke = time(21, (i) => {
    typing.textContent = `wort-0${'x'.repeat(i % 7)}`
    typing.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
  typing.blur()
  await frame()

  /* A change somewhere else in the note: the table has nothing to do with it,
     and should be paying nothing for it. */
  results.elsewhere = time(11, (i) => {
    view.dispatch({ changes: { from: 0, to: 1, insert: i % 2 ? '#' : '#' } })
  })

  /* Dragging a rectangle of cells across the grid — the selection path, which
     touches every cell it passes. */
  const from = cell(1, 0).getBoundingClientRect()
  const to = cell(40, 3).getBoundingClientRect()
  results.select = time(5, () => {
    cell(1, 0).dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      clientX: from.x + 2, clientY: from.y + 2
    }))
    for (let step = 1; step <= 8; step++) {
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, buttons: 1,
        clientX: from.x + ((to.x - from.x) * step) / 8,
        clientY: from.y + ((to.y - from.y) * step) / 8
      }))
    }
    /* Release inside the measurement. The selection path coalesces moves to a
       frame and synchronously flushes the final coordinate here; measuring the
       moves while settling the release afterwards would hide the work whose
       latency the gesture actually exposes. */
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }))
  })

  view.destroy()
  parent.remove()
  window.__tableBench = results
}

main()
