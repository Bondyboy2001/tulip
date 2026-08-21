/* ============================================== the three-way merge
   What runs when a note was edited in two places at once — the buffer being
   typed in, and the file a sync client wrote over the version Tulip last saved.

   This is the one module in the app whose output is written straight over a
   file the reader has been working in, so the property every check below is
   really asserting is the same one: whatever the reader picks in the merge
   panel, the text they get is exactly the text of the side they picked, and
   nothing outside the disputed region moves.

   That property is not decoration. Before these existed, a conflict where one
   side's hunk began inside the other's rewritten span put `theirs` into the
   merged text while measuring the region by `ours` — so "keep mine" returned
   the other side's text, and "take theirs" spliced away more lines than the
   region held and ate whatever followed it. Both are checked by name at the
   bottom.
   ================================================================== */

import assert from 'node:assert/strict'
import { merge3, resolveMerge } from '../src/merge.js'

let failures = 0
function check (what, run) {
  try { run(); console.log(`ok - ${what}`) } catch (error) {
    failures++
    console.error(`not ok - ${what}`)
    console.error(`  ${error.message.split('\n').join('\n  ')}`)
  }
}

const lines = (...rows) => rows.join('\n')

/** Both sides of a merge, settled every way the panel can settle it. */
const settle = (base, ours, theirs) => {
  const merged = merge3(base, ours, theirs)
  return {
    ...merged,
    choose: (...choices) => resolveMerge(merged.lines, merged.conflicts, choices),
    allOurs: () => resolveMerge(merged.lines, merged.conflicts, merged.conflicts.map(() => 'ours')),
    allTheirs: () => resolveMerge(merged.lines, merged.conflicts, merged.conflicts.map(() => 'theirs'))
  }
}

/* ------------------------------------------------ the uncontested cases */

check('an unchanged note merges to itself', () => {
  const text = lines('one', 'two', 'three')
  const merged = merge3(text, text, text)
  assert.equal(merged.text, text)
  assert.deepEqual(merged.conflicts, [])
})

check('edits in different places both survive', () => {
  const base = lines('title', 'a', 'b', 'c', 'end')
  const ours = lines('title', 'MINE', 'b', 'c', 'end')
  const theirs = lines('title', 'a', 'b', 'THEIRS', 'end')
  const merged = merge3(base, ours, theirs)
  assert.deepEqual(merged.conflicts, [], 'nothing to settle')
  assert.equal(merged.text, lines('title', 'MINE', 'b', 'THEIRS', 'end'))
})

check('the same edit made twice lands once', () => {
  const base = lines('a', 'b', 'c')
  const same = lines('a', 'AGREED', 'c')
  const merged = merge3(base, same, same)
  assert.deepEqual(merged.conflicts, [], 'agreement is not a conflict')
  assert.equal(merged.text, same, 'and it is not applied twice')
})

check('an insertion from each side keeps both', () => {
  const base = lines('a', 'b')
  const merged = merge3(base, lines('MINE', 'a', 'b'), lines('a', 'b', 'THEIRS'))
  assert.deepEqual(merged.conflicts, [])
  assert.equal(merged.text, lines('MINE', 'a', 'b', 'THEIRS'))
})

/* ------------------------------ appends at the very end of a note

   A line added at the bottom is the commonest thing a sync client brings back,
   and the base walk had no line at `baseLines.length` to reach it on: the hunk
   was dropped whole, from either side, with no conflict raised. A trailing
   newline hid it, so these are asserted with and without one. */

check('a line the other side appended is kept', () => {
  const merged = merge3(lines('a', 'b'), lines('a', 'b'), lines('a', 'b', 'THEIRS'))
  assert.deepEqual(merged.conflicts, [], 'nobody disagreed about it')
  assert.equal(merged.text, lines('a', 'b', 'THEIRS'))
})

check('a line we appended is kept', () => {
  const merged = merge3(lines('a', 'b'), lines('a', 'b', 'MINE'), lines('a', 'b'))
  assert.deepEqual(merged.conflicts, [])
  assert.equal(merged.text, lines('a', 'b', 'MINE'), 'our own append used to vanish silently')
})

