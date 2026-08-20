/* The whole suite.
 *
 * There used to be one npm script per test file and a `test` script that
 * chained seventeen of them with `&&`. Three things were wrong with that, and
 * the third is why this exists:
 *
 *   - `&&` stops at the first failure, so one broken test hides every later
 *     one and a red run takes as many round trips as it has problems.
 *   - Every file paid for its own esbuild incantation, spelled out twice —
 *     once in the script and once in whatever you typed to run it by hand.
 *   - A file was in the suite only by being named in that chain. Nothing
 *     checked. `test-agent-diff.mjs` mounts the real editor in a real Chromium
 *     window to prove the Copilot review diff actually paints, and it was in
 *     neither `npm test` nor `npm run verify`: written, committed, and never
 *     once run in CI.
 *
 * So tests are found rather than listed. Every `scripts/test-*.{mjs,cjs}` is
 * one, and a new file is in the suite the moment it exists.
 *
 *   npm test            everything
 *   npm test pdf        just the files whose name contains "pdf"
 *   npm test -- --no-display    skip the two that need a screen
 */

import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')
const CACHE = path.join(ROOT, 'node_modules', '.cache')

/* How a file is run, where it is not the default.
 *
 * The default is: bundle it with esbuild as ESM for node, then run the bundle.
 * That is what most of these need, because they import from `src/`, which is
 * ESM and full of browser assumptions this package's CommonJS cannot load
 * directly.
 *
 * A `.cjs` test needs none of that and runs as it is — inferred, not listed.
 * Everything below is a real exception. */
const EXCEPTIONS = {
  // Requires main-process modules, which are CommonJS.
  'test-ai.mjs': { format: 'cjs' },
  // Imports a logo, which the renderer's build inlines as text.
  'test-codeblock-performance.mjs': { loader: { '.svg': 'text' } },
  /* These two spawn Electron themselves, and need a window on a screen:
     Chromium defers focus events on an unfocused document, and both assert on
     things that only happen to a focused one. On a headless Linux box, put
     `xvfb-run --auto-servernum` in front. */
  'test-table.mjs': { display: true },
  'test-agent-diff.mjs': { display: true }
}

/* Whether a test has to be bundled at all.
 *
 * Only the ones that reach into `src/` or `electron/` do — that code is ESM
 * full of browser assumptions this CommonJS package cannot import directly.
 * A test that just reads files and asserts about them needs nothing, and
 * bundling it actively breaks it: the bundle lands in node_modules/.cache, so
 * anything resolving a path against its own location starts looking for the
 * repository inside node_modules.
 *
 * Inferred rather than listed, because that failure is silent until the test
 * happens to read a file, and by then it looks like the test is wrong.
 *
 * Static and dynamic both: the codeblock benchmark reaches for highlight.js
 * with `await import(...)` so the cost of loading it lands inside the timed
 * section, and a pattern that only knew about `from` quietly stopped
 * bundling it. */
const IMPORTS_APP = /(?:from|import)\s*\(?\s*['"]\.\.\/(src|electron)\//

/* Not tests, despite the names: the first is a page the agent-diff test writes
   out and loads, the second is the body of the table suite, which
   test-table.mjs bundles into that page. Neither runs on its own. */
const NOT_TESTS = new Set(['test-agent-diff.page.mjs'])

const argv = process.argv.slice(2)
const noDisplay = argv.includes('--no-display')
const filters = argv.filter((arg) => !arg.startsWith('-'))

async function findTests () {
  const names = (await readdir(path.join(ROOT, 'scripts')))
    .filter((name) => /^test-.*\.(mjs|cjs)$/.test(name))
    .filter((name) => !NOT_TESTS.has(name))
    .sort()
  return Promise.all(names.map(async (name) => {
    const file = path.join(ROOT, 'scripts', name)
    const direct = name.endsWith('.cjs') || !IMPORTS_APP.test(await readFile(file, 'utf8'))
    return { name, file, ...(EXCEPTIONS[name] || {}), direct }
  }))
}

/** Run a command, holding its output rather than interleaving it with others. */
function run (command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', (err) => resolve({ ok: false, output: `${output}\n${err.message}` }))
    child.on('close', (code) => resolve({ ok: code === 0, output }))
  })
}

async function runTest (test) {
  const started = Date.now()
  if (test.direct) {
    const result = await run(process.execPath, [test.file])
    return { ...test, ...result, ms: Date.now() - started }
  }

  await mkdir(CACHE, { recursive: true })
  const format = test.format || 'esm'
  const bundle = path.join(CACHE, test.name.replace(/\.mjs$/, format === 'cjs' ? '.cjs' : '.mjs'))
  const flags = [
    test.file, '--bundle', `--format=${format}`, '--platform=node',
    `--outfile=${bundle}`, '--log-level=error',
    ...Object.entries(test.loader || {}).map(([ext, kind]) => `--loader:${ext}=${kind}`)
  ]

  const built = await run(path.join(ROOT, 'node_modules', '.bin', 'esbuild'), flags)
  if (!built.ok) return { ...test, ok: false, output: built.output, ms: Date.now() - started }

  const result = await run(process.execPath, [bundle])
  return { ...test, ...result, ms: Date.now() - started }
}

/** Run `tests` at most `limit` at a time, in order. */
async function pool (tests, limit, onDone) {
  const results = []
  let next = 0
  const workers = Array.from({ length: Math.min(limit, tests.length) }, async () => {
    while (next < tests.length) {
      const index = next++
      const result = await runTest(tests[index])
      results[index] = result
      onDone(result)
    }
  })
  await Promise.all(workers)
  return results
}

const all = await findTests()
const chosen = filters.length
  ? all.filter((test) => filters.some((f) => test.name.includes(f)))
  : all

if (!chosen.length) {
  console.error(filters.length
    ? `No test matches ${filters.join(', ')}. Found: ${all.map((t) => t.name).join(', ')}`
    : 'No tests found in scripts/.')
  process.exit(1)
}

const skipped = noDisplay ? chosen.filter((test) => test.display) : []
const running = chosen.filter((test) => !skipped.includes(test))

/* The ones that drive a window go one at a time and last. Two Electron windows
   fighting over which is focused is exactly the condition they are asserting
   is not happening. */
const windowed = running.filter((test) => test.display)
const plain = running.filter((test) => !test.display)

const tick = (result) => {
  const status = result.ok ? '  ok ' : 'FAIL '
  console.log(`${status}${result.name.padEnd(34)} ${String(result.ms).padStart(6)}ms`)
}

const started = Date.now()
const results = [
  ...await pool(plain, Math.max(2, Math.min(8, os.cpus().length - 1)), tick),
  ...await pool(windowed, 1, tick)
]

const failed = results.filter((result) => !result.ok)

/* Every failure, not just the first: the point of running them all is being
   able to see all of them at once. */
for (const result of failed) {
  console.log(`\n${'—'.repeat(72)}\n${result.name}\n${'—'.repeat(72)}`)
  console.log(result.output.trim())
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\n${results.length - failed.length}/${results.length} passed in ${seconds}s`)
for (const test of skipped) console.log(`  skipped ${test.name} (--no-display)`)
if (skipped.length) console.log('  these run in CI, where a display is provided')

process.exit(failed.length ? 1 : 0)
