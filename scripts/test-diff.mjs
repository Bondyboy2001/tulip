/* The diff a note's history shows: which words moved inside an edited line,
   and which rows count as one line being edited rather than two lines being
   swapped. Both are plain functions over plain data, so they are tested here
   rather than through the panel that draws them.

     node scripts/test-diff.mjs
*/

import assert from 'node:assert/strict'
import { wordDiff, fileDiff, withinLines } from '../src/linediff.js'

const text = (side) => side.map((piece) => piece.text).join('')
const marked = (side) => side.filter((piece) => piece.changed).map((piece) => piece.text)

/* One word swapped in the middle of a sentence: the sentence is not the
   change, the word is. */
{
  const found = wordDiff('the carrot is pink', 'the carrot is green')
  assert.ok(found, 'a one-word edit is worth marking')
  assert.equal(text(found.before), 'the carrot is pink')
  assert.equal(text(found.after), 'the carrot is green')
  assert.deepEqual(marked(found.before), ['pink'])
  assert.deepEqual(marked(found.after), ['green'])
}

/* Neighbouring changes join into one mark rather than coming out as a row of
   little boxes. */
{
  const found = wordDiff('a b c d', 'a x y d')
  assert.deepEqual(marked(found.before), ['b c'])
  assert.deepEqual(marked(found.after), ['x y'])
}

/* Two lines with nothing much in common were replaced, not edited — marking
   the odd shared word would be noise. */
assert.equal(wordDiff('the carrot is pink', 'entirely different words here'), null)

/* Nor is a very long line worth the walk. */
assert.equal(
  wordDiff('word '.repeat(300), 'word '.repeat(299) + 'other'),
  null,
  'past the budget the row colour speaks for itself'
)

/* An empty side has no words to pair. */
assert.equal(wordDiff('', 'something'), null)

/* Rows: a removal followed straight away by an addition is one edited line. */
{
  const { rows } = fileDiff(
    'alpha\nthe carrot is pink\nomega\n',
    'alpha\nthe carrot is green\nomega\n'
  )
  const del = rows.findIndex((row) => row.kind === 'del')
  const add = rows.findIndex((row) => row.kind === 'add')
  assert.ok(del >= 0 && add === del + 1, 'the pair sit together')

  const marks = withinLines(rows)
  assert.deepEqual(marked(marks.get(del)), ['pink'])
  assert.deepEqual(marked(marks.get(add)), ['green'])
  assert.equal(marks.size, 2, 'nothing else was marked')
}

/* Three lines becoming five: the first three are edits, the last two arrived
   whole and have nothing to be compared against. */
{
  const rows = [
    { kind: 'del', text: 'one a' },
    { kind: 'del', text: 'two a' },
    { kind: 'del', text: 'three a' },
    { kind: 'add', text: 'one b' },
    { kind: 'add', text: 'two b' },
    { kind: 'add', text: 'three b' },
    { kind: 'add', text: 'four b' },
    { kind: 'add', text: 'five b' }
  ]
  const marks = withinLines(rows)
  assert.deepEqual([...marks.keys()].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(marked(marks.get(0)), ['a'])
  assert.deepEqual(marked(marks.get(3)), ['b'])
}

/* A pure insertion pairs with nothing: added lines below unchanged ones must
   not be read as edits of them. */
{
  const rows = [
    { kind: 'same', text: 'kept' },
    { kind: 'add', text: 'brand new' }
  ]
  assert.equal(withinLines(rows).size, 0)
}

/* A removal with additions before it rather than after is not a pair either. */
{
  const rows = [
    { kind: 'add', text: 'new line' },
    { kind: 'del', text: 'old line' }
  ]
  assert.equal(withinLines(rows).size, 0)
}

console.log('diff: all checks passed')
