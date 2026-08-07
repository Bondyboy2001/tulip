/* ========================================================== code blocks
   Editing behaviour that belongs to code but not to prose. Markdown's own
   indentation rules stop at the fence, so pressing Enter inside a block would
   otherwise drop the caret back to column zero on every line.
   ================================================================== */

import { keymap, ViewPlugin, Decoration, WidgetType, EditorView } from '@codemirror/view'
import { Prec, StateEffect, StateField } from '@codemirror/state'
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

/**
 * The room to the right of a line, which codeBlockScroll sizes so that every
 * line in a block scrolls exactly as far as its widest.
 *
 * A widget, not a style on the line: the editor owns a line's attributes and
 * rewrites them whenever it re-renders that line, so an inline style set from
 * a measure pass survives only until the next keystroke. What is inside a
 * widget is ours to keep. All spacers are equal, so one is never rebuilt for
 * being a different width — the room it holds is set on the element, not in
 * the decoration.
 *
 * Standing at the end of the line, it is also what the caret asks for its own
 * rectangle whenever the caret is at the end of that line — which is why the
 * room it holds is padding on an inline box rather than a width on a block one.
 * See .tk-code-run in the stylesheet, where that is arranged and explained.
 */
class RunSpacerWidget extends WidgetType {
  eq () { return true }
  toDOM () {
    const span = document.createElement('span')
    span.className = 'tk-code-run'
    return span
  }
  ignoreEvent () { return true }
}

const codeLineNumbers = ViewPlugin.fromClass(
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
                  .range(state.doc.line(ln).from),
                Decoration.widget({ widget: new RunSpacerWidget(), side: 1 })
                  .range(state.doc.line(ln).to)
              )
            }
            // Nothing inside a fence is another fence.
            return false
          }
        })
      }

      return Decoration.set(ranges, true)
    }
  },
  { decorations: (v) => v.decorations }
)

/* ------------------------------------------------ room for the copilot */

/**
 * The code block copilot's prompt, kept in the document's own layout.
 *
 * The reading view builds the block itself and simply puts the form in it, so
 * the code moves down to make room. The editing view draws the block as editor
 * lines, and a form floated over them covers the very code it is asking about —
 * which is what a fixed overlay did before this. A block widget is the editing
 * view's way of saying the same thing: the editor reserves the height, the
 * lines below it move down, and the form scrolls with the block because it is
 * part of the block.
 *
 * The form itself is the renderer's — one element, reused by both views, so the
 * widget carries it rather than building one. Which means it must not be
 * rebuilt for a redraw it did not cause: `eq` on the element and the position
 * keeps the same node in place, and with it the caret and the half-typed
 * request inside it.
 */
export const setCodeAiForm = StateEffect.define()

class CodeFormWidget extends WidgetType {
  constructor (form, pos) { super(); this.form = form; this.pos = pos }
  eq (other) { return other.form === this.form && other.pos === this.pos }
  toDOM () { return this.form }
  /* Everything inside it — typing, the send chord, the resize handle — belongs
     to the form, not to the document behind it. */
  ignoreEvent () { return true }
  get estimatedHeight () { return this.form.offsetHeight || 120 }
  /* The element outlives the widget: it is the renderer's, and closing the
     form is what takes it off screen. */
  destroy () {}
}

export const codeAiForm = StateField.define({
  create: () => null,

  update (open, tr) {
    for (const effect of tr.effects) if (effect.is(setCodeAiForm)) return effect.value
    if (!open || !tr.docChanged) return open
    /* The block can move under it — the copilot's own edit arrives as a change
       to the note, and so does anything typed above it. */
    const pos = tr.changes.mapPos(open.pos, -1)
    return pos === open.pos ? open : { form: open.form, pos }
  },

  provide: (field) => EditorView.decorations.from(field, (open) => open
    ? Decoration.set([
      Decoration.widget({
        widget: new CodeFormWidget(open.form, open.pos),
        block: true,
        side: -1
      }).range(open.pos)
    ])
    : Decoration.none)
})

/* -------------------------------------------------- scrolling one block */

/* The frame's own right-hand padding, which a line keeps beyond its text.
   Stated once here and in the stylesheet's .tk-code-block padding-inline. */
const PAD_RIGHT = 12

/** A line's spacer, the element whose padding is the room to its right. */
function runSpacer (line) {
  return line.querySelector(':scope > .tk-code-run')
}

/** Of a block's lines, the ones that hold code — the ones that scroll. */
function codeLines (lines) {
  return lines.filter((l) =>
    !l.classList.contains('tk-code-top') && !l.classList.contains('tk-code-fence'))
}

/**
 * The lines of one fence, from any line in it. A block is a contiguous run of
 * `.tk-code-block` siblings bounded by the header and the closing fence.
 */
function blockLines (line) {
  const out = [line]
  for (let n = line.previousElementSibling; n?.classList.contains('tk-code-block'); n = n.previousElementSibling) {
    out.push(n)
    if (n.classList.contains('tk-code-top')) break
  }
  for (let n = line.nextElementSibling; n?.classList.contains('tk-code-block'); n = n.nextElementSibling) {
    out.push(n)
    if (n.classList.contains('tk-code-bottom')) break
  }
  return out
}

