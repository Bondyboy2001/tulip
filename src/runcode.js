/* ========================================================== running code
   A fenced block in a runnable language gets a control that executes it and
   shows what came back underneath.

   Two rules shape everything here. The renderer never spawns anything — it
   asks `window.tulip.run` by name and the main process decides — and the
   output is never written back into the note. Results live in the session
   store below, so switching notes and returning keeps what you saw, and
   quitting Tulip forgets it. A note is what you wrote, not what your machine
   printed the last time you ran it.
   ================================================================== */

import { renderedBlock } from './blocks.js'
import { el, svgIcon } from './dom.js'
import { runners as RUNNERS } from '../electron/runnable-languages.json'

const api = window.tulip

/* The languages the main process will accept, read from the one list both
   sides read — see electron/runnable-languages.json. The reading view decides
   whether to draw the control at all without a round trip, and cannot decide
   it differently from the process that would run the block. */
const RUNNABLE = new Set(Object.values(RUNNERS).flat())
const WARMABLE = new Set([
  ...(RUNNERS.rust || []),
  ...(RUNNERS.cpp || []),
  ...(RUNNERS.cuda || [])
])
const warming = new Set()

export function isRunnable (lang) {
  return RUNNABLE.has(String(lang || '').trim().toLowerCase())
}

/* Every result this session, keyed by the language and the code together. Two
   blocks with the same body are the same run — but only in the same language;
   the same three lines under ```py and ```jl are two different programs, and
   one key for both had Run on one flipping the other's button. Editing a block
   abandons its old output rather than showing yesterday's answer under today's
   code. Bounded, because a long session of edits would otherwise keep every
   draft's output alive. */
const results = new Map()
const MAX_RESULTS = 200

/* Runs the page is currently watching, and a holding pen for output that
   arrives before the renderer has learned the run's id — `run:start` resolves
   over the same channel the output comes down, so the first chunk can and does
   overtake it. */
const live = new Map()
const inbox = new Map()

api.on('run:out', ({ id, stream, text }) => {
  const state = live.get(id)
  if (state) {
    appendOutput(state, stream, text)
    scheduleRender(state)
    return
  }
  const box = held(id)
  appendOutput(box, stream, text)
})

/* A chatty process can deliver hundreds of chunks between two screen paints.
   Rebuilding the complete output panel for every one makes rendering grow with
   the square of the output: chunk 200 redraws chunks 1 through 199 yet again.
   One paint per frame keeps streaming live while doing only the work a person
   can see. `run:done` still paints immediately below, so the last frame cannot
   lag behind the verdict. */
const pendingRenders = new Set()
let renderFrame = null

function scheduleRender (state) {
  pendingRenders.add(state)
  if (renderFrame != null) return
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null
    const states = [...pendingRenders]
    pendingRenders.clear()
    for (const pending of states) pending.render()
  })
}

function renderNow (state) {
  pendingRenders.delete(state)
  state.render()
}

api.on('run:done', (payload) => {
  const state = live.get(payload.id)
  if (state) {
    live.delete(payload.id)
    finishOutput(state)
    Object.assign(state, payload, { status: 'done' })
    renderNow(state)
    settleRun(state)
    return
  }
  held(payload.id).done = payload
})

/**
 * Tell whoever is waiting that this run is over.
 *
 * "Run all" awaits each block before starting the next, and a run that landed
 * on `done` without saying so would leave the sweep waiting for the rest of the
 * session — so every path that sets that status calls this, including the one
 * where the run never started at all. A holding-pen box (see `held`) has no
 * waiters, which is why the set is optional.
 */
function settleRun (state) {
  if (!state.settlers?.size) return
  const waiting = [...state.settlers]
  state.settlers.clear()
  for (const done of waiting) done()
}

/** A promise for the end of this run, resolved at once when it has already ended. */
function whenSettled (state) {
  if (state.status !== 'running') return Promise.resolve()
  return new Promise((resolve) => state.settlers.add(resolve))
}

function held (id) {
  let box = inbox.get(id)
  if (!box) inbox.set(id, (box = outputState({ done: null })))
  return box
}

/* Streaming ANSI decoder. Output arrives at arbitrary byte boundaries, so an
   escape can begin in one IPC message and finish in the next. Keeping the tiny
   parser state lets panels consume only new visible text rather than stripping
   the complete transcript again on every animation frame. */
function ansiState () { return { mode: 'text', pending: '' } }

