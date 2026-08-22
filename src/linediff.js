/**
 * A line diff, the shape a diff is usually read in: each removed line sitting
 * directly above the line that replaced it, with a little unchanged text either
 * side for bearings.
 *
 * Myers' algorithm, which is the one `git diff` uses, so the pairings come out
 * where a reader of any other diff would expect them. It is O(ND) in the number
 * of *differences*, not the file size — a one-line edit in a ten-thousand-line
 * note costs almost nothing, which is the case that matters here.
 */

const CONTEXT = 2

/* Myers' greedy trace. The furthest-reaching path on each diagonal k is kept
   per edit-distance d; the first to reach the far corner is the shortest edit
   script, and the saved traces are walked back to recover it. */
function trace (a, b) {
  const n = a.length
  const m = b.length
  const max = n + m
  const saved = []
  const v = new Int32Array(2 * max + 2)
  for (let d = 0; d <= max; d++) {
    saved.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max]))
        ? v[k + 1 + max]
        : v[k - 1 + max] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[k + max] = x
      if (x >= n && y >= m) return { saved, d, max }
    }
  }
  return { saved, d: max, max }
}

/**
 * The edit script as rows: `{ kind, text, before, after }`, in file order —
 * `fileDiff` below is the door in; this walks one already-trimmed span.
 * `before` and `after` are 1-based line numbers, null where the line does not
 * exist on that side. `origin` is where the two slices start in the real file.
 */
function lineDiff (a, b, origin = 1) {
  const { saved, max } = trace(a, b)
  const rows = []
  let x = a.length
  let y = b.length
  for (let d = saved.length - 1; d >= 0; d--) {
    const v = saved[d]
    const k = x - y
    const prevK = (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) ? k + 1 : k - 1
    const prevX = v[prevK + max]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      rows.push({ kind: 'same', text: a[x - 1], before: origin + x - 1, after: origin + y - 1 })
      x--
      y--
    }
    if (d > 0) {
      if (x > prevX) {
        rows.push({ kind: 'del', text: a[x - 1], before: origin + x - 1, after: null })
        x--
      } else if (y > prevY) {
        rows.push({ kind: 'add', text: b[y - 1], before: null, after: origin + y - 1 })
        y--
      }
    }
  }
  return rows.reverse()
}

/**
 * The diff of two whole files, trimmed to the parts worth showing: matching
 * head and tail are dropped, and long stretches of unchanged text between two
 * edits collapse to a marker, so a note with two small changes at either end
 * is two small changes and not nine thousand lines of agreement.
 */
export { lineDiff }

/* Splitting on newlines gives a file that ends with one a final empty string,
   and that empty string is not a line anybody wrote. Left in, it is common to
   both sides of almost every diff and shows up as a blank context row hanging
   off the bottom of the change — see `wholeFile` in src/history.js, which drops
   it for the same reason and in the same words.

   The cost is that adding or removing only the final newline now reads as no
   change at all. That is the right trade for a notes app: the blank row was on
   screen constantly, and the other case is invisible in a diff either way. */
const lines = (text) => {
  const whole = String(text ?? '')
  // An empty file is no lines at all. Split would call it one empty line, and
  // writing into it would then read as having deleted something.
  if (whole === '') return []
  const split = whole.split('\n')
  if (split.at(-1) === '') split.pop()
  return split
}

export function fileDiff (before, after, { budget = 4000 } = {}) {
  const a = lines(before)
  const b = lines(after)

  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tailA = a.length - 1
  let tailB = b.length - 1
  while (tailA >= head && tailB >= head && a[tailA] === b[tailB]) { tailA--; tailB-- }

  const midA = a.slice(head, tailA + 1)
  const midB = b.slice(head, tailB + 1)
  if (!midA.length && !midB.length) return { rows: [], added: 0, removed: 0, truncated: false }

  /* Myers is cheap in the number of differences, not their size. A rewrite of
     a whole large note is the one shape that costs real time, so past a budget
     the two sides are shown whole rather than paired line by line. */
  if (midA.length + midB.length > budget) {
    const rows = [
      ...midA.map((text, i) => ({ kind: 'del', text, before: head + i + 1, after: null })),
      ...midB.map((text, i) => ({ kind: 'add', text, before: null, after: head + i + 1 }))
    ]
    return { rows, added: midB.length, removed: midA.length, truncated: true }
  }

  const rows = lineDiff(midA, midB, head + 1)

  // Context either side, taken back off the head and tail that were trimmed.
  const lead = []
  for (let i = Math.max(0, head - CONTEXT); i < head; i++) {
    lead.push({ kind: 'same', text: a[i], before: i + 1, after: i + 1 })
  }
  const trail = []
  for (let i = 0; i < CONTEXT && tailA + 1 + i < a.length; i++) {
    trail.push({
      kind: 'same',
      text: a[tailA + 1 + i],
      before: tailA + 2 + i,
      after: tailB + 2 + i
    })
  }

  const full = collapse([...lead, ...rows, ...trail])
  return {
    rows: full,
    added: rows.filter((row) => row.kind === 'add').length,
    removed: rows.filter((row) => row.kind === 'del').length,
    truncated: false
  }
}

/* --------------------------------------------------------- within a line

   A line that was edited rather than replaced is mostly the line it was, and
   painting the whole of it as changed makes the reader find the change
   themselves. The same Myers walk runs over the two lines as words, so what
   actually moved can be picked out inside the row.
   ================================================================== */

