/* Driving a real kernel, end to end.
 *
 * electron/kernel.js is the half of running cells that no pure test can reach:
 * it spawns a server, waits for it, opens a socket and speaks a protocol. All
 * of that either works against a real Jupyter or does not work at all, and the
 * failures it has — a server that is listening but not ready, a socket that
 * outlives a restart, output that arrives before the id that names it — are
 * exactly the ones a mock would be written not to have.
 *
 * It needs nothing from Electron, which is what makes this possible: the file
 * asks only for child_process, crypto, net and path.
 *
 * Skipped, loudly, where Jupyter is not installed. A machine without it is a
 * machine where this feature is unavailable rather than broken, and the app
 * says so through the error KernelHost throws — which is itself checked below.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { KernelHost } = require('../electron/kernel.js')

/* `shell` because on Windows the executable is jupyter.cmd, which spawn will
 * not find by the bare name — without it this probe can only ever report a
 * miss there, which reads exactly like a machine without Jupyter. */
const have = spawnSync('jupyter', ['server', '--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
if (have.error || have.status !== 0) {
  /* A skip is honest on a developer's machine and a lie in CI, where nothing
   * else covers this file: green would mean "the kernel works" when it means
   * "we never asked". CI sets TULIP_REQUIRE_JUPYTER and gets a failure. */
  if (process.env.TULIP_REQUIRE_JUPYTER) {
    console.error('kernel: TULIP_REQUIRE_JUPYTER is set but no Jupyter server is on PATH')
    process.exit(1)
  }
  console.log('kernel: skipped — no Jupyter server on PATH')
  process.exit(0)
}

let passed = 0
const ok = (what) => { passed++; console.log(`ok - ${what}`) }

const root = await mkdtemp(path.join(tmpdir(), 'tulip-kernel-test-'))
await writeFile(path.join(root, 'data.txt'), 'from the notebook’s own folder\n')
const notebook = path.join(root, 'Analysis.ipynb')

/* Every output for one request, collected the way the viewer collects it. */
function collector (host) {
  const seen = new Map()      // msgId -> { outputs, counts, states }
  host.onEvent = (event) => {
    if (event.kind === 'state' || event.kind === 'notice') return
    const entry = seen.get(event.msgId) || { outputs: [], count: null }
    if (event.kind === 'output') entry.outputs.push([event.msgType, event.content])
    if (event.kind === 'count') entry.count = event.executionCount
    seen.set(event.msgId, entry)
  }
  return seen
}

const host = new KernelHost({ rootDir: root })
const seen = collector(host)

try {
  const started = Date.now()
  const kernel = await host.kernelFor(notebook, 'python3')
  ok(`a kernel starts (${kernel.displayName}, ${Date.now() - started}ms)`)

  /* The whole reason this is a kernel and not the block runner: what the first
     cell defines, the second can still see. */
  const first = kernel.execute('x = 41\nprint("one")')
  await first.done
  const second = kernel.execute('x + 1')
  const secondResult = await second.done

  const firstOut = seen.get(first.msgId).outputs
  assert.deepEqual(firstOut.map(([type]) => type), ['stream'])
  assert.equal(firstOut[0][1].text, 'one\n')
  ok('a cell’s printed output comes back')

  const value = seen.get(second.msgId).outputs
    .find(([type]) => type === 'execute_result')
  assert.equal(value[1].data['text/plain'], '42', 'the second cell saw the first cell’s x')
  ok('two cells share one namespace — the point of a kernel')

  assert.equal(seen.get(first.msgId).count, 1)
  assert.equal(seen.get(second.msgId).count, 2)
  assert.equal(secondResult.executionCount, 2)
  ok('each run is numbered, in order')

  /* A traceback, which is the output a reader sees most and the one the ANSI
     scanner in src/notebook.js exists for. */
  const bad = kernel.execute('1/0')
  const badResult = await bad.done
  const error = seen.get(bad.msgId).outputs.find(([type]) => type === 'error')
  assert.equal(error[1].ename, 'ZeroDivisionError')
  assert.ok(error[1].traceback.length > 1, 'a traceback is more than its first line')
  assert.equal(badResult.status, 'error', 'so Run all knows to stop here')
  ok('an error arrives as a named traceback, and the run reports it failed')

  /* The kernel's working directory is the notebook's folder, so a relative
     path in a cell means what it means beside the file. */
  const cwd = kernel.execute('print(open("data.txt").read().strip())')
  await cwd.done
  const said = seen.get(cwd.msgId).outputs.find(([type]) => type === 'stream')
  assert.match(said[1].text, /from the notebook/)
  ok('a relative path in a cell means the notebook’s own folder')

  /* Output has to arrive while the cell runs, not in one lump at the end —
     the difference between a readable ten-second cell and a frozen one. */
  const slow = kernel.execute(
    'import sys, time\nfor i in range(3):\n    print(i); sys.stdout.flush(); time.sleep(0.25)')
  await new Promise((r) => setTimeout(r, 400))
  const partway = (seen.get(slow.msgId)?.outputs || []).length
  await slow.done
  const whenDone = seen.get(slow.msgId).outputs.length
  assert.ok(partway >= 1, 'something had arrived before the cell finished')
  assert.ok(partway < whenDone, `output streamed rather than landing at once (${partway} then ${whenDone})`)
  ok(`output streams as it is produced (${partway} chunks partway, ${whenDone} by the end)`)

  /* Interrupt, which is the only way out of a cell that will not end. */
  const stuck = kernel.execute('import time\ntime.sleep(30)')
  await new Promise((r) => setTimeout(r, 500))
  const at = Date.now()
  await kernel.interrupt()
  await stuck.done
  const interrupted = seen.get(stuck.msgId).outputs.find(([type]) => type === 'error')
  assert.equal(interrupted[1].ename, 'KeyboardInterrupt')
  ok(`interrupt stops a running cell (${Date.now() - at}ms)`)

  /* Restart, and the socket question underneath it: the old socket belonged to
     the old process, so a kernel that is not reconnected is one whose next
     cell is answered by nobody. */
  await kernel.restart()
  const after = kernel.execute('x')
  const afterResult = await after.done
  const gone = seen.get(after.msgId).outputs.find(([type]) => type === 'error')
  assert.equal(gone[1].ename, 'NameError', 'restart threw away the variables')
  assert.equal(afterResult.executionCount, 1, 'and started numbering again')
  ok('restart clears the namespace, and the kernel still answers afterwards')

  /* A notebook asking for a kernel this machine does not have is still worth
     running — see kernelFor. */
  const odd = path.join(root, 'Elsewhere.ipynb')
  const substituted = await host.kernelFor(odd, 'kernel-that-does-not-exist')
  assert.ok(substituted.displayName, 'fell back rather than refusing')
  assert.equal(substituted.substituted, 'kernel-that-does-not-exist', 'and says what it swapped')
  ok('a missing kernelspec falls back instead of refusing to run')

  /* The picker is only as honest as the server's search path, and a server
     pointed at the wrong data directory does not fail — it succeeds with a
     shorter list. That is invisible on the one machine where every kernel is
     ipykernel, so it is checked against the reader's own `jupyter kernelspec
     list`: whatever their CLI can see, this server has to offer. */
  const listed = spawnSync('jupyter', ['kernelspec', 'list', '--json'], { encoding: 'utf8' })
  if (!listed.error && listed.status === 0) {
    const theirs = Object.keys(JSON.parse(listed.stdout).kernelspecs || {})
    const { specs } = await host.kernelSpecs()
    const ours = new Set(specs.map((spec) => spec.name))
    const missing = theirs.filter((name) => !ours.has(name))
    assert.deepEqual(missing, [], 'the server was pointed away from some kernels')
    ok(`every kernel on this machine is offered (${theirs.length})`)
  }

  /* Two notebooks are two namespaces, the way two tabs in Jupyter are. */
  const other = await host.kernelFor(path.join(root, 'Other.ipynb'), 'python3')
  assert.notEqual(other.id, kernel.id)
  const isolated = other.execute('y = "mine"\ny')
  await isolated.done
  const leak = kernel.execute('"y" in dir()')
  await leak.done
  assert.equal(
    seen.get(leak.msgId).outputs.find(([t]) => t === 'execute_result')[1].data['text/plain'],
    'False', 'one notebook cannot see the other’s variables')
  ok('two notebooks get two namespaces')

  /* Two asks for the same notebook while it is starting. Starting a kernel is
     several round trips long, and two callers that both looked and both saw
     nothing built two of them — the second took the map, and the first became
     a Python process nothing could name, shut down or interrupt again. */
  const twice = path.join(root, 'Twice.ipynb')
  const [a, b] = await Promise.all([
    host.kernelFor(twice, 'python3'),
    host.kernelFor(twice, 'python3')
  ])
  assert.equal(a, b, 'one kernel, asked for twice')
  assert.equal(a.id, host.get(twice).id, 'and it is the one the map holds')
  await host.shutdown(twice)
  ok('two asks while a kernel is starting wait on the one kernel')

  await host.shutdown(notebook)
  assert.equal(host.get(notebook), null)
  ok('a notebook’s kernel goes when the notebook does')
} finally {
  await host.dispose().catch(() => {})
}

/* The failure a machine without Jupyter has, which is the one this feature
   most often meets. It has to arrive as the sentence that says what to install
   — and it has to arrive at all: resolving a spawn on a timer rather than on
   the `spawn` event meant a slow ENOENT read as a running server, and sixty
   seconds of polling a process that did not exist before the wrong error. */
const nowhere = new KernelHost({ rootDir: root, pathFor: () => path.join(root, 'no-such-bin') })
const began = Date.now()
await assert.rejects(
  () => nowhere.kernelFor(path.join(root, 'Nothing.ipynb')),
  /could not start a Jupyter server/i)
assert.ok(Date.now() - began < 10_000, 'and says so rather than waiting out the readiness poll')
ok(`a machine without Jupyter is told what to install (${Date.now() - began}ms)`)

console.log(`\n${passed} checks passed`)
