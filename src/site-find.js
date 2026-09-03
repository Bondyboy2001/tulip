/* =========================================================== website find
   ⌘F over a web page, in the same bar ⌘F gives a note and a PDF.

   A guest keeps its own text out of reach of the app around it, and for a long
   time that was taken to settle the question: ⌘F over a website answered "find
   does not reach inside a web page" and stopped. But the reaching was never
   necessary. Chromium's own find runs *inside* the guest — `findInPage` walks
   the document, highlights what it finds, scrolls to it, and answers with
   `3 of 12` — so all that is wanted here is the bar, and a way to hand the
   query across.

   The controls are literally the note's and the PDF's: the chip, the step
   buttons and the tally are built by src/find-bar.js, and the `find-*` classes
   are the same set. What differs is who does the looking, and one consequence
   of it — the tally arrives *after* the search, in a `found-in-page` event, so
   this bar is told its numbers rather than counting them.
   ================================================================== */

import { el } from './dom.js'
import { chip, icon, tallyText } from './find-bar.js'

/* Typing waits, the way it does over a PDF. Chromium's find is fast, but each
   keystroke also scrolls the page to the first hit — so an un-debounced bar
   makes the page lurch through a word being typed. */
const QUERY_WAIT = 90

/**
 * @param {object} deps
 * @param {HTMLElement} deps.host   where the bar is docked — the stage
 * @param {{ find: (query: string, opts?: object) => void,
 *           stepFind: (by: number, opts?: object) => void,
 *           clearFind: () => void }} deps.site  the viewer
 * @param {() => void} [deps.onClose]  run after the bar closes, to put focus back
 * @returns {{ open: () => void, close: () => void, reset: () => void,
 *            found: (tally: {at: number, total: number}) => void }}
 */
export function mountSiteFind ({ host, site, onClose }) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  let tallyAt = 0
  let tallyTotal = 0

  /* ------------------------------------------------------------- the bar */

  const input = el('input', 'find-input')
  input.type = 'text'
  input.placeholder = 'Find in page'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.setAttribute('aria-label', 'Find in page')

  const tally = el('span', 'find-tally')
  tally.setAttribute('aria-live', 'polite')

  const field = el('div', 'find-field')
  field.append(input, tally)

  /* Case, and nothing else. A regexp or a whole-word switch would be promising
     something `findInPage` does not offer — it takes a phrase and a case flag,
     and a chip that quietly did nothing would be worse than no chip. */
  const caseChip = chip('Aa', 'Match case', false, () => { run(input.value); input.focus() })

  const chips = el('div', 'find-chips')
  chips.append(caseChip)

  const step = (by) => {
    if (!input.value.trim()) return
    site.stepFind(by, { matchCase: matchCase() })
    input.focus()
  }

  const bar = el('div', 'find')
  const row = el('div', 'find-row')
  row.append(
    field,
    chips,
    icon('find-step', '↑', 'Previous match', () => step(-1)),
    icon('find-step', '↓', 'Next match', () => step(1))
  )
  bar.append(row, icon('find-close', '×', 'Close', () => close()))

  const dom = el('div', 'doc-find')
  dom.hidden = true
  dom.append(bar)
  host.append(dom)

  /* ----------------------------------------------------------- the query */

  const matchCase = () => caseChip.getAttribute('aria-pressed') === 'true'

  /* Typing waits; pressing a button does not — the same rule the PDF's bar
     keeps, and for the same reason: a switch flipped on a phrase already in
     the box is one deliberate act. */
  function queue (value) {
    clearTimeout(timer)
    timer = setTimeout(() => { timer = null; run(value) }, QUERY_WAIT)
  }

  function run (value) {
    clearTimeout(timer)
    timer = null
    const query = String(value || '')
    if (!query.trim()) { forget(); return }
    site.find(query, { matchCase: matchCase() })
  }

  /* ----------------------------------------------------------- the tally

     Pushed in from the viewer as the guest answers, rather than returned from
     the call that asked: Chromium reports a find in progress and then reports
     it again when it has counted the whole document, so the number in the box
     climbs to the truth instead of appearing at once. */

  function found ({ at, total }) {
    tallyAt = at
    tallyTotal = total
    paint()
  }

  function paint () {
    tally.textContent = input.value.trim()
      /* No cap: Chromium counts the whole document, so there is no
         number this bar stops at and has to say so. */
      ? tallyText({ at: tallyAt, total: tallyTotal, limit: Infinity })
      : ''
  }

  /* ------------------------------------------------------------- the keys */

  input.addEventListener('input', () => queue(input.value))

  dom.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key !== 'Enter') return
    e.preventDefault()
    // A query that has not been searched for yet is searched now rather than
    // stepping through the last one's results.
    if (timer) { run(input.value); return }
    step(e.shiftKey ? -1 : 1)
  })

  /* --------------------------------------------------------- open and shut */

  /** Nothing in flight, no highlight on the page, no tally in the box. */
  function forget () {
    clearTimeout(timer)
    timer = null
    site.clearFind()
    tallyAt = 0
    tallyTotal = 0
    paint()
  }

  function open () {
    dom.hidden = false
    /* The stage leaves room under the document for this bar, and the only
       thing that truly knows how tall it is is the bar once it is on screen. */
    host.style.setProperty('--doc-find-h', `${dom.offsetHeight}px`)
    input.focus()
    input.select()
    if (input.value.trim()) run(input.value)
  }

  function close () {
    if (dom.hidden) return
    forget()
    dom.hidden = true
    onClose?.()
  }

  /** A different page is a different search. The query stays — looking for the
   *  same phrase across a walk through a site is a real thing to be doing —
   *  but the tally does not describe the new document. */
  function reset () {
    tallyAt = 0
    tallyTotal = 0
    paint()
    if (!dom.hidden && input.value.trim()) run(input.value)
  }

  return { open, close, reset, found }
}
