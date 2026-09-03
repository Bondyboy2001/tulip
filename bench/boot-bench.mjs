/* ================================================================ boot bench
   What a cold launch costs, measured the only way that has ever been honest
   here: real launches of the real app, interleaved against a baseline, median
   of the warm ones.

   Read the 2026-08-05 packaging note before trusting any other proxy. Bundle
   bytes are not boot time — a 110KB cut moved the median by 8ms, inside the
   noise — because what a launch pays for is COMPILED CODE, and 76KB of that
   cut was SVG path strings V8 barely looks at. So this measures time, in a
   window, from navigation to the point the module graph has finished running.

   THE METRIC is `domContentLoadedEventEnd` from the renderer's own navigation
   timing. The page's scripts are ES modules, which are deferred by definition
   and therefore all evaluate BEFORE that event fires. So the number covers
   exactly the thing the code cache changes — fetch, parse, compile, evaluate —
   and excludes what it cannot help with, like how long the vault takes to read.
   `loadEventEnd` is reported beside it as the wider figure.

   THE USER DATA DIRECTORY IS REUSED ACROSS RUNS, ON PURPOSE. V8's code cache
   lives there. A fresh directory per launch is a cold cache every launch, which
   would measure the feature as worthless no matter how well it worked. Run 1 is
   what fills the cache and is reported separately from the median for the same
   reason.

   NOTHING HERE TOUCHES A REAL VAULT. It builds a scratch one under the system
   temp directory and points a scratch config at it.

     node bench/boot-bench.mjs                     # 6 runs
     node bench/boot-bench.mjs --runs 10
     node bench/boot-bench.mjs --label baseline    # names the result
     TULIP_NO_APP_SCHEME=1 node bench/boot-bench.mjs --label file-url

   The last of those is how the two halves of a like-for-like comparison are
   taken from ONE build: the switch is read in electron/main.js and sends the
   window back to `loadFile`, which is the state this bench exists to compare
   against. Interleave them — two runs of each, alternating — rather than
   taking all of one and then all of the other; a machine that gets busy
   halfway through otherwise attributes its own weather to the change.
*/

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
/* The executable the package exports, not the .bin shim, which Windows cannot
   spawn without a shell. */
import electron from 'electron'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

const RUNS = Number(flag('runs', 6))
const LABEL = flag('label', process.env.TULIP_NO_APP_SCHEME ? 'file-url' : 'app-scheme')
const CHECK = args.includes('--check')
const ROOT = path.join(import.meta.dirname, '..')

/* High enough to stay clear of anything a developer is likely to be running,
   and varied per invocation so two of these side by side do not fight over a
   port. The launch below fails loudly rather than silently reusing a stranger's
   debugger if it collides anyway. */
const PORT = 9500 + Math.floor(Math.random() * 400)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const round = (n) => Math.round(n * 10) / 10

/* A vault with something in it, but nothing large: this bench is about the app
   arriving, not about a document. One note is what the window opens into. */
async function scratchVault (dir) {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'Welcome.md'), [
    '# Welcome', '',
    'A note with a [[Second]] link, some **bold** text and a little $x^2$ of maths.',
    '', '- one', '- two', ''
  ].join('\n'))
  await writeFile(path.join(dir, 'Second.md'), '# Second\n\nThe other note.\n')
}

/**
 * The first page target the debugger offers, once it offers one.
 *
 * Polled rather than awaited: the HTTP endpoint exists before the window does,
 * and a target list can come back empty for a moment after that.
 */
async function pageTarget (deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* Not up yet. The deadline is the only thing that ends this loop. */
    }
    await sleep(60)
  }
  throw new Error(`no page target on port ${PORT} within the deadline`)
}

/** One CDP round trip, on a socket that answers more than one. */
function driver (socket) {
  let nextId = 0
  const waiting = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const settle = waiting.get(message.id)
    if (!settle) return
    waiting.delete(message.id)
    if (message.error) settle.reject(new Error(message.error.message))
    else settle.resolve(message.result)
  })
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    waiting.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

/**
 * Launch once and report what the navigation cost.
 *
 * The child is its own process group (`detached`) and is killed as one. Killing
 * the electron wrapper alone orphans the app it spawned, and an orphan holds
 * the debugging port — so the NEXT run attaches to the window that never went
 * away and reports a launch that never happened.
 */
/* A launch that never answers must fail, not wait. The page-target and load
   loops each have a deadline, but the debugger socket and every CDP round trip
   had none — and on a hosted runner where the app did not come up, the job
   sat in this function until GitHub killed it hours later. One clock over the
   whole attempt, and the app's own stderr in the error, because a window that
   never opened says why there and nowhere else. */
const LAUNCH_MS = 90_000

