/* What an `.ipynb` means, and what comes back out of one.
 *
 * The round trip is the test that matters most here. A notebook is a file
 * people also open in Jupyter, in git and in nbdime, and the whole argument for
 * editing one in Tulip is that doing so leaves the rest of that alone: an edit
 * to one cell has to be a diff against one cell, unknown fields have to survive
 * a save they had nothing to do with, and a file this app has merely *looked*
 * at has to come back byte for byte.
 *
 * The rest is the reading: which of the several drawings of one value a viewer
 * should show, and what a kernel's escape codes mean — both of them easy to get
 * subtly wrong and impossible to notice by looking at the screen.
 */

import assert from 'node:assert/strict'
import {
  cellText,
  sourceLines,
  readNotebook,
  writeNotebook,
  newCell,
  notebookLanguage,
  notebookShape,
  outputParts,
  ansiSpans,
  kernelOutput,
  applyOutput
} from '../src/notebook.js'
import VAULT_CONTRACT from '../electron/vault-contract.json'
import { isNotebookPath, isViewedFilePath, isCodePath } from '../src/vault-paths.js'

let passed = 0
function ok (what, fn) {
  fn()
  passed++
  console.log(`ok - ${what}`)
}

const ESC = String.fromCharCode(27)

/* A notebook as Jupyter itself writes one: keys sorted, one space of indent,
   a trailing newline. Everything below that talks about bytes compares against
   this shape. */
const JUPYTER = `{
 "cells": [
  {
   "cell_type": "markdown",
   "id": "aaa",
   "metadata": {},
   "source": [
    "# Title\\n",
    "\\n",
    "Some prose."
   ]
  },
  {
   "cell_type": "code",
   "execution_count": 3,
   "id": "bbb",
   "metadata": {
    "tags": [
     "keep"
    ]
   },
   "outputs": [
    {
     "name": "stdout",
     "output_type": "stream",
     "text": [
      "hello\\n"
     ]
    }
   ],
   "source": [
    "print('hello')"
   ]
  }
 ],
 "metadata": {
  "kernelspec": {
   "display_name": "Python 3",
   "language": "python",
   "name": "python3"
  },
  "language_info": {
   "name": "python",
   "version": "3.12.1"
  }
 },
 "nbformat": 4,
 "nbformat_minor": 5
}
`

/* ------------------------------------------------------------ the source */

ok('a cell’s source reads the same either way it was stored', () => {
  assert.equal(cellText(['a\n', 'b']), 'a\nb')
  assert.equal(cellText('a\nb'), 'a\nb')
  assert.equal(cellText(undefined), '')
})

ok('text goes back as the lines nbformat stores, newlines and all', () => {
  assert.deepEqual(sourceLines('a\nb'), ['a\n', 'b'])
  assert.deepEqual(sourceLines('a\nb\n'), ['a\n', 'b\n'])
  // An empty cell is an empty list, not a list holding an empty line: the
  // difference is a diff against every empty cell in the file.
  assert.deepEqual(sourceLines(''), [])
  assert.deepEqual(sourceLines('\n'), ['\n'])
})

ok('every source survives the trip out and back', () => {
  for (const text of ['', 'x', 'a\nb', 'a\nb\n', '\n\n', 'ends with space \n']) {
    assert.equal(cellText(sourceLines(text)), text, JSON.stringify(text))
  }
})

/* ------------------------------------------------------------- the file */

ok('a notebook parses into its cells', () => {
  const { shell, cells } = readNotebook(JUPYTER)
  assert.equal(cells.length, 2)
  assert.equal(cells[0].type, 'markdown')
  assert.equal(cells[0].source, '# Title\n\nSome prose.')
  assert.equal(cells[1].type, 'code')
  assert.equal(cells[1].executionCount, 3)
  assert.equal(cells[1].outputs.length, 1)
  assert.equal(shell.nbformat, 4)
})

ok('what is not a notebook is refused rather than half-opened', () => {
  assert.throws(() => readNotebook('not json at all'), /valid JSON/)
  assert.throws(() => readNotebook('{"hello": 1}'), /not a Jupyter notebook/)
  assert.throws(() => readNotebook('[]'), /not a Jupyter notebook/)
  assert.throws(() => readNotebook(''), /valid JSON/)
})

