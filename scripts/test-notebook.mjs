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
  copyCell,
  notebookLanguage,
  notebookShape,
  outputParts,
  OUTPUT_LIMIT,
  ansiSpans,
  stripAnsi,
  cellSearchText,
  kernelOutput,
  applyOutput,
  DISPLAY_ID,
  cellDuration,
  setCellDuration,
  formatDuration,
  sourceHidden,
  outputsHidden,
  setHidden,
  cellTags,
  setCellTags,
  withAttachments,
  notebookToScript,
  notebookToHtml
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
    // `head` is what fits on screen, which for anything short is all of it.
    [{ kind: 'stream', stream: 'stdout', text: 'a\nb', head: 'a\nb' }])
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

ok('maths from a kernel comes back as maths, not as its own source', () => {
  // `display(Eq(...))` is the most common thing sympy does, and it was drawn
  // here as the LaTeX it is written in.
  const [part] = outputParts({
    output_type: 'execute_result',
    data: { 'text/latex': ['$\\displaystyle x^{2}$'], 'text/plain': 'x**2' }
  })
  assert.deepEqual(part, { kind: 'latex', text: '$\\displaystyle x^{2}$' })
})

ok('a JSON output keeps the value, so it can be drawn as a tree', () => {
  const [part] = outputParts({
    output_type: 'execute_result',
    data: { 'application/json': { a: [1, 2], b: null } }
  })
  assert.equal(part.kind, 'json')
  assert.deepEqual(part.value, { a: [1, 2], b: null })
  // And the text of it alongside, for anything that cannot draw a tree.
  assert.equal(part.text.includes('"a"'), true)
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

ok('a line ending is not a redraw, however it is spelled', () => {
  /* `\r\n` is one newline. Read as "start this line again" it threw the line
     away — so a kernel whose output ends its lines that way, which is every
     kernel on Windows, printed nothing at all. */
  assert.deepEqual(ansiSpans('one\r\ntwo\r\n'),
    [{ text: 'one\ntwo\n', classes: '' }])
  // And a real redraw still is one, including on a line that then ends in CRLF.
  assert.deepEqual(ansiSpans('10%\r100%\r\ndone'),
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

ok('a cell that prints for a minute is drawn from the head, not the whole', () => {
  /* What a growing stream costs to draw. Appending builds a string the engine
     holds as a tree of its pieces, and asking for the first hundred thousand
     characters of one is what forces that tree flat — so a viewer that takes
     the head off the whole text once a frame walks everything printed so far,
     once a frame, and the work grows with the square of the output.
     `outputParts` carries the head instead, built from the last head rather
     than from the text. This checks it says the same thing the slow way did,
     which is the only way to tell the fast one is still right. */
  let state = { outputs: [], clearWhenNext: false }
  const line = `${'x'.repeat(79)}\n`
  for (let i = 0; i < 4000; i++) {                       // 320k, well past the cap
    state = applyOutput(state, kernelOutput('stream', { name: 'stdout', text: line }))
    // Drawn as it arrives, which is what primes each head from the one before.
    outputParts(state.outputs[0])
  }
  const [part] = outputParts(state.outputs[0])
  assert.equal(part.text.length, 4000 * line.length, 'the file still holds all of it')
  assert.equal(part.head, part.text.slice(0, OUTPUT_LIMIT), 'and the head is that text’s own')
  assert.equal(part.head.length, OUTPUT_LIMIT)
})

ok('an output nobody has drawn yet still knows its own head', () => {
  // Nothing primes the chain when the cell is off screen, so the head has to
  // be computable from the text alone the first time it is asked for.
  let state = { outputs: [], clearWhenNext: false }
  const line = `${'y'.repeat(79)}\n`
  for (let i = 0; i < 4000; i++) {
    state = applyOutput(state, kernelOutput('stream', { name: 'stdout', text: line }))
  }
  const [part] = outputParts(state.outputs[0])
  assert.equal(part.head, part.text.slice(0, OUTPUT_LIMIT))
})

ok('a short stream is its own head', () => {
  const [part] = outputParts({ output_type: 'stream', name: 'stdout', text: 'hello\n' })
  assert.equal(part.head, 'hello\n')
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

/* ------------------------------------------------- a redrawn display

   `update_display_data` is the message a library sends when it means to
   replace something it drew earlier rather than add to it. Appended, the
   notebook keeps every frame; dropped — which is what happened before — the
   first frame stays on screen for ever and the reader believes it.
   ================================================================== */

const displayed = (id, value) => kernelOutput('display_data', {
  data: { 'text/plain': value }, metadata: {}, transient: { display_id: id }
})
const redrawn = (id, value) => kernelOutput('update_display_data', {
  data: { 'text/plain': value }, metadata: {}, transient: { display_id: id }
})

ok('a redrawn display replaces the one it names, and adds nothing', () => {
  let state = { outputs: [], clearWhenNext: false }
  state = applyOutput(state, displayed('bar', '0%'))
  state = applyOutput(state, kernelOutput('stream', { name: 'stdout', text: 'working\n' }))
  state = applyOutput(state, redrawn('bar', '50%'))
  state = applyOutput(state, redrawn('bar', '100%'))

  assert.equal(state.outputs.length, 2)
  assert.deepEqual(outputParts(state.outputs[0]), [{ kind: 'text', text: '100%' }])
  // And the print between the frames is still where it was printed.
  assert.equal(state.outputs[1].output_type, 'stream')
})

ok('a redraw naming a display nobody drew is dropped, not appended', () => {
  let state = { outputs: [], clearWhenNext: false }
  state = applyOutput(state, displayed('one', 'a'))
  state = applyOutput(state, redrawn('other', 'b'))
  assert.equal(state.outputs.length, 1)
  assert.deepEqual(outputParts(state.outputs[0]), [{ kind: 'text', text: 'a' }])
})

ok('two displays under one id: the later one is the one redrawn', () => {
  let state = { outputs: [], clearWhenNext: false }
  state = applyOutput(state, displayed('x', 'first'))
  state = applyOutput(state, displayed('x', 'second'))
  state = applyOutput(state, redrawn('x', 'now'))
  assert.deepEqual(state.outputs.map((o) => o.data['text/plain']), ['first', 'now'])
})

ok('the display id never reaches the file', () => {
  /* It is `transient` in the protocol and nbformat does not record it, so
     writing one would put a key in the JSON that Jupyter never writes — a diff
     on a line nobody edited. Carried on a symbol, which JSON cannot see. */
  const output = displayed('bar', '0%')
  assert.equal(output[DISPLAY_ID], 'bar')
  assert.equal(JSON.stringify(output).includes('bar'), false)
  assert.equal(Object.keys(output).includes('transient'), false)

  const { shell, cells } = readNotebook(JUPYTER)
  cells[1].outputs = [output]
  assert.equal(writeNotebook(shell, cells).includes('display_id'), false)
})

/* ----------------------------------------------------- what a run cost */

ok('how long a cell took is read from the file, not remembered', () => {
  const cell = newCell('code')
  assert.equal(cellDuration(cell), null)

  setCellDuration(cell, Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:03.2Z'))
  assert.equal(cellDuration(cell), 3200)
  // Written where jupyter-server itself writes it, so other tools agree.
  assert.equal(cell.raw.metadata.execution['iopub.execute_input'], '2026-01-01T00:00:00.000Z')

  // A cell whose outputs are cleared has no run left to have taken time.
  setCellDuration(cell, null, null)
  assert.equal(cellDuration(cell), null)
  assert.equal('execution' in cell.raw.metadata, false)
})

ok('a kernel that only stamps its status is still understood', () => {
  const cell = newCell('code')
  cell.raw.metadata.execution = {
    'iopub.status.busy': '2026-01-01T00:00:00Z',
    'iopub.status.idle': '2026-01-01T00:01:00Z'
  }
  assert.equal(cellDuration(cell), 60_000)
})

ok('a duration nothing can be read from is no duration at all', () => {
  const cell = newCell('code')
  cell.raw.metadata.execution = { 'iopub.execute_input': 'not a date' }
  assert.equal(cellDuration(cell), null)
  // Backwards is not a duration either — a clock that moved, not four hours.
  cell.raw.metadata.execution = {
    'iopub.execute_input': '2026-01-01T04:00:00Z',
    'shell.execute_reply': '2026-01-01T00:00:00Z'
  }
  assert.equal(cellDuration(cell), null)
})

ok('a duration is shown to the digit that says something', () => {
  assert.equal(formatDuration(11), '11 ms')
  assert.equal(formatDuration(1500), '1.5 s')
  assert.equal(formatDuration(42_000), '42 s')
  assert.equal(formatDuration(64_000), '1 m 04 s')
  assert.equal(formatDuration(3_900_000), '1 h 05 m')
  assert.equal(formatDuration(null), '')
})

/* --------------------------------------------------------- folds and tags */

ok('a cell folded by JupyterLab is folded here', () => {
  const { cells } = readNotebook(JSON.stringify({
    cells: [{
      cell_type: 'code',
      metadata: { jupyter: { source_hidden: true, outputs_hidden: true } },
      outputs: [], source: []
    }],
    metadata: {}, nbformat: 4, nbformat_minor: 5
  }))
  assert.equal(sourceHidden(cells[0]), true)
  assert.equal(outputsHidden(cells[0]), true)
})

ok('the fold the old Notebook wrote is read too', () => {
  const cell = newCell('code')
  cell.raw.metadata.collapsed = true
  assert.equal(outputsHidden(cell), true)
  // Unfolding clears the legacy key as well, or the two come to disagree.
  setHidden(cell, 'outputs', false)
  assert.equal(outputsHidden(cell), false)
  assert.equal('collapsed' in cell.raw.metadata, false)
})

ok('unfolding leaves no key behind that nbformat would not have written', () => {
  const cell = newCell('code')
  setHidden(cell, 'source', true)
  assert.deepEqual(cell.raw.metadata.jupyter, { source_hidden: true })
  setHidden(cell, 'source', false)
  assert.equal('jupyter' in cell.raw.metadata, false)
})

ok('a cell’s tags are read, written, and kept once each', () => {
  const { cells } = readNotebook(JUPYTER)
  assert.deepEqual(cellTags(cells[1]), ['keep'])

  setCellTags(cells[1], [' parameters ', 'skip', 'skip', ''])
  assert.deepEqual(cellTags(cells[1]), ['parameters', 'skip'])
  setCellTags(cells[1], [])
  assert.equal('tags' in cells[1].raw.metadata, false)
})

/* ------------------------------------------------------- copied cells */

ok('a copied cell shares nothing with the cell it came from', () => {
  const { shell, cells } = readNotebook(JUPYTER)
  cells[1].raw.metadata.execution = { 'iopub.execute_input': '2026-01-01T00:00:00Z' }
  const copy = copyCell(cells[1], shell)

  copy.raw.metadata.tags.push('added')
  assert.deepEqual(cellTags(cells[1]), ['keep'])
  copy.outputs.push({ output_type: 'stream', name: 'stdout', text: 'x' })
  assert.equal(cells[1].outputs.length, 1)

  // A new id, because nbformat 4.5 wants them unique within the file.
  assert.notEqual(copy.raw.id, cells[1].raw.id)
  assert.equal(typeof copy.raw.id, 'string')
  // And no claim to have been run: this copy never has been.
  assert.equal(copy.executionCount, null)
  assert.equal(cellDuration(copy), null)
})

ok('a copy into an older notebook takes no id it could not have', () => {
  const older = { nbformat: 4, nbformat_minor: 4 }
  const copy = copyCell(newCell('code', { nbformat: 4, nbformat_minor: 5 }), older)
  assert.equal('id' in copy.raw, false)
})

/* ---------------------------------------------------- pasted images */

ok('an image pasted into a markdown cell resolves to what it is', () => {
  const attachments = { 'shot.png': { 'image/png': ['AAAB\n', 'CCCD\n'] } }
  const out = withAttachments('![](attachment:shot.png)', attachments)
  assert.equal(out, '![](data:image/png;base64,AAABCCCD)')
})

ok('an escaped name is still the name it stands for', () => {
  const attachments = { 'my shot.png': { 'image/png': 'AA' } }
  assert.equal(withAttachments('![](attachment:my%20shot.png)', attachments),
    '![](data:image/png;base64,AA)')
})

ok('a reference to an attachment that is not there is left visibly broken', () => {
  // Rather than blanked, which would claim the image was empty instead of
  // missing — and the truth is that it is missing.
  const text = '![](attachment:gone.png)'
  assert.equal(withAttachments(text, {}), text)
  assert.equal(withAttachments(text, null), text)
})

/* ----------------------------------------------------- searching a cell */

ok('a cell is searched by what it printed as well as by what it says', () => {
  const cell = newCell('code')
  cell.source = 'df.head()'
  cell.outputs = [
    { output_type: 'stream', name: 'stderr', text: `${ESC}[31mFutureWarning: renamed${ESC}[0m\n` },
    { output_type: 'execute_result', data: { 'text/html': '<table><th>salary</th></table>' } }
  ]
  const text = cellSearchText(cell).toLowerCase()
  assert.equal(text.includes('df.head'), true)
  // The colour is not part of the text, and the tags are not part of the table.
  assert.equal(text.includes('futurewarning: renamed'), true)
  assert.equal(text.includes('salary'), true)
  assert.equal(text.includes('table'), false)
  assert.equal(stripAnsi(`${ESC}[31mred${ESC}[0m`), 'red')
})

/* -------------------------------------------------------- taking it out */

ok('a notebook comes out as a script other tools can read back', () => {
  const { shell, cells } = readNotebook(JUPYTER)
  const script = notebookToScript(shell, cells)
  // The `# %%` format, which Jupytext, VS Code, PyCharm and Spyder all read.
  assert.equal(script.includes('# %% [markdown]\n# # Title'), true)
  assert.equal(script.includes("# %%\nprint('hello')"), true)
  assert.equal(script.includes('# kernel: Python 3'), true)
  // The outputs are not code and do not come.
  assert.equal(script.includes('hello\n"'), false)
})

ok('a notebook comes out as one HTML file, outputs and all', () => {
  const { shell, cells } = readNotebook(JUPYTER)
  const html = notebookToHtml(shell, cells, { title: 'Analysis' })
  assert.equal(html.startsWith('<!doctype html>'), true)
  assert.equal(html.includes('<title>Analysis</title>'), true)
  assert.equal(html.includes("print(&#039;hello&#039;)") ||
    html.includes("print('hello')"), true)
  assert.equal(html.includes('hello'), true)
  // Nothing fetched from anywhere: a file that needs a stylesheet beside it is
  // a file that arrives broken.
  assert.equal(/<(link|script)\b/.test(html), false)
})

ok('an output’s own HTML is sanitised on the way out of the app', () => {
  const { shell, cells } = readNotebook(JUPYTER)
  cells[1].outputs = [{
    output_type: 'display_data',
    data: { 'text/html': '<b>fine</b><script>bad()</script>' }
  }]
  const html = notebookToHtml(shell, cells, {
    sanitize: (markup) => markup.replace(/<script[\s\S]*?<\/script>/g, '')
  })
  assert.equal(html.includes('<b>fine</b>'), true)
  assert.equal(html.includes('bad()'), false)
})

ok('a cell’s source is escaped rather than run when it is exported', () => {
  const { shell, cells } = readNotebook(JUPYTER)
  cells[1].source = 'print("<script>alert(1)</script>")'
  const html = notebookToHtml(shell, cells)
  assert.equal(html.includes('<script>alert(1)'), false)
  assert.equal(html.includes('&lt;script&gt;alert(1)'), true)
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
