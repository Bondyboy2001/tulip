/* Tests for src/review-stats.js — the arithmetic behind the review panel.
 *
 * All of it is stated relative to a fixed `now`, because every figure here is
 * about days and a test that used the real clock would pass or fail depending
 * on the hour it ran at. `DAY` below is the same day the module means: a local
 * one, since a review at 23:50 belongs to the day the reader thinks it does.
 */

import assert from 'node:assert/strict'
import {
  summarize, streakEndingAt, splitCardId, startOfDay, MATURE_DAYS, LEECH_LAPSES
} from '../src/review-stats.js'

let passed = 0
let failed = 0
const check = (what, run) => {
  try { run(); console.log(`ok - ${what}`); passed++ } catch (error) {
    console.log(`not ok - ${what}\n  ${error.message}`); failed++
  }
}

const DAY = 24 * 60 * 60 * 1000
/* Mid-afternoon, so that "today" has room on both sides of it — a `now` at
   midnight would make several of these pass for the wrong reason. */
const NOW = new Date(2026, 7, 6, 15, 30).getTime()
const TODAY = startOfDay(NOW)

const card = (over = {}) =>
  ({ due: 0, stability: 0, difficulty: 5, reps: 0, lapses: 0, last: 0, ...over })

/* ------------------------------------------------------------- card ids */

check('an id splits into the note and the term', () => {
  const parts = splitCardId('Languages/Greek.language.md|φῶς|recognise')
  assert.equal(parts.path, 'Languages/Greek.language.md')
  assert.equal(parts.term, 'φῶς')
  assert.equal(parts.direction, 'recognise')
})

check('a term containing a bar survives the split', () => {
  assert.equal(splitCardId('a.md|to be | to become|produce').term, 'to be | to become')
})

check('something that is not an id is not guessed at', () => {
  assert.equal(splitCardId('nonsense'), null)
  assert.equal(splitCardId('one|two'), null)
})

/* --------------------------------------------------------------- counts */

check('an empty vault counts to nothing and says nothing about retention', () => {
  const stats = summarize({ now: NOW })
  assert.equal(stats.counts.total, 0)
  assert.equal(stats.due.now, 0)
  assert.equal(stats.answers.retention, null, 'no answers is not 0% recall')
  assert.equal(stats.streak, 0)
  assert.deepEqual(stats.leeches, [])
})

check('cards are unseen, learning or known by reps and stability', () => {
  const stats = summarize({
    now: NOW,
    cards: {
      'a.md|new|recognise': card(),
      'a.md|young|recognise': card({ reps: 3, stability: MATURE_DAYS - 1, due: NOW + DAY }),
      'a.md|known|recognise': card({ reps: 9, stability: MATURE_DAYS, due: NOW + 30 * DAY })
    }
  })
  assert.deepEqual(stats.counts, { total: 3, unseen: 1, young: 1, mature: 1 })
})

check('a card is due when its time has passed, and a new card never is', () => {
  const stats = summarize({
    now: NOW,
    cards: {
      'a.md|overdue|recognise': card({ reps: 2, stability: 4, due: NOW - 3 * DAY }),
      'a.md|later|recognise': card({ reps: 2, stability: 4, due: NOW + 3 * DAY }),
      // due: 0 is how a card that has never been answered is stored
      'a.md|unseen|recognise': card()
    }
  })
  assert.equal(stats.due.now, 1, 'the unseen card is waiting, but not on a schedule')
})

/* ------------------------------------------------------------- forecast */

check('the forecast puts each card on the day it comes back', () => {
  const stats = summarize({
    now: NOW,
    cards: {
      'a.md|one|recognise': card({ reps: 1, stability: 3, due: TODAY + 2 * DAY + 3600e3 }),
      'a.md|two|recognise': card({ reps: 1, stability: 3, due: TODAY + 2 * DAY + 7200e3 }),
      'a.md|three|recognise': card({ reps: 1, stability: 3, due: TODAY + 5 * DAY })
    }
  })
  assert.equal(stats.forecast[2].count, 2)
  assert.equal(stats.forecast[5].count, 1)
  assert.equal(stats.forecast[0].count, 0)
})

check('everything overdue is work for today, however overdue', () => {
  const stats = summarize({
    now: NOW,
    cards: {
      'a.md|yesterday|recognise': card({ reps: 1, stability: 2, due: NOW - DAY }),
      'a.md|last year|recognise': card({ reps: 1, stability: 2, due: NOW - 400 * DAY })
    }
  })
  assert.equal(stats.forecast[0].count, 2)
})

check('a card due beyond the horizon is in no column rather than the last one', () => {
  const stats = summarize({
    now: NOW,
    days: 14,
    cards: { 'a.md|far|recognise': card({ reps: 1, stability: 200, due: NOW + 300 * DAY }) }
  })
  assert.equal(stats.forecast.reduce((n, day) => n + day.count, 0), 0)
})

/* ------------------------------------------------------------ retention */