export function stripAnsiChunk (state, chunk, final = false) {
  let out = ''
  for (const char of String(chunk || '')) {
    if (state.mode === 'text') {
      if (char === '\x1b') { state.mode = 'esc'; state.pending = char } else out += char
      continue
    }

    state.pending += char
    if (state.mode === 'esc') {
      if (char === '[') { state.mode = 'csi'; continue }
      if (char === ']') { state.mode = 'osc'; continue }
      if (/[@-Z\\-_]/.test(char)) { state.mode = 'text'; state.pending = ''; continue }
      out += state.pending
      state.mode = 'text'
      state.pending = ''
      continue
    }

    if (state.mode === 'csi') {
      if (/[@-~]/.test(char)) { state.mode = 'text'; state.pending = '' }
      continue
    }

    if (state.mode === 'osc') {
      if (char === '\x07') { state.mode = 'text'; state.pending = '' }
      else if (char === '\x1b') state.mode = 'osc-esc'
      continue
    }

    if (state.mode === 'osc-esc') {
      if (char === '\\' || char === '\x07') { state.mode = 'text'; state.pending = '' }
      else state.mode = char === '\x1b' ? 'osc-esc' : 'osc'
    }
  }

  if (final && state.mode !== 'text') {
    /* Match plain(): an unfinished CSI/lone escape remains literal, while an
       unterminated OSC title is discarded. */
    if (state.mode === 'esc' || state.mode === 'csi') out += state.pending
    state.mode = 'text'
    state.pending = ''
  }
  return out
}

function outputState (extra = {}) {
  return {
    stdout: '',
    stderr: '',
    ansi: { stdout: ansiState(), stderr: ansiState() },
    ...extra
  }
}

function appendOutput (state, stream, text) {
  if (stream !== 'stdout' && stream !== 'stderr') return
  state[stream] += stripAnsiChunk(state.ansi[stream], text)
}

function finishOutput (state) {
  for (const stream of ['stdout', 'stderr']) {
    state[stream] += stripAnsiChunk(state.ansi[stream], '', true)
  }
}

/* Rust and C++ pay most of their first click loading the compiler and having
   macOS admit the first locally-built executable. Start that harmless work in
   an idle moment as soon as a block control exists, rather than after Run is
   pressed. Main still decides whether the named runner supports warming. */
function warmRunner (lang) {
  const name = String(lang || '').trim().toLowerCase()
  if (!WARMABLE.has(name) || warming.has(name)) return
  warming.add(name)
  const begin = () => api.run.warm(name).catch(() => warming.delete(name))
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(begin, { timeout: 750 })
  } else {
    setTimeout(begin, 0)
  }
}

/**
 * What a run looks like with nothing behind it yet, on whichever status the
 * caller is putting it: `running` for one that is starting, `idle` for one whose
 * output has just been thrown away.
 *
 * Written out once because those two callers have to agree about what "no
 * output" is. They did not: clearing a panel by hand and starting a run cleared
 * different fields, so a cleared block kept the exit code of the run before it
 * and reported it again the moment anything repainted.
 */
function blankRun (status) {
  return {
    ...outputState(),
    status,
    code: null,
    id: null,
    ms: 0,
    buildMs: 0,
    stopRequested: false,
    signal: null,
    error: null,
    timedOut: false,
    truncated: false,
    path: null
  }
}

/**
 * A blank run state. Manim keeps its own view but streams through the same
 * machinery, so the two cannot drift over what "running" looks like.
 */
function runState () {
  return {
    ...blankRun('idle'),
    painters: new Set(),
    settlers: new Set(),
    render () { for (const paint of this.painters) paint() }
  }
}

/**
 * The run state for one block, shared through `map` under `key` — so a rebuilt
 * widget adopts the run its predecessor started instead of stranding it. The
 * key is remembered on the state so whoever finishes with it can retire the
 * entry.
 */
function adoptRun (map, key) {
  let state = map.get(key)
  if (!state) {
    state = runState()
    state.key = key
    map.set(key, state)
  }
  return state
}

/** Hand a started run its view, replaying anything that arrived first. */
function adopt (id, state) {
  const box = inbox.get(id)
  if (box) {
    inbox.delete(id)
    state.stdout += box.stdout
    state.stderr += box.stderr
    state.ansi = box.ansi
    if (box.done) {
      finishOutput(state)
      Object.assign(state, box.done, { status: 'done' })
      state.render()
      settleRun(state)
      return
    }
  }
  live.set(id, state)
  state.render()
}

/* The language and the body together — see the note over `results`. */
function runKey (lang, code) {
  return `${String(lang || '').trim().toLowerCase()}\n${code}`
}

function stateFor (lang, code) {
  const key = runKey(lang, code)
  let state = results.get(key)
  if (state) {
    /* Re-entered so a block still on screen counts as recent. Insertion order
       is the only recency a Map keeps, and without this the cache evicted by
       age-of-first-run — the note you have open all session was the first
       thing to go. */
    results.delete(key)
    results.set(key, state)
    return state
  }

  /* One state can be on screen more than once — the same snippet twice in a
     note — so every panel showing it registers its own painter. */
  state = runState()
  if (results.size >= MAX_RESULTS) {
    /* Oldest first, but never a run still going: evicted mid-run, the next
       widget rebuild would mint a fresh idle state for the same code while
       the live one streamed into panels nothing points at any more. */
    for (const old of results.keys()) {
      if (results.get(old).status !== 'running') { results.delete(old); break }
    }
  }
  results.set(key, state)
  return state
}

