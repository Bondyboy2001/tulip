/* ================================================================ money
   `$` is overloaded: it opens maths and it prices things. The maths scanners
   already decline anything that looks like a price, which leaves prices as
   plain text that happens to start with a delimiter — indistinguishable, at a
   glance, from an expression that failed to render.
   So money is claimed explicitly. The reading view sets the sign as a small
   badge; the editor tints it, because the character there is still text you
   have to be able to type over.
   ================================================================== */

import { findMath } from './math.js'

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
export function findMoney (text, maths = findMath(text)) {
  const out = []

  /* `findMath` yields its spans in document order and never overlapping, and a
     regex walk yields its hits the same way, so the two lists are walked once
     side by side. Asking `maths.some(...)` per price instead made the scan
     O(prices x spans) — and a note dense in maths is exactly a note dense in
     the `$` this pattern keeps catching. */
  let next = 0
  MONEY.lastIndex = 0
  for (const m of text.matchAll(MONEY)) {
    const from = m.index
    const to = from + m[0].length
    // Spans that end at or before this price cannot hold it, nor any price
    // after it: both cursors only ever move forward.
    while (next < maths.length && maths[next].to <= from) next++
    if (escaped(text, from)) continue
    if (next < maths.length && to > maths[next].from) continue
    out.push({ from, to, amount: m[1] })
  }
  return out
}

/* --------------------------------------------------------- markdown-it */

/* The inline run, scanned once per run rather than once per `$`: the rule is
   called at every dollar sign in a paragraph, and they all share `src`. */
/** @type {{ src: string | null, spans: ReturnType<typeof findMath> }} */
let inlineMaths = { src: null, spans: [] }
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
