/* Every class the stylesheet styles is a class something assigns.

   The print rule used to hide `.dd-root`, a class nothing has ever created.
   The rule looked right, read right in review, and did nothing: the dropdown's
   menu carries `dd-menu`, and it went on printing over exported notes. A
   selector that matches nothing is worse than a missing one, because it says
   in writing that the case is handled.

   Classes are the checkable part. Many are built rather than written —
   `is-h${level}`, `${tag}-run`, `${kind}-stage` — so a name absent from the
   source is only a *candidate*, and the allowlist below is where the ones that
   really are built get recorded, each with the line that builds it.

     node scripts/test-css-selectors.mjs
*/

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (p) => readFileSync(path.join(root, p), 'utf8')

/* Names assembled at runtime, and where. A candidate here is not dead; it is
   spelled somewhere as a template. Anything added to this list should name the
   code that builds it, so the next reader can check the claim rather than
   trust it. */
const BUILT_AT_RUNTIME = new Map([
  ['is-h1', 'renderer.js — `outline-row is-h${heading.level}`'],
  ['is-h2', 'renderer.js — as is-h1'],
  ['is-h3', 'renderer.js — as is-h1'],
  ['is-h4', 'renderer.js — as is-h1'],
  ['is-h5', 'renderer.js — as is-h1'],
  ['is-h6', 'renderer.js — as is-h1'],
  ['tk-h1', 'editor.js — `tk-h${heading[1]}`'],
  ['tk-h2', 'editor.js — as tk-h1'],
  ['tk-h3', 'editor.js — as tk-h1'],
  ['tk-h4', 'editor.js — as tk-h1'],
  ['tk-h5', 'editor.js — as tk-h1'],
  ['tk-h6', 'editor.js — as tk-h1'],
  ['is-unlinked', 'renderer.js — `link-group is-${kind}`, kind = linked | unlinked'],
  ['is-same', 'history.js — `history-diff-line is-${row.kind}`'],
  ['is-audio', 'renderer.js — `media-dock is-${spec.kind}`'],
  ['is-image', 'renderer.js — as is-audio'],
  ['is-good', 'tone on a callout mark — editor.js `tk-callout-mark is-${tone}`'],
  ['is-info', 'as is-good'],
  ['is-amber', 'as is-good'],
  ['is-grey', 'as is-good'],
  ['is-mint', 'as is-good'],
  ['is-rose', 'as is-good'],
  ['is-violet', 'as is-good'],
  ['html-run', 'guest.js — `${tag}-run`'],
  ['three-run', 'guest.js — as html-run'],
  ['html-run-view', 'guest.js — `${tag}-run-view`'],
  ['three-run-view', 'guest.js — as html-run-view'],
  ['html-page', 'guest.js — `${tag}-page`'],
  ['three-page', 'guest.js — as html-page'],
  ['drawing-stage', 'blocks.js — `${kind}-stage`'],
  ['manim-stage', 'blocks.js — as drawing-stage'],
  ['manim-status', 'blocks.js — as drawing-stage'],
  ['msg-bot', 'copilot.js — `msg msg-${msg.t}`'],
  ['msg-note', 'copilot.js — as msg-bot'],
  ['msg-high', 'copilot.js — as msg-bot']
])

/* Classes that belong to somebody else's markup: CodeMirror, KaTeX, pdf.js and
   markdown-it all emit their own, and Tulip styles them without ever writing
   them. Matched by prefix. */
const FOREIGN_PREFIXES = [
  'cm-',            // CodeMirror
  'katex',          // KaTeX
  'markedContent',  // pdf.js text layer
  'textLayer',      // pdf.js
  'annotationLayer',// pdf.js
  'footnote',       // markdown-it-footnote
  'mermaid',        // mermaid
  'hljs-'           // highlight.js
]

/* Comments stripped first. The prose in this stylesheet talks *about*
   selectors — including, in the print block, a note about the dead `.dd-root`
   rule this check was written for — and a class named only in a comment is
   styling nothing by definition. Reading them as declarations makes the check
   report its own documentation. */
const styles = read('src/styles.css').replace(/\/\*[\s\S]*?\*\//g, ' ')

/* Everything that looks like a class in a selector position. Deliberately
   permissive — a false candidate costs one allowlist line, while a missed one
   is the bug this exists to catch. */
const declared = new Set(
  [...styles.matchAll(/\.(-?[A-Za-z_][\w-]{2,})/g)].map((m) => m[1])
)

// Every source the app ships, plus the test harness that mounts real widgets.
const sources = [
  ...readdirSync(path.join(root, 'src'))
    .filter((f) => /\.(js|html)$/.test(f))
    .map((f) => `src/${f}`),
  ...readdirSync(path.join(root, 'electron'))
    .filter((f) => /\.(js|cjs)$/.test(f))
    .map((f) => `electron/${f}`),
  'scripts/table-tests.js'
]
const code = sources.map(read).join('\n')

let failures = 0
const dead = []
const staleAllowlist = []

for (const name of [...declared].sort()) {
  if (FOREIGN_PREFIXES.some((prefix) => name.startsWith(prefix))) continue

  const used = code.includes(name)
  const excused = BUILT_AT_RUNTIME.has(name)

  if (!used && !excused) dead.push(name)
  /* An allowlist entry for a class the source now writes plainly is not a
     failure, but it is a lie waiting to mislead someone. */
  if (used && excused) staleAllowlist.push(name)
}

if (dead.length) {
  failures++
  console.error('not ok - every styled class is one the app assigns')
  console.error('\n  These appear in src/styles.css and nowhere in the source:\n')
  for (const name of dead) console.error(`    .${name}`)
  console.error(
    '\n  If one is built at runtime, add it to BUILT_AT_RUNTIME in this file\n' +
    '  with the line that builds it. Otherwise the rule is styling nothing\n' +
    '  and should go — see the .dd-root bug this check exists for.\n'
  )
} else {
  console.log('ok - every styled class is one the app assigns')
}

if (staleAllowlist.length) {
  console.log(
    `note - now written plainly in the source, so the allowlist entry could go: ` +
    staleAllowlist.map((n) => `.${n}`).join(', ')
  )
}

/* The specific rule that started this. The export contract test checks the
   print block; this checks the claim underneath it, which is that a selector
   naming a class nothing assigns is a bug wherever it appears. */
const printBlock = styles.slice(styles.indexOf('@media print'))
const ddRoot = printBlock.includes('.dd-root')
if (ddRoot) {
  failures++
  console.error('not ok - the print rule no longer hides .dd-root (nothing has that class)')
} else {
  console.log('ok - the print rule does not name .dd-root')
}

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\ncss selectors: every rule has something to style')