/* An invoke that throws arrives wrapped in Electron's own framing —
   "Error invoking remote method 'run:start': Error: …" — and only the sentence
   the handler wrote is worth showing. */
function reason (err) {
  const text = String(err?.message || err)
  const at = text.lastIndexOf('Error: ')
  return at === -1 ? text : text.slice(at + 'Error: '.length)
}

/**
 * Starts a piece of work and hands its state the run it produced.
 *
 * Every runner goes through here — a snippet, a scene, a picture — so none of
 * them can have its own idea of what "starting" clears or of how a refused
 * start is reported. `start` returns whatever the main process said; the `id`
 * in it is the run, and the rest is the caller's.
 *
 * @param {object} state          from runState()
 * @param {() => Promise<{id: number}>} start
 * @returns {Promise<object|null>}  what start() said, or null if it threw
 */
async function launch (state, start) {
  Object.assign(state, blankRun('running'))
  state.render()

  try {
    const result = await start()
    state.id = result.id
    adopt(result.id, state)
    /* Stop was clicked while start() was still in flight — there was no id to
       kill then, so the wish was parked on the state. Honour it now. */
    if (state.stopRequested) {
      state.stopRequested = false
      api.run.kill(result.id).catch(() => {})
    }
    return result
  } catch (err) {
    Object.assign(state, { status: 'done', error: reason(err), ms: 0, stopRequested: false })
    state.render()
    settleRun(state)
    return null
  }
}

/**
 * Run these blocks one after another, and answer with what became of them.
 *
 * One at a time, and awaited: a note with twenty blocks in it would otherwise
 * start twenty processes in the same instant, on a machine somebody is reading
 * on — the same argument `AUTO_AT_ONCE` makes above, in its strictest form,
 * because these are whole programs rather than drawings.
 *
 * A block that fails does not end the sweep. Every block here is its own
 * process with its own state, so the one after it is unaffected — unlike a
 * notebook, where the cell below a raised exception runs against a session that
 * never happened (see runCells in notebook.js). A block stopped by hand does
 * end it: while the sweep is going, Stop is the only way to say "enough".
 *
 * @param {{lang: string, code: string}[]} blocks
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{ran: number, failed: number, stopped: boolean}>}
 */
export async function runBlocksInOrder (blocks, onProgress) {
  const summary = { ran: 0, failed: 0, stopped: false }

  for (const [index, block] of blocks.entries()) {
    onProgress?.(index, blocks.length)
    const state = stateFor(block.lang, block.code)
    /* Already going — because the reader pressed its button a moment ago, or
       because the same snippet appears twice in the note. Joined rather than
       restarted: killing a run somebody started by hand to start the identical
       run again is work for nothing. */
    if (state.status !== 'running') {
      await launch(state, () => api.run.start(block.lang, block.code))
    }
    await whenSettled(state)
    summary.ran++
    if (state.signal) { summary.stopped = true; break }
    if (state.error || state.timedOut || state.code !== 0) summary.failed++
  }

  return summary
}

/**
 * Throw away what these blocks last printed.
 *
 * The state object is emptied rather than dropped from `results`: every panel
 * on screen is painting from the object it was handed, so a deleted entry would
 * leave those panels showing the old output for ever while the next run built a
 * fresh state nothing pointed at.
 *
 * A running block is left alone and counted, because clearing it would empty a
 * panel that is about to fill again — and the caller has something to say about
 * that.
 *
 * @param {{lang: string, code: string}[]} blocks
 * @returns {{cleared: number, running: number}}
 */
export function clearBlockOutputs (blocks) {
  const summary = { cleared: 0, running: 0 }

  for (const { lang, code } of blocks) {
    const state = results.get(runKey(lang, code))
    if (!state || state.status === 'idle') continue
    if (state.status === 'running') { summary.running++; continue }
    Object.assign(state, blankRun('idle'))
    state.render()
    summary.cleared++
  }

  return summary
}

/**
 * Stop a run, including one still starting. Between the click on Run and
 * `start()` resolving there is no id yet, and killing `undefined` is a no-op
 * that leaves the run going while the button says it stopped — so in that
 * window the request is flagged on the state and launch() carries it out the
 * moment the id arrives.
 */
function requestStop (state) {
  if (state.id != null) {
    api.run.kill(state.id).catch(() => {})
    return
  }
  state.stopRequested = true
}

/* Escape sequences a runner may still put in a stored error or diagnostic
   despite the env saying not to (see startRun's env in main.js): CSI —
   colours, cursor moves — OSC — titles and hyperlinks — and lone two-byte
   escapes. Streamed output is already decoded incrementally above; keeping
   this idempotent cleanup covers non-stream payloads and older saved state. */
