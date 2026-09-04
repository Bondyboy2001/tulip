/* ============================================================ pdf find
   ⌘F over a PDF, in the same bar ⌘F gives a note.

   It used to be a mode of the big overlay: a modal card down the middle of the
   window, holding a scrolling list of every hit with a line of context each.
   That is the shape of the *vault* search, where the question is "which of
   four hundred notes did I mean" and a list of candidates is the answer. Inside
   one document the question is a different one — "show me the next one" — and a
   list is a poor way to ask it. The card covered the pages it was searching, so
   the reader could not see a hit until they had chosen it and dismissed the
   thing that found it; stepping meant arrowing a list rather than reading the
   page; and nothing on screen said where in the document they had got to.

   So a PDF gets what a note gets: a slim bar along the bottom edge, the query
   answered as it is typed, `3 / 47` for how far through you are, and ↑ ↓ to
   walk it — with the document itself in full view the whole time, which is the
   thing being searched and the thing the old panel was covering.

   The controls are literally the note's: the chip, the step buttons and the
   tally are built by src/find-bar.js, which both bars import, and the `find-*`
   classes are the same set. Two search bars in one window that are nearly the
   same is worse than either being wrong. What differs is what sits underneath —
   a note is searched through CodeMirror, which holds the text and the
   selection; a PDF is searched through the viewer, which reads the words off
   the pages and answers with a page number and a height down it.
   ================================================================== */

import { el } from './dom.js'
import { chip, icon, tallyText } from './find-bar.js'

/* The first pass over a long document asks the worker for every page's text.
   Doing that per keystroke while a phrase is typed is the one way to make a
   four-hundred-page paper feel slow, so the query waits for a pause. Short
   enough that it never feels like waiting; the pages are cached after the
   first pass, so this only really costs on the first word typed. */
const QUERY_WAIT = 90

/* What the viewer will count up to. Named here as well because the tally has to
   say when it has stopped counting, and `500` on its own reads as the answer. */
const LIMIT = 500

/**
 * @param {object} deps
 * @param {HTMLElement} deps.host   where the bar is docked — the stage
 * @param {{ find: (query: string, opts: { limit: number, caseSensitive: boolean }) => Promise<Array<{ page: number, y: number }>>, page: () => number, goToPage: (page: number, y: number) => void, markHit: (page: number, y: number) => void, clearHit: () => void, stopFind?: () => void }} deps.pdf         the viewer: `find`, `goToPage`, `markHit`, `clearHit`
 * @param {() => void} [deps.onClose]  run after the bar closes, to put focus back
 * @returns {{ open: () => void, close: () => void, reset: () => void }}
 */