check('Hard counts as remembered and Again does not', () => {
  const stats = summarize({
    now: NOW,
    history: [
      { id: 'a', at: NOW - DAY, grade: 1 },
      { id: 'a', at: NOW - DAY, grade: 2 },
      { id: 'a', at: NOW - DAY, grade: 3 },
      { id: 'a', at: NOW - DAY, grade: 4 }
    ]
  })
  assert.equal(stats.answers.window, 4)
  assert.equal(stats.answers.retention, 0.75)
})

check('answers older than the window count in the total but not the rate', () => {
  const stats = summarize({
    now: NOW,
    window: 30,
    history: [
      { id: 'a', at: NOW - 200 * DAY, grade: 1 },
      { id: 'a', at: NOW - 2 * DAY, grade: 3 }
    ]
  })
  assert.equal(stats.answers.total, 2)
  assert.equal(stats.answers.window, 1)
  assert.equal(stats.answers.retention, 1)
  assert.equal(stats.answers.retentionAllTime, 0.5)
})

check('a log line with no timestamp is skipped rather than counted at the epoch', () => {
  const stats = summarize({ now: NOW, history: [{ id: 'a', grade: 3 }, null, { at: 0, grade: 3 }] })
  assert.equal(stats.answers.total, 0)
})

check('the daily strip has one bucket per day of the window, in order', () => {
  const stats = summarize({ now: NOW, window: 30, history: [{ id: 'a', at: NOW, grade: 3 }] })
  assert.equal(stats.daily.length, 30)
  assert.equal(stats.daily[29].at, TODAY, 'today is the last bucket')
  assert.equal(stats.daily[29].count, 1)
  assert.equal(stats.daily[29].recalled, 1)
  for (let at = 1; at < stats.daily.length; at++) {
    assert.equal(stats.daily[at].at - stats.daily[at - 1].at, DAY)
  }
})

/* --------------------------------------------------------------- streak */

check('a run of days ending today is the streak', () => {
  const days = new Set([TODAY, TODAY - DAY, TODAY - 2 * DAY])
  assert.equal(streakEndingAt(days, TODAY), 3)
})

check('a streak survives a day that is not over yet', () => {
  const days = new Set([TODAY - DAY, TODAY - 2 * DAY])
  assert.equal(streakEndingAt(days, TODAY), 2, 'morning is not a broken streak')
})

check('a gap ends the streak', () => {
  const days = new Set([TODAY - 2 * DAY, TODAY - 3 * DAY])
  assert.equal(streakEndingAt(days, TODAY), 0)
})

check('never having studied is a streak of nothing', () => {
  assert.equal(streakEndingAt(new Set(), TODAY), 0)
})

/* -------------------------------------------------------------- leeches */

check('a card is a leech once it has been failed enough times', () => {
  const stats = summarize({
    now: NOW,
    cards: {
      'a.md|fine|recognise': card({ reps: 20, lapses: LEECH_LAPSES - 1 }),
      'a.md|stuck|recognise': card({ reps: 20, lapses: LEECH_LAPSES })
    }
  })
  assert.equal(stats.leeches.length, 1)
  assert.equal(stats.leeches[0].term, 'stuck')
})

check('the three cards of one row are one entry, at the worst count', () => {
  const stats = summarize({
    now: NOW,
    cards: {
      'Greek.md|θάλασσα|f': card({ reps: 30, lapses: 9 }),
      'Greek.md|θάλασσα|r': card({ reps: 28, lapses: 7 }),
      'Greek.md|θάλασσα|d': card({ reps: 20, lapses: 6 })
    }
  })
  assert.equal(stats.leeches.length, 1, 'one row, not three cards')
  assert.equal(stats.leeches[0].lapses, 9, 'the worst direction, not the sum')
  assert.equal(stats.leeches[0].reps, 78, 'reviews do add up')
  assert.equal(stats.leeches[0].cards, 3)
})

check('the same term in two notes stays two entries', () => {
  const stats = summarize({
    now: NOW,
    cards: {
      'Greek.md|light|f': card({ reps: 10, lapses: 7 }),
      'Latin.md|light|f': card({ reps: 10, lapses: 8 })
    }
  })
  assert.deepEqual(stats.leeches.map((c) => c.path), ['Latin.md', 'Greek.md'])
})

check('leeches come back worst first, and name the note they are in', () => {
  const stats = summarize({
    now: NOW,
    cards: {
      'Greek.md|beta|recognise': card({ reps: 30, lapses: 7 }),
      'Greek.md|alpha|recognise': card({ reps: 30, lapses: 12 })
    }
  })
  assert.deepEqual(stats.leeches.map((c) => c.term), ['alpha', 'beta'])
  assert.equal(stats.leeches[0].path, 'Greek.md')
  assert.equal(stats.leeches[0].lapses, 12)
})

/* --------------------------------------------------------------- rubbish */

check('a state file full of junk does not take the panel down with it', () => {
  const stats = summarize({
    now: NOW,
    cards: { 'a.md|x|recognise': null, 'a.md|y|recognise': 'not a card', 'a.md|z|recognise': 7 },
    history: ['not a line', 42]
  })
  assert.equal(stats.counts.total, 3, 'they are still cards on the books')
  assert.equal(stats.counts.unseen, 0, 'but none of them says anything')
  assert.equal(stats.answers.total, 0)
})

console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ''}`)
if (failed) process.exit(1)
