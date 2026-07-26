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

const api = window.tulip

/* The languages the main process will accept, repeated here so the reading
   view can decide whether to draw the control at all without a round trip.
   Kept in step with RUNNERS in electron/main.js. */
const RUNNABLE = new Set([
  'js', 'javascript', 'node', 'mjs', 'cjs',
  'py', 'python', 'python3',
  'sh', 'shell', 'bash', 'zsh'
])

export function isRunnable (lang) {
  return RUNNABLE.has(String(lang || '').trim().toLowerCase())
}

/* Every result this session, keyed by the code itself. Two blocks with the
   same body are the same run, and editing a block abandons its old output
   rather than showing yesterday's answer under today's code. Bounded, because
   a long session of edits would otherwise keep every draft's output alive. */
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
    state[stream] += text
    state.render()
    return
  }
  const box = held(id)
  box[stream] += text
})

api.on('run:done', (payload) => {
  const state = live.get(payload.id)
  if (state) {
    live.delete(payload.id)
    Object.assign(state, payload, { status: 'done' })
    state.render()
    return
  }
  held(payload.id).done = payload
})

function held (id) {
  let box = inbox.get(id)
  if (!box) inbox.set(id, (box = { stdout: '', stderr: '', done: null }))
  return box
}

/**
 * A blank run state. Manim keeps its own view but streams through the same
 * machinery, so the two cannot drift over what "running" looks like.
 */
export function runState () {
  return {
    status: 'idle',
    stdout: '',
    stderr: '',
    code: null,
    painters: new Set(),
    render () { for (const paint of this.painters) paint() }
  }
}

/** Hand a started run its view, replaying anything that arrived first. */
export function adopt (id, state) {
  const box = inbox.get(id)
  if (box) {
    inbox.delete(id)
    state.stdout += box.stdout
    state.stderr += box.stderr
    if (box.done) {
      Object.assign(state, box.done, { status: 'done' })
      state.render()
      return
    }
  }
  live.set(id, state)
  state.render()
}

function stateFor (code) {
  let state = results.get(code)
  if (state) return state

  /* One state can be on screen more than once — the same snippet twice in a
     note — so every panel showing it registers its own painter. */
  state = runState()
  if (results.size >= MAX_RESULTS) results.delete(results.keys().next().value)
  results.set(code, state)
  return state
}

/* -------------------------------------------------------------- the box */

function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

/* An invoke that throws arrives wrapped in Electron's own framing —
   "Error invoking remote method 'run:start': Error: …" — and only the sentence
   the handler wrote is worth showing. */
function reason (err) {
  const text = String(err?.message || err)
  const at = text.lastIndexOf('Error: ')
  return at === -1 ? text : text.slice(at + 'Error: '.length)
}

/** How a finished run is summarised in a line: what happened, and how long. */
function verdict (state) {
  if (state.error) return { text: state.error, tone: 'bad' }
  if (state.timedOut) return { text: `Timed out after ${(state.ms / 1000).toFixed(1)}s`, tone: 'bad' }
  if (state.signal) return { text: 'Stopped', tone: 'warn' }
  const ms = state.ms < 1000 ? `${state.ms} ms` : `${(state.ms / 1000).toFixed(1)} s`
  return state.code === 0
    ? { text: `Exit 0 · ${ms}`, tone: 'ok' }
    : { text: `Exit ${state.code} · ${ms}`, tone: 'bad' }
}

/**
 * Draws the output panel for one block. The panel is rebuilt in place on every
 * update rather than appended to, so a re-render after a note switch produces
 * exactly the same DOM as the run that filled it.
 */
function drawOutput (panel, state) {
  panel.replaceChildren()
  if (state.status === 'idle') { panel.hidden = true; return }
  panel.hidden = false

  const head = el('div', 'run-out-head')
  head.append(el('span', 'run-out-label', 'Output'))

  if (state.status === 'running') {
    head.append(el('span', 'run-out-verdict is-running', 'Running…'))
  } else {
    const v = verdict(state)
    head.append(el('span', `run-out-verdict is-${v.tone}`, v.text))
  }
  panel.append(head)

  if (state.stdout) panel.append(el('pre', 'run-out-stream', state.stdout))
  // stderr is kept as its own stream rather than interleaved: which of the two
  // a line came from is information, and merging them throws it away.
  if (state.stderr) panel.append(el('pre', 'run-out-stream is-stderr', state.stderr))
  if (!state.stdout && !state.stderr && state.status === 'done') {
    panel.append(el('pre', 'run-out-stream is-empty', 'No output.'))
  }
  if (state.truncated) {
    panel.append(el('div', 'run-out-note', 'Output truncated — the block printed more than Tulip will hold.'))
  }
}

/**
 * Fits a code block with its run control and an output panel beneath it.
 *
 * @param {HTMLElement} wrap  the .code-wrap drawing the frame
 * @param {HTMLElement} head  the .code-head the control belongs in
 * @param {string} lang       the word after the fence
 * @param {string} code       the block's source
 */
export function attachRunControl (wrap, head, lang, code) {
  if (!isRunnable(lang)) return

  const state = stateFor(code)

  const button = el('button', 'run-btn')
  button.type = 'button'

  const panel = el('div', 'run-out')
  panel.setAttribute('role', 'group')
  panel.setAttribute('aria-label', 'Output')
  panel.setAttribute('aria-live', 'polite')
  // A sibling of the frame rather than a child, so a long output line scrolls
  // in its own box instead of widening the code above it.
  wrap.after(panel)

  const paint = () => {
    // The reading view rebuilds wholesale, so a panel from a previous render is
    // detached and has nothing left to say. It drops itself the first time it
    // is asked to draw.
    if (!panel.isConnected && panel.dataset.drawn) {
      state.painters.delete(paint)
      return
    }
    panel.dataset.drawn = '1'

    const running = state.status === 'running'
    button.classList.toggle('is-running', running)
    button.textContent = running ? 'Stop' : 'Run'
    button.title = running ? 'Stop this block' : `Run this block with ${lang}`
    button.setAttribute('aria-label', button.title)
    drawOutput(panel, state)
  }
  state.painters.add(paint)

  button.addEventListener('click', async () => {
    if (state.status === 'running') {
      api.run.kill(state.id).catch(() => {})
      return
    }

    Object.assign(state, {
      status: 'running',
      stdout: '',
      stderr: '',
      code: null,
      signal: null,
      error: null,
      timedOut: false,
      truncated: false
    })
    state.render()

    try {
      const { id } = await api.run.start(lang, code)
      state.id = id
      adopt(id, state)
    } catch (err) {
      Object.assign(state, { status: 'done', error: reason(err), ms: 0 })
      state.render()
    }
  })

  head.append(button)
  paint()
}
