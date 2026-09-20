'use strict'

/* ------------------------------------------------------------ review queue

   Which cards a session offers, and in what order. Lives apart from
   language-table.js — whose cards are rows of a table — because the flashcard
   bank studies with the same rules: due cards first by how overdue they are,
   new cards only as many as the day allows, a leech never.

   A standalone flashcard carries the recognise kind, so the dependency gate
   that stages a table's four cards per word passes it unconditionally. */

import { isDue, isNew, isLeech } from './srs.js'

/* The card that asks a word be recognised rather than produced — the one the
   others wait on, and the kind a standalone flashcard is. `f` rather than a
   word, because the kind sits inside every card id and id changes are state
   changes. */
export const RECOGNISE = 'f'

/* How stable a word's recognition has to be before it is asked for in earnest.
   A week: long enough that the word is genuinely held rather than just seen
   this morning, short enough that production is not put off until the word has
   already been half-forgotten from never being produced. */
export const UNLOCK_STABILITY = 7

/**
 * Whether a card is available to the reader yet.
 *
 * Recognition always is. The other three wait until that word's recognition
 * card is holding — because a word you cannot yet read is not a word you can be
 * asked to spell, and a queue that asks anyway spends its whole budget on
 * failures. Once a card has been answered even once it stays unlocked: the
 * gate is for reaching the stage, not for staying in it, and a bad week at
 * recognition must not silently withdraw production.
 */
export function unlocked (card, states) {
  if (card.kind === RECOGNISE) return true
  if (states[card.id]?.reps) return true
  const seed = states[`${card.path}|${card.term}|${RECOGNISE}`]
  return !!seed?.reps && (seed.stability || 0) >= UNLOCK_STABILITY
}

function shuffled (cards) {
  const next = cards.map((card) => ({ ...card }))
  for (let at = next.length - 1; at > 0; at--) {
    const swap = Math.floor(Math.random() * (at + 1))
    ;[next[at], next[swap]] = [next[swap], next[at]]
  }
  return next
}

/* How many cards never seen before to introduce in one day. Without a cap, a
   table of four hundred words is four hundred first sights in one sitting, and
   every one of them comes back tomorrow — the classic way to abandon a deck in
   week two.

   Eight rather than the twenty this used to be, because this deck is not the
   only place new words are arriving from: a lesson elsewhere is already
   introducing its own, and a review layer that adds twenty a day on top of that
   is two firehoses. Somebody studying only here can raise it in settings. */
export const NEW_PER_DAY = 8

/** The end of today, so "due" means "due by tonight" and a card is not withheld
 *  because it is scheduled for this evening. */
function endOfToday (now) {
  const date = new Date(now)
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

/**
 * The queue for a session: everything overdue and unlocked, then as many new
 * words as the day's budget allows.
 *
 * Due cards come first and in order of how overdue they are, because those are
 * the ones actually about to be forgotten. New cards are shuffled in at the end
 * rather than the front: meeting eight new words before reviewing is how a
 * session becomes too long to finish.
 *
 * Interleaved by word rather than grouped: two cards of the same word back to
 * back means the second is answered from the first rather than from memory,
 * which is the one way a four-card row can be worth less than a one-card row.
 */
export function buildQueue (cards, states, now, { newPerDay = NEW_PER_DAY } = {}) {
  const cutoff = endOfToday(now)
  const due = []
  const fresh = []

  for (const card of cards) {
    const state = states[card.id]
    if (isLeech(state)) continue          // set aside, not drilled — see srs.js
    if (!unlocked(card, states)) continue
    /* Asked of the scheduler rather than worked out here. Both questions were
       spelled out again in this loop, which is two more places for "what counts
       as due" to drift away from what the scheduler thinks it means. */
    if (isNew(state)) fresh.push(card)
    else if (isDue(state, cutoff)) due.push({ card, due: state.due || 0 })
  }

  due.sort((a, b) => a.due - b.due)
  return spaced([
    ...due.map((entry) => entry.card),
    ...shuffled(fresh).slice(0, newPerDay)
  ])
}

/**
 * The same cards, with two of one word never adjacent.
 *
 * A stable sort by "how many of this word have already been placed" does it:
 * every word's first card comes before any word's second. The order within a
 * pass is the one the caller established, so overdue-first survives.
 */
function spaced (queue) {
  const seen = new Map()
  return queue
    .map((card, at) => {
      const pass = seen.get(card.term) || 0
      seen.set(card.term, pass + 1)
      return { card, pass, at }
    })
    .sort((a, b) => a.pass - b.pass || a.at - b.at)
    .map((entry) => entry.card)
}

/**
 * How much is waiting, without opening anything.
 *
 * What the badge in the sidebar reads. Counted the same way the queue is built,
 * because a badge saying twelve over a session that offers nine is a badge
 * nobody trusts twice.
 */
export function dueCount (cards, states, now, options = {}) {
  return buildQueue(cards, states, now, options).length
}
