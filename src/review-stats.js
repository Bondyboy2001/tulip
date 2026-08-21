/* ========================================================== review statistics
   What the review log adds up to.

   Two files have been accumulating in every vault that studies anything:
   `.tulip/review.json`, the current state of each card, and `.tulip/reviews.jsonl`,
   one line per answer ever given. Both were being written faithfully. Neither
   was ever read back for anything a reader could see — `review:history` and
   `review:prune` were plumbed the whole way from the store through main and the
   preload bridge, and had no callers at all. So the app knew, and could not say,
   how much was known, whether recall was improving, what was coming tomorrow,
   or which handful of words had been failed twenty times each.

   This module is the arithmetic, and only the arithmetic: no DOM, no IPC, no
   clock of its own — `now` is a parameter so a test can stand anywhere in time.
   The panel that draws it is review-panel.js.

   On the two inputs, which describe different things and disagree on purpose:

     cards    where each card *is*: its stability, when it is next due. The
              present tense, rewritten in place, with no memory of yesterday.
     history  what *happened*: a line per answer, appended and never rewritten.
              The past tense, and the only place a trend can come from.

   So "how many mature cards" comes from the first and "is recall improving"
   from the second, and neither can answer the other's question.
*/

/* A card whose memory has grown past three weeks is one you know rather than
   one you are learning. The number is Anki's and is a convention, not a
   discovery — it is a place to draw a line on a curve that has none. */
export const MATURE_DAYS = 21

/* Failed this many times and still coming back: not a card you are failing to
   learn but a card that is wrong — a term with a typo in it, two meanings
   crammed into one row, a translation that is not quite either word. The fix
   is nearly always to edit the note, which is why these are listed by name. */
export const LEECH_LAPSES = 6

const DAY = 24 * 60 * 60 * 1000

/** Midnight local time on the day `at` falls in. Days are the unit a reader
 *  thinks in, and they are local ones — a review at 23:50 belongs to today. */
export function startOfDay (at) {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Split a card id back into the note and term it names.
 *
 * The same rule as the store's own `splitId` (electron/review-store.js): first
 * bar and last bar, so a term containing a bar survives the round trip. Kept
 * as its own copy rather than shared, because the two live on opposite sides
 * of the IPC bridge — but if one changes the other must, and this comment is
 * the only thing that will say so.
 */
export function splitCardId (id) {
  const text = String(id)
  const first = text.indexOf('|')
  const last = text.lastIndexOf('|')
  if (first < 0 || last <= first) return null
  return {
    path: text.slice(0, first),
    term: text.slice(first + 1, last),
    direction: text.slice(last + 1)
  }
}

/**
 * Everything the panel shows, from the two things the store keeps.
 *
 * @param cards    `{ id: state }` — review.all()
 * @param history  the answer log, oldest first — review.history()
 * @param now      the moment to reckon from
 * @param days     how far ahead the forecast reaches
 * @param window   how far back the trend and retention figures look
 */
export function summarize ({ cards = {}, history = [], now = Date.now(), days = 14, window = 30 } = {}) {
  const entries = Object.entries(cards || {})
  const today = startOfDay(now)

  /* ---- where the collection is, from the state file ---- */

  const counts = { total: entries.length, unseen: 0, young: 0, mature: 0 }
  let dueNow = 0
  let dueToday = 0
  const forecast = Array.from({ length: days }, (_, day) => ({
    at: today + day * DAY,
    count: 0
  }))

  for (const [, state] of entries) {
    if (!state || typeof state !== 'object') continue
    const reps = Number(state.reps) || 0
    const stability = Number(state.stability) || 0
    const due = Number(state.due) || 0

    if (!reps) counts.unseen++
    else if (stability < MATURE_DAYS) counts.young++
    else counts.mature++

    /* A new card is due in the sense that it is waiting, but it is not waiting
       *because of a schedule* — counting it as due would make "3 due" mean two
       different things depending on how much of the deck had been started. */
    if (!reps) continue

    if (due <= now) dueNow++
    if (due <= today + DAY) dueToday++

    const day = Math.floor((startOfDay(due) - today) / DAY)
    /* Everything already overdue is work for today, because it is: the
       forecast answers "what is in front of me", not "what did I fall behind
       on and when". */
    if (day < 0) forecast[0].count++
    else if (day < days) forecast[day].count++
  }

  /* ---- what has happened, from the log ---- */

  const since = today - (window - 1) * DAY
  const daily = new Map()
  for (let day = 0; day < window; day++) {
    daily.set(since + day * DAY, { at: since + day * DAY, count: 0, recalled: 0 })
  }

  let answered = 0
  let recalled = 0
  let answeredAllTime = 0
  let recalledAllTime = 0
  const activeDays = new Set()

  for (const line of history || []) {
    const at = Number(line?.at) || 0
    if (!at) continue
    /* Grade 1 is Again and everything above it is a card that came back. The
       three shades of success are a scheduling distinction, not a memory one:
       for "did you remember it", Hard is a yes. */
    const remembered = (Number(line.grade) || 0) > 1

    answeredAllTime++
    if (remembered) recalledAllTime++
    activeDays.add(startOfDay(at))

    const day = startOfDay(at)
    const bucket = daily.get(day)
    if (!bucket) continue
    bucket.count++
    if (remembered) bucket.recalled++
    answered++
    if (remembered) recalled++
  }

  /* ---- the cards that are not working ---- */

  /* By row, not by card. One row of a vocabulary table becomes up to three
     cards — recognise it, produce it, hear it — and a word that is genuinely
     hard is usually hard in all three, so listing cards put the same term on
     screen three times over. The reader is being pointed at a row to edit, and
     there is one of those.

     The count shown is the worst direction's, not the sum: "failed nine times"
     is a fact about remembering this word, and adding the three together would
     say twenty-seven and mean nothing. */
  const rows = new Map()
  for (const [id, state] of entries) {
    const lapses = Number(state?.lapses) || 0
    if (lapses < LEECH_LAPSES) continue
    const parts = splitCardId(id) || { path: '', term: id, direction: '' }
    const key = `${parts.path}|${parts.term}`
    const seen = rows.get(key)
    if (!seen) {
      rows.set(key, { path: parts.path, term: parts.term, lapses, reps: Number(state?.reps) || 0, cards: 1 })
      continue
    }
    seen.lapses = Math.max(seen.lapses, lapses)
    seen.reps += Number(state?.reps) || 0
    seen.cards++
  }
  const leeches = [...rows.values()]
    .sort((a, b) => b.lapses - a.lapses || a.term.localeCompare(b.term))

  return {
    counts,
    due: { now: dueNow, today: dueToday },
    forecast,
    daily: [...daily.values()],
    answers: {
      window: answered,
      total: answeredAllTime,
      /* null rather than 0 for "nothing to divide by": a vault that has never
         been studied has no retention rate, and showing it 0% would read as
         "you remember nothing" rather than "there is nothing to say yet". */
      retention: answered ? recalled / answered : null,
      retentionAllTime: answeredAllTime ? recalledAllTime / answeredAllTime : null
    },
    streak: streakEndingAt(activeDays, today),
    leeches
  }
}

/**
 * Consecutive days ending today, or ending yesterday.
 *
 * Yesterday counts so that a streak is not reported as broken for the whole of
 * a day it has not yet had a chance to be continued in — opening the app in
 * the morning should not say the run of thirty days ended.
 */
export function streakEndingAt (activeDays, today) {
  const start = activeDays.has(today) ? today : today - DAY
  if (!activeDays.has(start)) return 0
  let run = 0
  for (let day = start; activeDays.has(day); day -= DAY) run++
  return run
}