const ANSI = /\x1b(?:\[[0-9;?]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g

function plain (text) {
  return String(text || '').replace(ANSI, '')
}

/** The line of a runner's chatter worth showing while a compact render works. */
function lastLine (text) {
  const lines = plain(text).trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line) return line.slice(0, 90)
  }
  return ''
}

/**
 * The status line under a block that renders to a file — a scene, a picture.
 *
 * These do not report their output the way a snippet does: the artefact is the
 * result, so a finished render says nothing at all, and a failed one has to say
 * everything, because "no file" is the only reliable signal there is. TeX will
 * report an error and still exit 0 in some configurations, and a manim scene
 * that raises exits non-zero with nothing in `error`.
 *
 * @param {HTMLElement} status  the panel to fill
 * @param {object} state        from runState()
 * @param {{busy: string, keep: number, silent: string, transcript?: boolean}} words
 * @param {HTMLElement|null} stop  a Stop control for a transcript that replaces its source
 */
function drawArtefactStatus (status, state, { busy, keep, silent, transcript }, stop) {
  status.replaceChildren()
  status.classList.remove('is-bad')
  if (state.status === 'idle') { status.hidden = true; return }

  const bar = el('div', 'run-out-head')

  if (state.status === 'running') {
    bar.append(el('span', 'run-out-verdict is-running', busy))
    if (transcript && stop) bar.append(stop)
    status.append(bar)
    if (transcript) {
      if (state.stdout) status.append(el('pre', 'run-out-stream', plain(state.stdout)))
      if (state.stderr) status.append(el('pre', 'run-out-stream is-stderr', plain(state.stderr)))
      if (state.truncated) {
        status.append(el('div', 'run-out-note',
          'Output truncated — the render printed more than Tulip will hold.'))
      }
    } else {
      const note = lastLine(state.stdout) || lastLine(state.stderr)
      if (note) status.append(el('pre', 'run-out-stream', note))
    }
    status.hidden = false
    if (transcript) status.scrollTop = status.scrollHeight
    return
  }

  // A finished render speaks for itself: the picture is the result, and a
  // green "Exit 0" under it would be noise.
  if (state.path) { status.hidden = true; return }

  bar.append(el('span', 'run-out-verdict is-bad',
    state.timedOut ? 'Timed out' : state.signal ? 'Stopped' : 'Failed'))
  status.append(bar)
  /* Reached only when there is no artefact to show, which for a render is the
     definition of a failure — including the stopped case, where the words
     above already say `is-bad` for the same reason. */
  status.classList.add('is-bad')

  const said = plain(state.error || '')
  if (said) status.append(el('pre', 'run-out-stream is-stderr', said))
  if (transcript && state.stdout) status.append(el('pre', 'run-out-stream', plain(state.stdout)))
  const trace = plain(state.stderr)
  if (trace) {
    status.append(el('pre', 'run-out-stream is-stderr',
      transcript ? trace : trace.trim().slice(-keep)))
  }
  if (!said && !state.stdout && !trace) {
    status.append(el('pre', 'run-out-stream is-stderr', silent(state)))
  }
  if (transcript && state.truncated) {
    status.append(el('div', 'run-out-note',
      'Output truncated — the render printed more than Tulip will hold.'))
  }
  status.hidden = false
}

/** The panel those statuses are drawn into. */
function artefactStatus (className) {
  const status = el('div', `run-out ${className}`)
  status.setAttribute('aria-live', 'polite')
  status.hidden = true
  return status
}

/**
 * The whole control behind a block that renders to a file — a scene, a picture.
 *
 * Manim and TikZ struck the same bargain in the same order, and each wrote it
 * out: adopt the run under a key so a rebuilt widget does not strand it, a
 * Run/Stop button, a status panel, a painter that retires the entry once the
 * result has been shown, and a lookup on mount so an artefact already on disk
 * appears without anything being started. Only the words and the two `api`
 * calls ever differed, and having it twice meant the fixes landed once — the
 * "adopt rather than strand" rule was learned separately in both files, which
 * is exactly the shape of thing that gets learned a third time.
 *
 * What is shown is tracked here as `shown`, so the caller is told about a path
 * only when it changes, and the button can say "again" once there is one.
 *
 * @param {Map} runs           the module's own in-flight table
 * @param {string} key         note and code together — see adoptRun
 * @param {object} spec
 * @param {string} spec.statusClass          the status panel's own class
 * @param {{busy: string, keep: number, silent: (s) => string, transcript?: boolean}} spec.words
 * @param {{stop: string, again: string, first: string}} spec.titles
 * @param {() => Promise<object>} spec.start   what running it is
 * @param {() => Promise<object>} spec.lookup  what is already on disk
 * @param {(path: string|null) => void} spec.onPath  an artefact arrived, or went
 * @param {() => boolean} [spec.alive]     is the caller's DOM still on the page
 * @param {() => void} [spec.willStart]    about to run
 * @param {(started: object|null) => void} [spec.didStart]  it started
 * @param {(hit: object) => void} [spec.onHit]  the lookup found one
 * @param {() => void} [spec.onMiss]  the lookup found nothing on disk
 * @param {(state: object) => void} [spec.onPaint]  the status changed shape; re-measure
 * @returns {{button: HTMLElement, status: HTMLElement, begin: () => Promise<void>}}
 */