ok('a cell of an unknown kind is carried as raw rather than dropped', () => {
  const { cells } = readNotebook('{"cells":[{"cell_type":"heading","source":"x"}]}')
  assert.equal(cells.length, 1)
  assert.equal(cells[0].type, 'raw')
  assert.equal(cells[0].source, 'x')
})

ok('a file only read comes back byte for byte', () => {
  const { shell, cells } = readNotebook(JUPYTER)
  assert.equal(writeNotebook(shell, cells), JUPYTER)
})

ok('editing one cell rewrites one cell', () => {
  const { shell, cells } = readNotebook(JUPYTER)
  cells[1].source = "print('goodbye')"
  const after = writeNotebook(shell, cells)

  const changed = JUPYTER.split('\n')
    .filter((line, i) => line !== after.split('\n')[i])
  assert.deepEqual(changed, ["    \"print('hello')\""])
})

ok('a field this app has never heard of survives a save', () => {
  const source = JSON.stringify({
    cells: [{
      cell_type: 'code',
      source: ['x'],
      metadata: { collapsed: true, deletable: false },
      outputs: [],
      execution_count: null,
      attachments: {},
      some_future_field: { kept: 1 }
    }],
    metadata: { widgets: { state: 'opaque' } },
    nbformat: 4,
    nbformat_minor: 5
  })
  const { shell, cells } = readNotebook(source)
  const back = JSON.parse(writeNotebook(shell, cells))
  assert.deepEqual(back.cells[0].some_future_field, { kept: 1 })
  assert.deepEqual(back.cells[0].metadata, { collapsed: true, deletable: false })
  assert.deepEqual(back.metadata.widgets, { state: 'opaque' })
})

ok('a cell that stops being code stops carrying what only code has', () => {
  const { shell, cells } = readNotebook(JUPYTER)
  cells[1].type = 'markdown'
  cells[1].outputs = []
  const back = JSON.parse(writeNotebook(shell, cells))
  assert.equal(back.cells[1].cell_type, 'markdown')
  assert.equal('outputs' in back.cells[1], false)
  assert.equal('execution_count' in back.cells[1], false)
  // And what every cell has is still there.
  assert.equal(back.cells[1].id, 'bbb')
})

ok('a new cell takes an id only where the file already uses them', () => {
  const modern = newCell('code', { nbformat: 4, nbformat_minor: 5 })
  assert.equal(typeof modern.raw.id, 'string')
  assert.ok(modern.raw.id.length)

  const older = newCell('code', { nbformat: 4, nbformat_minor: 2 })
  assert.equal('id' in older.raw, false)
  assert.equal('id' in newCell('code', null).raw, false)
})

ok('a new markdown cell has no outputs to carry', () => {
  const cell = newCell('markdown', { nbformat: 4, nbformat_minor: 5 })
  assert.equal(cell.type, 'markdown')
  assert.equal(cell.source, '')
  assert.equal('outputs' in cell.raw, false)
  const written = JSON.parse(writeNotebook({ cells: [] }, [cell]))
  assert.equal('execution_count' in written.cells[0], false)
})

ok('the kernel says which language the code cells are in', () => {
  const { shell } = readNotebook(JUPYTER)
  assert.equal(notebookLanguage(shell), 'python')
  assert.equal(notebookLanguage({ metadata: { kernelspec: { language: 'Julia' } } }), 'julia')
  // Nothing to go on is nothing claimed, rather than a guess at Python.
  assert.equal(notebookLanguage({ metadata: {} }), '')
  assert.equal(notebookLanguage(null), '')
})

ok('a notebook is measured in what it is made of', () => {
  const { cells } = readNotebook(JUPYTER)
  assert.deepEqual(notebookShape(cells), { cells: 2, code: 1, markdown: 1, outputs: 1 })
})

/* ---------------------------------------------------------- the outputs */

