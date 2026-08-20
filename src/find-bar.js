// @ts-check
/* ======================================================== find bar parts
   The controls both find bars are built from.

   There are two bars — src/find.js for a note, src/pdf-find.js for a PDF — and
   they must not drift apart, because they are the same bar. What they search is
   genuinely different: a note is searched through CodeMirror, which holds the
   text and the selection; a PDF is searched through the viewer, which reads the
   words off the pages and answers with a page number. There is no honest shared
   abstraction over those two, and trying to write one would be worse than
   having two.

   The chrome is a different matter. A chip, a round icon button, the `3 / 47`
   tally: those are the same in both, and were written twice — the same
   `aria-pressed` protocol spelled out in two files, and a tally whose copies
   had already disagreed about what to show once the count was capped. Sharing
   the pieces is what keeps "the two bars look alike" true rather than merely
   asserted in a comment.
   ================================================================== */

import { el } from './blocks.js'

/**
 * A switch that looks pressed rather than a box that looks ticked: three words
 * of caption cost more room than the whole row of controls they qualify, so the
 * full name lives in the tooltip.
 *
 * @param {string} label   the two or three characters on the face of it
 * @param {string} title   what it does, spelled out
 * @param {boolean} on     pressed to begin with
 * @param {() => void} onToggle  run after the state flips
 */
export function chip (label, title, on, onToggle) {
  const b = el('button', 'find-chip', label)
  b.type = 'button'
  b.title = title
  b.setAttribute('aria-label', title)
  b.setAttribute('aria-pressed', String(!!on))
  b.onclick = () => {
    b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'))
    onToggle()
  }
  return b
}

/** One of the round buttons: a step arrow, the twist, the close cross. */
export function icon (className, glyph, title, onclick) {
  const b = el('button', className, glyph)
  b.type = 'button'
  b.title = title
  b.setAttribute('aria-label', title)
  if (onclick) b.onclick = onclick
  return b
}

/** Groups controls that belong together, so the gaps between them can differ. */
export function wrap (className, children) {
  const box = el('div', className)
  box.append(...children)
  return box
}

/**
 * `3 / 47`, or as much of it as is true.
 *
 * The position is only shown when there is one: in a note the selection may not
 * be on a match at all — after a plain click it is not, and claiming a position
 * would be a lie about where you are. Past the cap the total is a floor rather
 * than a count, and says so.
 */
export function tallyText ({ at, total, limit }) {
  if (total === 0) return 'none'
  if (total > limit) return `${at || '·'} / ${limit}+`
  return at ? `${at} / ${total}` : String(total)
}
