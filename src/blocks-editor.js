/* ======================================================= blocks, editing
   The fence walk, and the StateField boilerplate that turns it into
   decorations. Split from blocks.js so that the reading view can use the
   block DOM helpers without dragging CodeMirror onto the startup path — see
   the note at the top of that file.
   ================================================================== */

import { EditorView, Decoration } from '@codemirror/view'
import { StateField } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

/* A finished block ends on a line holding nothing but its fence. While that
   line is still unwritten the "block" is whatever happens to sit under the
   caret, so nothing is drawn for it. */
const CLOSING = /^\s*(```|~~~)\s*$/
const OPENING = /^\s*(?:```|~~~)\s*([\w+-]+)/

/* The walk's answer, kept for the state that produced it.
   editor.js installs four independent fenceFields, and each rebuild used to ask
   for its own walk — so one Enter key was eight whole-tree iterations and eight
   complete re-extractions of every fence body in the note. The four rebuild
   against the same state within one update cycle, so one entry is all it takes
   to make that one walk. Keyed on the document *and* the tree: the parser
   advances a note's tree without touching its text, and a fence that has only
   just finished parsing must not be answered for out of a stale list. */
let fenceCache = { doc: null, tree: null, list: null }

/**
 * Hands every finished fenced block in the document to `visit`, as its node,
 * its language and its body.
 *
 * `node` is a plain `{ from, to }` rather than a live cursor: the walk's
 * results outlive the iteration that found them, and Lezer's node ref does not.
 */
export function eachFence (state, visit) {
  for (const fence of fenceList(state)) visit(fence)
}

/**
 * Every finished fence in the document, walked once per (document, tree).
 *
 * Never descends into a fence: a block's interior is its own language's tokens,
 * and cannot contain another fence, so walking it is pure cost.
 */
function fenceList (state) {
  const { doc } = state
  const tree = syntaxTree(state)
  if (fenceCache.doc === doc && fenceCache.tree === tree) return fenceCache.list

  const list = []

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return

      const first = doc.lineAt(node.from)
      const last = doc.lineAt(node.to)
      if (last.number <= first.number || !CLOSING.test(last.text)) return false

      /* CommonMark's own rule: a fence opened N columns in has up to N columns
         of indentation removed from every content line. The reading view gets
         its code from markdown-it, which applies this — and the two views must
         produce byte-identical strings, because everything downstream (run
         results, tikz and manim artefact hashes, the mermaid cache) is keyed
         by them. A fence in a list item disagreed in every one of those. */
      const indent = /^[ \t]*/.exec(first.text)[0].length
      let code = last.number - first.number < 2
        ? ''
        : doc.sliceString(doc.line(first.number + 1).from, doc.line(last.number - 1).to)
      if (indent && code) {
        code = code.split('\n').map((line) => {
          let i = 0
          while (i < indent && i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
          return line.slice(i)
        }).join('\n')
      }

      list.push({
        node: { from: node.from, to: node.to },
        first,
        last,
        lang: OPENING.exec(first.text)?.[1] || '',
        code
      })
      return false
    }
  })

  fenceCache = { doc, tree, list }
  return list
}

/**
 * Could this transaction do nothing to the document's fences but slide them?
 *
 * The bar is deliberately low: an edit qualifies only when it stays inside one
 * line, past that line's indentation, types no backtick, tilde or newline, and
 * comes no closer than a line to any known fence. Everything else — including
 * every way of creating a fence one keystroke at a time, and the line-start
 * edits that can re-parent a list item's contents — takes the full rebuild.
 * Wrongly rebuilding costs a walk; wrongly shifting costs a stale note.
 */
function shiftOnly (tr, fences) {
  const doc = tr.startState.doc
  let ok = true

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!ok) return
    if (/[`~\n]/.test(inserted.toString())) { ok = false; return }

    const line = doc.lineAt(fromA)
    if (toA > line.to) { ok = false; return }
    const indent = line.text.length - line.text.trimStart().length
    if (fromA <= line.from + indent) { ok = false; return }

    for (const fence of fences) {
      if (line.number >= doc.lineAt(fence.from).number - 1 &&
          line.number <= doc.lineAt(fence.to).number + 1) { ok = false; return }
    }
  })

  return ok
}

/**
 * The StateField every one of these fields is.
 *
 * A StateField rather than a ViewPlugin: block widgets change line geometry,
 * and a plugin cannot be consulted before the viewport it would change has been
 * measured; the symptom is a null-deref inside focus().
 *
 * Rebuilt when the fences could have moved in kind — and when the parse
 * advances. A freshly opened note has no syntax tree at create(), and the
 * parser reports its progress through transactions of its own; that rebuild is
 * also the net under the fast path here, which maps the decorations through
 * ordinary typing instead of re-walking the whole tree once per field per
 * keystroke. The field remembers where every fence stands to make that call.
 * Widget eq() keeps the untouched ones alive across every rebuild.
 *
 * @param {(state) => DecorationSet} build
 * @param {{ also?: (tr) => boolean }} [opts]  a further reason to rebuild
 */
export function fenceField (build, { also } = {}) {
  const make = (state) => ({
    deco: build(state),
    fences: fenceList(state).map(({ node }) => ({ from: node.from, to: node.to }))
  })

  return StateField.define({
    create: make,
    update (value, tr) {
      if (also?.(tr)) return make(tr.state)

      if (!tr.docChanged) {
        return syntaxTree(tr.state) !== syntaxTree(tr.startState) ? make(tr.state) : value
      }

      if (shiftOnly(tr, value.fences)) {
        return {
          deco: value.deco.map(tr.changes),
          fences: value.fences.map((f) => ({
            from: tr.changes.mapPos(f.from),
            to: tr.changes.mapPos(f.to)
          }))
        }
      }
      return make(tr.state)
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.deco)
  })
}

/**
 * The common case: one block widget under every fence in a given language,
 * holding the picture that block describes.
 *
 * @param {(lang: string) => boolean} matches
 * @param {(code: string) => WidgetType} makeWidget
 * @param {{ also?: (tr) => boolean }} [opts]
 */
export function pictureBlocks (matches, makeWidget, opts) {
  const build = (state) => {
    const widgets = []
    eachFence(state, ({ node, lang, code }) => {
      if (!matches(lang) || !code.trim()) return
      /* The closing fence line is marked as having a picture joined beneath it,
         so the stylesheet can drop its bottom border by matching a class on the
         line itself. It used to ask `:has(+ .cm-widgetBuffer + …)` instead —
         and `:has()` with a sibling combinator makes the engine re-check every
         line in the viewport whenever CodeMirror touches the sibling list,
         which it does on every keystroke. The decoration is free here: this
         field already knows the answer, which is why it is drawing a widget. */
      widgets.push(
        Decoration.line({ class: 'tk-code-joined' }).range(state.doc.lineAt(node.to).from),
        Decoration.widget({ widget: makeWidget(code), block: true, side: 1 }).range(node.to)
      )
    })
    /* Sorted, not appended in place: a line decoration starts at the head of
       the closing line and the widget sits at its end, so the two go in out of
       order and `Decoration.set` is entitled to refuse an unsorted list. */
    return Decoration.set(widgets, true)
  }
  return fenceField(build, opts)
}