/**
 * Code scrolls sideways rather than wrapping, and the editor draws a document
 * as lines rather than as blocks — so each line is a scroller of its own. Two
 * things follow, and this plugin does both.
 *
 * Every line in a block is padded out to the width of the widest, so they all
 * scroll exactly as far as each other. The alternative — letting each line stop
 * at its own width and correcting the difference afterwards — means contra-
 * dicting a scroll while it is happening, which the trackpad feels as the text
 * shaking against the finger.
 *
 * Then one line's offset is carried to the rest of its block, which is what
 * makes the fence read as a single box being scrolled rather than a stack of
 * strips. It is also what keeps the caret's own line from sliding out of step
 * with the lines around it when you type past the right edge.
 *
 * The listener goes on each line: a scroll event does not bubble, and in
 * practice it does not reach a capture listener on the content either. Lines
 * are recycled as the viewport moves, so the ones already carrying a listener
 * are remembered rather than re-bound.
 *
 * Both jobs happen in the measure phase, because `update` runs before the view
 * writes its DOM — the lines an update brings into view do not exist yet when
 * it is called, and there is nothing there to measure or to bind.
 */
const codeBlockScroll = ViewPlugin.fromClass(
  class {
    constructor (view) {
      // The lines outlive the plugin — raw view swaps it out and back, and the
      // editor hands the same elements to the next instance — so what was bound
      // is held by handler, to be taken off again in destroy().
      this.bound = new Map()
      this.busy = false
      this.schedule(view)
    }

    destroy () {
      for (const [line, onScroll] of this.bound) line.removeEventListener('scroll', onScroll)
      this.bound.clear()
    }

    // Lines arrive with a viewport change, a note switch, a window resize and
    // a font settling, and a block whose padding is never planned is a block
    // that shears when it scrolls — so all four re-plan. A moving caret is not
    // one of them: the measure sweeps every code line on screen, and doing it
    // on arrow-key repeat was the plugin's whole cost for no change in layout.
    update (update) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.schedule(update.view)
      }
    }

    schedule (view) {
      // Widths are read in one phase and written in the next, the way the
      // editor asks: measuring after a write would re-do the layout it just
      // caused, for every block on screen.
      view.requestMeasure({
        read: (v) => { this.bind(v); return this.plan(v) },
        write: (plan) => {
          for (const [spacer, run] of plan) spacer.style.paddingLeft = `${run}px`
        }
      })
    }

    bind (view) {
      // Lines are recycled as the viewport moves; the map is not a WeakSet and
      // would otherwise hold every line the note has ever shown.
      for (const line of this.bound.keys()) if (!line.isConnected) this.bound.delete(line)

      for (const line of view.contentDOM.querySelectorAll('.cm-line.tk-code-block')) {
        if (this.bound.has(line)) continue
        const onScroll = () => this.sync(line)
        this.bound.set(line, onScroll)
        line.addEventListener('scroll', onScroll)
      }
    }

    /**
     * How wide a line's own content is: where its spacer begins, plus the
     * padding the frame keeps to the right of the text. Read from the layout
     * rather than from scrollWidth, which reports the column's width for a line
     * narrower than it and would make short lines look ever narrower as they
     * were padded.
     */
    width (line) {
      const spacer = runSpacer(line)
      return spacer ? spacer.offsetLeft + PAD_RIGHT : 0
    }

    /**
     * What each rendered line should be padded by: enough to bring it to the
     * width of the widest line in its block. The header and the closing fence
     * hold no code and do not scroll, so they are neither measured — a wide
     * language tile is not a wide line of code — nor padded.
     */
    plan (view) {
      const seen = new Set()
      const plan = []
      // Nothing to measure while the editor is off screen, and a plan drawn up
      // from zeroes would have to be undone the moment it came back.
      if (!view.contentDOM.clientWidth) return plan

      for (const line of view.contentDOM.querySelectorAll('.cm-line.tk-code-block')) {
        if (seen.has(line)) continue

        // The block and each line's width are read once and reused: both walk
        // the DOM, and this runs over every code line on screen.
        const block = blockLines(line)
        block.forEach((l) => seen.add(l))
        const lines = codeLines(block)
        if (!lines.length) continue

        const widths = lines.map((l) => this.width(l))
        const widest = Math.max(...widths)
        for (const [i, l] of lines.entries()) {
          const spacer = runSpacer(l)
          if (!spacer) continue
          const run = Math.max(0, Math.round(widest - widths[i]))
          /* Only a difference worth making. Sub-pixel text metrics wobble by a
             fraction from one measurement to the next, and a padding that
             chases them re-lays the block out on every pass — which the editor
             notices and stops as a measure loop. */
          if (Math.abs(spacer.offsetWidth - run) > 2) plan.push([spacer, run])
        }
      }

      return plan
    }

    /** One line's offset, given to the rest of its block. */
    sync (line) {
      if (this.busy || !line.isConnected) return
      this.busy = true
      /* Read every line, then write every line — never one after the other down
         the block. Interleaved, each write invalidates the layout the next read
         has to rebuild, so a long fence costs a layout per line rather than one
         for the reads and one for the writes. `line.scrollLeft` is hoisted for
         the same reason: it does not change while this runs, and asking for it
         once per sibling was asking the same question n times. */
      const to = line.scrollLeft
      const behind = []
      for (const other of codeLines(blockLines(line))) {
        /* A pure read pass: nothing here writes, so the layout settles once and
           every answer after that is already known. The writes are the loop
           below, which is why they are a loop of their own. */
        // eslint-disable-next-line tulip/no-layout-thrash
        if (other !== line && other.scrollLeft !== to) behind.push(other)
      }
      /* And a pure write pass. Writing `scrollLeft` invalidates the layout but
         does not wait for one, so n writes with no read between them are n
         cheap writes and a single settle afterwards. */
      // eslint-disable-next-line tulip/no-layout-thrash
      for (const other of behind) other.scrollLeft = to
      this.busy = false
    }
  }
)

/* The numbers and the scrolling are one feature, not two: the plugin below
   sizes the spacers the plugin above emits, so half of this in a view and half
   out is a code block that scrolls out of step with itself. They are named
   together here so nowhere else has to remember they travel together. */
export const codeBlockView = [codeLineNumbers, codeBlockScroll]
