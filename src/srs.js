/* ============================================================== scheduling
   When a card should come back.

   The old study surface shuffled the table and asked for every word in it,
   every time. That is a drill, not a review: it spends the same effort on the
   word you have known for a month as on the one you met this morning, and it
   forgets both the moment the overlay closes. What makes review worth doing is
   the opposite — seeing a word just as you are about to lose it, and not
   before.

   This is FSRS, the scheduler Anki adopted. Two numbers describe a card:

     stability   how many days until recall falls to 90%. This is the memory.
     difficulty  how stubborn this particular card is, 1–10. This is the card.

   and one function describes forgetting: recall decays as a power of elapsed
   time over stability. Grading a card updates both numbers from how well it
   went *and* from how likely you were to have remembered it at that moment —
   which is why a card recalled after a long gap gains far more than the same
   card recalled the next day. Nothing here reads the clock; the caller passes
   `now`, so a review can be replayed and a test can state its own dates.

   The weights below are the published defaults. They are trained values, not
   derived ones, so there is nothing to check them against by reading — what is
   checked instead is the behaviour they produce, which is what `scripts/
   test-srs.mjs` asserts: intervals stay positive and bounded, Again always
   shortens, Easy always lengthens, and repeated Good grows. A weight
   remembered slightly wrong would still satisfy those; a sign error would not,
   and that is the failure worth catching.
   ================================================================== */

/** Again, Hard, Good, Easy — the four answers, and the only grades used. */
export const AGAIN = 1
export const HARD = 2
export const GOOD = 3
export const EASY = 4

/* The forgetting curve's shape. `DECAY` is the exponent; `FACTOR` is what puts
   the curve through 90% recall at exactly one stability, which is what makes
   "stability" mean that and not merely correlate with it. */
const DECAY = -0.5
const FACTOR = 19 / 81

/* FSRS-4.5's default weights, in the order the formulas below use them:
   0–3   the stability a card starts at, one per grade
   4–5   the difficulty it starts at
   6–7   how difficulty moves, and how strongly it reverts toward the mean
   8–10  how much stability grows on a successful review
   11–14 what stability drops to after a lapse
   15–16 the penalty for Hard and the bonus for Easy */
const W = [
  0.4872, 1.4003, 3.7145, 13.8206,
  5.1618, 1.2298,
  0.8975, 0.0310,
  1.6474, 0.1367, 1.0461,
  2.1072, 0.0793, 0.3246, 1.5870,
  0.2272, 2.8755
]

/** A day, in milliseconds — the unit every interval here is counted in. */
export const DAY = 86400000

/* No card is ever scheduled less than a day out, because the queue is a daily
   one: a card due "in four hours" would simply reappear in the same session,
   which is drilling again. And none is scheduled past a decade, which is not a
   review but a deletion with extra steps. */
const MIN_DAYS = 1
const MAX_DAYS = 3650

const clamp = (value, low, high) => Math.min(Math.max(value, low), high)

/* Difficulty is defined on 1–10 and every formula that consumes it assumes so.
   Clamped at each step rather than only at the end: `11 - D` appears as a
   multiplier, and a difficulty that had drifted past 11 would flip its sign and
   make a correct answer *shrink* the interval. */
const clampDifficulty = (d) => clamp(d, 1, 10)

/* Stability is a number of days and must stay strictly positive: it appears as
   a denominator, and as the base of a negative power. */
const clampStability = (s) => clamp(s, 0.01, MAX_DAYS)

/**
 * A card nobody has seen yet.
 *
 * `due` is the epoch rather than null so that a new card sorts into the same
 * queue as everything else, ahead of anything actually scheduled.
 */
export function newCard () {
  return { due: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, last: 0 }
}

/** Whether a card has ever been graded. */
export const isNew = (card) => !card || !card.reps

/**
 * How likely the card is to be recalled right now: 1 immediately after a
 * review, falling to 0.9 after one stability has passed, and on down.
 *
 * A card never seen has no memory to decay, and is reported as certainly
 * forgotten — which is what makes its first grading use the initial formulas
 * rather than the update ones.
 */
export function retrievability (card, now) {
  if (isNew(card) || !card.last) return 0
  const days = Math.max(0, (now - card.last) / DAY)
  return Math.pow(1 + FACTOR * days / clampStability(card.stability), DECAY)
}

/* The interval that lands the card at `retention` recall — the inverse of the
   curve above, which is the whole point of tracking stability. */
function intervalFor (stability, retention) {
  const days = (clampStability(stability) / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1)
  return clamp(Math.round(days), MIN_DAYS, MAX_DAYS)
}

/** Where difficulty starts, from the first grade given. */
const initialDifficulty = (grade) => clampDifficulty(W[4] - Math.exp(W[5] * (grade - 1)) + 1)

/**
 * Difficulty after a grade.
 *
 * Two movements at once: the grade pushes it (Again up, Easy down), and the
 * result is pulled back toward where an Easy card would have started. That
 * second term is what stops a card that has been Hard three times running from
 * being marked impossible forever.
 */
function nextDifficulty (difficulty, grade) {
  const moved = difficulty - W[6] * (grade - 3)
  return clampDifficulty(W[7] * initialDifficulty(EASY) + (1 - W[7]) * moved)
}

