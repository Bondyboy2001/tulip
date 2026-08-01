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
export function fileDiff (before, after, { budget = 4000 } = {}) {
  const a = String(before ?? '').split('\n')
  const b = String(after ?? '').split('\n')

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
