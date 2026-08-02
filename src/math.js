/**
 * LaTeX maths, via KaTeX.
 *
 * KaTeX is chosen over MathJax for one reason that outweighs the rest here:
 * it renders synchronously. A CodeMirror widget's toDOM() must return a node
 * immediately, and the live-preview layer re-runs on every keystroke, so an
 * async typesetter would either flash a placeholder or lag the caret. KaTeX is
 * also several times faster per expression, which matters when a note is
 * re-decorated as you type.
 *
 * The cost is ~1MB of bundled woff2 fonts. MathJax's SVG output would avoid
 * that, and Temml would avoid it by emitting MathML — but Temml then needs a
 * system maths font that macOS does not reliably ship, and Chromium's MathML
 * still renders stretchy delimiters and spacing worse than KaTeX's own boxes.
 */

import { EditorView, Decoration, WidgetType } from '@codemirror/view'
import { StateField } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { inCode } from './blocks.js'

/* ---------------------------------------------------------------- render */

let katex = null
let loadingKatex = null
let loadingStyles = null

function loadStyles () {
  if (loadingStyles) return loadingStyles

  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = new URL('katex.css', import.meta.url).href
  link.dataset.tulipKatex = ''

  loadingStyles = new Promise((resolve, reject) => {
    link.addEventListener('load', resolve, { once: true })
    link.addEventListener('error', () => {
      loadingStyles = null
      reject(new Error('KaTeX styles could not be loaded.'))
    }, { once: true })
  })
  document.head.append(link)
  return loadingStyles
}

function loadKatex () {
  if (katex) return Promise.resolve(katex)
  if (!loadingKatex) {
    loadingKatex = Promise.all([import('katex'), loadStyles()]).then(([module]) => {
      katex = module.default || module
      return katex
    }).catch((err) => {
      loadingKatex = null
      throw err
    })
  }
  return loadingKatex
}

export async function prepareMath (text) {
  if (!findMath(String(text || '')).length) return false
  await loadKatex()
  return true
}

const escapeMath = (text) => String(text)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const LABEL = /\\label\s*\{([^{}]+)\}/
const TAG = /\\tag\*?\s*\{([^{}]+)\}/
const equationId = (label) => `eq-${encodeURIComponent(label).replaceAll('%', '_')}`

/** Labels and the numbers/tags they display, in document order. */
export function equationIndex (text) {
  return indexEquations(findMath(String(text || '')))
}

/* The indexing itself, over spans that have already been found. Split out so
   the editor can index the spans it has cached rather than scanning again —
   see `equationsFor`. */
function indexEquations (spans) {
  const labels = new Map()
  let number = 0
  for (const span of spans) {
    if (!span.display) continue
    const found = LABEL.exec(span.tex)
    if (!found) continue
    number++
    labels.set(found[1].trim(), {
      label: found[1].trim(),
      tag: TAG.exec(span.tex)?.[1]?.trim() || String(number)
    })
  }
  return labels
}

function equationSource (tex, equations = null) {
  const found = LABEL.exec(tex)
  const label = found?.[1]?.trim() || ''
  let source = String(tex || '').replace(/\\label\s*\{[^{}]+\}/g, '').trim()
  const tag = label ? equations?.get(label)?.tag || TAG.exec(source)?.[1]?.trim() || '' : ''
  if (label && tag && !TAG.test(source)) source += ` \\tag{${tag}}`
  TAG.lastIndex = 0
  return { source, label, tag }
}

/**
 * Never throws: a half-typed expression is the normal state of an editor, so a
 * malformed one renders as the offending source in the error colour rather
 * than taking the surrounding render down with it.
 */
function renderMath (tex, displayMode = false) {
  if (!katex) {
    loadKatex().catch(() => {})
    return `<span class="math-pending">${escapeMath(tex)}</span>`
  }
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    errorColor: 'var(--accent)',
    strict: false,
    trust: false,
    output: 'htmlAndMathml',
    macros: { '\\R': '\\mathbb{R}', '\\N': '\\mathbb{N}', '\\Z': '\\mathbb{Z}' }
  })
}