check('an append survives whether or not the note ends in a newline', () => {
  for (const [base, ours, theirs, want] of [
    [lines('a', 'b'), lines('a', 'b'), lines('a', 'b', 'T'), lines('a', 'b', 'T')],
    [lines('a', 'b', ''), lines('a', 'b', ''), lines('a', 'b', 'T', ''), lines('a', 'b', 'T', '')]
  ]) {
    assert.equal(merge3(base, ours, theirs).text, want, `base ${JSON.stringify(base)}`)
  }
})

check('two different endings are a conflict, not a silent loss', () => {
  const base = lines('a', 'b')
  const ours = lines('a', 'b', 'MINE')
  const theirs = lines('a', 'b', 'THEIRS')
  const merged = settle(base, ours, theirs)
  assert.equal(merged.conflicts.length, 1, 'the reader is asked')
  assert.equal(merged.allOurs(), ours)
  assert.equal(merged.allTheirs(), theirs)
})

check('the same append made by both sides lands once', () => {
  const merged = merge3(lines('a', 'b'), lines('a', 'b', 'SAME'), lines('a', 'b', 'SAME'))
  assert.deepEqual(merged.conflicts, [])
  assert.equal(merged.text, lines('a', 'b', 'SAME'))
})

check('an append rides alongside an edit further up', () => {
  const merged = merge3(lines('a', 'b'), lines('a', 'MINE'), lines('a', 'b', 'THEIRS'))
  assert.deepEqual(merged.conflicts, [], 'different places, no argument')
  assert.equal(merged.text, lines('a', 'MINE', 'THEIRS'))
})

check('a side that did not change anything cedes to the one that did', () => {
  const base = lines('a', 'b', 'c')
  const theirs = lines('a', 'CHANGED', 'c')
  const merged = merge3(base, base, theirs)
  assert.deepEqual(merged.conflicts, [])
  assert.equal(merged.text, theirs)
})

/* --------------------------------------------------- the contested ones */

check('one line rewritten two ways is one conflict, standing as ours', () => {
  const base = lines('a', 'b', 'c')
  const ours = lines('a', 'MINE', 'c')
  const theirs = lines('a', 'THEIRS', 'c')
  const merged = settle(base, ours, theirs)
  assert.equal(merged.conflicts.length, 1)
  assert.deepEqual(merged.conflicts[0].ours, ['MINE'])
  assert.deepEqual(merged.conflicts[0].theirs, ['THEIRS'])
  assert.equal(merged.text, ours, 'ours stands in until it is settled')
  assert.equal(merged.allOurs(), ours)
  assert.equal(merged.allTheirs(), theirs)
})

check('the placeholder is exactly the region the conflict claims', () => {
  const base = lines('a', 'b', 'c')
  const merged = merge3(base, lines('a', 'M1', 'M2', 'c'), lines('a', 'T', 'c'))
  const [conflict] = merged.conflicts
  assert.deepEqual(merged.lines.slice(conflict.s, conflict.s + conflict.count), conflict.ours,
    'resolveMerge splices by s and count, so they must name where ours actually sits')
})

check('two conflicts can be settled differently', () => {
  const base = lines('a', 'b', 'c', 'd', 'e')
  const ours = lines('a', 'M1', 'c', 'M2', 'e')
  const theirs = lines('a', 'T1', 'c', 'T2', 'e')
  const merged = settle(base, ours, theirs)
  assert.equal(merged.conflicts.length, 2)
  assert.equal(merged.choose('ours', 'theirs'), lines('a', 'M1', 'c', 'T2', 'e'))
  assert.equal(merged.choose('theirs', 'ours'), lines('a', 'T1', 'c', 'M2', 'e'))
})

check('taking theirs first does not move the conflict after it', () => {
  /* The reason resolveMerge works backwards. Their first hunk is longer than
     ours, so settling it forwards would shift every later position — and the
     second conflict would be spliced out of the wrong place. */
  const base = lines('a', 'b', 'c', 'd', 'e')
  const ours = lines('a', 'M1', 'c', 'M2', 'e')
  const theirs = lines('a', 'T1', 'T2', 'T3', 'c', 'T4', 'e')
  const merged = settle(base, ours, theirs)
  assert.equal(merged.conflicts.length, 2)
  assert.equal(merged.allTheirs(), theirs, 'both sides of a growing first hunk still land')
  assert.equal(merged.choose('theirs', 'ours'), lines('a', 'T1', 'T2', 'T3', 'c', 'M2', 'e'))
})