export function artefactRun (runs, key, {
  statusClass, words, titles, start, lookup, onPath,
  alive, willStart, didStart, onHit, onMiss, onPaint
}) {
  const state = adoptRun(runs, key)
  const status = artefactStatus(statusClass)
  const button = runButton()
  const stop = words.transcript ? runButton() : null
  if (stop) {
    drawRunFace(stop, true, titles.stop)
    stop.addEventListener('click', () => requestStop(state))
  }

  /* What is on screen, as against what the run last produced — the two differ
     exactly when there is something new to show. */
  let shown = null
  const settle = (path) => { shown = path; onPath(path) }

  /* One painter per attach, retiring with its element — a shared state
     accumulates a painter for every rebuild, and the dead ones must not keep
     drawing into detached DOM. */
  const paint = painter(state, button, () => {
    /* A run that ends hands back the path it wrote, or nothing at all — and
       once that has been shown, the shared entry has done its job. */
    if (state.status === 'done') {
      const path = state.path || null
      if (path !== shown) settle(path)
      runs.delete(state.key)
    }

    /* The words that would have been on the button are on it as the tooltip:
       whether this has already been rendered is worth saying, and it is the one
       thing the mark itself cannot. */
    const running = state.status === 'running'
    drawRunFace(button, running, running ? titles.stop : (shown ? titles.again : titles.first))
    drawArtefactStatus(status, state, words, stop)
    onPaint?.(state)
  })

  /* Starting it, as against asking for it to be started. A caller that renders
     the block without being clicked — see attachArtefactBlock's `auto` — goes
     through the same door the button does, so there is one path into a run. */
  const begin = async () => {
    if (state.status === 'running') return
    willStart?.()
    /* Awaited into a name of its own, rather than straight into the argument of
       `didStart?.()`: an optional call whose callee is nullish never evaluates
       its arguments, so a caller that wants no notification — a tikz picture —
       started no run either, and its button did nothing at all. */
    const started = await launch(state, start)
    didStart?.(started)
  }

  button.addEventListener('click', () => {
    if (state.status === 'running') { requestStop(state); return }
    begin()
  })

  paint()

  /* Already rendered? Then the artefact is what this block is, without anything
     being run at all — and if it is not, whoever wanted it rendered on sight is
     told so here, once the disk has answered. */
  lookup()
    .then((hit) => {
      if (alive?.() === false) return
      if (!hit?.path) { onMiss?.(); return }
      onHit?.(hit)
      settle(hit.path)
      paint()
    })
    .catch(() => {})

  return { button, status, begin }
}

/* Blocks whose render has been asked for on sight this session, so a note read
   twice does not run TeX twice — and, more to the point, so a block that cannot
   render at all is attempted once rather than on every repaint of the note.
   The button is still there for a second go. */
const askedFor = new Set()

/* How many blocks may draw themselves at once.

   A run started on sight is started by the note, not by the reader, and a page
   of lecture notes with thirty figures on it used to start thirty of them in
   the same instant — thirty TeX processes, each with the full drawing budget,
   competing for the machine the reader is trying to read on. A click is
   self-limiting because a person does the clicking; this is not, so it is
   limited here.

   Small on purpose. The first picture in the note is the one being waited for,
   and finishing it sooner matters more than starting the twelfth. */
const AUTO_AT_ONCE = 2
const autoWaiting = []
let autoRunning = 0

function pumpAuto () {
  while (autoRunning < AUTO_AT_ONCE && autoWaiting.length) {
    const next = autoWaiting.shift()
    autoRunning++
    /* `begin` resolves when the run is over either way — a failure is still a
       slot freed, and letting one stop the queue would leave the rest of the
       note's pictures undrawn. */
    Promise.resolve(next()).catch(() => {}).finally(() => {
      autoRunning--
      pumpAuto()
    })
  }
}

/** Put a draw-on-sight in the queue rather than starting it now. */
function queueAuto (begin) {
  autoWaiting.push(begin)
  pumpAuto()
}

