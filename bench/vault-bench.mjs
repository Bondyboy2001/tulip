/* The vault's cold open, timed — the half the search bench cannot see.
 *
 *   node bench/vault-bench.mjs            one run
 *   node bench/vault-bench.mjs --check    …and fail if the CPU half got slower
 *   node bench/vault-bench.mjs --json     …and print the raw numbers
 *
 * `bench/search-bench.mjs` measures the per-note scan against synthetic
 * strings in memory. What it never touches is the *disk*: opening a large
 * vault walks every folder, reads every note, parses each one's frontmatter
 * and headings, and round-trips the index through the on-quit cache. A vault
 * that grew an order of magnitude would slow exactly that path, and nothing
 * in the tree would have noticed — so this bench builds a real vault in a
 * temporary directory and times the phases a cold open is made of.
 *
 * The walk and the cache round trip are disk-bound, and a hosted runner's
 * disk is nobody's baseline: those are reported, never gated. The parse half
 * runs on the same seeded bytes every time and is pure CPU, so it gates —
 * generously, the way the search bench does: the point is to catch an order
 * of magnitude, not to argue about a millisecond.
 */

import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { mkdirSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { scanKind, entryProps, entryHeadTags } = require('../electron/vault-scan.js')
const { makeIndexCache } = require('../electron/index-cache.js')
const { mapLimit, WALK_LIMIT } = require('../electron/map-limit.js')

/* Same generator discipline as the search bench: seeded, so two runs on two
   machines read the same bytes and the number means one thing. Shaped like
   notes rather than like lorem — frontmatter, headings, the odd fence, the
   odd tag — because the parse half is what costs, and it costs on structure. */
const NOTES = 8000
const FOLDERS = 40

let seed = 0x51ed270b
const rand = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
  return (seed >>> 0) / 0x100000000
}

const WORDS = ('the a of and to in that it is was for on with as by at from but not they '
  + 'physics gradient tensor manifold lemma proof corollary integral entropy lattice '
  + 'vault note heading fence table caption footnote citation appendix figure').split(' ')
const TAGS = ('study reading papers inbox projects quadrature glossary').split(' ')

const pick = (bag) => bag[Math.floor(rand() * bag.length)]

function makeNote (n) {
  const lines = [
    '---',
    `title: Note ${n}`,
    `tags: [${pick(TAGS)}, ${pick(TAGS)}]`,
    '---',
    '',
    `# Note ${n}`
  ]
  for (let i = 0; i < 60; i++) {
    if (i % 15 === 0) lines.push(`## ${pick(WORDS)} ${pick(WORDS)}`)
    else if (i % 23 === 0) lines.push('```python')
    else if (i % 23 === 1) lines.push('```')
    else lines.push(Array.from({ length: 10 }, () => pick(WORDS)).join(' '))
  }
  if (n % 40 === 0) lines.push(`A note about quadrature, number ${n}.`)
  return lines.join('\n')
}

/* The temporary vault: FOLDERS folders, NOTES notes spread across them. Gone
   again before the process exits, whichever way it exits. */
const vault = mkdtempSync(path.join(tmpdir(), 'tulip-vault-bench-'))
const cacheDir = mkdtempSync(path.join(tmpdir(), 'tulip-vault-bench-cache-'))
for (let f = 0; f < FOLDERS; f++) mkdirSync(path.join(vault, `Folder ${String(f).padStart(2, '0')}`))

let bytes = 0
for (let n = 0; n < NOTES; n++) {
  const text = makeNote(n)
  bytes += text.length
  writeFileSync(path.join(vault, `Folder ${String(n % FOLDERS).padStart(2, '0')}`, `Note ${String(n).padStart(4, '0')}.md`), text)
}

/** Every note under the vault, the way a cold walk finds them. */
function listNotes (dir) {
  const out = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name)
    if (name.isDirectory()) out.push(...listNotes(p))
    else if (name.name.endsWith('.md')) out.push(p)
  }
  return out
}

/* 1 — the walk: enumerating the tree and reading every note, at the same
   concurrency the index build uses. Disk-bound; reported, not gated. */
const files = listNotes(vault)
let walkMs = 0
let texts = null
{
  const at = performance.now()
  texts = await mapLimit(files, WALK_LIMIT, (file) => readFile(file, 'utf8'))
  walkMs = performance.now() - at
}