check('a choice that is neither keeps ours', () => {
  const merged = settle(lines('a', 'b', 'c'), lines('a', 'M', 'c'), lines('a', 'T', 'c'))
  assert.equal(resolveMerge(merged.lines, merged.conflicts, []), lines('a', 'M', 'c'))
  assert.equal(resolveMerge(merged.lines, merged.conflicts, [undefined]), lines('a', 'M', 'c'))
})

/* ------------------------------------- overlapping hunks: the regression */

check('their rewrite starting inside ours settles to whole sides', () => {
  const base = lines('a', 'b', 'c', 'd', 'e', 'f')
  const ours = lines('a', 'M1', 'M2', 'd', 'e', 'f')
  const theirs = lines('a', 'b', 'T1', 'd', 'e', 'f')
  const merged = settle(base, ours, theirs)
  assert.equal(merged.conflicts.length, 1, 'overlapping rewrites are one decision')
  assert.equal(merged.allOurs(), ours)
  assert.equal(merged.allTheirs(), theirs)
})

check('our rewrite starting inside theirs settles to whole sides', () => {
  /* The branch that was wrong. `theirs` begins first and `ours` begins inside
     the span it replaces, so the merged text is assembled from the base around
     our hunk — and it must be OUR reconstruction that stands in, because that
     is what `count` measures. */
  const base = lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')
  const theirs = lines('a', 'T1', 'T2', 'T3', 'e', 'f', 'g', 'h')
  const ours = lines('a', 'b', 'O1', 'd', 'e', 'f', 'g', 'h')
  const merged = settle(base, ours, theirs)
  assert.equal(merged.conflicts.length, 1)
  assert.equal(merged.text, ours, 'ours stands in, as everywhere else')
  assert.equal(merged.allOurs(), ours, '"keep mine" used to return theirs')
  assert.equal(merged.allTheirs(), theirs)
})

check('an overlap of unequal length does not eat what follows it', () => {
  /* The same branch, with the two sides different lengths so a mismatched
     `count` cannot hide. Taking theirs once spliced five lines out of a region
     holding one, deleting `e`, `f`, `g` and `h` — lines neither side had
     touched — and leaving the note two lines long. */
  const base = lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')
  const theirs = lines('a', 'T1', 'e', 'f', 'g', 'h')
  const ours = lines('a', 'b', 'O1', 'O2', 'O3', 'd', 'e', 'f', 'g', 'h')
  const merged = settle(base, ours, theirs)
  assert.equal(merged.allOurs(), ours)
  assert.equal(merged.allTheirs(), theirs)
  for (const settled of [merged.allOurs(), merged.allTheirs()]) {
    assert.ok(settled.endsWith(lines('e', 'f', 'g', 'h')),
      'the untouched tail of the note survives either choice')
  }
})

/* ------------------------------------------------------ the edge cases */

check('an empty base means both sides are additions', () => {
  const merged = settle('', lines('mine'), lines('theirs'))
  assert.equal(merged.allOurs(), lines('mine'))
  assert.equal(merged.allTheirs(), lines('theirs'))
})

check('nullish sides are read as empty rather than thrown on', () => {
  const merged = merge3(null, undefined, null)
  assert.equal(typeof merged.text, 'string')
  assert.deepEqual(merged.conflicts, [])
})

check('a note too large to pair is offered whole, either way', () => {
  /* Past the budget the merge stops being line-by-line: one conflict covering
     the whole note, which the panel shows as "yours or theirs". Both sides must
     still come back exactly, because this is the case where the most text is at
     stake. */
  const many = (mark) => Array.from({ length: 3000 }, (_, i) => `${mark}${i}`).join('\n')
  const merged = settle(many('base'), many('ours'), many('theirs'))
  assert.equal(merged.conflicts.length, 1, 'one decision for the whole note')
  assert.equal(merged.allOurs(), many('ours'))
  assert.equal(merged.allTheirs(), many('theirs'))
})