/**
 * The reading view's shape for a block that renders to a file — a scene, a
 * picture. The shell, the control, the status, and what becomes of the artefact
 * when there is one.
 *
 * Manim and TikZ had written this out twice: the shell from blocks.js, the run
 * from artefactRun above, the status after the figure and the button in the
 * head — in that order, because any other order puts the status inside the
 * frame it is meant to stand under. Only three things ever differed, and they
 * are the three arguments below: what the artefact becomes on the page, the
 * words on the control, and whether the block renders itself when it is read.
 *
 * `auto` is for a render measured in seconds. A picture is what the block *is*,
 * so a reader should not have to ask for one — but a scene costs minutes of a
 * machine's attention, and starting that unbidden because someone opened a note
 * is not a thing to do to anybody. That block keeps its button.
 *
 * @param {HTMLElement} wrap  the .code-wrap holding the source
 * @param {HTMLElement} head  the .code-head the control belongs in
 * @param {object} spec
 * @param {Map} spec.runs      the caller's own in-flight table
 * @param {string} spec.key    note and code together — see adoptRun
 * @param {string} spec.kind   the figure's class; its stage and status follow it
 * @param {(path: string) => Element} spec.make  the artefact, as something to show
 * @param {boolean} [spec.auto]  render it when the note is read, not when asked
 * @param {(started: object|null) => void} [spec.onStarted]
 * @param {(hit: object) => void} [spec.onFound]
 * @returns {{view: object, run: object}}
 */
export function attachArtefactBlock (wrap, head, {
  runs, key, kind, words, titles, start, lookup, make,
  auto = false, onStarted, onFound
}) {
  const view = renderedBlock(wrap, kind)
  const transcript = Boolean(words.transcript)

  const run = artefactRun(runs, key, {
    statusClass: `${kind}-status`,
    words,
    titles,
    start,
    lookup,
    onPath: (path) => {
      if (path) {
        view.stage.replaceChildren(make(path))
        view.settle(true)
        return
      }
      /* A transcript is the whole of what a failed render has to say, and it is
         standing where the block was; showing the source again would take it
         away at the moment it is worth reading. A block without one has nothing
         to show but its source, so it goes back to that. */
      if (!transcript) view.settle(false)
    },
    // The reading view can be rebuilt under a render — a note switch and back —
    // and a lookup landing afterwards must not write into the detached copy.
    alive: () => wrap.isConnected,
    // The transcript takes the block's place while the render works, whether
    // this attachment started it or adopted it from the one before.
    willStart: transcript ? view.hide : undefined,
    onPaint: transcript
      ? (state) => { if (state.status === 'running') view.hide() }
      : undefined,
    onMiss: () => {
      if (!auto || askedFor.has(key) || !wrap.isConnected) return
      askedFor.add(key)
      /* Queued rather than begun: see `queueAuto`. The block may also have left
         the page while it waited its turn — a note switch is enough — and
         starting a render for a detached block is work nobody will ever see. */
      queueAuto(() => (wrap.isConnected ? run.begin() : undefined))
    },
    didStart: onStarted,
    onHit: onFound
  })

  view.figure.after(run.status)
  head.append(run.button)
  return { view, run }
}

/**
 * How a finished run is summarised in a line: what happened, and how long.
 *
 * The exit code is always stated — it is the one fact a run has to report — and
 * it is coloured by what it says: green for a clean exit, red for a failure or
 * a timeout. A run you stopped yourself is neither, and stays grey.
 */
function verdict (state) {
  const time = (n) => (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`)
  const ms = time(state.ms)
  if (state.error) return { text: plain(state.error), tone: 'bad' }
  if (state.timedOut) return { text: `timed out · ${ms}`, tone: 'bad' }
  if (state.signal) return { text: `stopped · ${ms}`, tone: 'plain' }

  // A compiled language spent most of that on the compiler, and saying so is
  // the difference between "Rust is slow" and "rustc is slow".
  const built = state.buildMs ? `${ms} · ${time(state.buildMs)} building` : ms
  return {
    text: `exit ${state.code} · ${built}`,
    tone: state.code === 0 ? 'good' : 'bad'
  }
}

/**
 * Where a failed run goes when the reader asks for help with it.
 *
 * Set by the renderer, which owns the copilot panel. Nothing here knows what a
 * copilot is — it hands over a finished question and lets the panel decide what
 * to do with it — and until something registers, the button is not drawn at all.
 */
let askToFix = null

export function onAskToFix (handler) {
  askToFix = handler
}

/* How much of what a failed block printed goes into that question: enough for
   a traceback and the lines around it, not the whole of a run that failed
   after printing a megabyte. */
const FIX_OUTPUT_MAX = 6000

/**
 * Is this a failure worth offering help with?
 *
 * A run stopped by hand is not one — you already know why it ended — and a
 * block that has not finished has nothing to explain yet.
 */
function worthFixing (state) {
  if (state.status !== 'done' || state.signal) return false
  return !!state.error || !!state.timedOut || state.code !== 0
}

/**
 * The question the copilot is asked, written the way the reader would write it:
 * the block, what became of it, and what it printed. The *end* of the output is
 * what is kept — a traceback finishes with the line that raised.
 */
function fixPrompt (lang, code, state) {
  const printed = plain([state.error, state.stdout, state.stderr]
    .filter(Boolean).join('\n')).trimEnd()
  const shown = printed.length > FIX_OUTPUT_MAX
    ? `…\n${printed.slice(-FIX_OUTPUT_MAX)}`
    : printed
  const what = state.timedOut
    ? 'it timed out'
    : state.error
      ? `it would not start: ${state.error}`
      : `it exited ${state.code}`

  return [
    `I ran this ${lang} block from the note I have open, and ${what}:`,
    '',
    '```' + lang,
    code.trimEnd(),
    '```',
    '',
    shown ? 'It printed:\n\n```\n' + shown + '\n```' : 'It printed nothing.',
    '',
    'Work out what is wrong and edit that block in the note to fix it. ' +
      'Change nothing else, and keep the explanation short.'
  ].join('\n')
}

