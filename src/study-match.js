// @ts-check
/* ========================================================== typed answers
   Whether what was typed is the answer.

   A card you reveal and then grade yourself is the weakest kind of retrieval
   practice there is: you read `καρότο`, think "yes, carrot", and press Good.
   The recognition is real and the recall was never tested. Typing the answer
   removes the choice — either the word came back or it did not — and for a
   language written in another script it drills the alphabet at the same time.

   Which means the grading has to be honest about three things a string
   comparison is not:

     accents      `καροτο` is the right word with a mark missing, not a
                  different word. Greek marks stress and that matters, so it is
                  not simply forgiven; it is graded Hard, which shortens the
                  next interval instead of failing the card outright.
     final sigma  `ς` and `σ` are the same letter in two positions. A learner
                  typing the wrong one has made no mistake worth a lapse.
     synonyms     a translation column holds `is / is he /she is`, and any one
                  of those is the answer.

   Nothing here reads the clock, touches the DOM or knows what a card is: it
   takes two strings and returns a verdict, which is what `scripts/
   test-study-match.mjs` exercises.
   ================================================================== */

import { AGAIN, HARD, GOOD } from './srs.js'

/** The three verdicts. `close` is the one that earns this file its length. */
export const EXACT = 'exact'
export const CLOSE = 'close'
export const WRONG = 'wrong'

/* Written as a translation but not part of the word: an English gloss's
   infinitive marker and its articles, and the parenthesised gender or register
   note a vocabulary list carries. Someone who types `carrot` for `the carrot`
   has not got it wrong. */
const LEADING_WORDS = /^(?:to|the|a|an)\s+/

/* The combining marks NFD separates a letter from — Greek's accents and
   diaeresis among them. Written as codepoints rather than as the characters
   themselves, which in a source file are invisible and land on whatever letter
   precedes them. */
const COMBINING = /\p{M}/gu

/**
 * A string reduced to what nobody could call a mistake.
 *
 * Case, punctuation, doubled spaces and a leading `to`/`the` all go; the
 * letters and their accents stay. Greek final sigma is folded onto medial
 * sigma because they are one letter in two positions, and typing the wrong one
 * is not an error worth a lapse.
 */
export function plain (text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .replace(/[.,!?;:·"“”'’()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_WORDS, '')
}

/**
 * The same, with the accents taken off as well.
 *
 * The decomposition is what strips them: NFD splits `ό` into `ο` and a
 * combining acute, and the acute is then a character in the range above. Two
 * strings equal here but not under `plain` differ in their marks and nothing
 * else — which is the whole of what `close` means.
 */
export function normalize (text) {
  return plain(text).normalize('NFD').replace(COMBINING, '').normalize('NFC')
}

/**
 * Every answer a cell offers.
 *
 * A vocabulary table writes synonyms in one cell — `is / is he /she is`,
 * `mark, sign` — and any of them is the word. Split on the separators people
 * actually use for that and on a parenthesised aside, so `(the) carrot` is
 * answered by either half.
 */
export function alternatives (answer) {
  const raw = String(answer || '')
  const out = []

  for (const part of raw.split(/\s*[/;,]\s*|\s+or\s+/i)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    out.push(trimmed)
    // `καρότο (n.)` — also accept the word without its note, and the note is
    // never the answer on its own.
    const bare = trimmed.replace(/\s*\([^)]*\)\s*/g, ' ').trim()
    if (bare && bare !== trimmed) out.push(bare)
  }

  return out.length ? out : [raw.trim()].filter(Boolean)
}

/**
 * Edit distance, giving up once it passes `limit`.
 *
 * Bounded because the only question asked of it is "one typo, or a different
 * word entirely" — and a full matrix over two long sentences to answer that is
 * work nobody wanted. Two rows rather than a matrix for the same reason.
 */
export function distance (a, b, limit = Infinity) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > limit) return limit + 1

  let previous = Array.from({ length: b.length + 1 }, (_, at) => at)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost)
      if (row[j] < best) best = row[j]
    }
    // Every remaining row can only add to the best score on this one.
    if (best > limit) return limit + 1
    previous = row
  }
  return previous[b.length]
}

/**
 * How many characters may be wrong before an answer stops being the word.
 *
 * Proportional, with a floor: one slip in `ναι` is most of the word and one in
 * `ενδιαφέρομαι` is a fingertip. Nothing short of four letters gets any
 * latitude at all.
 */
function tolerance (length) {
  if (length < 4) return 0
  if (length < 9) return 1
  return 2
}

/**
 * What was typed, against what the card says.
 *
 * @returns {{verdict: string, matched: string}} the verdict, and which of the
 *   accepted answers it was judged against — so the card can show the one the
 *   reader was closest to rather than the whole cell.
 */
export function judge (typed, answer) {
  const attempt = String(typed || '').trim()
  const options = alternatives(answer)
  if (!attempt) return { verdict: WRONG, matched: options[0] || '' }

  let best = { verdict: WRONG, matched: options[0] || '' }

  for (const option of options) {
    // Accents and all: this is the only comparison that can return `exact`.
    if (plain(attempt) === plain(option)) return { verdict: EXACT, matched: option }

    const a = normalize(attempt)
    const b = normalize(option)
    if (!b) continue

    if (a === b) {
      // Same letters, different marks — the accent, and nothing else.
      best = { verdict: CLOSE, matched: option }
      continue
    }
    if (best.verdict === CLOSE) continue

    const allowed = tolerance(b.length)
    if (allowed && distance(a, b, allowed) <= allowed) {
      best = { verdict: CLOSE, matched: option }
    }
  }

  return best
}

/**
 * The grade a verdict earns.
 *
 * Deliberately not Easy: Easy means "this was instant and I want to see it much
 * less often", which is a judgement about the reader's own confidence that no
 * amount of correct typing can establish. It stays available as a button.
 */
export function gradeFor (verdict) {
  if (verdict === EXACT) return GOOD
  if (verdict === CLOSE) return HARD
  return AGAIN
}

/**
 * The two strings lined up, as runs marked same or different.
 *
 * Shown after a wrong or close answer, because being told "the answer was
 * καρότο" after typing `καροτο` invites you to read the two as identical —
 * which is exactly the mistake being corrected. Marking the run that differs
 * puts the eye on it.
 *
 * @returns {Array<{text: string, same: boolean}>} runs of the *answer*
 */
export function diff (typed, answer) {
  const a = String(typed || '')
  const b = String(answer || '')

  /* Compared letter for letter with the accents left on — the point of this is
     to show the mark that was missed, so the comparison that forgives it would
     mark nothing at all. Case and final sigma are still folded, because neither
     is what the reader is being shown. */
  const key = (char) => char.toLowerCase().replace(/ς/g, 'σ')
  let head = 0
  while (head < a.length && head < b.length && key(a[head]) === key(b[head])) head++
  let tail = 0
  while (
    tail < b.length - head &&
    tail < a.length - head &&
    key(a[a.length - 1 - tail]) === key(b[b.length - 1 - tail])
  ) tail++

  const runs = [
    { text: b.slice(0, head), same: true },
    { text: b.slice(head, b.length - tail), same: false },
    { text: b.slice(b.length - tail), same: true }
  ]
  return runs.filter((run) => run.text)
}
