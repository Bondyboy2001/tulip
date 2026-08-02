/**
 * What the scheduler must do, whatever its weights are.
 *
 * The weights in src/srs.js are trained values copied from the published
 * defaults — there is no way to check them by reading, and a digit remembered
 * wrongly would look exactly like a digit remembered rightly. So what is
 * asserted here is the behaviour they have to produce. A weight slightly off
 * still passes; a sign error, a swapped pair, or a formula that has lost a term
 * does not, and those are the mistakes that would quietly mis-schedule
 * somebody's revision for months.
 *
 *   node scripts/test-srs.mjs
 */
import {
  AGAIN, HARD, GOOD, EASY, DAY, LEECH_AT,
  grade as gradeFuzzed, preview, isDue, isNew, isLeech, newCard, retrievability, humanDays
} from '../src/srs.js'

/* Every assertion below is about the schedule, not about the jitter laid over
   it, so the fuzz is pinned to its midpoint — which is exactly no change. The
   jitter has tests of its own at the end. */
const grade = (card, answer, now, retention) =>
  gradeFuzzed(card, answer, now, retention, () => 0.5)

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) return
  failures++
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

const T0 = 1_700_000_000_000            // a fixed epoch; nothing reads the clock
const days = (card, now = T0) => (card.due - now) / DAY

/* ---------------------------------------------------- a card's first sight */

const first = {}
for (const g of [AGAIN, HARD, GOOD, EASY]) first[g] = grade(null, g, T0)

check('new card: every grade schedules into the future',
  [AGAIN, HARD, GOOD, EASY].every((g) => first[g].due > T0))

check('new card: harder answers come back sooner',
  days(first[AGAIN]) <= days(first[HARD]) &&
  days(first[HARD]) <= days(first[GOOD]) &&
  days(first[GOOD]) <= days(first[EASY]),
  [AGAIN, HARD, GOOD, EASY].map((g) => `${g}:${days(first[g])}d`).join(' '))

check('new card: Again returns within a few days', days(first[AGAIN]) <= 3,
  `${days(first[AGAIN])}d`)
check('new card: Easy does not vanish for years', days(first[EASY]) <= 400,
  `${days(first[EASY])}d`)
check('new card: difficulty lands inside 1..10',
  [AGAIN, HARD, GOOD, EASY].every((g) => first[g].difficulty >= 1 && first[g].difficulty <= 10))
check('new card: Again is harder than Easy',
  first[AGAIN].difficulty > first[EASY].difficulty)

/* ------------------------------------------------------------ the long run */

/* Reviewed on time and answered Good every time, a card's interval has to keep
   growing. This is the property the whole idea rests on: if it ever stopped,
   the scheduler would be a fixed-interval drill wearing FSRS's clothes. */
let card = newCard()
let now = T0
const intervals = []
for (let i = 0; i < 12; i++) {
  card = grade(card, GOOD, now)
  const gap = (card.due - now) / DAY
  intervals.push(gap)
  now = card.due                        // answered exactly when it came due
}
check('repeated Good: intervals never shrink',
  intervals.every((gap, i) => i === 0 || gap >= intervals[i - 1]),
  intervals.map(Math.round).join(','))
check('repeated Good: intervals actually grow',
  intervals[intervals.length - 1] > intervals[0] * 5,
  intervals.map(Math.round).join(','))
check('repeated Good: nothing exceeds the ten-year cap',
  intervals.every((gap) => gap <= 3650))
check('repeated Good: reps counted', card.reps === 12, String(card.reps))
check('repeated Good: no lapses recorded', card.lapses === 0, String(card.lapses))

/* ------------------------------------------------------------------ lapses */

const mature = card                     // a well-established card
const lapsed = grade(mature, AGAIN, mature.due)
check('lapse: stability falls', lapsed.stability < mature.stability,
  `${mature.stability.toFixed(1)} -> ${lapsed.stability.toFixed(1)}`)
check('lapse: comes back soon', (lapsed.due - mature.due) / DAY <= 30,
  `${Math.round((lapsed.due - mature.due) / DAY)}d`)
check('lapse: counted', lapsed.lapses === mature.lapses + 1)
check('lapse: difficulty rises', lapsed.difficulty > mature.difficulty)
check('lapse: stability stays positive', lapsed.stability > 0)

/* ------------------------------------------------- overdue teaches more */

/* The same card, same answer, recalled after a long gap versus a short one. A
   review you were about to fail and passed is worth more than one you could
   not have failed — if this ever inverted, the scheduler would be punishing
   people for reviewing late. */
const base = grade(grade(newCard(), GOOD, T0), GOOD, T0 + 10 * DAY)
const onTime = grade(base, GOOD, base.due)
const late = grade(base, GOOD, base.due + 60 * DAY)
check('overdue: a late success gains more stability than a punctual one',
  late.stability > onTime.stability,
  `late ${late.stability.toFixed(1)} vs on-time ${onTime.stability.toFixed(1)}`)

/* --------------------------------------------------------- retrievability */

