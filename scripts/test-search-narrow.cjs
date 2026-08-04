'use strict'

/* Tests for the predicate the incremental search rests on.
 *
 * The failure this guards against is silent: a wrong `true` does not throw, it
 * hands the reader a shorter list that still looks like an answer. So the
 * cases below are weighted towards the ones that must come back false. */

const { narrowsFrom } = require('../electron/search-narrow')

let failures = 0
const check = (name, got, want) => {
  if (got === want) { console.log(`  ok   ${name}`); return }
  failures++
  console.log(`  FAIL ${name} — expected ${want}, got ${got}`)
}

const NO_FILTERS = { tag: [], path: [], file: [], prop: [] }
const PLAIN = { regex: false, word: false, caseSensitive: false }

/** A previous answer, with everything not under test held at its default. */
const answer = (over = {}) => ({
  generation: 1,
  words: ['phys'],
  filters: NO_FILTERS,
  opts: PLAIN,
  keys: ['a.md'],
  ...over
})

const query = (words, filters = NO_FILTERS) => ({ words, filters })

const can = (previous, next, opts = PLAIN, generation = 1) =>
  narrowsFrom(previous, next, opts, generation)

console.log('narrowing')

// --- the case the whole thing exists for -------------------------------
check('a word being typed narrows', can(answer(), query(['physi'])), true)
check('same query narrows (a redraw is not a rescan)', can(answer(), query(['phys'])), true)
check('an added word narrows', can(answer(), query(['phys', 'optics'])), true)
check('a word grown at the front narrows', can(answer(), query(['astrophys'])), true)
check('no previous answer cannot narrow', can(null, query(['phys'])), false)

// --- the cases that must not narrow ------------------------------------
check('deleting a character widens', can(answer(), query(['phy'])), false)
check('an unrelated word widens', can(answer(), query(['optics'])), false)
check('dropping one of two words widens',
  can(answer({ words: ['phys', 'optics'] }), query(['phys'])), false)
check('an emptied query widens', can(answer(), query([])), false)

// --- the index moving underneath ---------------------------------------
check('an edited vault invalidates the answer',
  can(answer({ generation: 1 }), query(['physi']), PLAIN, 2), false)

// --- the search switches -----------------------------------------------
const REGEX = { ...PLAIN, regex: true }
const WORD = { ...PLAIN, word: true }
const CASE = { ...PLAIN, caseSensitive: true }

check('regex mode never narrows',
  can(answer({ opts: REGEX }), query(['phys.']), REGEX), false)
check('whole-word mode never narrows',
  can(answer({ opts: WORD }), query(['physi']), WORD), false)
check('turning regex on invalidates the answer',
  can(answer(), query(['physi']), REGEX), false)
check('turning regex off invalidates the answer',
  can(answer({ opts: REGEX }), query(['physi']), PLAIN), false)
check('turning case-sensitivity on invalidates the answer',
  can(answer(), query(['physi']), CASE), false)

// --- case folding -------------------------------------------------------
check('case-insensitive narrowing ignores case',
  can(answer({ words: ['PHYS'] }), query(['physics'])), true)
check('case-sensitive narrowing respects case',
  can(answer({ words: ['PHYS'], opts: CASE }), query(['physics']), CASE), false)
check('case-sensitive narrowing holds when case agrees',
  can(answer({ words: ['PHYS'], opts: CASE }), query(['PHYSICS']), CASE), true)

// --- filters ------------------------------------------------------------
const tagged = (...tags) => ({ ...NO_FILTERS, tag: tags })
const pathed = (...paths) => ({ ...NO_FILTERS, path: paths })
const propped = (...prop) => ({ ...NO_FILTERS, prop })

check('the same filter narrows',
  can(answer({ filters: tagged('book') }), query(['physi'], tagged('book'))), true)
check('a filter added since invalidates the answer',
  can(answer(), query(['physi'], tagged('book'))), false)
check('a filter dropped since invalidates the answer',
  can(answer({ filters: tagged('book') }), query(['physi'])), false)
check('a changed filter invalidates the answer',
  can(answer({ filters: tagged('book') }), query(['physi'], tagged('paper'))), false)
check('a second filter of the same kind invalidates the answer',
  can(answer({ filters: tagged('book') }), query(['physi'], tagged('book', 'read'))), false)
check('filters of different kinds are not confused',
  can(answer({ filters: tagged('book') }), query(['physi'], pathed('book'))), false)
check('the same property filter narrows',
  can(answer({ filters: propped({ key: 'status', value: 'read' }) }),
    query(['physi'], propped({ key: 'status', value: 'read' }))), true)
check('a property filter with a changed value invalidates the answer',
  can(answer({ filters: propped({ key: 'status', value: 'read' }) }),
    query(['physi'], propped({ key: 'status', value: 'unread' }))), false)
check('a bare property filter is not one with a value',
  can(answer({ filters: propped({ key: 'status', value: null }) }),
    query(['physi'], propped({ key: 'status', value: 'read' }))), false)

// --- a filter-only query is a legitimate starting point -----------------
check('adding words to a filter-only query narrows',
  can(answer({ words: [], filters: tagged('book') }), query(['phys'], tagged('book'))), true)

console.log(failures ? `\nsearch narrowing: ${failures} FAILED` : '\nsearch narrowing: all checks passed')
process.exit(failures ? 1 : 0)
