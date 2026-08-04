/* Browser side of test:agent-diff — see test-agent-diff.mjs for the runner and
   the assertions. Mounts the real editor in a real Chromium, applies an
   Edit-tool style change through the same code path the panel uses
   (`view.patch(text, { agent: true, before })`), and reports what the review
   diff actually drew: the decorations on the state, the removed-lines widget,
   and the computed paint of both halves. */
import { EditorView } from '@codemirror/view'
import { createEditor } from '../src/editor.js'

const BEFORE = [
  '# Title', '',
  'The quick brown fox jumps over the lazy dog.', '',
  'Second paragraph stays.', '',
  'Old line to delete.', ''
].join('\n')

const AFTER = [
  '# Title', '',
  'The quick brown fox leaps over the quiet dog.', '',
  'Second paragraph stays.', ''
].join('\n')

/* Every Copilot-mark currently on the document's decorations, with what it
   covers — decoration sets only, so this needs no layout pass. */
function agentMarks (view) {
  const lines = []
  const words = []
  const widgets = []
  for (const set of view.state.facet(EditorView.decorations)) {
    if (typeof set?.between !== 'function') continue
    set.between(0, view.state.doc.length, (from, to, deco) => {
      if (deco.spec?.class === 'cm-agent-added-line') lines.push(view.state.doc.lineAt(from).number)
      if (deco.spec?.class === 'cm-agent-word-added') words.push(view.state.sliceDoc(from, to))
      if (deco.spec?.widget) widgets.push(deco.spec.widget)
    })
  }
  return { lines, words, widgets }
}

export async function run () {
  const host = document.createElement('div')
  document.body.append(host)
  const view = createEditor({
    parent: host,
    onChange: () => {},
    onOpenLink: () => {},
    noteNames: () => [],
    noteTitle: () => 'Title',
    onRename: () => {},
    resolveEmbed: (path) => path,
    resolveNoteEmbed: () => null,
    languageTable: () => false,
    noteFlag: () => '',
    titleEditable: () => true
  })

  view.setDoc(BEFORE)
  view.patch(AFTER, { agent: true, before: BEFORE })

  const stateMarks = agentMarks(view)
  // Other widgets share the document (the inline title, picture blocks…); the
  // deleted half of the diff is the one carrying removed rows — one block per
  // run of removed lines.
  const deleted = stateMarks.widgets.filter((widget) => Array.isArray(widget?.rows))
  const removedRows = deleted.flatMap((widget) =>
    Array.from(widget.toDOM().querySelectorAll('.cm-agent-deleted-line')).map((row) => ({
      text: row.textContent.slice(1), // the '−' marker before the text
      marked: row.querySelectorAll('.cm-agent-word-removed').length
    })))

  /* Let the measure loop paint, then read what the page itself shows. */
  const paint = () => new Promise((resolve) => {
    view.requestMeasure?.()
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60)))
  })
  const paintStyle = (el) => (el ? getComputedStyle(el).backgroundColor : null)

  await paint()
  const deletedEl = host.querySelector('.cm-agent-deleted')
  const inEditView = {
    added: host.querySelectorAll('.cm-agent-added-line').length,
    addedPaint: paintStyle(host.querySelector('.cm-agent-added-line')),
    addedWords: host.querySelectorAll('.cm-agent-word-added').length,
    deletedDisplay: deletedEl ? getComputedStyle(deletedEl).display : null,
    deletedPaint: paintStyle(deletedEl),
    removedWords: host.querySelectorAll('.cm-agent-word-removed').length
  }

  // Raw view: the same review keeps showing, classes and paint alike.
  view.setRaw(true)
  const rawMarks = agentMarks(view)
  await paint()
  const deletedRaw = host.querySelector('.cm-agent-deleted')
  const inRawView = {
    isRaw: view.dom.classList.contains('is-raw'),
    deletedDisplay: deletedRaw ? getComputedStyle(deletedRaw).display : null,
    deletedPaint: paintStyle(deletedRaw),
    addedPaint: paintStyle(host.querySelector('.cm-agent-added-line'))
  }

  view.destroy()
  host.remove()
  return {
    lines: stateMarks.lines,
    wordTexts: stateMarks.words,
    widgetCount: deleted.length,
    removedRows,
    rawLines: rawMarks.lines,
    rawWords: rawMarks.words.length,
    inEditView,
    inRawView
  }
}