export function renderMathInto (el, tex, displayMode = false) {
  if (!katex) {
    el.textContent = tex
    loadKatex().then(() => {
      if (el.isConnected) renderMathInto(el, tex, displayMode)
    }).catch(() => { el.classList.add('math-error') })
    return el
  }
  try {
    katex.render(tex, el, {
      displayMode,
      throwOnError: false,
      errorColor: 'var(--accent)',
      strict: false,
      trust: false,
      output: 'htmlAndMathml'
    })
  } catch {
    el.textContent = tex
    el.classList.add('math-error')
  }
  return el
}

/* --------------------------------------------------------- markdown-it */

/**
 * `$...$` inline and `$$...$$` display. A `$` only opens a span when it is not
 * followed by whitespace and not escaped, which keeps prices ("$5 and $10")
 * from being read as maths.
 */
export function mathPlugin (md) {
  md.inline.ruler.before('escape', 'equation_ref', (state, silent) => {
    const found = /^\\(eqref|ref)\{([^{}\n]+)\}/.exec(state.src.slice(state.pos))
    if (!found) return false
    if (!silent) {
      const token = state.push('equation_ref', '', 0)
      token.meta = { label: found[2].trim(), parens: found[1] === 'eqref' }
    }
    state.pos += found[0].length
    return true
  })

  md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    const { src, pos } = state
    if (src.charCodeAt(pos) !== 0x24) return false            // '$'
    if (pos > 0 && src[pos - 1] === '\\') return false
    if (src.charCodeAt(pos + 1) === 0x24) return false        // handled as display
    if (/\s/.test(src[pos + 1] || '') || pos + 1 >= src.length) return false

    let end = pos + 1
    while (end < src.length) {
      if (src[end] === '$' && src[end - 1] !== '\\') break
      if (src[end] === '\n') return false                     // inline maths is single-line
      end++
    }
    if (end >= src.length) return false
    if (/\s/.test(src[end - 1])) return false                 // "$ x $" is not maths
    if (/[\d]/.test(src[end + 1] || '')) return false         // "$5...$6" is currency

    if (!silent) {
      const token = state.push('math_inline', '', 0)
      token.content = src.slice(pos + 1, end)
    }
    state.pos = end + 1
    return true
  })

  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]
    if (start + 2 > max) return false
    if (state.src.slice(start, start + 2) !== '$$') return false

    const firstLine = state.src.slice(start + 2, max).trim()
    let line = startLine
    let content = ''
    let closed = false

    if (firstLine.endsWith('$$') && firstLine.length > 2) {
      content = firstLine.slice(0, -2)
      closed = true
    } else {
      const parts = firstLine ? [firstLine] : []
      while (++line < endLine) {
        const from = state.bMarks[line] + state.tShift[line]
        const to = state.eMarks[line]
        const text = state.src.slice(from, to)
        if (text.trim().endsWith('$$')) {
          const head = text.trim().slice(0, -2)
          if (head) parts.push(head)
          closed = true
          break
        }
        parts.push(text)
      }
      content = parts.join('\n')
    }
    if (!closed) return false
    if (silent) return true

    const token = state.push('math_block', '', 0)
    token.content = content.trim()
    token.map = [startLine, line + 1]
    state.line = line + 1
    return true
  }, { alt: ['paragraph', 'blockquote', 'list'] })

  md.renderer.rules.equation_ref = (tokens, i, _opts, env) => {
    const { label, parens } = tokens[i].meta
    const tag = env?.equations?.get(label)?.tag || label
    const shown = parens ? `(${tag})` : tag
    const id = equationId(label)
    return `<a class="tk-eq-ref" href="#${id}" data-equation-ref="${md.utils.escapeHtml(label)}">` +
      `${md.utils.escapeHtml(shown)}</a>`
  }
  md.renderer.rules.math_inline = (tokens, i) =>
    renderMath(equationSource(tokens[i].content).source, false)
  md.renderer.rules.math_block = (tokens, i, _opts, env) => {
    const equation = equationSource(tokens[i].content, env?.equations)
    const identity = equation.label
      ? ` id="${equationId(equation.label)}" data-equation="${md.utils.escapeHtml(equation.label)}"`
      : ''
    return `<div class="math-block"${identity}>${renderMath(equation.source, true)}</div>`
  }
}