ok('a stream is its text, and knows which one it came down', () => {
  assert.deepEqual(
    outputParts({ output_type: 'stream', name: 'stdout', text: ['a\n', 'b'] }),
    [{ kind: 'stream', stream: 'stdout', text: 'a\nb' }])
  assert.equal(
    outputParts({ output_type: 'stream', name: 'stderr', text: 'x' })[0].stream, 'stderr')
  // Nothing printed is nothing drawn, rather than an empty box.
  assert.deepEqual(outputParts({ output_type: 'stream', name: 'stdout', text: '' }), [])
})

ok('an error is its traceback, and its name when it has none', () => {
  const [part] = outputParts({
    output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['line 1', 'line 2']
  })
  assert.equal(part.kind, 'error')
  assert.equal(part.text, 'line 1\nline 2')
  assert.equal(part.title, 'ValueError: bad')

  const [bare] = outputParts({ output_type: 'error', ename: 'ValueError', evalue: 'bad' })
  assert.equal(bare.text, 'ValueError: bad')
})

ok('the richest drawing of a value is the one shown', () => {
  // A DataFrame ships a table and a picture of one in text. The table wins.
  const [table] = outputParts({
    output_type: 'execute_result',
    data: { 'text/html': '<table><tr><td>1</td></tr></table>', 'text/plain': '   a\n0  1' }
  })
  assert.equal(table.kind, 'html')

  // A plot ships a PNG and the string `<Figure size 640x480>`. The plot wins.
  const [plot] = outputParts({
    output_type: 'display_data',
    data: { 'image/png': 'AAAB\nCCCD\n', 'text/plain': '<Figure size 640x480>' }
  })
  assert.equal(plot.kind, 'image')
  assert.equal(plot.mime, 'image/png')
  // The newlines a writer wrapped the base64 at are not part of the payload.
  assert.equal(plot.data, 'AAABCCCD')

  const [svg] = outputParts({
    output_type: 'display_data', data: { 'image/svg+xml': '<svg/>', 'text/plain': 'x' }
  })
  assert.equal(svg.kind, 'svg')
  assert.equal(svg.markup, '<svg/>')

  const [plain] = outputParts({
    output_type: 'execute_result', data: { 'text/plain': ['42'] }
  })
  assert.deepEqual(plain, { kind: 'text', text: '42' })
})

ok('an output nothing here can draw draws nothing', () => {
  assert.deepEqual(outputParts({ output_type: 'display_data', data: {} }), [])
  assert.deepEqual(outputParts({
    output_type: 'display_data',
    data: { 'application/vnd.plotly.v1+json': { data: [] } }
  }), [])
  assert.deepEqual(outputParts({ output_type: 'something_new' }), [])
  assert.deepEqual(outputParts(null), [])
})

/* --------------------------------------------------------------- ansi */

ok('plain text is one span with nothing on it', () => {
  assert.deepEqual(ansiSpans('hello'), [{ text: 'hello', classes: '' }])
  assert.deepEqual(ansiSpans(''), [])
})

ok('a colour lasts until it is turned off', () => {
  const spans = ansiSpans(`${ESC}[31mred${ESC}[0m plain`)
  assert.deepEqual(spans, [
    { text: 'red', classes: 'nb-fg-red' },
    { text: ' plain', classes: '' }
  ])
})

ok('bold, italic and a background are read together', () => {
  const [span] = ansiSpans(`${ESC}[1;3;42mx`)
  assert.equal(span.text, 'x')
  assert.ok(span.classes.includes('nb-bold'))
  assert.ok(span.classes.includes('nb-italic'))
  assert.ok(span.classes.includes('nb-bg-green'))
})

ok('neighbours wearing the same look are one span', () => {
  // A traceback is thousands of fragments and most of them are its neighbours
  // in the same colour; one span per fragment is one DOM node per fragment.
  const spans = ansiSpans(`${ESC}[31ma${ESC}[31mb${ESC}[31mc`)
  assert.deepEqual(spans, [{ text: 'abc', classes: 'nb-fg-red' }])
})

ok('an empty parameter list means reset', () => {
  assert.deepEqual(ansiSpans(`${ESC}[31mred${ESC}[mplain`), [
    { text: 'red', classes: 'nb-fg-red' },
    { text: 'plain', classes: '' }
  ])
})

