/* The spelling pass, timed.
 *
 *   node bench/spelling-bench.mjs            one run
 *   node bench/spelling-bench.mjs --check    …and fail if it has got slower
 *   node bench/spelling-bench.mjs --json     …and print the raw numbers
 *
 * Why this exists: the pass runs half a second after every pause in typing,
 * over the whole note, to arrive at an answer that differs from the last one by
 * the word that was just typed. Every other hot path in the app has a ceiling;
 * this one did not, and it is the only one whose cost is paid *while somebody
 * is writing* rather than while they are waiting for something.
 *
 * It measures `src/spelling.js` — the half that finds the words and where they
 * are. What is around it is either cheap (a Map lookup per distinct word,
 * cached across passes) or paid once (the dictionary, in another process).
 *
 * The syntax tree is not primed here, which is the honest degradation the
 * module documents: nothing is skipped, so every word in the note is found.
 * That is the *upper* bound on the work, which is what a ceiling wants.
 */

import { performance } from 'node:perf_hooks'
import * as esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* `src/spelling.js` is ESM in a package node reads as CommonJS, the same
   arrangement every other bench and test here works around — bundled to a
   cache file and imported from there. It pulls in nothing, so this is a
   rename rather than a build. */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const bundled = path.join(root, 'node_modules/.cache/spelling-bench-src.mjs')
await esbuild.build({
  entryPoints: [path.join(root, 'src/spelling.js')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundled,
  logLevel: 'error'
})
const { wordsIn, makeLineScanner } = await import(bundled)

/* The production path no longer groups every occurrence before it knows which
   words are misspelled — that allocation was the bottleneck this benchmark
   was added to prevent. Keep the old whole-note operation here as the baseline
   the line cache is compared with, without restoring it to the app's API. */
const groupWords = (words) => {
  const groups = new Map()
  for (const { word, lower = word.toLowerCase(), from, to } of words) {
    let group = groups.get(lower)
    if (!group) groups.set(lower, (group = { word, at: [] }))
    group.at.push({ from, to })
  }
  return groups
}

/* A note at the size the guard in renderer.js still checks — the one a reader
   would notice this on. Seeded by hand so two runs on two machines scan the
   same bytes. */
const LINES = 9000

let seed = 0x51f3a7b
const rand = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
  return (seed >>> 0) / 0x100000000
}

const WORDS = ('the a of and to in that it is was for on with as by at from but not they '
  + 'physics gradient tensor manifold lemma proof corollary integral entropy lattice '
  + 'vault note heading fence table caption footnote citation appendix figure').split(' ')

const pick = () => WORDS[Math.floor(rand() * WORDS.length)]

const lines = []
for (let i = 0; i < LINES; i++) {
  if (i % 20 === 0) lines.push(`## ${pick()} ${pick()}`)
  else if (i % 37 === 0) lines.push(`$$\\int_0^1 ${pick()}\\,dx$$`)
  else if (i % 23 === 0) lines.push(`See [[${pick()} ${pick()}]] and #${pick()}.`)
  else lines.push(Array.from({ length: 12 }, pick).join(' '))
}
const text = lines.join('\n')
const bytes = text.length

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

function time (run) {
  for (let i = 0; i < 3; i++) run(0)   // warm the JIT, not the clock
  const runs = []
  for (let i = 0; i < 7; i++) {
    const at = performance.now()
    run(i)
    runs.push(performance.now() - at)
  }
  return median(runs)
}

/* What one keystroke costs. The document differs from the last pass by the
   characters typed into one line, which is what the whole point of a pass on a
   500ms timer is: the reader is still writing. */
const typedInto = (n) => {
  const edited = [...lines]
  edited[4000] = `${edited[4000]} ${'x'.repeat(1 + (n % 5))}`
  return edited.join('\n')
}

const results = {}

results['whole note, from cold'] = time(() => groupWords(wordsIn(text)))

results['whole note, one line edited'] = time((n) => groupWords(wordsIn(typedInto(n))))

/* What a real pass does: find the distinct words, then ask where the few the
   dictionary flags are. Two words wrong in nine thousand lines is the shape of
   a note somebody is actually writing. */
const whole = groupWords(wordsIn(text))
const misspelled = new Set([...whole.keys()].slice(0, 2))