/* -------------------------------------------------- live preview widget */

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

/** Every $…$ and $$…$$ span in the document, in order. */
export function findMath (text) {
  const spans = []

  /* Display maths is a block, and the reading view's block rule treats it as
     one: `$$` only opens when it begins its line (three spaces of indent at
     most — a fourth makes indented code) and only closes when it ends one.
     The same two tests here, or `a $$x$$ b` would centre itself in the editor
     while staying literal text in the reading view. */
  /* What may stand between the start of a line and a `$$` that opens a block.
     Spaces, up to the three that still count as unindented — and the markers of
     the containers markdown-it runs this rule inside. Its block rule is
     registered for paragraphs, blockquotes *and* lists, and reads each line
     from `bMarks + tShift`, which is the position after the container's own
     prefix; so `> $$…$$` inside a callout is display maths in the reading view.
     Refusing it here made the editing view show a stray `$` on each side and
     typeset the middle inline, which is the exact disagreement between the two
     scanners this module exists to prevent. */
  const CONTAINER = /^ {0,3}(?:> ?)*(?:(?:[-*+]|\d{1,9}[.)]) +)? {0,3}$/
  const lineStart = (i) => text.lastIndexOf('\n', i - 1) + 1
  const opensLine = (i) => CONTAINER.test(text.slice(lineStart(i), i))
  const closesLine = (i) => {
    const to = text.indexOf('\n', i)
    return /^[ \t]*$/.test(text.slice(i, to === -1 ? text.length : to))
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch !== '$' || (i > 0 && text[i - 1] === '\\')) { i++; continue }

    const display = text[i + 1] === '$'
    /* A `$$` that does not begin its line is no opener at all: the reading
       view leaves the first `$` as text and lets the second try its luck as
       an inline delimiter, so the same step is taken here. */
    if (display && !opensLine(i)) { i++; continue }
    const open = display ? i + 2 : i + 1
    if (!display && /\s/.test(text[open] || ' ')) { i++; continue }
    const close = display ? '$$' : '$'
    let end = open

    while (end < text.length) {
      if (text.startsWith(close, end) && text[end - 1] !== '\\' &&
          (!display || closesLine(end + 2))) break
      if (!display && text[end] === '\n') break
      end++
    }
    if (end >= text.length || !text.startsWith(close, end)) { i++; continue }

    /* The same two tests the markdown-it rule applies, so the editor and the
       reading view agree about what is maths: "$ x $" is not an expression,
       and a digit on the far side of the closing "$" means the pair was two
       prices rather than one span. */
    if (!display && /\s/.test(text[end - 1])) { i++; continue }
    if (!display && /\d/.test(text[end + close.length] || '')) { i++; continue }

    let tex = text.slice(open, end)
    /* A block opened inside a blockquote or callout carries that container's
       marker down its left edge, and the marker is not part of the expression —
       markdown-it never sees it, because the block parser strips each line's
       prefix before this rule reads it. Stripped here too, so both views
       typeset the same TeX. */
    if (display && tex.includes('\n') && /^ {0,3}(?:> ?)+/.test(text.slice(lineStart(i), i))) {
      tex = tex.replace(/\n[ \t]*>[ \t]?/g, '\n')
    }
    if (tex.trim()) spans.push({ from: i, to: end + close.length, tex, display })
    i = end + close.length
  }
  return spans
}

/* ------------------------------------------------------------- the cache */

