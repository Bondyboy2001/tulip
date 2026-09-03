/* The vault search, timed.
 *
 *   node bench/search-bench.mjs            one run
 *   node bench/search-bench.mjs --check    …and fail if it has got slower
 *   node bench/search-bench.mjs --json     …and print the raw numbers
 *
 * Why this exists: `searchVault` runs synchronously, on the main process, over
 * every note in the vault, once per debounce tick while somebody is typing —
 * and it was the only hot path in the app with no benchmark and no ceiling.
 * Boot, the reading view, the DOM and the table grid all have one; a search
 * that quietly went quadratic would have been noticed by whoever owned the
 * biggest vault, which is not a regression test.
 *
 * It measures `electron/search-scan.js` — the per-note half — against a
 * synthetic vault, rather than driving the real app. That is the part that
 * scales with the vault: everything around it (compiling the query, sorting a
 * capped result list) is paid once per query, not once per note.
 */

import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { findSpots, hitLines } = require('../electron/search-scan.js')
const { scanKind } = require('../electron/vault-scan.js')

/* A vault big enough that a per-note cost shows up over the noise, and shaped
   like notes rather than like lorem: headings, prose, the occasional fence.
   Seeded by hand so two runs on two machines scan the same bytes — `Math.random`
   would make the number mean something slightly different every time. */
const NOTES = 2000
const LINES_PER_NOTE = 120

let seed = 0x2f6e2b1
const rand = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
  return (seed >>> 0) / 0x100000000
}

const WORDS = ('the a of and to in that it is was for on with as by at from but not they '
  + 'physics gradient tensor manifold lemma proof corollary integral entropy lattice '
  + 'vault note heading fence table caption footnote citation appendix figure').split(' ')

const pick = () => WORDS[Math.floor(rand() * WORDS.length)]

function makeNote (n) {
  const lines = []
  for (let i = 0; i < LINES_PER_NOTE; i++) {
    if (i % 20 === 0) lines.push(`## ${pick()} ${pick()}`)
    else if (i % 31 === 0) lines.push('```python')
    else lines.push(Array.from({ length: 12 }, pick).join(' '))
  }
  lines.push(`note ${n} ends here`)
  /* One token in a fiftieth of the vault. Without it every query below matched
     every note, so the presence test — the branch that decides whether a note
     is scanned at all, and the reason a rare term is cheap — was never the
     thing being measured. */
  if (n % 50 === 0) lines.push(`tagged with quadrature in note ${n}`)
  return lines.join('\n')
}

const vault = Array.from({ length: NOTES }, (_, n) => makeNote(n))
const bytes = vault.reduce((sum, text) => sum + text.length, 0)

/* The queries that bracket what the scan actually does. A term almost nothing
   holds is the common case — the presence test rejects the note and the scan
   stops — and a term nearly everything holds is the pathological one, where
   every note is walked end to end and its lines read. */
const term = (word) => ({
  has: new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  find: new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
})

const QUERIES = [
  ['a rare word', [term('quadrature')]],
  ['a common word', [term('the')]],
  ['two words', [term('tensor'), term('lattice')]],
  ['a word nothing holds', [term('zzzznothing')]]
]

