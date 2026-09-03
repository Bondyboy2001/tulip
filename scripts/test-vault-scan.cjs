'use strict'

/* Tests for electron/vault-scan.js — the loop that runs over every indexed file
 * in the vault on every keystroke, and the filters it applies to each one.
 *
 * Two of these guard things nothing else can see going wrong.
 *
 * The scan yields to the event loop. It runs on the main process, which is also
 * what serves every autosave write and every watcher event, and before it
 * yielded a search of a large vault was a stall in all of them — felt as the
 * editor hesitating, which is the last place anybody would look for a search
 * bug. There is no assertion available for "the app felt smooth", so the test
 * is the mechanical one underneath it: work queued before the scan starts runs
 * while it is still going.
 *
 * And a scan that stopped early reports that it stopped. The caller must throw
 * the whole answer away — a partial list of matching keys handed to the
 * narrowing cache would make the next, longer query search a set with notes
 * missing from it, and answer confidently. That is the worst failure a search
 * can have, and it would look exactly like a correct answer.
 */

const assert = require('node:assert/strict')
const { scanKind, passesFilters } = require('../electron/vault-scan')
const { hitLines } = require('../electron/search-scan')

let passed = 0
let failed = 0
/* Collected rather than run, then awaited in order at the foot of the file.
   Every check here is async — the scan yields — so calling them as they are
   declared would leave the summary printing before any of them had finished,
   and a failing suite exiting 0. */
const checks = []
const check = (what, run) => { checks.push([what, run]) }

/* A compiled query, in the shape `compileQuery` hands over: a `has` test for
   presence and a `find` for the positions. Built here rather than imported
   because `compileQuery` lives in main.js, which cannot be required outside
   Electron — which is the whole reason this module was pulled out of it. */
const query = (words, filters = {}) => ({
  terms: words.map((word) => ({
    has: new RegExp(word, 'i'),
    find: new RegExp(word, 'gi')
  })),
  words,
  filters: { tag: [], path: [], file: [], prop: [], type: [], ...filters }
})

const note = (name, text, extra = {}) =>
  [`${name}.md`, { name, text, size: text.length, mtime: 1, ...extra }]

const vault = (n) => new Map(Array.from({ length: n }, (_, i) =>
  note(`Note ${i}`, `Some prose about tulips and gardens, number ${i}.\n`)))

const plain = {
  narrowed: false,
  kindOf: () => 'note',
  factsFor: () => ({ kind: 'note', fileTags: [] }),
  limit: 4 * 1024 * 1024
}

check('every note holding the word comes back, with where it is', async () => {
  const entries = new Map([
    note('One', '# Tulips\n\nA tulip is a flower.\n'),
    note('Two', 'No flowers here.\n'),
    note('Three', 'Another tulip, and a tulip again.\n')
  ])
  const found = await scanKind({ ...plain, entries, query: query(['tulip']) })
  assert.equal(found.stopped, false)
  assert.deepEqual(found.keys, ['One.md', 'Three.md'])
  assert.deepEqual(found.results.map((r) => r.total), [2, 2])
  assert.equal(found.results[0].hits[0].line, 1)
})

check('a term in the name and a term in a heading both count towards rank', async () => {
  /* All three say it once in the prose, so the only thing separating their
     scores is where *else* the term is. A note whose text does not hold the
     term is not a result at all, however its file is named — the presence test
     reads the text, and that is what the score is a ranking of. */
  const entries = new Map([
    note('Gardening', 'A page that says tulip once.\n'),
    note('Tulip notes', 'A page that says tulip once.\n'),
    note('Headed', '# On the tulip\n\nA page that says tulip once.\n')
  ])
  const found = await scanKind({ ...plain, entries, query: query(['tulip']), rankHeadings: true })
  const by = Object.fromEntries(found.results.map((r) => [r.name, r.score]))
  assert.ok(by['Tulip notes'] > by.Gardening, 'a name should outrank a mention')
  assert.ok(by.Headed > by.Gardening, 'a heading should outrank a mention')
})

check('a note whose name matches but whose text does not is not a result', async () => {
  const entries = new Map([note('Tulip notes', 'Nothing of the sort in here.\n')])
  const found = await scanKind({ ...plain, entries, query: query(['tulip']) })
  assert.deepEqual(found.results, [])
})

check('headings only count where headings mean something', async () => {
  const entries = new Map([note('Headed', '# On the tulip\n\ntulip\n')])
  const withRank = await scanKind({ ...plain, entries, query: query(['tulip']), rankHeadings: true })
  const without = await scanKind({ ...plain, entries, query: query(['tulip']) })
  assert.ok(withRank.results[0].score > without.results[0].score)
})

check('a file too large to hold is reported unread rather than skipped', async () => {
  const entries = new Map([
    note('Huge', 'tulip', { size: 99 * 1024 * 1024 }),
    note('Small', 'tulip')
  ])
  const found = await scanKind({ ...plain, entries, query: query(['tulip']) })
  assert.deepEqual(found.unsearched, ['Huge.md'])
  assert.deepEqual(found.results.map((r) => r.path), ['Small.md'])
  /* Still carried forward, so a narrower query can repeat the caveat rather
     than quietly dropping it. */
  assert.ok(found.keys.includes('Huge.md'))
})

