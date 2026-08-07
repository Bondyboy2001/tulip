/* ============================================================== test runner
   Every `test:*` script in package.json, run together rather than one after
   another.

   The suite used to be a single `&&` chain of 33 npm scripts. Most of them are
   an esbuild call followed by a node call, neither of which saturates a core,
   so the whole thing took 26 seconds at 84% CPU — one core working and the
   rest idle. Nothing here is faster than it was; it is only that the machine
   is now doing more than one thing at a time.

   Two rules make that safe.

   The list comes from package.json, not from here. A `test:` script that
   exists is a script that runs, so adding one is adding one line — the old
   chain had to be edited in a second place, and a script left out of it was
   a test that silently never ran again.

   The window-driven tests take turns. Four of them drive a real Chromium
   window and assert what its layout came out as; Chromium throttles frames in
   a window that is not in front, so two of them racing is two tests measuring
   a paused window. They run one at a time in a lane of their own, alongside
   the rest rather than after them.
*/

import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/* Not part of the suite. It builds a production tree and swaps it into place
   to prove a failed build leaves the last one intact — which is a thing to do
   to a dist, not a test to run beside 32 others that are reading one.
   `npm run verify` runs it on its own, after the build. */
const NOT_A_TEST = new Set(['test:build-staging'])

/* One at a time. Each of these drives a window that is deliberately shown —
   see the note above. test:reading-list drives an offscreen one and is not
   here: with nothing to paint there is nothing for the compositor to take
   away, and it runs in the pool with the rest. */
const WINDOWED = new Set([
  'test:agent-diff',
  'test:grid',
  'test:notebook-view',
  'test:table'
])

const packageData = JSON.parse(await readFile('package.json', 'utf8'))
const scripts = packageData.scripts || {}

/* A rename in package.json must not quietly turn a windowed test into one that
   races the others: the failure it would cause is a layout assertion failing
   once in a while on a machine that happened to be busy, which is the kind of
   flake that gets re-run rather than read. */
const unknown = [...WINDOWED].filter((name) => !scripts[name])
if (unknown.length) {
  console.error(`run-tests: no such script: ${unknown.join(', ')}`)
  console.error('WINDOWED in scripts/run-tests.mjs is out of date.')
  process.exit(2)
}

const all = Object.keys(scripts)
  .filter((name) => name.startsWith('test:') && !NOT_A_TEST.has(name))
  .sort()

if (!all.length) {
  console.error('run-tests: package.json declares no test: scripts')
  process.exit(2)
}

/* npm puts the local binaries on PATH, and the scripts call `esbuild` by bare
   name. Running them through `npm run` instead would buy that back at the cost
   of an npm startup per test — 33 of them, which is most of what this file
   exists to remove. */
const env = {
  ...process.env,
  PATH: [path.resolve('node_modules/.bin'), process.env.PATH].join(path.delimiter)
}

const run = (name) => new Promise((resolve) => {
  const started = Date.now()
  const child = spawn(scripts[name], { shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  /* Held rather than streamed. Thirty-three tests writing to one terminal at
     once interleaves them line by line, and a failure the reader cannot find
     the top of is a failure they will re-run serially to read — so the output
     is kept whole and printed when the test that owns it is done. */
  const output = []
  child.stdout.on('data', (chunk) => output.push(chunk))
  child.stderr.on('data', (chunk) => output.push(chunk))
  child.on('error', (error) => {
    output.push(Buffer.from(`${error.message}\n`))
    resolve({ name, code: 1, seconds: (Date.now() - started) / 1000, output })
  })
  child.on('close', (code) => {
    resolve({ name, code: code ?? 1, seconds: (Date.now() - started) / 1000, output })
  })
})

const done = []
const report = (result) => {
  done.push(result)
  const mark = result.code === 0 ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${result.name.padEnd(28)} ${result.seconds.toFixed(1)}s  (${done.length}/${all.length})`)
}

/** Take from `queue` until it is empty, one at a time. */
const lane = async (queue) => {
  while (queue.length) report(await run(queue.shift()))
}

const windowed = all.filter((name) => WINDOWED.has(name))
const rest = all.filter((name) => !WINDOWED.has(name))

/* One lane for the windowed tests and a pool for the rest, running together.
   Half the machine, not all of it. A test here is not one process: the ones
   that matter spawn Electron, which is a browser — five or six processes with
   their own threads — and a Jupyter server. A pool as wide as the machine
   starves the windowed lane, which was measured: a grid test that takes four
   seconds took fifty-two, waiting on frames its window was not being given.
   Nothing in the pool is on the critical path anyway; the suite's floor is the
   windowed lane and the ten seconds test:kernel spends waiting on Jupyter. */
const width = Math.max(2, Math.floor(availableParallelism() / 2))

const wall = Date.now()
await Promise.all([
  lane(windowed),
  ...Array.from({ length: width }, () => lane(rest))
])

const failed = done.filter((result) => result.code !== 0)

for (const result of failed) {
  console.log(`\n${'='.repeat(72)}\n${result.name}\n${'='.repeat(72)}`)
  process.stdout.write(Buffer.concat(result.output))
}

console.log(
  `\n${all.length - failed.length}/${all.length} passed in ` +
  `${((Date.now() - wall) / 1000).toFixed(1)}s` +
  (failed.length ? ` — failed: ${failed.map((r) => r.name).join(', ')}` : '')
)

process.exit(failed.length ? 1 : 0)