const scanner = makeLineScanner()
scanner.scan(text)                     // the pass that populates the cache
results['line cache, one line edited'] = time((n) => {
  scanner.scan(typedInto(n))
  return scanner.places(misspelled)
})

const cold = makeLineScanner()
results['line cache, from cold'] = time(() => {
  cold.forget()
  cold.scan(text)
  return cold.places(misspelled)
})

/* The answers have to agree, or the faster one is only faster. Checked here
   rather than in a test because the fixture is here: a note with maths,
   wikilinks and tags in it is exactly where a line-at-a-time scan could differ
   from a whole-document one. Every word is asked for, not just the flagged
   two, so the comparison covers the whole note. */
const asked = new Set(whole.keys())
const fresh = makeLineScanner()
const distinct = fresh.scan(text)
const byLine = fresh.places(asked)
const disagreements = []
for (const [key, group] of whole) {
  if (!distinct.has(key)) disagreements.push(`${key}: not in the word list`)
  const mine = byLine.get(key)
  if (!mine) { disagreements.push(`${key}: missing`); continue }
  if (mine.word !== group.word) disagreements.push(`${key}: written "${mine.word}", not "${group.word}"`)
  if (mine.at.length !== group.at.length) {
    disagreements.push(`${key}: ${mine.at.length} places, not ${group.at.length}`)
  } else if (mine.at.some((place, i) => place.from !== group.at[i].from || place.to !== group.at[i].to)) {
    disagreements.push(`${key}: in different places`)
  }
}
for (const key of byLine.keys()) if (!whole.has(key)) disagreements.push(`${key}: invented`)
for (const key of distinct.keys()) if (!whole.has(key)) disagreements.push(`${key}: invented word`)

/* And the same again after an edit, which is the case the cache exists for and
   the only one where it can be wrong: every line after the edited one has
   moved, and their words are being read back from entries scanned against the
   document as it stood before. A stale position here is an underline drawn
   over the wrong word — the failure this whole change could introduce, and the
   one nothing else would catch. */
const edited = typedInto(3)
const wholeEdited = groupWords(wordsIn(edited))
fresh.scan(edited)
const afterEdit = fresh.places(new Set(wholeEdited.keys()))
for (const [key, group] of wholeEdited) {
  const mine = afterEdit.get(key)
  if (!mine) { disagreements.push(`after an edit, ${key}: missing`); continue }
  if (mine.at.length !== group.at.length) {
    disagreements.push(`after an edit, ${key}: ${mine.at.length} places, not ${group.at.length}`)
  } else if (mine.at.some((place, i) => place.from !== group.at[i].from || place.to !== group.at[i].to)) {
    disagreements.push(`after an edit, ${key}: in different places`)
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ lines: LINES, bytes, results, disagreements }, null, 2))
} else {
  console.log(`\n${LINES} lines, ${(bytes / 1024).toFixed(0)}KB, ${whole.size} distinct words\n`)
  for (const [label, ms] of Object.entries(results)) {
    console.log(`  ${`${ms.toFixed(1)}ms`.padStart(8)}  ${label}`)
  }
  console.log(disagreements.length
    ? `\n  ${disagreements.length} disagreements: ${disagreements.slice(0, 5).join('; ')}\n`
    : '\n  the two scans agree word for word, cold and after an edit\n')
}

/* The ceilings. A pass lands on the renderer's main thread while somebody is
   typing, so the number that matters is the edited one — from cold is paid once
   per note opened, and can afford to be a whole frame. */
const LIMITS = {
  'whole note, from cold': 70,
  'line cache, one line edited': 20,
  'line cache, from cold': 70
}

if (process.argv.includes('--check')) {
  const over = Object.entries(LIMITS).filter(([label, limit]) => !(results[label] <= limit))
  if (disagreements.length) {
    console.error(`the line scan disagrees with the whole-note scan: ${disagreements.slice(0, 5).join('; ')}`)
    process.exit(1)
  }
  if (over.length) {
    console.error('spelling is slower than its budget: ' + over
      .map(([label, limit]) => `${label} ${results[label]?.toFixed(1) ?? 'missing'}ms > ${limit}ms`)
      .join(', '))
    process.exit(1)
  }
  console.log('spelling within budget\n')
}