check('a filter with no terms answers with the notes it names', async () => {
  const entries = new Map([note('One', 'anything'), note('Two', 'anything')])
  const found = await scanKind({
    ...plain,
    entries,
    query: query([], { file: ['one'] })
  })
  assert.deepEqual(found.results.map((r) => r.path), ['One.md'])
  assert.equal(found.results[0].total, 0)
})

check('a narrowed scan does not re-apply the filters', async () => {
  const entries = new Map([note('Two', 'tulip')])
  /* `file:one` would drop this note if the filters ran. Narrowed, they do not:
     the previous answer already applied them. */
  const found = await scanKind({
    ...plain, entries, narrowed: true, query: query(['tulip'], { file: ['one'] })
  })
  assert.deepEqual(found.results.map((r) => r.path), ['Two.md'])
})

check('a scan that is told to stop says so, and says it before finishing', async () => {
  const entries = vault(4000)
  let seen = 0
  const found = await scanKind({
    ...plain,
    entries,
    query: query(['tulips']),
    stop: () => ++seen > 3
  })
  assert.equal(found.stopped, true)
  assert.ok(found.results.length < 4000,
    'a stopped scan should not have seen the whole vault')
})

check('the event loop runs while the scan does', async () => {
  const entries = vault(60000)
  let ranDuring = false
  /* Queued before the scan starts. Without a yield in the loop this cannot run
     until the scan is over, because there is one thread and the scan is on it. */
  const timer = setTimeout(() => { ranDuring = true }, 0)
  await scanKind({ ...plain, entries, query: query(['tulips']) })
  clearTimeout(timer)
  assert.equal(ranDuring, true, 'the scan held the event loop to the end')
})

check('a scan of an empty vault is an empty answer, not a failure', async () => {
  const found = await scanKind({ ...plain, entries: new Map(), query: query(['tulip']) })
  assert.deepEqual(found, { keys: [], results: [], unsearched: [], stopped: false })
})

/* --------------------------------------------------------------- filters */

const entry = (text, name = 'Note') => ({ name, text, size: text.length })

check('a fence-language match carries code context without moving its line', async () => {
  const text = '# Example\n\n```rust\n// Fix the error returned here\nfn main() {}\n```\n'
  const at = text.indexOf('rust')
  assert.deepEqual(hitLines(text, [at], 1)[0], {
    line: 3,
    text: 'rust · // Fix the error returned here',
    col: 3,
    heading: false
  })
})

check('a tag is found in the head, in the prose, or assigned to the path', async () => {
  const filters = { tag: ['book'], path: [], file: [], prop: [], type: [] }
  assert.equal(passesFilters('a.md', entry('---\ntags: [book]\n---\nProse.\n'), filters,
    { kind: 'note', fileTags: [] }), true, 'the head')
  assert.equal(passesFilters('a.md', entry('Prose with #book in it.\n'), filters,
    { kind: 'note', fileTags: [] }), true, 'the prose')
  assert.equal(passesFilters('a.pdf', entry('Prose.\n'), filters,
    { kind: 'pdf', fileTags: ['book'] }), true, 'the sidecar')
  assert.equal(passesFilters('a.md', entry('Prose.\n'), filters,
    { kind: 'note', fileTags: [] }), false, 'nowhere')
})

check('a tag filter names a branch of the tag tree', async () => {
  const filters = { tag: ['book'], path: [], file: [], prop: [], type: [] }
  assert.equal(passesFilters('a.md', entry('---\ntags: [book/fiction]\n---\n'), filters,
    { kind: 'note', fileTags: [] }), true)
  assert.equal(passesFilters('a.md', entry('---\ntags: [bookshelf]\n---\n'), filters,
    { kind: 'note', fileTags: [] }), false)
})

check('a property is matched by name, and by value when one is asked', async () => {
  const has = { tag: [], path: [], file: [], prop: [{ key: 'status', value: null }], type: [] }
  const is = { tag: [], path: [], file: [], prop: [{ key: 'status', value: 'reading' }], type: [] }
  const note = entry('---\nstatus: [reading, review]\n---\nProse.\n')
  assert.equal(passesFilters('a.md', note, has, { kind: 'note' }), true)
  assert.equal(passesFilters('a.md', note, is, { kind: 'note' }), true)
  assert.equal(passesFilters('a.md', entry('---\nstatus: done\n---\n'), is, { kind: 'note' }), false)
})

check('path, file and type each drop what they are not about', async () => {
  const none = { tag: [], path: [], file: [], prop: [], type: [] }
  const it = entry('Prose.\n', 'Paper')
  assert.equal(passesFilters('work/Paper.md', it, { ...none, path: ['work'] }, { kind: 'note' }), true)
  assert.equal(passesFilters('play/Paper.md', it, { ...none, path: ['work'] }, { kind: 'note' }), false)
  assert.equal(passesFilters('work/Paper.md', it, { ...none, file: ['pap'] }, { kind: 'note' }), true)
  assert.equal(passesFilters('work/Paper.md', it, { ...none, file: ['zzz'] }, { kind: 'note' }), false)
  assert.equal(passesFilters('work/Paper.md', it, { ...none, type: ['pdf'] }, { kind: 'note' }), false)
})

;(async () => {
  for (const [what, run] of checks) {
    try { await run(); console.log(`ok - ${what}`); passed++ } catch (error) {
      console.log(`not ok - ${what}\n  ${error.message}`); failed++
    }
  }
  console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ''}`)
  if (failed) process.exit(1)
})()