/** The offer itself, standing in the output panel's header beside the verdict. */
function fixButton (lang, code, state) {
  const button = el('button', 'run-fix')
  button.type = 'button'
  button.title = 'Ask Copilot to fix this block'
  button.append(
    svgIcon(
      '<path d="M8 1.6 9.3 5.4 13 6.7 9.3 8 8 11.8 6.7 8 3 6.7 6.7 5.4Z"/>' +
      '<path d="M12.4 10.2l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5Z"/>',
      { className: 'run-fix-icon', fill: 'currentColor' }
    ),
    el('span', '', 'Fix with Copilot')
  )
  button.addEventListener('click', () => askToFix(fixPrompt(lang, code, state)))
  return button
}

/**
 * What one block's output panel holds, for whatever state its run is in.
 *
 * A block that printed nothing says so: an empty panel and a panel that never
 * opened look alike, and telling them apart is the whole of what the reader
 * came to the panel for.
 */
function drawOutput (panel, state, lang, code) {
  panel.replaceChildren()
  if (state.status === 'idle') { panel.hidden = true; return }
  panel.hidden = false

  const bar = el('div', 'run-out-head')
  if (state.status === 'running') {
    bar.append(el('span', 'run-out-verdict is-running', 'Running…'))
    panel.classList.remove('is-bad')
  } else {
    const said = verdict(state)
    // Before the verdict, not after it: the line is what the reader has just
    // read, and the offer is what they want next.
    if (askToFix && lang && worthFixing(state)) bar.append(fixButton(lang, code, state))
    bar.append(el('span', `run-out-verdict is-${said.tone}`, said.text))
    panel.classList.toggle('is-bad', said.tone === 'bad')
  }
  panel.append(bar)

  const out = state.stdout
  const err = state.stderr
  if (out) panel.append(el('pre', 'run-out-stream', out))
  if (err) panel.append(el('pre', 'run-out-stream is-stderr', err))
  if (!out && !err && state.status === 'done') {
    panel.append(el('pre', 'run-out-stream is-empty', 'No output.'))
  }
  if (state.truncated) {
    panel.append(el('div', 'run-out-note',
      'Output truncated — the block printed more than Tulip will hold.'))
  }
}

/* The stable DOM behind a running output panel. Only the newly arrived suffix
   is appended between frames; the panel is rebuilt once when a run starts and
   once when its final verdict replaces "Running…". */
function incrementalOutput (panel, state, lang, code) {
  let status = null
  let outAt = 0
  let errAt = 0
  let outNode = null
  let errNode = null

  const rebuild = () => {
    drawOutput(panel, state, lang, code)
    status = state.status
    outAt = state.stdout.length
    errAt = state.stderr.length
    const streams = panel.querySelectorAll('.run-out-stream:not(.is-empty)')
    outNode = [...streams].find((node) => !node.classList.contains('is-stderr')) || null
    errNode = [...streams].find((node) => node.classList.contains('is-stderr')) || null
  }

  return () => {
    if (state.status !== 'running' || status !== 'running') { rebuild(); return }

    const out = state.stdout
    const err = state.stderr
    if (out.length < outAt || err.length < errAt) { rebuild(); return }

    if (out.length > outAt) {
      if (!outNode) {
        outNode = el('pre', 'run-out-stream')
        panel.insertBefore(outNode, errNode)
      }
      outNode.append(document.createTextNode(out.slice(outAt)))
      outAt = out.length
    }
    if (err.length > errAt) {
      if (!errNode) {
        errNode = el('pre', 'run-out-stream is-stderr')
        panel.append(errNode)
      }
      errNode.append(document.createTextNode(err.slice(errAt)))
      errAt = err.length
    }
  }
}

/** The one button's two meanings: whichever of them the block is asking for. */
async function startOrStop (state, lang, code) {
  if (state.status === 'running') { requestStop(state); return }
  await launch(state, () => api.run.start(lang, code))
}

/**
 * Registers `draw` against a run and hands it back, so a view paints itself
 * once and is repainted by every chunk of output that arrives afterwards.
 *
 * A painter drops itself the first time it is asked to draw into an element
 * that has left the page — the only tear-down a running block ever needs.
 */