ok('a progress bar is shown as the last thing it drew', () => {
  assert.deepEqual(ansiSpans('10%\r50%\r100%\ndone'),
    [{ text: '100%\ndone', classes: '' }])
})

ok('the escape codes that move a cursor are dropped, not shown', () => {
  assert.deepEqual(ansiSpans(`a${ESC}[2Kb${ESC}[1;1Hc`),
    [{ text: 'abc', classes: '' }])
})

ok('an escape code written out as text is text', () => {
  // A traceback quoting source that prints "\x1b[0m" has the *characters*, not
  // the escape. A scanner anchored on the bracket alone would eat them.
  assert.deepEqual(ansiSpans('print("[0m")'),
    [{ text: 'print("[0m")', classes: '' }])
})

/* ------------------------------------------------------ what a kernel says

   The claim this half rests on is that a kernel message and a saved output are
   the same object. If that is true, everything `outputParts` was already
   tested for above applies unchanged to a cell that is running — so these
   check the translation, and then check the round trip through it. */

ok('a kernel message becomes the output nbformat records', () => {
  assert.deepEqual(kernelOutput('stream', { name: 'stdout', text: 'hi\n' }),
    { output_type: 'stream', name: 'stdout', text: 'hi\n' })

  assert.deepEqual(
    kernelOutput('execute_result', { data: { 'text/plain': '42' }, metadata: {}, execution_count: 3 }),
    { output_type: 'execute_result', data: { 'text/plain': '42' }, metadata: {}, execution_count: 3 })

  // display_data is the same shape without the number: it is something the
  // cell showed, not the value the cell had.
  const shown = kernelOutput('display_data', { data: { 'image/png': 'AAAA' }, metadata: {} })
  assert.deepEqual(shown, { output_type: 'display_data', data: { 'image/png': 'AAAA' }, metadata: {} })
  assert.equal('execution_count' in shown, false)

  assert.deepEqual(
    kernelOutput('error', { ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['a', 'b'] }),
    { output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['a', 'b'] })
})

ok('the messages that are not outputs are not treated as any', () => {
  // Our own request, echoed back on iopub. Recorded as an output it would put
  // the cell's own source into the cell's output.
  assert.equal(kernelOutput('execute_input', { code: 'x = 1', execution_count: 1 }), null)
  assert.equal(kernelOutput('status', { execution_state: 'idle' }), null)
  assert.equal(kernelOutput('comm_open', {}), null)
  assert.equal(kernelOutput('stream', null)?.text, '')
})

ok('a kernel message draws the same as the output it becomes', () => {
  // The whole bargain of this file: live output and saved output are one path.
  const live = kernelOutput('display_data', {
    data: { 'text/plain': '<Figure size 640x480>', 'image/png': 'iVBOR\nw0KG' }, metadata: {}
  })
  assert.deepEqual(outputParts(live), [{ kind: 'image', mime: 'image/png', data: 'iVBORw0KG' }])
})

ok('a thousand printed lines are one output, not a thousand', () => {
  // A loop sends a message per flush. Recorded one-for-one this would write a
  // notebook no other tool writes, and build a <pre> per line to show one
  // paragraph.
  let state = { outputs: [], clearWhenNext: false }
  for (const text of ['a\n', 'b\n', 'c\n']) {
    state = applyOutput(state, kernelOutput('stream', { name: 'stdout', text }))
  }
  assert.equal(state.outputs.length, 1)
  assert.equal(state.outputs[0].text, 'a\nb\nc\n')
})

ok('the two streams stay apart', () => {
  // stdout and stderr are drawn differently and interleaving them into one
  // output would lose which was which.
  let state = { outputs: [], clearWhenNext: false }
  state = applyOutput(state, kernelOutput('stream', { name: 'stdout', text: 'out' }))
  state = applyOutput(state, kernelOutput('stream', { name: 'stderr', text: 'err' }))
  state = applyOutput(state, kernelOutput('stream', { name: 'stdout', text: 'more' }))
  assert.deepEqual(state.outputs.map((o) => [o.name, o.text]),
    [['stdout', 'out'], ['stderr', 'err'], ['stdout', 'more']])
})

