/* ================================================================== match
   Scoring and marking for the overlay pickers — the quick switcher, the
   command palette, the tag and theme and font lists, and the vault search's
   result rows.

   Lifted out of renderer.js: these four functions answer every "does this row
   answer what was typed" question the overlays ask, and none of them touches
   vault, editor or overlay state — which is exactly what made them the right
   piece to carry out of a file that has everything else in it.
   ================================================================== */

/** Subsequence match; consecutive hits and word starts score higher. */
/**
 * How well `text` answers `query`, or null if it does not answer it at all.
 *
 * Whole runs, not scattered letters. A subsequence matcher — every letter of
 * the query somewhere in the text, in order — finds "gre" in "Guernsey" and in
 * "Singapore", and a list where four real answers sit among a dozen
 * coincidences is a list that has to be read rather than glanced at. Every
 * term has to appear whole.
 *
 * The looseness that is kept is the useful kind: the query is split on spaces
 * and the terms may appear in any order and anywhere apart, so "index reading"
 * still finds "Reading Index" and "gre" finds "St. Vincent & Grenadines".
 *
 * Where a term lands is most of the score — the start of the name beats the
 * start of a word beats the middle of one — because that is the difference
 * between the thing you meant and the thing that merely contains it.
 */
const WORD_EDGE = /[\s/\\_\-–—.,:;([{&]/

/* The query, split up. One pass of the quick switcher runs `fuzzy` against
   every note in the vault with the *same* query, and each call was lowercasing
   and re-splitting it — thousands of times per keystroke for a string that is
   the one thing common to all of them. One entry is the whole cache this
   wants: the pass moves on when the query changes. */
/** @type {any} */
let termCache = { query: null, terms: [] }

function queryTerms (query) {
  const text = String(query || '')
  if (termCache.query !== text) {
    termCache = { query: text, terms: text.toLowerCase().split(/\s+/).filter(Boolean) }
  }
  return termCache.terms
}

export function fuzzy (query, text) {
  const terms = queryTerms(query)
  if (!terms.length) return { score: 0, hits: [] }
  const t = String(text || '').toLowerCase()

  const hits = []
  let score = 0

  for (const term of terms) {
    const at = t.indexOf(term)
    if (at === -1) return null

    const wordStart = at === 0 || WORD_EDGE.test(t[at - 1])
    score += 10 + (at === 0 ? 8 : wordStart ? 4 : 0)
    // Earlier is better, but only ever as a tie-break between equals — and it
    // stops counting past a point, so one long name does not outrank another
    // purely for being longer.
    score -= Math.min(at, 40) * 0.05

    for (let i = at; i < at + term.length; i++) hits.push(i)
  }

  // A short name that matches is a better answer than a long one carrying the
  // same run somewhere inside it.
  score -= Math.max(0, t.length - query.length) * 0.02
  return { score, hits }
}

/**
 * An item against the query: its own label, or failing that the short code
 * shown beside it.
 *
 * The codes are on screen — GR, GD, VC down the right-hand side of the country
 * list — so they are a thing people type, and a list that displays a key it
 * refuses to match on is a list that lies about itself. A code match scores
 * below every label match and marks nothing, because the letters it matched
 * are not in the text being shown.
 */
export function matchItem (query, item) {
  const code = item.code?.toLowerCase()
  /* Typed in full, a code is not a guess. Someone entering "GD" at a list whose
     right-hand column is codes means Grenada, and should not be answered first
     with the United Kin(gd)om — which is a real match on the label, just not
     the one they asked for. */
  if (code && code === query.trim().toLowerCase()) return { score: 1000, hits: [] }

  const onLabel = fuzzy(query, item.label)
  if (onLabel) return onLabel
  /* Palette synonyms find the command without highlighting letters that are
     not in its visible title. They rank below a title match, every time. */
  if (item.keywords) {
    const onKeywords = fuzzy(query, item.keywords)
    if (onKeywords) return { score: onKeywords.score - 20, hits: [] }
  }
  if (!code) return null
  const onCode = fuzzy(query, item.code)
  return onCode ? { score: onCode.score - 100, hits: [] } : null
}

export function markHits (text, hits) {
  const set = new Set(hits)
  const frag = document.createDocumentFragment()
  let buf = ''
  let marking = false

  const flush = () => {
    if (!buf) return
    if (marking) {
      const m = document.createElement('mark')
      m.textContent = buf
      frag.append(m)
    } else frag.append(document.createTextNode(buf))
    buf = ''
  }

  for (let i = 0; i < text.length; i++) {
    const on = set.has(i)
    if (on !== marking) { flush(); marking = on }
    buf += text[i]
  }
  flush()
  return frag
}

/**
 * The query's words, marked where they land in a result's snippet.
 *
 * `hit.text` is the matched line trimmed to a useful length but not to the
 * match, so which part of it answered the query was left to the reader; the
 * words come back from main — the parser that actually ran — rather than
 * being guessed at here, and an empty answer leaves the text unmarked.
 */
export function markWords (text, words) {
  const list = Array.isArray(words) ? words.filter((word) => word) : []
  if (!list.length) return document.createTextNode(text)
  const lower = text.toLowerCase()
  const marked = new Set()
  for (const word of list) {
    const needle = String(word).toLowerCase()
    let at = lower.indexOf(needle)
    while (at !== -1) {
      for (let i = at; i < at + needle.length; i++) marked.add(i)
      at = lower.indexOf(needle, at + needle.length)
    }
  }
  return marked.size ? markHits(text, marked) : document.createTextNode(text)
}
