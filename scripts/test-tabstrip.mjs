/* Tests for src/tabstrip.js — the order of the tab strip, and which tabs a
 * bulk close takes with it.
 *
 * Written against the invariant the module exists to hold up: pinned tabs lead
 * the strip, and a close sweep never touches one. Both halves are stated here
 * for every gesture, because the failure mode is a strip that still looks
 * right — the count of tabs is plausible either way, and the note that went is
 * only missed later.
 */

import assert from 'node:assert/strict'
import { pinCount, settled, repin, othersOf, rightOf } from '../src/tabstrip.js'

let passed = 0
let failed = 0
const check = (what, run) => {
  try { run(); console.log(`ok - ${what}`); passed++ } catch (error) {
    console.log(`not ok - ${what}\n  ${error.message}`); failed++
  }
}

/** A strip written as a string: capitals are pinned, lower case are not. */
const strip = (spec) => [...spec].map((c) => ({
  path: `${c.toLowerCase()}.md`,
  pinned: c === c.toUpperCase()
}))

/** The same notation back, so a failure reads as the strip it produced. */
const spell = (tabs) =>
  tabs.map((t) => t.pinned ? t.path[0].toUpperCase() : t.path[0]).join('')

/* ----------------------------------------------------------------- order */

check('the pinned tabs are counted, and that is where the rest begin', () => {
  assert.equal(pinCount(strip('ABc')), 2)
  assert.equal(pinCount(strip('abc')), 0)
  assert.equal(pinCount(strip('')), 0)
})

check('a drag that crossed the boundary is put back', () => {
  assert.equal(spell(settled(strip('aBc'))), 'Bac')
})

check('a drag inside one group is left exactly as the reader left it', () => {
  assert.equal(spell(settled(strip('BAdc'))), 'BAdc')
})

/* ------------------------------------------------------------- pin, unpin */

check('a newly pinned tab joins the end of the pinned block', () => {
  const { tabs, index } = repin(strip('ABcd'), 3, true)
  assert.equal(spell(tabs), 'ABDc')
  assert.equal(index, 2)
  assert.equal(tabs[index].path, 'd.md', 'and the index still names it')
})

check('pinning the tab already next in line does not move it', () => {
  const { tabs, index } = repin(strip('Abc'), 1, true)
  assert.equal(spell(tabs), 'ABc')
  assert.equal(index, 1)
})

check('an unpinned tab lands at the front of the unpinned block', () => {
  /* Counted after the tab is lifted out: with it still in place the pin count
     is one too high and it lands a slot to the right of where it belongs. */
  const { tabs, index } = repin(strip('ABcd'), 0, false)
  assert.equal(spell(tabs), 'Bacd')
  assert.equal(index, 1)
  assert.equal(tabs[index].path, 'a.md')
})

check('unpinning the only pinned tab puts it at the front of the strip', () => {
  const { tabs, index } = repin(strip('Abc'), 0, false)
  assert.equal(spell(tabs), 'abc')
  assert.equal(index, 0)
})

check('the tab that moves is the same object, so its references survive', () => {
  const before = strip('abc')
  const carried = before[2]
  const { tabs, index } = repin(before, 2, true)
  assert.equal(tabs[index], carried, 'the very same tab, not a copy of it')
  assert.equal(carried.pinned, true)
  assert.equal(before.length, 3, 'and the array it came from is a different one')
  assert.equal(spell(before), 'abC', 'which still holds the tab, now pinned')
})

check('an index naming no tab changes nothing', () => {
  const { tabs, index } = repin(strip('ab'), 7, true)
  assert.equal(spell(tabs), 'ab')
  assert.equal(index, 7)
})

/* ----------------------------------------------------------- close others */

check('close others keeps the one it was asked from', () => {
  assert.deepEqual(othersOf(strip('abcd'), 1), [3, 2, 0])
})

check('close others keeps every pinned tab', () => {
  assert.deepEqual(othersOf(strip('ABcd'), 2), [3])
})

check('close others from a pinned tab still spares the other pins', () => {
  assert.deepEqual(othersOf(strip('ABcd'), 0), [3, 2])
})

check('the indices come back highest first, so splicing them is safe', () => {
  const tabs = strip('abcde')
  const doomed = othersOf(tabs, 4)
  const left = tabs.slice()
  for (const i of doomed) left.splice(i, 1)
  assert.equal(spell(left), 'e')
})

check('close others on a strip of one closes nothing', () => {
  assert.deepEqual(othersOf(strip('a'), 0), [])
})

/* -------------------------------------------------------- close to the right */

check('close to the right takes only what follows', () => {
  assert.deepEqual(rightOf(strip('abcd'), 1), [3, 2])
})

check('nothing follows the last tab', () => {
  assert.deepEqual(rightOf(strip('abc'), 2), [])
})

check('close to the right from a pinned tab spares the pins beside it', () => {
  /* The gesture from the first of three pins would otherwise mean "throw away
     the other two", which is the opposite of what pinning them said. */
  assert.deepEqual(rightOf(strip('ABCde'), 0), [4, 3])
})

check('the tab it is asked from is never in the sweep', () => {
  for (let i = 0; i < 4; i++) {
    assert.ok(!rightOf(strip('abcd'), i).includes(i))
    assert.ok(!othersOf(strip('abcd'), i).includes(i))
  }
})

console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ''}`)
if (failed) process.exit(1)
