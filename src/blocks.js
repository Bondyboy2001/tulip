/* ============================================================== blocks
   What a fenced block becomes when it is not shown as code, in both views.

   Five modules answer that question — mermaid, svg, tikz, manim and the Run
   control — and until they shared this one they each carried their own copy of
   the same three things: how to build an element, how to walk the document's
   fences, and the StateField boilerplate that turns the walk into decorations.

   The walk is the part worth having in one place. It runs on every keystroke
   and every parse advance, once per module, so a detail wrong here is wrong
   four times over — which is what happened: three of the four refused to
   descend into a fence's interior (the densest part of the tree, and the one
   place that cannot hold another fence) and the fourth walked all of it.
   ================================================================== */

import { EditorView, Decoration } from '@codemirror/view'
import { StateField } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

/** An element, with its class and its text — the shape all of this is built from. */
export function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * An inline icon.
 *
 * Six places drew one before this, and each spelled out the namespace, the
 * viewBox, the aria-hidden and — for the outlined ones — the same five stroke
 * attributes. `stroke` asks for the outlined preset at a given width; `fill`
 * for the solid one. `markup` is trusted: every caller's paths are constants in
 * this repo, never note text.
 */
export function svgIcon (markup, {
  viewBox = '0 0 16 16',
  className = '',
  size = null,
  stroke = null,
  fill = null
} = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  if (className) svg.setAttribute('class', className)
  if (size != null) {
    svg.setAttribute('width', String(size))
    svg.setAttribute('height', String(size))
  }
  if (stroke != null) {
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', String(stroke))
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
  } else if (fill) {
    svg.setAttribute('fill', fill)
  }
  svg.innerHTML = markup
  return svg
}

/* The five characters that stop note text being read as markup. Here rather
   than beside either of the two modules that write untrusted text into an HTML
   string, because a second copy of an escaper is a copy that gets fixed once. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Note text, safe to put in either an element body or a quoted attribute. */
export function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPES[c])
}

/* What the parser calls the three ways a document can hold code: a span between
   backticks, a fenced block, and a block indented four spaces. */
const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock'])

/**
 * Is `pos` inside code?
 *
 * The one answer, because the modules that scan the document's text for things
 * to typeset each need it and each used to answer it themselves: a `$` in code
 * is a shell variable or a string literal in every one of them. They had drifted
 * — the money scanner tested one level of parent and never learned about
 * indented blocks, so a price inside one got a badge the maths beside it did
 * not, and the editing and reading views disagreed about the same character.
 */
export function inCode (tree, pos) {
  for (let n = tree.resolveInner(pos, 1); n; n = n.parent) {
    if (CODE_NODES.has(n.name)) return true
  }
  return false
}

/* ------------------------------------------------------- reading view */

/**
 * The reading-view shell shared by rendered fences.
 *
 * It owns the figure and its optional stage, the failed-render fallback, and
 * the state where a live log temporarily replaces both source and result.
 * Reaching the source is the document-level Editing view's job; a rendered
 * figure carries no control of its own.
 *
 * @param {HTMLElement} wrap  the .code-wrap holding the source
 * @param {string} kind       figure class; the stage is `${kind}-stage`
 * @param {{stage?: boolean}} [options]
 * @returns {{figure: HTMLElement, stage: HTMLElement|null,
 *            settle: (available: boolean, options?: {showFailure?: boolean}) => void,
 *            hide: () => void}}
 */
export function renderedBlock (wrap, kind, { stage: hasStage = true } = {}) {
  const figure = el('figure', kind)
  const stage = hasStage ? el('div', `${kind}-stage`) : null
  if (stage) figure.append(stage)
  wrap.after(figure)

  let available = false
  let showFailure = false
  let hidden = false

  const paint = () => {
    if (hidden) {
      wrap.hidden = true
      figure.hidden = true
      return
    }
    wrap.hidden = available
    figure.hidden = !available && !showFailure
  }

  paint()
  return {
    figure,
    stage,
    settle (yes, { showFailure: failure = false } = {}) {
      hidden = false
      available = Boolean(yes)
      showFailure = !available && failure
      paint()
    },
    // A live render transcript occupies the block's place: neither source nor
    // the previous artifact should sit underneath it.
    hide () {
      if (hidden) return
      hidden = true
      paint()
    }
  }
}

/**
 * The reading view's shape for a block that is really a picture. It adds the
 * parse-error behavior that immediate drawings need to renderedBlock's normal
 * source/result lifecycle.
 *
 * The caller draws into `stage` and then reports whether it got a picture. A
 * block that did not is left showing its source with the complaint under it —
 * there is nothing else to look at, and the source is where you would go next.
 *
 * @param {HTMLElement} wrap   the .code-wrap holding the source
 * @param {string} kind        the figure's class; its stage is `${kind}-stage`
 * @returns {{stage: HTMLElement, settle: (drew: boolean) => void}}
 */
export function pictureBlock (wrap, kind) {
  const block = renderedBlock(wrap, kind)

  return {
    stage: block.stage,
    settle (ok) {
      // A parse failure sits under the still-visible source; unlike a missing
      // cached artifact, it has a useful diagnostic to show.
      block.settle(ok, { showFailure: !ok })
    }
  }
}

/* ------------------------------------------------------- editing view */

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
      widgets.push(
        Decoration.widget({ widget: makeWidget(code), block: true, side: 1 }).range(node.to)
      )
    })
    return Decoration.set(widgets)
  }
  return fenceField(build, opts)
}
