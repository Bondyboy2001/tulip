/**
 * What typed grading must and must not forgive.
 *
 * The whole value of typing the answer is that it cannot be fudged — so the
 * two failures worth catching here are opposite ones. Too strict and a missing
 * accent fails a word you knew, which teaches you to stop typing accents.
 * Too loose and a different word passes, which is the flip card back again
 * with extra steps.
 *
 *   node scripts/test-study-match.mjs
 */
import {
  EXACT, CLOSE, WRONG,
  plain, normalize, alternatives, distance, judge, gradeFor, diff
} from '../src/study-match.js'
import { AGAIN, HARD, GOOD } from '../src/srs.js'

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) return
  failures++
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

const verdict = (typed, answer) => judge(typed, answer).verdict

/* ------------------------------------------------------------ reduction */

check('plain: keeps the accent', plain('καρότο') === 'καρότο', plain('καρότο'))
check('plain: folds final sigma', plain('φως') === plain('φωσ'))
check('plain: drops case and punctuation', plain('Carrot!') === 'carrot')
check('plain: drops a leading article', plain('the carrot') === 'carrot')
check('plain: drops an infinitive marker', plain('to be') === 'be')
check('normalize: takes the accent off', normalize('καρότο') === 'καροτο',
  normalize('καρότο'))
check('normalize: leaves the letters alone', normalize('καροτο') === 'καροτο')
check('normalize: is idempotent', normalize(normalize('ρωσικά')) === normalize('ρωσικά'))

/* --------------------------------------------------------- alternatives */

check('alternatives: splits the slash form',
  JSON.stringify(alternatives('is / is he /she is')) ===
  JSON.stringify(['is', 'is he', 'she is']))
check('alternatives: splits commas', alternatives('mark, sign').length === 2)
check('alternatives: offers a word with and without its note',
  alternatives('καρότο (n.)').includes('καρότο'))
check('alternatives: a plain cell is one answer',
  JSON.stringify(alternatives('carrot')) === JSON.stringify(['carrot']))
check('alternatives: an empty cell offers nothing',
  alternatives('   ').length === 0)

/* ------------------------------------------------------------- distance */

check('distance: identical is zero', distance('abc', 'abc') === 0)
check('distance: one substitution', distance('abc', 'abd') === 1)
check('distance: one insertion', distance('abc', 'abcd') === 1)
check('distance: gives up past the limit', distance('abcdef', 'zzzzzz', 2) > 2)
check('distance: length gap alone can exceed the limit',
  distance('a', 'abcdefgh', 2) > 2)

/* -------------------------------------------------------------- verdicts */

check('exact: the word itself', verdict('καρότο', 'καρότο') === EXACT)
check('exact: case is not a mistake', verdict('Carrot', 'carrot') === EXACT)
check('exact: an article the table wrote and you did not',
  verdict('carrot', 'the carrot') === EXACT)
check('exact: any one of the synonyms', verdict('she is', 'is / is he /she is') === EXACT)
check('exact: trailing space', verdict('  carrot ', 'carrot') === EXACT)

check('close: the accent missing', verdict('καροτο', 'καρότο') === CLOSE)
check('close: the accent on the wrong letter', verdict('κάροτο', 'καρότο') === CLOSE)
check('close: one letter wrong in a long word',
  verdict('ενδιαφερομαι', 'ενδιαφέρομαl') === CLOSE)
check('close: a single typo in an English gloss', verdict('carrott', 'carrot') === CLOSE)

check('wrong: a different word entirely', verdict('ρύζι', 'καρότο') === WRONG)
check('wrong: nothing typed', verdict('', 'καρότο') === WRONG)
check('wrong: a short word with a letter changed', verdict('και', 'ναι') === WRONG)
check('wrong: the English when the Greek was asked for',
  verdict('carrot', 'καρότο') === WRONG)
check('wrong: a prefix of the answer', verdict('καρ', 'καρότο') === WRONG)

/* A whole sentence is long enough that two characters of latitude must still
   not let a different sentence through. */
check('wrong: a sentence with a word swapped',
  verdict('το ρύζι είναι', 'το καρότο είναι') === WRONG)
check('exact: the sentence typed correctly',
  verdict('το καρότο είναι', 'το καρότο είναι') === EXACT)

/* ---------------------------------------------------------- what it earns */

check('grade: exact is Good, not Easy', gradeFor(EXACT) === GOOD)
check('grade: close is Hard', gradeFor(CLOSE) === HARD)
check('grade: wrong is Again', gradeFor(WRONG) === AGAIN)

check('judge: says which synonym it matched',
  judge('she is', 'is / is he /she is').matched === 'she is')
check('judge: an unmatched attempt still names an answer to show',
  judge('zzz', 'is / is he').matched === 'is')

/* -------------------------------------------------------------- the diff */

const marked = diff('καροτο', 'καρότο')
check('diff: covers the answer exactly', marked.map((r) => r.text).join('') === 'καρότο')
check('diff: marks the letter that differs',
  marked.some((run) => !run.same && run.text.includes('ό')),
  JSON.stringify(marked))
check('diff: a right answer has nothing marked',
  diff('καρότο', 'καρότο').every((run) => run.same))
check('diff: a wholly wrong answer marks the whole word',
  diff('zzz', 'ρύζι').filter((run) => !run.same).map((r) => r.text).join('') === 'ρύζι')

console.log(failures ? `\n${failures} failed` : 'study-match: all checks passed')
process.exit(failures ? 1 : 0)