ok('a plot between two prints does not merge them', () => {
  let state = { outputs: [], clearWhenNext: false }
  state = applyOutput(state, kernelOutput('stream', { name: 'stdout', text: 'before' }))
  state = applyOutput(state, kernelOutput('display_data', { data: { 'image/png': 'x' }, metadata: {} }))
  state = applyOutput(state, kernelOutput('stream', { name: 'stdout', text: 'after' }))
  assert.deepEqual(state.outputs.map((o) => o.output_type),
    ['stream', 'display_data', 'stream'])
})

ok('clear_output empties the cell', () => {
  let state = { outputs: [], clearWhenNext: false }
  state = applyOutput(state, kernelOutput('stream', { name: 'stdout', text: 'gone' }))
  state = applyOutput(state, kernelOutput('clear_output', { wait: false }))
  assert.deepEqual(state.outputs, [])
})

ok('clear_output with wait holds the old output until there is a new one', () => {
  /* How a progress bar redraws without the cell flickering empty between
     frames: the clear is a promise to replace, not an instruction to blank. */
  let state = { outputs: [], clearWhenNext: false }
  state = applyOutput(state, kernelOutput('stream', { name: 'stdout', text: '10%' }))
  state = applyOutput(state, kernelOutput('clear_output', { wait: true }))
  assert.equal(state.outputs.length, 1, 'still showing the old frame')
  assert.equal(state.outputs[0].text, '10%')

  state = applyOutput(state, kernelOutput('stream', { name: 'stdout', text: '20%' }))
  assert.equal(state.outputs.length, 1, 'replaced, not appended')
  assert.equal(state.outputs[0].text, '20%')
})

ok('a clear marker never reaches the file', () => {
  // It is an instruction about outputs, carried down the same path so a cell's
  // story arrives in order. A notebook holding one is a notebook that fails
  // validation everywhere else.
  let state = { outputs: [], clearWhenNext: false }
  state = applyOutput(state, kernelOutput('clear_output', { wait: true }))
  state = applyOutput(state, kernelOutput('stream', { name: 'stdout', text: 'x' }))
  assert.equal(state.outputs.some((o) => o.output_type === 'clear_output'), false)
})

ok('what a run records is what a notebook file holds', () => {
  /* The end of the claim: run a cell, write the file, read it back, and the
     outputs are the ones the kernel produced — through the same writer that
     has to keep a byte-for-byte round trip above. */
  let state = { outputs: [], clearWhenNext: false }
  state = applyOutput(state, kernelOutput('stream', { name: 'stdout', text: 'hello\n' }))
  state = applyOutput(state, kernelOutput('execute_result', {
    data: { 'text/plain': '42' }, metadata: {}, execution_count: 1
  }))

  const { shell, cells } = readNotebook(JSON.stringify({
    cells: [{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['1+1'] }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5
  }))
  cells[0].outputs = state.outputs
  cells[0].executionCount = 1

  const reread = readNotebook(writeNotebook(shell, cells))
  assert.equal(reread.cells[0].executionCount, 1)
  assert.deepEqual(reread.cells[0].outputs.map((o) => o.output_type),
    ['stream', 'execute_result'])
  assert.deepEqual(outputParts(reread.cells[0].outputs[1]), [{ kind: 'text', text: '42' }])
})

/* ------------------------------------------------------- the vault path */

ok('the vault knows an .ipynb from everything else it holds', () => {
  assert.equal(VAULT_CONTRACT.notebookExtension, '.ipynb')
  assert.equal(isNotebookPath('Papers/Analysis.ipynb'), true)
  assert.equal(isNotebookPath('Papers/ANALYSIS.IPYNB'), true)
  assert.equal(isNotebookPath('notes/ipynb'), false)
  // Not a source file, and not one of the kinds with no viewer: it has its own.
  assert.equal(isCodePath('Analysis.ipynb'), false)
  assert.equal(isViewedFilePath('Analysis.ipynb'), false)
})

console.log(`\n${passed} checks passed`)