const fresh = grade(newCard(), GOOD, T0)
check('recall: certain immediately after review',
  retrievability(fresh, fresh.last) > 0.99)
check('recall: about 90% after one stability',
  Math.abs(retrievability(fresh, fresh.last + fresh.stability * DAY) - 0.9) < 0.02,
  String(retrievability(fresh, fresh.last + fresh.stability * DAY)))
check('recall: falls with time',
  retrievability(fresh, T0 + 400 * DAY) < retrievability(fresh, T0 + 40 * DAY))
check('recall: a new card is treated as forgotten', retrievability(newCard(), T0) === 0)

/* ------------------------------------------------------------ the queue */

check('due: a new card is due', isDue(newCard(), T0) && isNew(newCard()))
check('due: a just-graded card is not', !isDue(fresh, T0))
check('due: it is due again once its date passes', isDue(fresh, fresh.due + 1))

/* ---------------------------------------------------------- retention knob */

const strict = grade(newCard(), GOOD, T0, 0.95)
const loose = grade(newCard(), GOOD, T0, 0.80)
check('retention: asking for more recall shortens intervals',
  days(strict) < days(loose),
  `0.95 -> ${days(strict)}d, 0.80 -> ${days(loose)}d`)

/* ------------------------------------------------------------- the labels */

const shown = preview(newCard(), T0)
check('preview: one number per button',
  [AGAIN, HARD, GOOD, EASY].every((g) => Number.isFinite(shown[g])))
check('preview: agrees with grading', shown[GOOD] === Math.round(days(first[GOOD])))
check('humanDays: reads as days, months, then years',
  humanDays(1) === '1d' && humanDays(45) === '2mo' && humanDays(730) === '2.0y',
  `${humanDays(1)} ${humanDays(45)} ${humanDays(730)}`)

/* --------------------------------------------------- nothing absurd, ever */

/* Every reachable state, graded every way, must stay inside its bounds. This
   is the blanket the specific cases above sit under: whatever the weights are,
   no sequence of answers may produce a NaN, a negative interval, or a card
   scheduled past the cap. */
let absurd = null
let walk = newCard()
let at = T0
for (let i = 0; i < 400 && !absurd; i++) {
  const g = [AGAIN, HARD, GOOD, EASY][i % 4]
  walk = grade(walk, g, at)
  const gap = (walk.due - at) / DAY
  if (!Number.isFinite(walk.stability) || walk.stability <= 0) absurd = `stability ${walk.stability}`
  else if (!Number.isFinite(walk.difficulty) || walk.difficulty < 1 || walk.difficulty > 10) absurd = `difficulty ${walk.difficulty}`
  else if (!Number.isFinite(gap) || gap < 1 || gap > 3650) absurd = `interval ${gap}`
  // Sometimes on time, sometimes very late, sometimes early.
  at = walk.due + [0, 90 * DAY, -0.5 * DAY][i % 3]
}
check('400 mixed answers: nothing leaves its bounds', !absurd, absurd || '')

/* ------------------------------------------------------------- the jitter */

/* Thirty cards learned in one sitting must not stay in lockstep. Graded
   identically with real randomness, their due dates have to spread — and stay
   within a few percent of where the schedule put them. */
const together = []
for (let i = 0; i < 30; i++) {
  let c = newCard()
  let t = T0
  for (let r = 0; r < 5; r++) { c = gradeFuzzed(c, GOOD, t); t = c.due }
  together.push(c.due)
}
check('fuzz: cards learned together do not stay in lockstep',
  new Set(together).size > 1, `${new Set(together).size} distinct due dates`)

const exact = grade(grade(grade(newCard(), GOOD, T0), GOOD, T0 + 3 * DAY), GOOD, T0 + 20 * DAY)
const spread = []
for (let i = 0; i < 200; i++) {
  spread.push((gradeFuzzed(exact, GOOD, exact.due).due - exact.due) / DAY)
}
const middle = (grade(exact, GOOD, exact.due).due - exact.due) / DAY
check('fuzz: stays within ±6% of the scheduled interval',
  spread.every((d) => Math.abs(d - middle) <= middle * 0.06 + 1),
  `middle ${middle}d, range ${Math.min(...spread)}–${Math.max(...spread)}d`)
check('fuzz: never produces a non-positive interval', spread.every((d) => d >= 1))
check('fuzz: short intervals are left exact',
  new Set(Array.from({ length: 50 }, () => gradeFuzzed(newCard(), AGAIN, T0).due)).size === 1)

/* -------------------------------------------------------------- leeches */

let failing = newCard()
let when = T0
for (let i = 0; i < LEECH_AT; i++) { failing = grade(failing, AGAIN, when); when = failing.due }
check('leech: flagged once it has lapsed enough times', isLeech(failing),
  `${failing.lapses} lapses`)
check('leech: a card doing fine is not one', !isLeech(card))

console.log(failures ? `\n${failures} failed` : 'srs: all checks passed')
process.exit(failures ? 1 : 0)