check('a trailing newline is not quietly dropped', () => {
  const base = lines('a', 'b', '')
  const ours = lines('a', 'MINE', '')
  const theirs = lines('a', 'THEIRS', '')
  const merged = settle(base, ours, theirs)
  assert.equal(merged.allOurs(), ours, 'the blank last line is a line')
  assert.equal(merged.allTheirs(), theirs)
})

/* ------------------------------------------------------------ the sweep

   The properties above, over enough shapes to catch a branch none of the
   hand-written cases reach. Both sides are edits of the same base, so every
   result is one the app could actually be asked to write.

   What is asserted here is deliberately narrower than "keeping everything as
   ours gives our text back". That is not true of a working merge and must not
   be: the whole point is that the other side's changes to lines we did not
   touch come along, so a settled note is usually neither side's text. What has
   to hold is that the conflict records and the merged text agree — every
   conflict names the region its own placeholder occupies, and settling one
   replaces exactly that region and nothing else. Those are the two facts
   `resolveMerge` splices on, and the pair of them going out of step is what
   silently ate lines in the branch above. */

check('the conflicts and the text they index agree, over many shapes', () => {
  const base = Array.from({ length: 12 }, (_, i) => `line ${i}`)
  /* A deterministic shuffle: the suite must fail the same way twice, and a
     seeded walk over the same space is what makes a failure reportable. */
  let seed = 1
  const next = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n

  for (let round = 0; round < 400; round++) {
    const edit = (mark) => {
      const out = base.slice()
      for (let n = next(3) + 1; n > 0; n--) {
        const how = next(3)
        /* `out.length` is a position for an insertion and not for the other
           two: appending past the last line is the shape that used to be
           dropped, so the walk has to be able to reach it. */
        if (how === 1) out.splice(next(out.length + 1), 0, `${mark} added`)
        else if (how === 0) out.splice(next(out.length), 1)
        else out[next(out.length)] = `${mark} changed`
      }
      return out.join('\n')
    }
    const ours = edit('ours')
    const theirs = edit('theirs')
    const merged = settle(base.join('\n'), ours, theirs)
    const where = `round ${round}\n  ours:   ${JSON.stringify(ours)}\n  theirs: ${JSON.stringify(theirs)}`

    /* Every conflict points at its own placeholder. Get this wrong and the
       splice below lands on the wrong lines — which is the failure that ate
       four untouched lines of a note. */
    for (const conflict of merged.conflicts) {
      assert.deepEqual(
        merged.lines.slice(conflict.s, conflict.s + conflict.count), conflict.ours,
        `${where}\n  a conflict does not name the region ours occupies`)
    }

    /* Leaving everything as it stands changes nothing. */
    assert.equal(merged.allOurs(), merged.text, `${where}\n  keeping ours rewrote the note`)

    /* And settling one conflict touches that conflict and nothing else — asked
       of each in turn, against the replacement done independently. */
    merged.conflicts.forEach((conflict, at) => {
      const choices = merged.conflicts.map((_, i) => (i === at ? 'theirs' : 'ours'))
      const expected = merged.lines.slice()
      expected.splice(conflict.s, conflict.count, ...conflict.theirs)
      assert.equal(resolveMerge(merged.lines, merged.conflicts, choices), expected.join('\n'),
        `${where}\n  settling conflict ${at} moved something else`)
    })

    /* Settling all of them is the same as settling each, applied from the end.
       This is the claim the doc comment on resolveMerge makes. */
    const everyone = merged.lines.slice()
    for (let i = merged.conflicts.length - 1; i >= 0; i--) {
      const conflict = merged.conflicts[i]
      everyone.splice(conflict.s, conflict.count, ...conflict.theirs)
    }
    assert.equal(merged.allTheirs(), everyone.join('\n'),
      `${where}\n  settling every conflict is not settling each of them`)
  }
})

console.log(failures ? `\nmerge: ${failures} failed` : '\nmerge: every check passed')
process.exit(failures ? 1 : 0)
