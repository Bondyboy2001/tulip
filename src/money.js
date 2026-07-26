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

const escaped = (text, i) => text[i - 1] === '\\' || text[i - 1] === '$'

/** Every price in `text`, skipping any that falls inside a maths span. */
function findMoney (text) {
  const maths = findMath(text)
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

/* --------------------------------------------------------- markdown-it */

export function moneyPlugin (md) {
  // Before the maths rule, so a price is claimed before `$` can open a span.
  md.inline.ruler.before('math_inline', 'money', (state, silent) => {
    const { src, pos } = state
    if (src.charCodeAt(pos) !== 0x24) return false
    if (escaped(src, pos)) return false

    MONEY_AT.lastIndex = pos
    const m = MONEY_AT.exec(src)
    if (!m) return false

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
 * caret. Tinting says the same thing and stays editable.
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
      const text = state.doc.toString()
      const tree = syntaxTree(state)
      const ranges = []

      for (const span of findMoney(text)) {
        if (span.to < view.viewport.from || span.from > view.viewport.to) continue
        // A price in a code block is a string literal, and belongs to the
        // language's own highlighting rather than to this.
        const node = tree.resolveInner(span.from, 1)
        if (node.name === 'InlineCode' || node.name === 'FencedCode' ||
            node.node.parent?.name === 'FencedCode') continue

        ranges.push(Decoration.mark({ class: 'tk-money' }).range(span.from, span.to))
      }
      return Decoration.set(ranges, true)
    }
  },
  { decorations: (v) => v.decorations }
)