/**
 * `findMath` is a whole-document scan, and three callers want the same answer
 * about the same document: this layer, on every keystroke *and every cursor
 * move*; and the money layer, which scans for prices and then needs to know
 * which of them fall inside maths. Uncached that was three passes over the
 * entire note per keystroke — and a full pass merely to move the caret.
 *
 * Keyed on the `Text` object rather than on a string. CodeMirror shares it
 * between states whenever the document itself did not change, so identity is
 * exactly the question being asked: a selection-only update reuses the scan,
 * and only a real edit pays for another.
 *
 * One entry is enough — the interesting case is many updates against one
 * document, not alternation between two.
 */
let cache = { doc: null, text: '', spans: null, equations: null }

function fill (doc) {
  if (cache.doc !== doc) {
    const text = doc.toString()
    cache = { doc, text, spans: findMath(text), equations: null }
  }
  return cache
}

/** The document as a string, computed once per version. */
export const docText = (doc) => fill(doc).text

/** Every maths span in the document, computed once per version. */
export const mathSpans = (doc) => fill(doc).spans

/**
 * The numbered equations of a document, computed once per version.
 *
 * `equationIndex` takes a string, which meant every caller in the editor was
 * paying for a fresh `findMath` over the whole note — the exact scan this cache
 * exists to prevent, reintroduced by going in through the door that does not
 * take a `Text`. Two callers made that mistake on every keystroke, and one of
 * them on every cursor movement as well. Built from the spans above rather than
 * scanning again, and held beside them because it is a fact about the same
 * document and goes stale at the same moment.
 */
export function equationsFor (doc) {
  const entry = fill(doc)
  if (!entry.equations) entry.equations = indexEquations(entry.spans)
  return entry.equations
}

/**
 * Renders maths in the editing view, and steps out of the way — showing the
 * raw TeX — whenever the cursor is inside the expression, which is the same
 * rule the rest of the live preview follows.
 *
 * A StateField rather than a ViewPlugin: a `$$…$$` block spans line breaks,
 * and CodeMirror refuses replace decorations across a line break when they
 * come from a plugin — opening a note with display maths threw and left the
 * whole view broken. Same rule the diagrams and the tables follow.
 */
/**
 * Which spans the selection is sitting in, as a string that changes only when
 * that set does.
 *
 * Moving the caret changes what this field draws only when it crosses into or
 * out of an expression — every other movement, which is nearly all of them,
 * produces exactly the decorations already on screen. Comparing the answer is
 * far cheaper than rebuilding: no widgets are constructed and no decoration set
 * is sorted, and the spans themselves are already cached.
 */
function touchedSpans (state) {
  const spans = mathSpans(state.doc)
  let signature = ''
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]
    if (state.selection.ranges.some((r) => r.to >= span.from && r.from <= span.to)) {
      signature += `${i},`
    }
  }
  return signature
}

function buildMathDeco (state) {
  const tree = syntaxTree(state)
  const ranges = []
  const equations = equationsFor(state.doc)

  /* In code, `$` is a shell variable or a string literal, and the reading
     view never typesets there. The test is asked of the tree rather than of
     the span cache, which is keyed on the document alone — money.js makes
     the same call, of the same helper. */
  for (const span of mathSpans(state.doc)) {
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
  }
  return Decoration.set(ranges, true)
}

const mathState = (state) => ({ deco: buildMathDeco(state), touched: touchedSpans(state) })

export const mathPreview = StateField.define({
  create: mathState,
  update (value, tr) {
    if (tr.docChanged) return mathState(tr.state)
    /* The parse advancing can move a span into or out of code — and a freshly
       opened note has no tree at create() at all. The parser reports its
       progress through transactions of its own; this catches them. Widget
       eq() keeps the untouched renders alive across every rebuild. */
    if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) return mathState(tr.state)
    if (tr.selection) {
      /* Only when the caret has crossed an expression's edge. Holding an arrow
         key down through a note full of maths used to rebuild every widget in
         it on every intermediate position. */
      const touched = touchedSpans(tr.state)
      return touched === value.touched ? value : { deco: buildMathDeco(tr.state), touched }
    }
    return value
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.deco),
    EditorView.atomicRanges.of((view) => view.state.field(field).deco)
  ]
})