export function mountPdfFind ({ host, pdf, onClose }) {
  let hits = []
  let index = -1
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  /* Every query answers asynchronously, and a slow one for `th` must not land
     after the quick one for `there` and overwrite it. */
  let generation = 0

  /* ------------------------------------------------------------- the bar */

  const input = el('input', 'find-input')
  input.type = 'text'
  input.placeholder = 'Find in document'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.setAttribute('aria-label', 'Find in document')

  const tally = el('span', 'find-tally')
  tally.setAttribute('aria-live', 'polite')

  const field = el('div', 'find-field')
  field.append(input, tally)

  /* One switch rather than the note's three. A regexp and a whole-word match
     are about text you are editing; over a printed page, where the phrase has
     been through a line break and a hyphenation the reader never sees, they
     would promise a precision the search does not have. Case is the one
     distinction that survives the trip, so it is the one offered. */
  const caseChip = chip('Aa', 'Match case', false, () => { run(input.value); input.focus() })

  const chips = el('div', 'find-chips')
  chips.append(caseChip)

  const step = (by) => {
    if (!hits.length) return
    // Wraps, the way the note's does: the end of a document is not the end of
    // the search, and a reader who has walked to the last hit is asking to
    // start again rather than to be told to stop.
    land(hits, (index + by + hits.length) % hits.length)
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

  /* Typing waits; pressing a button does not. A switch flipped or a bar opened
     on a phrase already in the box is one deliberate act, and making it sit out
     the debounce would read as the app hesitating over a decision it was handed
     whole. */
  function queue (value) {
    if (timer != null) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; run(value) }, QUERY_WAIT)
  }

  async function run (value) {
    if (timer != null) clearTimeout(timer)
    timer = null
    const mine = ++generation
    const query = String(value || '').trim()

    if (!query) { land([], -1); return }

    const found = await pdf.find(query, { limit: LIMIT, caseSensitive: matchCase() })
    // Typed on, or closed the document, while the pages were being read.
    if (mine !== generation) return

    /* The first hit at or after the page being read, so a search started
       halfway down a paper carries on from there rather than throwing the
       reader back to page one — the same promise the note's bar makes by
       searching from where the cursor was.  */
    const from = pdf.page()
    const at = found.findIndex((hit) => hit.page >= from)
    land(found, found.length ? (at === -1 ? 0 : at) : -1)
  }

  /** Takes a set of results, shows where the reader now is in it, and goes
   *  there. The one path that moves the document, so it is the one place the
   *  band on the page is drawn. */
  function land (found, at) {
    hits = found
    index = at
    paint()
    if (at < 0) { pdf.clearHit(); return }
    const hit = hits[at]
    pdf.goToPage(hit.page, hit.y)
    pdf.markHit(hit.page, hit.y)
  }

  /* ----------------------------------------------------------- the tally */

  function paint () {
    tally.textContent = input.value.trim()
      /* `>= LIMIT` rather than `>`: the viewer stops counting *at* the cap, so
         a document with exactly that many hits is indistinguishable from one
         with more, and the tally must not claim otherwise. */
      ? tallyText({ at: index + 1, total: hits.length, limit: hits.length >= LIMIT ? LIMIT - 1 : LIMIT })
      : ''
  }

  /* ------------------------------------------------------------- the keys */

  input.addEventListener('input', () => queue(input.value))

  dom.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key !== 'Enter') return
    e.preventDefault()
    /* Enter on a query that has not been searched for yet searches for it now
       rather than stepping through the last one's results — the debounce is an
       optimisation, and it must not be something the reader has to wait out. */
    if (timer) { run(input.value); return }
    step(e.shiftKey ? -1 : 1)
  })

  /* --------------------------------------------------------- open and shut */

  /** Everything in flight abandoned, and the bar showing no results.
   *
   *  `land([], -1)` is what "no results" means everywhere else in this file —
   *  it empties the hits, clears the tally and takes the band off the page — so
   *  shutting and starting over both say it that way rather than each spelling
   *  the same four assignments out again and risking a fifth being added to one
   *  of them. */
  function forget () {
    if (timer != null) clearTimeout(timer)
    timer = null
    generation++          // nothing in flight belongs to a search nobody made
    /* And the viewer's own walk of the pages, which the generation does not
       reach: shutting the bar a page into a long book otherwise left it
       pulling the text of every page that remained, for nobody. */
    pdf.stopFind?.()
    land([], -1)
  }

  function open () {
    dom.hidden = false
    /* The sheet leaves room under the last page for this bar, and the only
       thing that truly knows how tall it is is the bar once it is on screen.
       Measured here rather than written into the stylesheet as a number, so
       changing the bar's padding cannot silently hide the last page behind
       it. */
    host.style.setProperty('--doc-find-h', `${dom.offsetHeight}px`)
    input.focus()
    /* Selected rather than left as it was: ⌘F on a bar already open is a new
       search far more often than it is a correction to the old one, and the
       selection makes typing replace the query while ⌘F twice and an arrow key
       still gets back to editing it. */
    input.select()
    // Whatever is in the box is what the bar claims to be showing, so opening
    // on a phrase from last time answers it again rather than showing a tally
    // for a document that may not even be the same one.
    if (input.value.trim()) run(input.value)
  }

  function close () {
    if (dom.hidden) return
    forget()
    dom.hidden = true
    onClose?.()
  }

  /** A different document is a different search. The query stays — looking for
   *  the same phrase across a stack of papers is a real thing to be doing — but
   *  everything that was true about the last one does not. */
  function reset () {
    forget()
    if (!dom.hidden && input.value.trim()) run(input.value)
  }

  return { open, close, reset }
}
