// @ts-check
/* ================================================================ money
   `$` is overloaded: it opens maths and it prices things. The maths scanners
   already decline anything that looks like a price, which leaves prices as
   plain text that happens to start with a delimiter — indistinguishable, at a
   glance, from an expression that failed to render.
   So money is claimed explicitly. The reading view sets the sign as a small
   badge; the editor tints it, because the character there is still text you
   have to be able to type over.
   ================================================================== */

import { Decoration, ViewPlugin } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { findMath, mathSpans, docText } from './math.js'
import { inCode } from './blocks.js'

/**
 * A price is a `$` bound tightly to digits: `$5`, `$1,234.56`, `US$20`.
 *
 * The tail guard is what keeps maths out — `$5$` is an expression, not five
 * dollars — and the head guard skips both an escaped `\$` and the second `$`
 * of a `$$` display block.
 */
const MONEY = /\$(\d[\d,]*(?:\.\d{1,2})?)(?![\d$])/g
const MONEY_AT = new RegExp(MONEY.source, 'y')

/* Lent out so the other places that set a price — a table cell in the editing
   view, which draws its own contents — ask the same question this module asks,
   rather than carrying a second, slightly different idea of what a price is. */
export const MONEY_SOURCE = MONEY.source

/**
 * A price as the reading view sets it, built as DOM.
 *
 * Anything drawing a price outside markdown-it comes here for it, so a price
 * looks like a price wherever it is read.
 */
export function moneyNode (amount) {
  const span = document.createElement('span')
  span.className = 'money'
  const mark = document.createElement('span')
  mark.className = 'money-mark'
  mark.textContent = '$'
  const figures = document.createElement('span')
  figures.className = 'money-amount'
  figures.textContent = amount
  span.append(mark, figures)
  return span
}

const escaped = (text, i) => text[i - 1] === '\\' || text[i - 1] === '$'

/** Every price in `text`, skipping any that falls inside a maths span. */
function findMoney (text, maths = findMath(text)) {
  const inMath = (from, to) => maths.some((m) => from < m.to && to > m.from)

  const out = []
  MONEY.lastIndex = 0
  for (const m of text.matchAll(MONEY)) {
    const from = m.index
    const to = from + m[0].length
    if (escaped(text, from) || inMath(from, to)) continue
    out.push({ from, to, amount: m[1] })
  }
  return out
}

/**
 * The same answer for a whole document, computed once per version.
 *
 * Both halves of the work are shared with the maths layer: the document's
 * string and its maths spans come from that module's cache rather than being
 * recomputed here, which is what stops one keystroke from scanning the note
 * three times over.
 */
let cache = { doc: null, spans: null }

function moneySpans (doc) {
  if (cache.doc !== doc) {
    cache = { doc, spans: findMoney(docText(doc), mathSpans(doc)) }
  }
  return cache.spans
}

/* --------------------------------------------------------- markdown-it */

/* The inline run, scanned once per run rather than once per `$`: the rule is
   called at every dollar sign in a paragraph, and they all share `src`. */
let inlineMaths = { src: null, spans: null }
function mathsIn (src) {
  if (inlineMaths.src !== src) inlineMaths = { src, spans: findMath(src) }
  return inlineMaths.spans
}

export function moneyPlugin (md) {
  // Before the maths rule, so a price is claimed before `$` can open a span.
  md.inline.ruler.before('math_inline', 'money', (state, silent) => {
    const { src, pos } = state
    if (src.charCodeAt(pos) !== 0x24) return false
    if (escaped(src, pos)) return false

    MONEY_AT.lastIndex = pos
    const m = MONEY_AT.exec(src)
    if (!m) return false

    /* The editor's pass skips prices inside maths (`findMoney` above); the
       same test has to be made here, or `$1\sigma$` is a price in one view
       and an expression in the other — the very thing running before the
       maths rule makes possible. */
    if (mathsIn(src).some((s) => pos >= s.from && pos < s.to)) return false

    if (!silent) {
      const token = state.push('money', '', 0)
      token.content = m[1]
    }
    state.pos = pos + m[0].length
    return true
  })

  md.renderer.rules.money = (tokens, i) =>
    '<span class="money">' +
    '<span class="money-mark">$</span>' +
    `<span class="money-amount">${tokens[i].content}</span>` +
    '</span>'
}

/* -------------------------------------------------------- live preview */

/**
 * The editor keeps the literal `$`: replacing it with a badge would put a
 * widget where a character has to be, and typing into it would fight the
 * caret.
 *
 * So the character itself is set as the badge instead — the sign and the
 * figures each get their own mark, and the stylesheet cuts the `$` in the sans
 * face the reading view uses. Nothing is added, removed or moved: what you see
 * is the same run of characters you can still type over, which is why this can
 * look rendered without any of a widget's trouble.
 */
export const moneyPreview = ViewPlugin.fromClass(
  class {
    constructor (view) { this.decorations = this.build(view) }

    update (update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.build(update.view)
      }
    }

    build (view) {
      const { state } = view
      const tree = syntaxTree(state)
      const ranges = []

      for (const span of moneySpans(state.doc)) {
        if (span.to < view.viewport.from || span.from > view.viewport.to) continue
        // A price in a code block is a string literal, and belongs to the
        // language's own highlighting rather than to this. The same test the
        // maths scanner runs, so the two cannot disagree about a `$`.
        if (inCode(tree, span.from)) continue

        // The `$` is one character wide, always: the pattern starts on it.
        ranges.push(Decoration.mark({ class: 'tk-money-mark' }).range(span.from, span.from + 1))
        ranges.push(Decoration.mark({ class: 'tk-money-amount' }).range(span.from + 1, span.to))
      }
      return Decoration.set(ranges, true)
    }
  },
  { decorations: (v) => v.decorations }
)
