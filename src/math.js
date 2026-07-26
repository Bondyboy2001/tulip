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

import katex from 'katex'
import 'katex/dist/katex.min.css'
import { EditorView, Decoration, ViewPlugin, WidgetType } from '@codemirror/view'

/* ---------------------------------------------------------------- render */

/**
 * Never throws: a half-typed expression is the normal state of an editor, so a
 * malformed one renders as the offending source in the error colour rather
 * than taking the surrounding render down with it.
 */
function renderMath (tex, displayMode = false) {
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

function renderMathInto (el, tex, displayMode = false) {
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

  md.renderer.rules.math_inline = (tokens, i) => renderMath(tokens[i].content, false)
  md.renderer.rules.math_block = (tokens, i) =>
    `<div class="math-block">${renderMath(tokens[i].content, true)}</div>`
}

/* -------------------------------------------------- live preview widget */

class MathWidget extends WidgetType {
  constructor (tex, display) { super(); this.tex = tex; this.display = display }
  eq (other) { return other.tex === this.tex && other.display === this.display }

  toDOM () {
    const host = document.createElement('span')
    host.className = this.display ? 'tk-math tk-math-display' : 'tk-math'
    renderMathInto(host, this.tex, this.display)
    return host
  }

  // Clicking the rendered maths should put the caret in the source behind it.
  ignoreEvent () { return false }
}

/** Every $…$ and $$…$$ span in the document, in order. */
export function findMath (text) {
  const spans = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch !== '$' || (i > 0 && text[i - 1] === '\\')) { i++; continue }

    const display = text[i + 1] === '$'
    const open = display ? i + 2 : i + 1
    if (!display && /\s/.test(text[open] || ' ')) { i++; continue }
    const close = display ? '$$' : '$'
    let end = open

    while (end < text.length) {
      if (text.startsWith(close, end) && text[end - 1] !== '\\') break
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

    const tex = text.slice(open, end)
    if (tex.trim()) spans.push({ from: i, to: end + close.length, tex, display })
    i = end + close.length
  }
  return spans
}

/**
 * Renders maths in the editing view, and steps out of the way — showing the
 * raw TeX — whenever the cursor is inside the expression, which is the same
 * rule the rest of the live preview follows.
 */
export const mathPreview = ViewPlugin.fromClass(
  class {
    constructor (view) { this.decorations = this.build(view) }

    update (update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = this.build(update.view)
      }
    }

    build (view) {
      const { state } = view
      const ranges = []
      const text = state.doc.toString()

      for (const span of findMath(text)) {
        if (span.to < view.viewport.from || span.from > view.viewport.to) continue

        const touched = state.selection.ranges.some(
          (r) => r.to >= span.from && r.from <= span.to
        )
        if (touched) continue

        ranges.push(
          Decoration.replace({ widget: new MathWidget(span.tex, span.display) })
            .range(span.from, span.to)
        )
      }
      return Decoration.set(ranges, true)
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: () => EditorView.atomicRanges.of(
      (view) => view.plugin(mathPreview)?.decorations ?? Decoration.none
    )
  }
)