export function painter (state, node, draw) {
  const paint = () => {
    if (!node.isConnected && node.dataset.drawn) {
      state.painters.delete(paint)
      return
    }
    node.dataset.drawn = '1'
    draw()
  }
  state.painters.add(paint)
  /* Dropping itself on the next draw only reaches a block that is running —
     nothing asks an idle block's painters to draw. So the retire handle is left
     on the element for whoever tears it down; see retirePainters. */
  node.tkRetire = () => state.painters.delete(paint)
  node.dataset.painter = '1'
  return paint
}

/**
 * Retires every painter under `root`, for a caller that is about to throw the
 * subtree away.
 *
 * Without it a widget scrolled out of the viewport and back — or a note closed
 * and reopened — left its old painter behind, holding a detached element (and,
 * for an output panel, everything that block ever printed) for as long as the
 * session lasted.
 */
export function retirePainters (root) {
  if (!(root instanceof Element)) return
  root.tkRetire?.()
  for (const node of root.querySelectorAll('[data-painter]')) node.tkRetire?.()
}

/**
 * A Run/Stop button for one block. The state behind it is keyed by the language
 * and the code, so the same block's button in the editing view and in the
 * reading view drive one run between them.
 */
export function runButtonUI (lang, code) {
  warmRunner(lang)
  const state = stateFor(lang, code)
  const button = runButton()

  const paint = painter(state, button, () => {
    const running = state.status === 'running'
    drawRunFace(button, running, running ? 'Stop this block' : `Run this block with ${lang}`)
  })

  button.addEventListener('click', () => startOrStop(state, lang, code))
  paint()
  return button
}

/**
 * The button itself, for anything that starts a process against a block.
 *
 * Manim's render is the same gesture as a run — set something going, stop it
 * while it goes — so it is the same control, and only the tooltip differs. It
 * used to be a word ("Render", "Re-render", "Stop") beside blocks whose own
 * runs were a triangle, which read as two different kinds of thing. The html
 * preview (htmlrun.js) struck the same bargain, which is why this and
 * drawRunFace are exported.
 */
export function runButton () {
  const button = el('button', 'run-btn is-icon')
  button.type = 'button'
  return button
}

/**
 * Puts one of the button's two faces on it.
 *
 * Every painter runs on every chunk of output a run streams back, so the mark
 * is rebuilt when it changes face rather than thousands of times while one
 * face is on screen. The tooltip is set each time regardless: it is one string
 * assignment, and a caller may want to change the words without the face
 * changing — which is exactly what "Render" becoming "Render again" is.
 */
export function drawRunFace (button, running, title) {
  const face = running ? 'stop' : 'run'
  if (button.dataset.face !== face) {
    button.dataset.face = face
    button.classList.toggle('is-running', running)
    button.replaceChildren(runIcon(running))
  }
  button.title = title
  button.setAttribute('aria-label', title)
}

/**
 * The output panel for one block, drawing itself whenever the run moves.
 *
 * `onDraw` is how the editing view hears that the panel just changed height —
 * output arriving is a height the editor never measured, and one it has to be
 * told about or every line below the block sits a line from where it is drawn.
 */
export function runPanelUI (lang, code, className, onDraw) {
  const state = stateFor(lang, code)
  const panel = makePanel(className)
  const draw = incrementalOutput(panel, state, lang, code)
  painter(state, panel, () => {
    draw()
    onDraw?.()
  })()
  return panel
}

/**
 * The mark on the button: a filled triangle to start, a filled square to stop —
 * the same pair, on the same 16-unit grid, as every other icon in the app.
 */
function runIcon (running) {
  return svgIcon(
    running
      ? '<rect x="4.5" y="4.5" width="7" height="7" rx="1.4"/>'
      : '<path d="M5.4 4.3 12.4 8l-7 3.7Z" stroke="currentColor" stroke-width="1.2" ' +
        'stroke-linejoin="round"/>',
    { className: 'run-icon', fill: 'currentColor' }
  )
}

/* The box the output goes in: a named group, so a screen reader meets it as
   this block's output rather than as loose text after the code. */
function makePanel (className) {
  const panel = el('div', className ? `run-out ${className}` : 'run-out')
  panel.setAttribute('role', 'group')
  panel.setAttribute('aria-label', 'Output')
  panel.setAttribute('aria-live', 'polite')
  return panel
}

/**
 * The reading view's Run control: the button in the block's header, the output
 * under the frame. A block in a language Tulip cannot run gets neither.
 */
export function attachRunControl (wrap, head, lang, code) {
  if (!isRunnable(lang)) return

  // A sibling of the frame rather than a child, so a long output line scrolls
  // in its own box instead of widening the code above it.
  wrap.after(runPanelUI(lang, code))
  head.append(runButtonUI(lang, code))
}