/**
 * Stability after a card was recalled.
 *
 * The `(1 - r)` term is the one worth understanding: a card recalled when you
 * were *unlikely* to recall it teaches far more than one recalled the day after
 * you saw it, so the gain is largest exactly when the review was overdue.
 */
function stabilityOnRecall (stability, difficulty, r, grade) {
  const hard = grade === HARD ? W[15] : 1
  const easy = grade === EASY ? W[16] : 1
  const growth = Math.exp(W[8]) *
    (11 - difficulty) *
    Math.pow(clampStability(stability), -W[9]) *
    (Math.exp(W[10] * (1 - r)) - 1) *
    hard * easy
  return clampStability(stability * (1 + growth))
}

/** Stability after a lapse — a fraction of what it was, never zero. */
function stabilityOnLapse (stability, difficulty, r) {
  const next = W[11] *
    Math.pow(difficulty, -W[12]) *
    (Math.pow(clampStability(stability) + 1, W[13]) - 1) *
    Math.exp(W[14] * (1 - r))
  /* Never *more* than it was: a lapse is by definition a step backwards, and
     the formula above can exceed the old stability for a card that was barely
     established. */
  return clampStability(Math.min(next, stability || next))
}

/**
 * How many lapses before a card is set aside.
 *
 * A card that has been forgotten eight times is not being learned, and the
 * schedule cannot fix that — it will keep coming back, keep being missed, and
 * keep taking the place of cards that would have stuck. What it needs is for
 * the *card* to change: a better example sentence, a mnemonic, splitting one
 * overloaded word into two. So it is suspended and said so, which is the only
 * thing a scheduler can usefully do about a card that is wrong.
 */
export const LEECH_AT = 8

/** Whether a card has failed so often it should be looked at rather than drilled. */
export const isLeech = (card) => (card?.lapses || 0) >= LEECH_AT

/**
 * Scatter an interval by up to ±5%.
 *
 * Without it, cards learned together stay together forever: add thirty words
 * in one sitting and every one of them is due on the same day, every time,
 * compounding into a calendar of empty days and impossible ones. The jitter is
 * far too small to affect recall and is enough to break the lockstep within a
 * few reviews.
 *
 * `random` is passed in rather than reached for, so a test can state its own
 * and get the same answer twice — the same reason nothing here reads the clock.
 */
function fuzzed (days, random) {
  // Below a week there is nothing to scatter: ±5% of three days rounds back to
  // three days, and the shortest intervals want to be exact anyway.
  if (days < 7) return days
  const spread = days * 0.05
  return clamp(Math.round(days + (random() * 2 - 1) * spread), MIN_DAYS, MAX_DAYS)
}

/**
 * Grade a card and say when it comes back.
 *
 * @param {{ due?: number, stability?: number, difficulty?: number, reps?: number, lapses?: number, last?: number } | null} card    the card's state, or null/new for a first sight
 * @param {number} answer       AGAIN | HARD | GOOD | EASY
 * @param {number} now          epoch milliseconds; the caller owns the clock
 * @param {number} [retention]  the recall probability to aim at, 0.7–0.99
 * @param {() => number} [random]  0–1, for the interval fuzz; injected so a
 *   test can be deterministic
 * @returns {{ due: number, stability: number, difficulty: number, reps: number, lapses: number, last: number }} the card's new state, with `due` set
 */
export function grade (card, answer, now, retention = 0.9, random = Math.random) {
  const g = clamp(Math.round(answer), AGAIN, EASY)
  const wanted = clamp(retention, 0.7, 0.99)
  const previous = card && !isNew(card) ? card : null

  let stability
  let difficulty

  if (!previous) {
    // Never seen: both numbers come from the grade alone.
    stability = clampStability(W[g - 1])
    difficulty = initialDifficulty(g)
  } else {
    const r = retrievability(previous, now)
    difficulty = nextDifficulty(previous.difficulty, g)
    stability = g === AGAIN
      ? stabilityOnLapse(previous.stability, difficulty, r)
      : stabilityOnRecall(previous.stability, difficulty, r, g)
  }

  const days = fuzzed(intervalFor(stability, wanted), random)
  return {
    due: now + days * DAY,
    stability,
    difficulty,
    reps: (previous?.reps || 0) + 1,
    lapses: (previous?.lapses || 0) + (g === AGAIN ? 1 : 0),
    last: now
  }
}

/**
 * What each button will do, for the labels on them.
 *
 * Shown rather than described: "Good — 12d" is the single most useful thing a
 * review UI can say, because it turns an abstract judgement into a choice with
 * a visible consequence. Costs four evaluations of a closed-form function.
 */
export function preview (card, now, retention = 0.9) {
  const out = {}
  for (const g of [AGAIN, HARD, GOOD, EASY]) {
    /* Unfuzzed — the label has to say what the button does, and a number that
       moved by a day each time it was drawn would read as a bug. The fuzz is
       applied when the answer is actually given. */
    out[g] = Math.round((grade(card, g, now, retention, () => 0.5).due - now) / DAY)
  }
  return out
}

/** How an interval reads on a button: days, then months, then years. */
export function humanDays (days) {
  if (days < 1) return 'today'
  if (days < 30) return `${Math.round(days)}d`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return `${(days / 365).toFixed(days < 3650 ? 1 : 0)}y`
}

/** Whether a card wants reviewing at `now`. A new card always does. */
export const isDue = (card, now) => isNew(card) || (card?.due || 0) <= now
