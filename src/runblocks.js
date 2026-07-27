/* ========================================================== run widgets
   The editing view's Run control: a bar under every closed, runnable fence,
   holding the same button and output panel the reading view draws. The state
   behind it is keyed by the block's code (see runcode.js), so a run started
   in one view is the same run in the other.

   A StateField, not a ViewPlugin — block widgets change line geometry, and a
   plugin cannot be consulted before the viewport it would change has been
   measured; the symptom is a null-deref inside focus(). Same rule the title
   widget follows.
   ================================================================== */

import { EditorView, Decoration, WidgetType } from '@codemirror/view'
import { StateField } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { isRunnable, runBlockUI } from './runcode.js'

class RunBlockWidget extends WidgetType {
  constructor (lang, code) { super(); this.lang = lang; this.code = code }

  // Equal while the block's text is unchanged, so typing elsewhere in the note
  // maps the widget rather than rebuilding it — and a running block's panel is
  // not torn down mid-stream by an edit three paragraphs away.
  eq (other) { return other.lang === this.lang && other.code === this.code }

  toDOM () { return runBlockUI(this.lang, this.code) }

  // The widget owns its clicks; the editor should not move the caret for them.
  ignoreEvent () { return true }
}

function buildRunWidgets (state) {
  const widgets = []
  const { doc } = state

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return

      const first = doc.lineAt(node.from)
      const last = doc.lineAt(node.to)
      // Only a finished block gets a control: while the closing fence is still
      // unwritten, the "block" is whatever happens to sit under the caret.
      if (last.number <= first.number || !/^\s*(```|~~~)\s*$/.test(last.text)) return

      const lang = /^\s*(?:```|~~~)\s*([\w+-]+)/.exec(first.text)?.[1]
      if (!isRunnable(lang)) return

      const code = last.number - first.number < 2
        ? ''
        : doc.sliceString(doc.line(first.number + 1).from, doc.line(last.number - 1).to)

      widgets.push(
        Decoration.widget({
          widget: new RunBlockWidget(lang.toLowerCase(), code),
          block: true,
          side: 1
        }).range(node.to)
      )
    }
  })

  return Decoration.set(widgets)
}

export const runBlocks = StateField.define({
  create: buildRunWidgets,
  update (deco, tr) {
    // Rebuilt when the document moves — and when the parse does. A fresh note
    // has no syntax tree yet at create(), and the parser delivers its progress
    // through transactions of its own, so the tree changing hands is the one
    // other signal there may be fences we have not seen. Widget eq() keeps the
    // untouched ones alive across every rebuild.
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildRunWidgets(tr.state)
    }
    return deco
  },
  provide: (field) => EditorView.decorations.from(field)
})
