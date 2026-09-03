'use strict'

/* The per-note half of the vault search: given a note's text and a compiled
   query, where the terms land and which lines to show for them.

   Its own module for the reason `search-narrow.js` is: this is the loop that
   runs once per note in the vault on every keystroke, and inside `main.js` it
   could not be measured without standing up an Electron app around it. Here
   `bench/search-bench.mjs` can scan a synthetic vault directly, and
   `npm run test:performance` can hold the result to a number — which is what
   every other hot path in this app already has and this one did not.

   Nothing here touches the filesystem, the index or Electron. Both functions
   are pure, and `main.js` is the only caller. */

/* Past this many matches of one term in one note, the exact number stops being
   information — it is a ranking input, and the handful of hits shown were
   settled long before. */
const SPOT_CAP = 500

/* How many positions are worth keeping across a whole note. The caller shows
   at most a few lines; the rest of a note's matches are counted, not
   remembered. Holding all 500 meant allocating an array that size for every
   matching note on every keystroke, to throw away all but the first few.

   Shared out between the terms rather than taken first-come: one common word
   would otherwise spend the whole budget and leave the rarer word — the one
   that says why this note matched — with no line to show for it. */
const SPOTS_KEPT = 24
const SPOTS_MIN_PER_TERM = 4

/**
 * Where the terms land in one note, and how often — or null if any term is
 * absent. Positions only; the lines they fall on are read afterwards, for the
 * handful that are actually shown.
 */
function findSpots (text, terms) {
  /* Presence first, for every term, before any of them is scanned in full. A
     note has to hold all of them, so the one that is absent should stop the
     work rather than come after it — a common first word would otherwise be
     walked end to end only for a rare second word to discard the note. */
  for (const term of terms) if (!term.has.test(text)) return null

  const budget = Math.max(SPOTS_MIN_PER_TERM, Math.floor(SPOTS_KEPT / terms.length))
  const spots = []
  let total = 0

  for (const { find } of terms) {
    let found = 0
    find.lastIndex = 0
    for (let m = find.exec(text); m; m = find.exec(text)) {
      found++
      if (found <= budget) spots.push(m.index)
      // A pattern that can match nothing — `x*` — would otherwise spin here.
      if (m[0] === '') find.lastIndex++
      if (found >= SPOT_CAP) break
    }
    total += found
  }

  // The caller reads them in order, and with more than one term they arrive
  // interleaved by term rather than by position.
  if (terms.length > 1) spots.sort((a, b) => a - b)
  return { spots, total }
}

const HEADING_LINE = /^ {0,3}#{1,6}\s/
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/

/** A fence-language match such as `rust` is useful only when it carries a
 *  glimpse of the code it found. Keep the matched line as the navigation
 *  anchor, then borrow the first non-empty line inside that fence. */
function contextualLine (text, from, to, line) {
  const fence = FENCE_LINE.exec(line)
  if (!fence) return line.trim().slice(0, 220)

  const label = fence[2] || fence[1]
  let cursor = to < text.length ? to + 1 : to
  while (cursor < text.length) {
    let end = text.indexOf('\n', cursor)
    if (end === -1) end = text.length
    const next = text.slice(cursor, end).trim()
    if (next && !next.startsWith(fence[1])) {
      return `${label} · ${next}`.slice(0, 220)
    }
    if (next.startsWith(fence[1])) break
    cursor = end + 1
  }
  return line.trim().slice(0, 220)
}

/**
 * The first few matches, as the lines they fall on.
 *
 * A line is shown once however many times the term appears on it, which is
 * what the readout has always meant — and `heading` is recorded here because
 * this is the one pass that has the line in hand, and ranking wants it.
 *
 * `spots` must be in ascending order, which buys the two things below: the
 * line number is counted forward from the last one worked out rather than from
 * the top of the note for each hit, and "a line already shown" is the previous
 * hit's line rather than a set of every line so far.
 */
function hitLines (text, spots, max = 4) {
  const out = []
  let shown = -1
  let scanned = 0     // how far the line count has been carried
  let atLine = 1

  for (const at of spots) {
    const from = text.lastIndexOf('\n', at - 1) + 1
    if (from === shown) continue
    shown = from

    for (let i = text.indexOf('\n', scanned); i !== -1 && i < from; i = text.indexOf('\n', i + 1)) atLine++
    scanned = from

    let to = text.indexOf('\n', at)
    if (to === -1) to = text.length
    const line = text.slice(from, to)
    out.push({
      line: atLine,
      text: contextualLine(text, from, to, line),
      col: at - from,
      heading: HEADING_LINE.test(line)
    })
    if (out.length >= max) break
  }
  return out
}

module.exports = { findSpots, hitLines }
