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


/* ---------------------------------------------------------------- render */

let katex = null
let loadingKatex = null
let loadingStyles = null

function loadStyles () {
  if (loadingStyles) return loadingStyles

  const link = document.createElement('link')
  link.rel = 'stylesheet'
  /* Resolved against the document, not against this module.
     build.mjs emits the stylesheet as a named entry point beside index.html,
     so `dist/katex.css` is where it always is — but `import.meta.url` is
     wherever esbuild's splitting last happened to put *this file*, and the day
     math.js landed in a shared chunk that became `dist/chunks/katex.css`. The
     link 404ed, `loadKatex` never resolved, and every `$…$` in the app
     rendered as its own source in a `.math-pending` span, silently: nothing
     throws, the promise is simply never fulfilled. The document is the one
     base that cannot move out from under this. */
  link.href = new URL('katex.css', document.baseURI).href
  link.dataset.tulipKatex = ''

  loadingStyles = new Promise((resolve, reject) => {
    link.addEventListener('load', resolve, { once: true })
    link.addEventListener('error', () => {
      loadingStyles = null
      // Taken back out, because the next expression will try again: a
      // stylesheet that will not load once left one dead <link> in the head
      // per equation rendered.
      link.remove()
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

/* Exported for math-editor.js, which renders the same equation live. */
export function equationSource (tex, equations = null) {
  const found = LABEL.exec(tex)
  const label = found?.[1]?.trim() || ''
  let source = String(tex || '').replace(/\\label\s*\{[^{}]+\}/g, '').trim()
  const tag = label ? equations?.get(label)?.tag || TAG.exec(source)?.[1]?.trim() || '' : ''
  if (label && tag && !TAG.test(source)) source += ` \\tag{${tag}}`
  TAG.lastIndex = 0
  return { source, label, tag }
}

/* The shorthands a note may use without defining them. */
const MACROS = { '\\R': '\\mathbb{R}', '\\N': '\\mathbb{N}', '\\Z': '\\mathbb{Z}' }

/**
 * One option set for every caller. The reading view used to pass `macros` and
 * the editing view not, so `$\R$` typeset in one view and came back red in the
 * other — the disagreement between the two views this module exists to prevent,
 * and the language table (src/table.js) took the editor's side of it.
 *
 * Built fresh per call rather than hoisted whole: KaTeX writes the definitions
 * an expression makes with `\gdef` back into the macros object it is handed, so
 * one shared object would leak a note's definitions into everything typeset
 * after it — and would make the cache below, whose key is the source alone,
 * wrong. `errorColor` is a custom property rather than a colour for the same
 * reason: the markup must not depend on the theme in force when it was built.
 */
const mathOptions = (displayMode) => ({
  displayMode,
  throwOnError: false,
  errorColor: 'var(--accent)',
  strict: false,
  trust: false,
  output: 'htmlAndMathml',
  macros: { ...MACROS }
})

/**
 * Typeset markup for an expression, which — given the above — is a pure
 * function of its source and its mode, and so is worth keeping.
 *
 * KaTeX is around 70% of what a reading render costs, and a note repeats
 * itself heavily: the dense note this was measured against holds 1,903
 * expressions over 634 distinct sources. Opening it went from 113ms to 60ms,
 * and every render after that from 110ms to 15ms.
 *
 * Bounded, oldest first — a Map yields its keys in insertion order, so the
 * first one is the one to drop. Values are markup, on the order of 1.5KB an
 * expression.
 */
const RENDER_CAP = 3000
const renders = new Map()

function typeset (tex, displayMode) {
  const key = (displayMode ? 'D' : 'I') + tex
  const hit = renders.get(key)
  if (hit !== undefined) return hit
  const html = katex.renderToString(tex, mathOptions(displayMode))
  if (renders.size >= RENDER_CAP) renders.delete(renders.keys().next().value)
  renders.set(key, html)
  return html
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
  return typeset(tex, displayMode)
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
    /* The same markup `renderToString` would produce, which is what
       `katex.render` builds and appends anyway — but taken from the cache, so
       scrolling a note full of maths typesets each expression once. */
    el.innerHTML = typeset(tex, displayMode)
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

  /**
   * KaTeX's own delimiters: `\(…\)` inline, `\[…\]` display.
   *
   * Papers, and anything an assistant writes, arrive punctuated this way as
   * often as with dollars — and markdown-it's escape rule would otherwise eat
   * the backslashes and leave "(n=1)" behind. Registered before `escape` so it
   * gets first refusal on the backslash. `\\(` is not an opener: the pair of
   * backslashes is an escaped backslash, and the escape rule below owns it.
   */
  md.inline.ruler.before('escape', 'math_delimited', (state, silent) => {
    const { src, pos } = state
    if (src[pos] !== '\\') return false
    const opener = src[pos + 1]
    if (opener !== '(' && opener !== '[') return false

    const display = opener === '['
    const close = display ? '\\]' : '\\)'
    let end = pos + 2
    while (end < src.length && !src.startsWith(close, end)) {
      if (!display && src[end] === '\n') return false      // inline maths is single-line
      end++
    }
    if (end >= src.length) return false
    const tex = src.slice(pos + 2, end)
    if (!tex.trim()) return false

    if (!silent) {
      const token = state.push(display ? 'math_inline_display' : 'math_inline', '', 0)
      token.content = tex
    }
    state.pos = end + 2
    return true
  })

  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]
    if (start + 2 > max) return false
    /* `$$` and `\[` open the same block; whichever opened it is what closes
       it, so a note may not start in one notation and end in the other. */
    const open = state.src.slice(start, start + 2)
    const close = open === '$$' ? '$$' : open === '\\[' ? '\\]' : null
    if (!close) return false

    const firstLine = state.src.slice(start + 2, max).trim()
    let line = startLine
    let content = ''
    let closed = false

    if (firstLine.endsWith(close) && firstLine.length > 2) {
      content = firstLine.slice(0, -2)
      closed = true
    } else {
      const parts = firstLine ? [firstLine] : []
      while (++line < endLine) {
        const from = state.bMarks[line] + state.tShift[line]
        const to = state.eMarks[line]
        const text = state.src.slice(from, to)
        if (text.trim().endsWith(close)) {
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
  /* A `\[…\]` that did not open its own line — inside a table cell, or mid
     sentence. It is still display maths, but it cannot be a block here, so it
     is typeset in display mode inside the run of text it was written in. */
  md.renderer.rules.math_inline_display = (tokens, i) =>
    `<span class="tk-math tk-math-display">${renderMath(equationSource(tokens[i].content).source, true)}</span>`
  md.renderer.rules.math_block = (tokens, i, _opts, env) => {
    const equation = equationSource(tokens[i].content, env?.equations)
    const identity = equation.label
      ? ` id="${equationId(equation.label)}" data-equation="${md.utils.escapeHtml(equation.label)}"`
      : ''
    return `<div class="math-block"${identity}>${renderMath(equation.source, true)}</div>`
  }
}

/* -------------------------------------------------- live preview widget */

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

  /* The other notation, `\(…\)` and `\[…\]`, taken on the same terms as the
     markdown-it rule above: single-line inline, and a `\[` block that may run
     over lines. Unlike `$$`, a `\[` need not open its line — the reading view
     typesets one inside a sentence too, so both views agree. */
  const delimited = (i) => {
    const opener = text[i + 1]
    if (opener !== '(' && opener !== '[') return null
    if (i > 0 && text[i - 1] === '\\') return null           // an escaped backslash
    const display = opener === '['
    const close = display ? '\\]' : '\\)'
    let end = i + 2
    while (end < text.length && !text.startsWith(close, end)) {
      if (!display && text[end] === '\n') return null
      end++
    }
    if (end >= text.length) return null
    return { from: i, to: end + 2, tex: text.slice(i + 2, end), display }
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      const span = delimited(i)
      if (!span) { i++; continue }
      let { tex } = span
      if (span.display && tex.includes('\n') && /^ {0,3}(?:> ?)+/.test(text.slice(lineStart(i), i))) {
        tex = tex.replace(/\n[ \t]*>[ \t]?/g, '\n')
      }
      if (tex.trim()) spans.push({ ...span, tex })
      i = span.to
      continue
    }
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
