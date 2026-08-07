/* ============================================ what a launch has to compile

   A cold launch pays for exactly one thing that the app controls: the code V8
   has to parse and compile before the page can run. Not the bytes on disk —
   that was measured and is the wrong proxy; a 110KB cut moved the median by
   8ms because 76KB of it was SVG path strings. What costs is real code, and
   the largest pile of real code in this repo is CodeMirror and its grammars.

   Taking the editing stack off that path is what made a launch ~180ms instead
   of ~1.07s (bench/boot-bench.mjs). It is held there by ONE property: nothing
   in the eager graph statically imports `src/editor.js`. That property is
   invisible. A single `import { createEditor } from './editor.js'` written at
   the top of any module the renderer already imports — the obvious thing to
   write, and the thing the code read like before e51f763 — puts all of it back,
   and nothing fails. The app still works. It is just slow again, and stays slow
   until somebody thinks to run the bench.

   So the graph is a contract, and this is it. It walks the same import-statement
   edges the bundler does, from the same entry point, and asserts what may not be
   reachable without a dynamic import in the way.

   WHY A REAL BUILD and not a source grep: `editor.js` can be reached through a
   module that reaches a module that imports it, and a grep for the string sees
   only the first hop. The graph is the claim, so the graph is what is checked.
*/

import assert from 'node:assert/strict'
import esbuild from 'esbuild'

/* Mirrors the renderer half of build.mjs. It does not have to match in the ways
   that only affect output SIZE — minification, the lean-* plugins — because
   what is asserted is which modules are REACHED, and that is decided by the
   import graph alone. It does have to match the things that change the graph:
   the entry point, splitting, format, platform and conditions. */
const result = await esbuild.build({
  entryPoints: { renderer: 'src/renderer.js' },
  bundle: true,
  write: false,
  outdir: 'node_modules/.cache/boot-graph',
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'browser',
  target: ['chrome130'],
  conditions: ['production'],
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'text' },
  /* Minified, like the shipped build, because the ceiling below is a size and an
     unminified one is a different number for the same graph. */
  minify: true,
  logLevel: 'silent',
  metafile: true
})

const outputs = result.metafile.outputs
const entry = Object.keys(outputs).find((f) => /renderer\.js$/.test(f) && !f.includes('chunks/'))
assert.ok(entry, 'the renderer entry point was not built')

/* Only `import-statement` edges. A `dynamic-import` is the whole point of the
   arrangement being tested: it is a chunk fetched when something asks for it,
   and it is not compiled at launch. */
const eager = new Set()
;(function walk (file) {
  if (eager.has(file)) return
  eager.add(file)
  for (const im of outputs[file]?.imports || []) {
    if (im.kind === 'import-statement') walk(im.path)
  }
})(entry)

/** Every source module that ends up inside the eagerly-imported chunks. */
const sources = new Set()
let eagerBytes = 0
for (const file of eager) {
  eagerBytes += outputs[file]?.bytes || 0
  for (const src of Object.keys(outputs[file]?.inputs || {})) sources.add(src)
}

const has = (pattern) => [...sources].filter((s) => pattern.test(s))

const checks = []
const check = (what, run) => {
  try { run(); checks.push({ what, ok: true }) } catch (error) {
    checks.push({ what, ok: false, why: String(error.message || error) })
  }
}

check('the editing stack is not compiled at launch', () => {
  const found = has(/(^|\/)src\/editor\.js$/)
  assert.deepEqual(found, [],
    'src/editor.js is reachable from the renderer entry by static import. It must ' +
    'be reached through `import()` — see ensureEditor in src/renderer.js.')
})

check('CodeMirror is not compiled at launch', () => {
  const found = has(/node_modules\/@codemirror\//)
  assert.deepEqual(found, [],
    'CodeMirror packages are on the startup path: ' + found.slice(0, 5).join(', '))
})

check('the grammars CodeMirror parses with are not compiled at launch', () => {
  /* @lezer/common and @lezer/highlight ARE eager and are meant to be: the
     reading view highlights fenced code with them. What must not be here is the
     LR parser runtime and the language grammars built on it, which exist to
     drive an editor. */
  const found = has(/node_modules\/@lezer\/(lr|javascript|html|css|markdown|python|java|cpp|rust|php|xml|json|sass|yaml)\//)
  assert.deepEqual(found, [],
    'language grammars are on the startup path: ' + found.slice(0, 5).join(', '))
})

check('the drawing and document engines stay behind their own doors', () => {
  /* Each of these was made lazy deliberately and separately; they are the other
     half of what keeps the launch small. */
  const found = has(/node_modules\/(mermaid|katex|three|@excalidraw)\//)
  assert.deepEqual(found, [],
    'a lazily-loaded engine is on the startup path: ' + found.slice(0, 5).join(', '))
})

check('the eager graph has not grown past what it was measured at', () => {
  /* A ceiling, not a target: 522KB when this was written, against ~1,233KB
     before the editing stack moved off. It is here to make an accidental
     doubling loud — if a real feature needs the room, raise it in the same
     commit that spends it, and say what for.

     522 and not the 498KB `node build.mjs --metafile` reports for the same
     graph: build.mjs runs three lean-* plugins that trim payloads inside these
     modules (the entities table, KaTeX, Excalidraw) without changing which
     modules are reached. Sizes from the two are not comparable; growth is. */
  const kb = eagerBytes / 1024
  assert.ok(kb < 620, `the startup bundle is ${kb.toFixed(0)}KB, over the 620KB ceiling`)
})

let bad = 0
for (const c of checks) {
  console.log(`${c.ok ? 'ok' : 'FAIL'} - ${c.what}${c.ok ? '' : '\n     ' + c.why}`)
  if (!c.ok) bad++
}
console.log(`\nboot graph: ${(eagerBytes / 1024).toFixed(0)}KB over ${eager.size} chunks, ` +
  `${checks.length - bad} checks passed`)
process.exit(bad ? 1 : 0)
