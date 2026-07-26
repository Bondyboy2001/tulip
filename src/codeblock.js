/* ========================================================== code blocks
   Editing behaviour that belongs to code but not to prose. Markdown's own
   indentation rules stop at the fence, so pressing Enter inside a block would
   otherwise drop the caret back to column zero on every line.
   ================================================================== */

import { keymap, ViewPlugin, Decoration, WidgetType } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { syntaxTree, indentUnit } from '@codemirror/language'
import { markdownLanguage } from '@codemirror/lang-markdown'

/**
 * Bracket closing belongs to code, not to prose — a sentence that sprouts ")"
 * every time you open a parenthesis is worse than no help at all. Language
 * data is resolved at the caret, so emptying markdown's set leaves prose alone
 * while a fenced block still gets its own language's full set.
 *
 * "[" is the exception worth keeping: it makes [[wikilinks]] fall out of two
 * keystrokes.
 */
export const proseBrackets = markdownLanguage.data.of({
  closeBrackets: { brackets: ['['] }
})

const PAIRS = { '{': '}', '[': ']', '(': ')' }

/** The fenced block containing pos, or null when the caret is in prose. */
function fenceAt (state, pos) {
  let node = syntaxTree(state).resolveInner(pos, -1)
  while (node) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return node
    node = node.parent
  }
  return null
}

/**
 * Enter inside a fence: carry the current indentation down, add a level after
 * an opening bracket (or a trailing colon, for Python and friends), and when
 * the matching closer sits right after the caret, open a room between them and
 * leave the closer on its own line at the original depth.
 */
function newlineInCode (view) {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false

  const block = fenceAt(state, range.from)
  if (!block) return false

  const line = state.doc.lineAt(range.from)
  // The fence markers themselves are not code; leave them to the default.
  if (/^\s*(```|~~~)/.test(line.text)) return false

  const before = line.text.slice(0, range.from - line.from)
  const after = line.text.slice(range.from - line.from)
  const indent = /^[ \t]*/.exec(line.text)[0]
  const unit = state.facet(indentUnit) || '  '

  const opener = before.trimEnd().slice(-1)
  const deepens = Object.hasOwn(PAIRS, opener) || opener === ':'
  const closerNext = PAIRS[opener] && after.trimStart().startsWith(PAIRS[opener])

  let insert
  let caret
  if (closerNext) {
    insert = '\n' + indent + unit + '\n' + indent
    caret = range.from + 1 + indent.length + unit.length
  } else {
    insert = deepens ? '\n' + indent + unit : '\n' + indent
    caret = range.from + insert.length
  }

  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: caret },
    scrollIntoView: true,
    userEvent: 'input'
  })
  return true
}

/**
 * Backspace at the head of an indented code line removes a whole indent unit
 * rather than one space, which is what every other editor does.
 */
function backspaceIndent (view) {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false
  if (!fenceAt(state, range.from)) return false

  const line = state.doc.lineAt(range.from)
  const before = line.text.slice(0, range.from - line.from)
  if (!before || /\S/.test(before)) return false

  const unit = (state.facet(indentUnit) || '  ').length
  const remove = before.length % unit || unit
  view.dispatch({
    changes: { from: range.from - remove, to: range.from },
    userEvent: 'delete.backward'
  })
  return true
}

// High precedence so these beat the default Enter and Backspace bindings.
export const codeBlockKeymap = Prec.high(
  keymap.of([
    { key: 'Enter', run: newlineInCode },
    { key: 'Backspace', run: backspaceIndent }
  ])
)


/* --------------------------------------------------------- line numbers */

/**
 * The reading view numbers its code; the editing view should look the same.
 * The number is a widget at the head of each line inside a fence, sitting in
 * the space the frame's left padding already reserves, so the code does not
 * move when the numbers appear.
 */
class LineNumberWidget extends WidgetType {
  constructor (n) { super(); this.n = n }
  eq (other) { return other.n === this.n }
  toDOM () {
    const span = document.createElement('span')
    span.className = 'tk-linenum'
    span.textContent = String(this.n)
    return span
  }
  ignoreEvent () { return true }
}

export const codeLineNumbers = ViewPlugin.fromClass(
  class {
    constructor (view) { this.decorations = this.build(view) }

    update (update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.build(update.view)
      }
    }

    build (view) {
      const { state } = view
      const ranges = []
      const seen = new Set()

      for (const { from, to } of view.visibleRanges) {
        syntaxTree(state).iterate({
          from,
          to,
          enter: (node) => {
            if (node.name !== 'FencedCode') return
            const first = state.doc.lineAt(node.from).number
            const last = state.doc.lineAt(node.to).number
            // The fence lines themselves are chrome, not code, so numbering
            // starts on the line after the opening ```.
            let n = 0
            for (let ln = first + 1; ln < last; ln++) {
              if (seen.has(ln)) continue
              seen.add(ln)
              n++
              ranges.push(
                Decoration.widget({ widget: new LineNumberWidget(n), side: -1 })
                  .range(state.doc.line(ln).from)
              )
            }
          }
        })
      }

      return Decoration.set(ranges, true)
    }
  },
  { decorations: (v) => v.decorations }
)