async function runOnce (userData) {
  const child = spawn(
    electron,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`],
    { cwd: ROOT, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] }
  )
  let tail = ''
  child.stderr.on('data', (chunk) => { tail = (tail + chunk).slice(-4000) })
  child.stderr.on('error', () => {})
  const gone = new Promise((resolve) => child.once('exit', resolve))

  let socket
  let clock
  const expired = new Promise((_, reject) => {
    clock = setTimeout(() => reject(new Error(`the app did not come up within ${LAUNCH_MS / 1000}s\n${tail}`)), LAUNCH_MS)
  })
  try {
    return await Promise.race([expired, measure()])
  } finally {
    clearTimeout(clock)
    try { socket?.close() } catch { /* already gone */ }
    try { process.kill(-child.pid) } catch { try { child.kill() } catch { /* already gone */ } }
    /* Waited for, not assumed: the next launch binds the same debugging port,
       and an app still on its way out is an "address already in use" that has
       nothing to do with what is being measured. Then Chromium's lock files,
       which it unlinks on the way out, get a moment too. */
    await Promise.race([gone, sleep(5000)])
    await sleep(400)
  }

  async function measure () {
    const target = await pageTarget(Date.now() + 30_000)
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('debugger socket failed')), { once: true })
    })
    const send = driver(socket)
    await send('Runtime.enable')

    /* Asked for repeatedly rather than waited for with an event: attaching may
       happen after the load already fired, and a listener registered then would
       wait for a second load that never comes. The timing entry is a fact the
       page keeps, so polling it is reading a record, not racing one. */
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const { result } = await send('Runtime.evaluate', {
        expression: `(() => {
          const nav = performance.getEntriesByType('navigation')[0]
          if (!nav || !nav.loadEventEnd) return null
          return JSON.stringify({
            domContentLoaded: nav.domContentLoadedEventEnd - nav.startTime,
            load: nav.loadEventEnd - nav.startTime,
            transfer: nav.transferSize
          })
        })()`,
        returnByValue: true
      })
      if (result.value) return JSON.parse(result.value)
      await sleep(50)
    }
    throw new Error(`the page never finished loading\n${tail}`)
  }
}

const userData = await mkdtemp(path.join(tmpdir(), 'tulip-boot-data-'))
const vault = await mkdtemp(path.join(tmpdir(), 'tulip-boot-vault-'))
let exitCode = 0

try {
  await scratchVault(vault)
  await mkdir(userData, { recursive: true })
  /* Both keys: `vaultPath` is the vault this session opens, `defaultVaultPath`
     is what a first launch falls back to. Without the second, the app stops to
     ask which folder to open and the bench measures a dialog. */
  await writeFile(
    path.join(userData, 'config.json'),
    JSON.stringify({ vaultPath: vault, defaultVaultPath: vault }, null, 2)
  )

  const runs = []
  for (let n = 0; n < RUNS; n++) {
    const timing = await runOnce(userData)
    runs.push(timing)
    process.stderr.write(`  run ${n + 1}/${RUNS}  dcl ${round(timing.domContentLoaded)}ms\n`)
  }

  /* Run 1 is the one that FILLS the code cache, and is never part of the
     median: including it would average the cost of building the cache into the
     figure that exists to show what the cache saves. */
  const warm = runs.slice(1)
  const report = {
    label: LABEL,
    appScheme: !process.env.TULIP_NO_APP_SCHEME,
    runs: RUNS,
    firstRunMs: {
      domContentLoaded: round(runs[0].domContentLoaded),
      load: round(runs[0].load)
    },
    warmMedianMs: {
      domContentLoaded: round(median(warm.map((r) => r.domContentLoaded))),
      load: round(median(warm.map((r) => r.load)))
    },
    warmRunsMs: warm.map((r) => round(r.domContentLoaded))
  }
  console.log(JSON.stringify(report, null, 2))
  if (CHECK) {
    /* The ceilings, tight locally and roomy under CI — the same arrangement
       bench/table-bench.mjs uses, and for the same reason: a shared runner is
       not an idle laptop, and a gate set for the runner catches nothing on the
       machine where the regression is actually written.
     *
     * Warm boot measures around 200ms locally on the two-note vault this bench
     * builds. The old ceilings were 1800/900 for both machines, which is far
     * enough above that a fourfold regression would have passed the gate
     * silently. These are roughly double what it costs, which is what a
     * ceiling is for: to catch a change in kind, not to argue about a
     * millisecond. */
    const ceilings = process.env.CI
      ? { first: 1800, warm: 900 }
      : { first: 700, warm: 450 }
    const failures = []
    if (report.firstRunMs.domContentLoaded > ceilings.first) {
      failures.push(`first launch over ${ceilings.first}ms`)
    }
    if (report.warmMedianMs.domContentLoaded > ceilings.warm) {
      failures.push(`warm median over ${ceilings.warm}ms`)
    }
    if (failures.length) {
      console.error(`boot performance gate failed: ${failures.join(', ')}`)
      exitCode = 1
    } else {
      console.error('boot performance gate passed')
    }
  }
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  await rm(userData, { recursive: true, force: true }).catch(() => {})
  await rm(vault, { recursive: true, force: true }).catch(() => {})
  /* The debugger sockets keep node's event loop alive long after the last
     answer, so a script that merely runs out of work here sits for minutes
     printing nothing. */
  process.exit(exitCode)
}
