/* ============================================================= merging
   What one note looks like when two hands have written to it since they last
   agreed: the buffer the user is typing in and the file a sync client (or
   another editor, or Finder) wrote on top of the version Tulip last saved.

   A three-way merge against the version both sides started from. Changes that
   do not touch the same lines fall together; changes that rewrite the same
   place differently come back as a conflict for the reader to settle, one
   card each, in the merge panel.

   Built on the same Myers diff the rest of the app reads diffs from, so the
   pairings land where a reader of any other diff expects them.
   ================================================================== */

import { lineDiff } from './linediff.js'

/* A rewrite of everything is not a merge — it is two documents claiming the
   same page. Past a size the note is offered whole, yours or theirs, rather
   than paired line by line through an expensive diff. */
const MERGE_BUDGET = 8000

/**
 * The change-script hunks of one side against base: `{ s, e, lines }`, where
 * base lines `[s, e)` are replaced by `lines`. A pure insertion has `s === e`.
 * Positions are 0-based indices into the base's lines.
 */
function changeRuns (rows) {
  const hunks = []
  let run = []
  let insertPos = 0
  for (const row of rows) {
    if (row.kind === 'same') {
      if (run.length) { hunks.push(make(run, insertPos)); run = [] }
      insertPos = row.before
    } else {
      run.push(row)
    }
  }
  if (run.length) hunks.push(make(run, insertPos))
  return hunks
}

function make (run, insertPos) {
  const dels = []
  const adds = []
  for (const row of run) {
    if (row.kind === 'del') dels.push(row.before)
    else if (row.kind === 'add') adds.push(row.text)
  }
  if (dels.length) {
    return {
      s: Math.min(...dels) - 1,
      e: Math.max(...dels),
      lines: adds
    }
  }
  return { s: insertPos, e: insertPos, lines: adds }
}

const sameLines = (a, b) =>
  a.length === b.length && a.every((line, i) => line === b[i])

/**
 * Merge `ours` and `theirs`, both diverged from `base`.
 *
 * @returns {{lines: string[], conflicts: object[], text: string}} The merged
 *   text, with `ours` standing in every conflicting region. Each conflict is
 *   `{ s, count, ours, theirs }`: `lines[s..s+count)` is the placeholder
 *   (`ours`) the reader chooses between, and `theirs` is the other candidate.
 */
export function merge3 (base, ours, theirs) {
  const baseLines = String(base ?? '').split('\n')
  const oursLines = String(ours ?? '').split('\n')
  const theirsLines = String(theirs ?? '').split('\n')

  if (baseLines.length + oursLines.length + theirsLines.length > MERGE_BUDGET) {
    return {
      lines: oursLines,
      text: oursLines.join('\n'),
      conflicts: [{ s: 0, count: oursLines.length, ours: oursLines, theirs: theirsLines }]
    }
  }

  const A = changeRuns(lineDiff(baseLines, oursLines))
  const B = changeRuns(lineDiff(baseLines, theirsLines))

  const out = []
  const conflicts = []
  let i = 0
  let ai = 0
  let bi = 0

  while (i < baseLines.length) {
    const a = A[ai]
    const b = B[bi]
    const next = Math.min(a ? a.s : baseLines.length, b ? b.s : baseLines.length)
    for (; i < next; i++) out.push(baseLines[i])
    if (i >= baseLines.length) break

    const aHere = a && a.s === i
    const bHere = b && b.s === i

    if (aHere && bHere) {
      if (sameLines(a.lines, b.lines) && a.e === b.e) {
        out.push(...a.lines)
        i = a.e
        ai++; bi++
      } else {
        const e = Math.max(a.e, b.e)
        conflicts.push({ s: out.length, count: a.lines.length, ours: a.lines, theirs: b.lines })
        out.push(...a.lines)
        i = e
        ai++; bi++
      }
      continue
    }

    if (aHere) {
      // A rewrites from here; if B's next hunk begins inside the removed span
      // the two sides cannot both win, and the region is offered whole.
      if (b && b.s < a.e) {
        const e = Math.max(a.e, b.e)
        const ours = a.lines.slice()
        const theirs = [...baseLines.slice(i, b.s), ...b.lines, ...baseLines.slice(b.e, e)]
        conflicts.push({ s: out.length, count: ours.length, ours, theirs })
        out.push(...ours)
        i = e
        ai++; bi++
      } else {
        out.push(...a.lines)
        i = a.e
        ai++
      }
      continue
    }

    if (bHere) {
      if (a && a.s < b.e) {
        const e = Math.max(a.e, b.e)
        const ours = [...baseLines.slice(i, a.s), ...a.lines, ...baseLines.slice(a.e, e)]
        const theirs = b.lines.slice()
        conflicts.push({ s: out.length, count: ours.length, ours, theirs })
        /* Ours, like every other conflicting region: `count` is measured off
           `ours`, and `resolveMerge` splices that many lines away to put
           `theirs` in. Pushing `theirs` here instead left the two disagreeing —
           choosing "keep mine" returned the other side's text, and choosing
           theirs spliced `ours.length` lines out of a region holding
           `theirs.length`, eating whatever followed the conflict. */
        out.push(...ours)
        i = e
        ai++; bi++
      } else {
        out.push(...b.lines)
        i = b.e
        bi++
      }
      continue
    }

    // Defensive: no hunk starts at `i` although the scan said one did.
    i++
  }

  /* What either side added past the last base line. The walk above advances
     through base lines and stops when it runs out of them, so a hunk anchored
     at `baseLines.length` — an append — never had a line to be reached on, and
     was dropped whole: not merged, not conflicted, just gone. That covers the
     commonest sync edit there is, a line added at the bottom of a note on
     another device, and it went for our own appends as much as theirs.

     A note ending in a newline hid it for years, because splitting one leaves
     an empty final element for the insertion to sit before, which puts the hunk
     inside the loop's reach. A note saved without a trailing newline had no
     such luck. */
  const ourTail = A[ai] && A[ai].s >= i ? A[ai].lines : null
  const theirTail = B[bi] && B[bi].s >= i ? B[bi].lines : null
  if (ourTail && theirTail) {
    if (sameLines(ourTail, theirTail)) {
      out.push(...ourTail)
    } else {
      // Two different endings, settled the way every other disagreement is.
      conflicts.push({ s: out.length, count: ourTail.length, ours: ourTail, theirs: theirTail })
      out.push(...ourTail)
    }
  } else if (ourTail) out.push(...ourTail)
  else if (theirTail) out.push(...theirTail)

  return { lines: out, text: out.join('\n'), conflicts }
}

/**
 * The merged text with each conflict settled: `choices[i]` is `'ours'` or
 * `'theirs'` for `conflicts[i]`. Applied from the end so the earlier conflict
 * positions do not move under the replacements.
 */
export function resolveMerge (lines, conflicts, choices) {
  const result = lines.slice()
  for (let i = conflicts.length - 1; i >= 0; i--) {
    const conflict = conflicts[i]
    if (choices[i] === 'theirs') {
      result.splice(conflict.s, conflict.count, ...conflict.theirs)
    }
  }
  return result.join('\n')
}