/** Words, runs of space, and single punctuation marks — the units a reader
 *  would point at. Splitting on characters finds smaller differences and
 *  reports them as speckle across the middle of a word. */
const words = (text) => text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) || []

const merge = (parts) => parts.reduce((out, part) => {
  const last = out[out.length - 1]
  if (last && last.changed === part.changed) last.text += part.text
  else out.push({ ...part })
  return out
}, [])

/**
 * One side of a word diff, as the pieces to draw.
 *
 * Neighbouring pieces of the same kind are joined, and the space between two
 * changed words is taken as changed as well. Strictly it is not — the space
 * survived — but "two words were replaced" drawn as two marks with a gap down
 * the middle reads as two separate edits, and the gap is what makes a rewritten
 * phrase look like a row of little boxes.
 */
function pieces (parts) {
  const merged = merge(parts)
  for (let at = 1; at < merged.length - 1; at++) {
    if (merged[at].changed || merged[at].text.trim()) continue
    if (merged[at - 1].changed && merged[at + 1].changed) merged[at].changed = true
  }
  return merge(merged)
}

/** How many words two lines have between them at most, as characters: every
 *  token counted as many times as it appears on both sides. A common
 *  subsequence can only be a sub-multiset of that, so this is an upper bound on
 *  what the walk below could find in common — and it costs one pass. */
function overlap (a, b) {
  const have = new Map()
  for (const token of a) have.set(token, (have.get(token) || 0) + 1)
  let chars = 0
  for (const token of b) {
    const left = have.get(token) || 0
    if (!left) continue
    have.set(token, left - 1)
    chars += token.length
  }
  return chars
}

/* How much of the longer line has to survive for "what changed" to be worth
   pointing at, and how many words are worth walking. Constants rather than
   options: there is one caller and one right answer, and the two numbers are
   easier to reason about side by side than spread across call sites. */
const KEEP = 0.34
const BUDGET = 400

/**
 * What changed inside a pair of lines, as pieces to mark up — or null when the
 * answer would not help.
 *
 * Null in two cases, both of them the same judgement: when there is too little
 * left in common for "what changed" to mean anything, the honest reading is
 * that the line was replaced, and marking the few words the two happen to
 * share is worse than saying nothing. And a very long line is not worth the
 * walk — the row's own colour already says it changed.
 *
 * The cheap bound is taken *before* the walk, not after. Myers keeps a copy of
 * its frontier per edit step, so the pair that costs the most to diff is the
 * pair with the least in common — exactly the pair whose answer is thrown away.
 * Two lines that share too few words to pass the test cannot pass it after the
 * walk either, so they never take it.
 */
export function wordDiff (before, after) {
  const left = String(before ?? '')
  const right = String(after ?? '')
  const longest = Math.max(left.length, right.length)
  if (!longest) return null

  const a = words(left)
  const b = words(right)
  if (!a.length || !b.length) return null
  if (a.length + b.length > BUDGET) return null
  if (overlap(a, b) / longest < KEEP) return null

  const rows = lineDiff(a, b)
  let common = 0
  for (const row of rows) if (row.kind === 'same') common += row.text.length
  if (common / longest < KEEP) return null

  // One side each: the rows that side has, with the ones only it has marked.
  const side = (absent, mine) => pieces(rows
    .filter((row) => row.kind !== absent)
    .map((row) => ({ text: row.text, changed: row.kind === mine })))

  return { before: side('add', 'del'), after: side('del', 'add') }
}

/**
 * Which rows were edits rather than replacements, and what moved inside them.
 *
 * A line diff pairs nothing: it says these lines went and those arrived. But a
 * run of removals followed straight away by a run of additions is how one
 * edited line looks, so the two runs are zipped and each pair asked what
 * actually changed. The answer is keyed by the row's own index, so the drawing
 * side can stay a loop over rows.
 *
 * Rows past the shorter of the two runs are left alone — three lines becoming
 * five means the last two arrived whole, and there is nothing to compare them
 * against.
 */
export function withinLines (rows) {
  const marks = new Map()
  for (let at = 0; at < rows.length; at++) {
    if (rows[at].kind !== 'del') continue
    let mid = at
    while (rows[mid]?.kind === 'del') mid++
    let end = mid
    while (rows[end]?.kind === 'add') end++

    const pairs = Math.min(mid - at, end - mid)
    for (let i = 0; i < pairs; i++) {
      const found = wordDiff(rows[at + i].text, rows[mid + i].text)
      if (!found) continue
      marks.set(at + i, found.before)
      marks.set(mid + i, found.after)
    }
    at = end - 1
  }
  return marks
}

/* A run of unchanged lines longer than twice the context is a gap, not
   reading matter: the two ends stay and the middle becomes a count. */
function collapse (rows) {
  const out = []
  let run = []
  const flush = () => {
    if (run.length > CONTEXT * 2 + 1) {
      out.push(...run.slice(0, CONTEXT))
      out.push({ kind: 'gap', hidden: run.length - CONTEXT * 2 })
      out.push(...run.slice(-CONTEXT))
    } else out.push(...run)
    run = []
  }
  for (const row of rows) {
    if (row.kind === 'same') { run.push(row); continue }
    flush()
    out.push(row)
  }
  flush()
  return out
}