/* 2 — the parse: an entry and its metadata per note, the CPU half of the
   index build. Same bytes every run; this is the half that gates. */
let parseMs = 0
const index = new Map()
{
  const at = performance.now()
  files.forEach((file, i) => {
    const text = texts[i]
    const name = path.basename(file, '.md')
    const entry = { name, text, size: text.length, mtime: 1 }
    entryProps(entry)
    entryHeadTags(entry)
    index.set(file, entry)
  })
  parseMs = performance.now() - at
}

/* 3 — the cache write: what `before-quit` pays to leave the index behind.
   4 — the cache read: what the next launch pays instead of the walk. */
let cacheWriteMs = 0
let cacheReadMs = 0
{
  const writer = makeIndexCache({ dir: cacheDir, vaultPath: vault, quietMs: 0, maxWaitMs: 5000 })
  const at = performance.now()
  writer.save(index)
  await writer.flush()
  cacheWriteMs = performance.now() - at

  const reader = makeIndexCache({ dir: cacheDir, vaultPath: vault, quietMs: 0, maxWaitMs: 5000 })
  const at2 = performance.now()
  const loaded = await reader.load()
  cacheReadMs = performance.now() - at2
  if (loaded.size !== index.size) {
    console.error(`vault bench: the cache came back with ${loaded.size} of ${index.size} entries`)
    process.exit(1)
  }
}

/* 5 — one search pass over the index the walk built, the number a reader
   waits for on their first search after opening a big vault. */
/* A term one note in forty holds, mirroring the search bench's rare word.
   Terms arrive shaped as search-scan wants them: `has` to reject a note from
   its presence test, `find` to walk the lines of one that passed. */
const term = (word) => ({
  has: new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  find: new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
})
const rareArgs = {
  entries: index,
  query: {
    terms: [term('quadrature')],
    words: ['quadrature'],
    filters: { tag: [], path: [], file: [], prop: [], type: [] }
  },
  narrowed: false,
  kindOf: () => 'note',
  factsFor: () => ({ kind: 'note', fileTags: [] }),
  limit: 4 * 1024 * 1024,
  rankHeadings: true
}
let searchMs = 0
{
  await scanKind(rareArgs)          // warm the JIT, not the clock
  const at = performance.now()
  await scanKind(rareArgs)
  searchMs = performance.now() - at
}

rmSync(vault, { recursive: true, force: true })
rmSync(cacheDir, { recursive: true, force: true })

const results = {
  notes: NOTES,
  folders: FOLDERS,
  bytes,
  walkMs,
  parseMs,
  cacheWriteMs,
  cacheReadMs,
  searchMs
}

/* The parse is the gate: CPU on seeded bytes. Generous against today's
   number — the point is the order of magnitude, as with every bench here. */
const PARSE_LIMIT = 1000
const SEARCH_LIMIT = 300

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 2))
} else {
  console.log(`\n${NOTES} notes in ${FOLDERS} folders, ${(bytes / 1024 / 1024).toFixed(1)}MB on disk\n`)
  console.log(`  ${(walkMs / 1000).toFixed(2)}s    walk the tree and read every note (disk, ungated)`)
  console.log(`  ${parseMs.toFixed(0)}ms   parse every note's structure (gated, <= ${PARSE_LIMIT}ms)`)
  console.log(`  ${cacheWriteMs.toFixed(0)}ms   write the index cache (disk, ungated)`)
  console.log(`  ${cacheReadMs.toFixed(0)}ms   read the index cache back (disk, ungated)`)
  console.log(`  ${searchMs.toFixed(1)}ms  first search over the built index (gated, <= ${SEARCH_LIMIT}ms)`)
  console.log('')
}

if (process.argv.includes('--check')) {
  const over = [
    ['parse', parseMs, PARSE_LIMIT],
    ['search', searchMs, SEARCH_LIMIT]
  ].filter(([, ms, limit]) => ms > limit)
  if (over.length) {
    console.error('vault cold open is slower than its budget: ' + over
      .map(([label, ms, limit]) => `${label} ${ms.toFixed(1)}ms > ${limit}ms`).join(', '))
    process.exit(1)
  }
  console.log('vault cold open within budget')
}
