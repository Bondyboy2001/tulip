/* ==================================================== money, editing
   The live badge a price wears under the caret, and the doc-keyed cache of
   where the prices are.

   Split from money.js so the reading view's markdown-it rule can be reached
   without CodeMirror on the startup path — see the note at the top of
   blocks.js.
   ================================================== */

import { Decoration, ViewPlugin } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { findMoney } from './money.js'
import { mathSpans, docText, slidThrough } from './math.js'
import { inCode } from './blocks.js'

/**
 * The same answer for a whole document, computed once per version.
 *
 * Both halves of the work are shared with the maths layer: the document's
 * string and its maths spans come from that module's cache rather than being
 * recomputed here, which is what stops one keystroke from scanning the note
 * three times over.
 */
/** @type {{doc: import('@codemirror/state').Text|null, spans: ReturnType<typeof findMoney>|null}} */
let cache = { doc: null, spans: null }

function moneySpans (doc) {
  if (cache.doc === doc && cache.spans) return cache.spans

  /* A price begins with a `$`, and the maths layer only slides its cache
     through a change on a line that holds no `$` at all — so under the very
     same conditions no price can have been written, unwritten or reworded
     either, and this cache slides with it rather than scanning again. */
  const slid = /** @type {{from: import('@codemirror/state').Text|null, changes: import('@codemirror/state').ChangeSet|null}|null} */ (slidThrough(doc))
  if (slid && slid.changes && cache.spans && cache.doc === slid.from) {
    const { changes } = slid
    const map = (pos) => changes.mapPos(pos)
    const spans = cache.spans.map((s) => ({ ...s, from: map(s.from), to: map(s.to) }))
    cache = { doc, spans }
    return spans
  }

  const spans = findMoney(docText(doc), mathSpans(doc) ?? undefined)
  cache = { doc, spans }
  return spans
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