/** One full pass over the vault: exactly what one debounce tick costs. */
function scanVault (terms) {
  let matched = 0
  let shown = 0
  for (const text of vault) {
    const found = findSpots(text, terms)
    if (!found) continue
    matched++
    shown += hitLines(text, found.spots).length
  }
  return { matched, shown }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

function time (terms) {
  for (let i = 0; i < 3; i++) scanVault(terms)      // warm the JIT, not the clock
  const runs = []
  let last = null
  for (let i = 0; i < 7; i++) {
    const at = performance.now()
    last = scanVault(terms)
    runs.push(performance.now() - at)
  }
  return { ms: median(runs), ...last }
}

const results = {}
for (const [label, terms] of QUERIES) results[label] = time(terms)

/* And the whole loop, as the app runs it: `scanKind` over an index shaped the
   way main's is, which is the number a reader actually waits for.
 *
 * Measured two ways, because they answer different questions. The wall clock
 * says how long until the panel can paint. The *stall* says how long the main
 * process was unavailable to everything else in one go — every autosave write,
 * every watcher event, every other IPC call queues behind it — and that is the
 * number the yielding was added for. A scan that runs to completion without
 * standing aside has a stall equal to its wall clock; one that yields properly
 * has a stall of a few milliseconds however large the vault is.
 */
const index = new Map(vault.map((text, n) => [
  `Note ${n}.md`,
  { name: `Note ${n}`, text, size: text.length, mtime: 1 }
]))

const scanArgs = (terms) => ({
  entries: index,
  query: { terms, words: terms.map(() => 'x'), filters: { tag: [], path: [], file: [], prop: [], type: [] } },
  narrowed: false,
  kindOf: () => 'note',
  factsFor: () => ({ kind: 'note', fileTags: [] }),
  limit: 4 * 1024 * 1024,
  rankHeadings: true
})

/** The longest the event loop went unserved during one scan. */
async function stallOf (terms) {
  let worst = 0
  let last = performance.now()
  const tick = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
  }, 1)
  last = performance.now()
  await scanKind(scanArgs(terms))
  clearInterval(tick)
  return worst
}

const loop = {}
for (const [label, terms] of QUERIES) {
  const runs = []
  for (let i = 0; i < 3; i++) {
    const at = performance.now()
    await scanKind(scanArgs(terms))
    runs.push(performance.now() - at)
  }
  loop[label] = { ms: median(runs), stallMs: await stallOf(terms) }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ notes: NOTES, bytes, results, loop }, null, 2))
} else {
  console.log(`\n${NOTES} notes, ${(bytes / 1024 / 1024).toFixed(1)}MB of text\n`)
  console.log('  per note — electron/search-scan.js\n')
  for (const [label, r] of Object.entries(results)) {
    console.log(`  ${`${r.ms.toFixed(1)}ms`.padStart(8)}  ${label.padEnd(22)} ${r.matched} matched`)
  }
  console.log('\n  the whole loop — electron/vault-scan.js\n')
  for (const [label, r] of Object.entries(loop)) {
    console.log(`  ${`${r.ms.toFixed(1)}ms`.padStart(8)}  ${label.padEnd(22)} `
      + `main blocked for ${r.stallMs.toFixed(1)}ms at a stretch`)
  }
  console.log()
}

/* The ceilings. Generous against what the scan costs today — the point is to
   catch an order of magnitude, not to argue about a millisecond — but a search
   pass is a blocked main process, so "a common word over a large vault" is held
   inside a frame, because that is the number a reader feels as typing lag. */
const LIMITS = {
  'a rare word': 40,
  'a common word': 90,
  'two words': 110,
  'a word nothing holds': 40
}

/* What the scan may block the main process for in one go, whatever the vault
   costs in total. This is the ceiling that matters: a stall here is felt as the
   editor hesitating, and nothing in the app would point at the search box.
   Generous against the 4ms slice `vault-scan.js` aims for — a loaded CI machine
   overshoots one — but far under the whole-scan number it replaced. */
const STALL_LIMIT = 25

if (process.argv.includes('--check')) {
  const over = Object.entries(LIMITS)
    .filter(([label, limit]) => !(results[label]?.ms <= limit))
  const stalled = Object.entries(loop).filter(([, r]) => !(r.stallMs <= STALL_LIMIT))
  if (over.length) {
    console.error('search is slower than its budget: ' + over
      .map(([label, limit]) => `${label} ${results[label]?.ms?.toFixed(1) ?? 'missing'}ms > ${limit}ms`)
      .join(', '))
    process.exit(1)
  }
  if (stalled.length) {
    console.error('the scan blocks the main process for too long at a stretch: ' + stalled
      .map(([label, r]) => `${label} ${r.stallMs.toFixed(1)}ms > ${STALL_LIMIT}ms`)
      .join(', '))
    process.exit(1)
  }
  console.log('search within budget\n')
}
