/* ========================================================= maths, editing
   The live preview: the widget a typeset equation becomes under the caret's
   own rules, and the StateField that places it.

   Split from math.js so the reading view can scan, number and typeset maths
   without CodeMirror on the startup path — see the note at the top of
   blocks.js, which was split for the same reason. Everything here needs an
   editor to mean anything.
   ================================================================== */

import { EditorView, Decoration, ViewPlugin, WidgetType } from '@codemirror/view'
import { StateField } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { renderMathInto, mathSpans, equationsFor, equationSource, advanceMath } from './math.js'
import { inCode } from './blocks.js'

class MathWidget extends WidgetType {
  constructor (tex, display, label = '') {
    super()
    this.tex = tex
    this.display = display
    this.label = label
  }

  eq (other) {
    return other.tex === this.tex && other.display === this.display && other.label === this.label
  }

  toDOM () {
    const host = document.createElement('span')
    host.className = this.display ? 'tk-math tk-math-display' : 'tk-math'
    if (this.label) host.dataset.equation = this.label
    renderMathInto(host, this.tex, this.display)
    return host
  }

  // Clicking the rendered maths should put the caret in the source behind it.
  ignoreEvent () { return false }
}

/**
 * Renders maths in the editing view, and steps out of the way — showing the
 * raw TeX — whenever the cursor is inside the expression, which is the same
 * rule the rest of the live preview follows.
 *
 * Two extensions, split on one line: whether the expression contains a line
 * break. A `$$…$$` written over several lines is replaced across those breaks,
 * and CodeMirror refuses a replace decoration spanning a line break when it
 * comes from a plugin — opening a note with display maths threw and left the
 * whole view broken. Those keep the StateField, the same rule the diagrams and
 * the tables follow. Everything else — which in a dense note is nearly every
 * expression — is a decoration of one line and can come from a viewport-scoped
 * ViewPlugin, so a keystroke builds widgets for what is on screen rather than
 * for the whole note. `moneyPreview` is scoped the same way.
 *
 * A span's delimiters hold no newline, so its TeX holding none means the whole
 * span sits on one line.
 */
const overLines = (span) => span.tex.includes('\n')

/**
 * Which of `spans` the selection is sitting in, as a string that changes only
 * when that set does.
 *
 * Moving the caret changes what is drawn only when it crosses into or out of an
 * expression — every other movement, which is nearly all of them, produces
 * exactly the decorations already on screen. Comparing the answer is far
 * cheaper than rebuilding: no widgets are constructed and no decoration set is
 * sorted, and the spans themselves are already cached.
 */
function touchedSpans (state, spans) {
  let signature = ''
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]
    if (state.selection.ranges.some((r) => r.to >= span.from && r.from <= span.to)) {
      signature += `${i},`
    }
  }
  return signature
}

function buildMathDeco (state, spans) {
  const tree = syntaxTree(state)
  const ranges = []
  const hidden = []
  const equations = equationsFor(state.doc)

  /* In code, `$` is a shell variable or a string literal, and the reading
     view never typesets there. The test is asked of the tree rather than of
     the span cache, which is keyed on the document alone — money.js makes
     the same call, of the same helper. */
  for (const span of spans) {
    if (inCode(tree, span.from)) continue

    const touched = state.selection.ranges.some(
      (r) => r.to >= span.from && r.from <= span.to
    )
    if (touched) {
      /* The caret is in it, so the source is showing rather than the
         typeset result — and TeX is not prose. Without this the checker
         underlines every `\alpha` and `\frac` the moment you edit one. */
      ranges.push(
        Decoration.mark({ attributes: { spellcheck: 'false' } })
          .range(span.from, span.to)
      )
      continue
    }

    const equation = equationSource(span.tex, equations)
    ranges.push(
      Decoration.replace({ widget: new MathWidget(equation.source, span.display, equation.label) })
        .range(span.from, span.to)
    )
    /* Only what conceals text is atomic — the same rule the rest of the live
       preview follows (see editor.js). The spellcheck mark above leaves the
       TeX visible, and handing *that* range to `atomicRanges` too made the
       expression unenterable: every click inside the revealed source was
       pushed back out to an edge, so the caret could only ever sit at the
       ends of the block. */
    hidden.push(Decoration.replace({}).range(span.from, span.to))
  }
  return { deco: Decoration.set(ranges, true), atomic: Decoration.set(hidden, true) }
}

/* --------------------------------------------- the blocks, in a field */

const blockSpans = (state) => (mathSpans(state.doc) || []).filter(overLines)

const blockState = (state) => {
  const spans = blockSpans(state)
  return { ...buildMathDeco(state, spans), touched: touchedSpans(state, spans) }
}

const mathBlockPreview = StateField.define({
  create: blockState,
  update (value, tr) {
    if (tr.docChanged) {
      /* Before anything reads the spans. The maths cache can often answer the
         new document by sliding the old answer rather than rescanning the
         note, but only a transaction can tell it so, and this is the first
         thing in the editor to hold one. */
      advanceMath(tr)
      return blockState(tr.state)
    }
    /* The parse advancing can move a span into or out of code — and a freshly
       opened note has no tree at create() at all. The parser reports its
       progress through transactions of its own; this catches them. Widget
       eq() keeps the untouched renders alive across every rebuild. */
    if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) return blockState(tr.state)
    if (tr.selection) {
      /* Only when the caret has crossed an expression's edge. Holding an arrow
         key down through a note full of maths used to rebuild every widget in
         it on every intermediate position. */
      const touched = touchedSpans(tr.state, blockSpans(tr.state))
      return touched === value.touched
        ? value
        : { ...buildMathDeco(tr.state, blockSpans(tr.state)), touched }
    }
    return value
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.deco),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomic)
  ]
})

/* ------------------------------------------ the rest, in a view plugin */

const mathInlinePreview = ViewPlugin.fromClass(
  class {
    constructor (view) { this.build(view) }

    update (update) {
      if (update.docChanged || update.viewportChanged ||
          syntaxTree(update.state) !== syntaxTree(update.startState)) {
        this.build(update.view)
        return
      }
      /* Only when the caret has crossed an expression's edge — holding an
         arrow key down through a screenful of maths otherwise rebuilds every
         widget on it for every intermediate position. */
      if (update.selectionSet &&
          touchedSpans(update.state, this.spans) !== this.touched) {
        this.build(update.view)
      }
    }

    build (view) {
      const spans = []
      for (const span of mathSpans(view.state.doc) || /** @type {{from: number, to: number}[]} */ ([])) {
        if (span.to < view.viewport.from || span.from > view.viewport.to) continue
        if (overLines(span)) continue
        spans.push(span)
      }
      const built = buildMathDeco(view.state, spans)
      this.spans = spans
      this.touched = touchedSpans(view.state, spans)
      this.decorations = built.deco
      this.atomic = built.atomic
    }
  },
  {
    decorations: (v) => v.decorations ?? Decoration.none,
    provide: (plugin) => EditorView.atomicRanges.of(
      (view) => view.plugin(plugin)?.atomic ?? Decoration.none)
  }
)

export const mathPreview = [mathBlockPreview, mathInlinePreview]
