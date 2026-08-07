/* ========================================================= jupyter kernels
   Running a notebook's cells, by borrowing a real Jupyter kernel.

   A notebook is not a pile of scripts. `import pandas as pd` in the first cell
   is meant to still be true in the fortieth, so the thing that runs cells has
   to be one process that stays alive between them — which is exactly what a
   kernel is, and exactly what the block runner in main.js is not.

   Three decisions shape this file:

   - It borrows rather than reimplements. Tulip spawns `jupyter server` on a
     loopback port with a secret token and talks to it over HTTP and a
     WebSocket, both of which Node already has. The alternative — speaking
     ZeroMQ to an `ipykernel` directly — means a native module, a per-platform
     rebuild, and hand-rolled HMAC signing, to arrive at the protocol the
     server already speaks. Borrowing also means every kernel the reader has
     installed works here for free: Python, Julia, Rust, whatever is in
     `jupyter kernelspec list`.

   - A kernel message is almost already an nbformat output. `stream`,
     `display_data`, `execute_result` and `error` carry the same fields under
     the same names as the four output types a notebook file records, which is
     not a coincidence — the file format is a log of these messages. So this
     file forwards the type and content and lets the viewer build the output,
     and a plot that arrives live is the same object as a plot read from disk.

   - One kernel per notebook, one server for the app. Two notebooks are two
     namespaces, the way two tabs in Jupyter are; but a second server would be
     a second Python start-up for nothing.

   Nothing here decides whether running is allowed. That gate is the vault
   trust prompt in main.js, and it is asked before the first spawn.
   ================================================================== */

'use strict'

const { spawn } = require('child_process')
const { killTree } = require('./kill-tree')
const crypto = require('crypto')
const net = require('net')
const path = require('path')

/* The server gets this long to answer /api/status before we give up on it. A
   cold Python start behind a virus scanner is genuinely slow, and the failure
   we are guarding against — jupyter is not installed — is reported by the
   spawn error instead, long before this runs out. */
const SERVER_TIMEOUT_MS = 60_000
const POLL_MS = 150

/* How the server is started, in the order worth trying. The `jupyter` launcher
   is the right answer when it is on PATH; `python3 -m jupyter_server` reaches
   the same code in an environment whose scripts directory is not. */
const LAUNCHERS = [
  { cmd: 'jupyter', args: ['server'] },
  { cmd: process.platform === 'win32' ? 'python' : 'python3', args: ['-m', 'jupyter_server'] }
]

/**
 * Where kernels are installed, for a server told to look somewhere else.
 *
 * `JUPYTER_PLATFORM_DIRS=1` below is what silences Jupyter's deprecation
 * warning about its own paths, and it moves the user data directory: on this
 * Mac from `~/Library/Jupyter` to `~/Library/Application Support/jupyter`. But
 * a kernel is installed by whoever packaged it — IJulia, evcxr, xeus-cling —
 * and those write to the legacy directory, because they run without the flag.
 * So the server started here saw ipykernel (which lives beside the Python that
 * imports it, not in either) and nothing else: a machine with three kernels
 * offered one, and the picker was telling the truth about a server that had
 * been pointed away from the answer.
 *
 * `JUPYTER_PATH` is the documented way to add data directories to the search,
 * so both are searched and it no longer matters which convention installed
 * what. The reader's own value is kept ahead of ours — it is a deliberate
 * instruction about where their kernels are, and this is a guess.
 */
function kernelSearchPath () {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const legacy = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Jupyter')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'jupyter')
      : path.join(home, '.local', 'share', 'jupyter')

  const parts = [...String(process.env.JUPYTER_PATH || '').split(path.delimiter), legacy]
  // Deduplicated and emptied of blanks, which a trailing delimiter leaves.
  return [...new Set(parts.filter(Boolean))].join(path.delimiter)
}

/** A port nothing is listening on, asked of the OS and handed straight over.
 *  There is a gap between letting go and jupyter binding it; `port_retries=0`
 *  turns losing that race into an error we can report rather than a server
 *  quietly running somewhere we are not looking. */
function freePort () {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The one server, started on demand.
 *
 * `options.pathFor` supplies the PATH to spawn with — main.js has already done
 * the work of asking the login shell — and `options.rootDir` is the folder the
 * server may see, which is the vault. Notebooks outside it still run; they get
 * a kernel whose working directory is the server root rather than their own,
 * which is the same compromise Jupyter itself makes.
 */
class KernelHost {
  constructor ({ pathFor = () => process.env.PATH, rootDir = null, onEvent = () => {} } = {}) {
    this.pathFor = pathFor
    this.rootDir = rootDir
    this.onEvent = onEvent
    this.server = null          // the promise of { port, token, child }
    /* And the same server's child process the moment it exists, reachable
       without awaiting anything. `before-quit` does not wait, and a promise is
       no use to it: quitting while the server is still starting used to leave
       a `jupyter server` running for as long as the machine was up, because
       the only handle on it was a `.then` that the process exit beat. */
    this.serverChild = null
    this.kernels = new Map()    // notebook path -> Kernel
    this.starting = new Map()   // notebook path -> the in-flight start
  }

  /** Point the next server at a different vault. An already-running server
   *  keeps the root it was started with — moving it would mean restarting
   *  every live kernel, and a vault switch closes those tabs anyway. */
  setRoot (dir) {
    this.rootDir = dir || null
  }

  async ensureServer () {
    if (this.server) return this.server
    const mine = this.#startServer().then(
      (host) => { this.#watchServer(host, mine); return host },
      (err) => {
        // A failed start must not be remembered as the running server, or the
        // reader gets one chance to have jupyter installed.
        if (this.server === mine) { this.server = null; this.serverChild = null }
        throw err
      }
    )
    this.server = mine
    return mine
  }

  /**
   * Notice when the server we are holding is no longer running.
   *
   * `this.server` is a resolved promise for the life of the app, so a server
   * that is OOM-killed, crashes, or is killed by hand from a terminal leaves
   * every later `ensureServer` handing back a dead `{ port, token, child }`.
   * Each call then fails with ECONNREFUSED, reported as "Could not read the
   * list of kernels", and the only cure was to restart Tulip. Forgetting it
   * here means the next ask starts a new one, which is what the reader
   * expected the first failure to do.
   */
  #watchServer (host, promise) {
    host.child.once('exit', () => {
      /* Only if it is still *the* server: a vault switch may already have
         replaced it, and clearing that one would strand a live process. */
      if (this.server === promise) { this.server = null; this.serverChild = null }
      /* The kernels it was hosting died with it. Dropping them stops a later
         shutdown from waiting on sockets that will never answer, and makes the
         next run start cleanly rather than fail against a stale id. */
      for (const [path, kernel] of this.kernels) {
        this.kernels.delete(path)
        try { kernel.closeSocket() } catch { /* nothing to close */ }
        this.onEvent({ path, kind: 'notice', text: 'The Jupyter server stopped. Run a cell to start it again.' })
      }
    })
  }

  async #startServer () {
    const port = await freePort()
    const token = crypto.randomBytes(24).toString('hex')

    const args = [
      '--no-browser',
      `--ServerApp.port=${port}`,
      '--ServerApp.port_retries=0',
      '--ServerApp.ip=127.0.0.1',
      `--IdentityProvider.token=${token}`,
      /* Bound to loopback and gated on a secret token, so the cross-site
         defence has nothing left to defend: there is no browser origin here
         at all, only this process. */
      '--ServerApp.disable_check_xsrf=True',
      '--ServerApp.open_browser=False',
      /* No `jupyter_server_config.py` of the reader's, no extensions: this
         server exists to run one app's cells, and a config written for their
         real Jupyter has no business changing how it behaves. */
      '--ServerApp.answer_yes=True'
    ]
    if (this.rootDir) args.push(`--ServerApp.root_dir=${this.rootDir}`)

    const env = {
      ...process.env,
      PATH: this.pathFor(),
      JUPYTER_PLATFORM_DIRS: '1',
      JUPYTER_PATH: kernelSearchPath()
    }
    const child = await this.#spawnFirstThatStarts(args, env)
    /* Named the moment it exists, and not when it is ready: the sixty seconds
       this may spend polling below are sixty seconds in which ⌘Q would
       otherwise have nothing to kill. See `serverChild`. */
    this.serverChild = child

    /* Readiness is the API answering, not the process existing. Jupyter is
       listening some seconds after exec, and a POST sent into that gap fails
       in a way that looks like a broken feature rather than a slow one. */
    const base = `http://127.0.0.1:${port}`
    const headers = { Authorization: `token ${token}` }
    const deadline = Date.now() + SERVER_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode != null) {
        throw new Error(`The Jupyter server stopped before it was ready.${child.tail ? `\n\n${child.tail()}` : ''}`)
      }
      try {
        const reply = await fetch(`${base}/api/status`, { headers })
        if (reply.ok) return { port, token, child, base, headers }
      } catch { /* not listening yet */ }
      await sleep(POLL_MS)
    }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    throw new Error('The Jupyter server did not start in time.')
  }

  /** Try each launcher, and keep the first whose process does not fail to
   *  execute. A missing `jupyter` is an ENOENT on spawn, which is the one
   *  failure worth falling through on. */
  async #spawnFirstThatStarts (args, env) {
    let last = null
    for (const launcher of LAUNCHERS) {
      try {
        return await this.#spawnOne(launcher, args, env)
      } catch (err) {
        last = err
        if (err?.code !== 'ENOENT') break
      }
    }
    throw new Error(
      'Tulip could not start a Jupyter server, so notebook cells cannot run.\n\n' +
      'Install it with `pip install jupyter`, then reopen this notebook.' +
      (last?.message ? `\n\n${last.message}` : '')
    )
  }

  #spawnOne (launcher, args, env) {
    return new Promise((resolve, reject) => {
      const child = spawn(launcher.cmd, [...launcher.args, ...args], {
        env,
        cwd: this.rootDir || undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // A process group, so a kernel that outlives its parent still goes.
        detached: process.platform !== 'win32'
      })

      /* The last of what it said, kept for the error message. Jupyter explains
         its own refusals — a bad root_dir, a taken port — on stderr, and
         reporting "it stopped" without that is reporting nothing. */
      const said = []
      const keep = (data) => {
        said.push(String(data))
        while (said.length > 40) said.shift()
      }
      child.stdout.on('data', keep)
      child.stderr.on('data', keep)
      child.tail = () => said.join('').trim().slice(-1200)

      child.once('error', reject)
      /* `spawn` fires once the process actually exists, and is the answer to
         the only question asked here: did this command run at all. The
         readiness poll above is what decides whether it works.

         It used to be a 120ms timer, which is a guess at how long an ENOENT
         takes to arrive. Lose that race on a loaded machine and a missing
         `jupyter` resolves as a running server: the fallback launcher is never
         tried, and the poll spends its full sixty seconds on a process that
         does not exist before reporting the wrong failure. */
      child.once('spawn', () => {
        child.removeListener('error', reject)
        child.once('error', () => {})
        resolve(child)
      })
    })
  }

  /** Every kernel spec the server can offer, and which one it defaults to. */
  async kernelSpecs () {
    const { base, headers } = await this.ensureServer()
    const reply = await fetch(`${base}/api/kernelspecs`, { headers })
    if (!reply.ok) throw new Error('Could not read the list of kernels.')
    const body = await reply.json()
    const specs = body.kernelspecs || {}
    return {
      default: body.default || 'python3',
      specs: Object.entries(specs).map(([name, entry]) => ({
        name,
        displayName: entry?.spec?.display_name || name,
        language: entry?.spec?.language || ''
      }))
    }
  }

  /**
   * The kernel for one notebook, started if it is not running yet.
   *
   * `wanted` is the notebook's own `kernelspec.name`. A file asking for a
   * kernel this machine does not have gets the server's default rather than an
   * error: a notebook written on someone else's laptop is still worth running,
   * and saying which kernel actually ran is what `language_info` is for.
   *
   * Two asks while one is starting wait on that one. Starting a kernel is
   * several round trips long, and two callers that both looked and both saw
   * nothing built two of them: the second took the map, and the first became a
   * Python process nothing could name, shut down or interrupt again.
   */
  kernelFor (notebookPath, wanted = '') {
    const existing = this.kernels.get(notebookPath)
    if (existing) return Promise.resolve(existing)
    const inflight = this.starting.get(notebookPath)
    if (inflight) return inflight

    const start = this.#startKernel(notebookPath, wanted)
      .finally(() => { this.starting.delete(notebookPath) })
    this.starting.set(notebookPath, start)
    return start
  }

  async #startKernel (notebookPath, wanted) {
    const host = await this.ensureServer()
    const { specs, default: fallback } = await this.kernelSpecs()
    const asked = String(wanted || '').trim()
    const known = specs.find((spec) => spec.name === asked)
    const name = known ? known.name : fallback

    const kernel = new Kernel({
      host,
      name,
      notebookPath,
      rootDir: this.rootDir,
      substituted: !!asked && !known ? asked : '',
      displayName: (known || specs.find((s) => s.name === name))?.displayName || name,
      onEvent: (event) => this.onEvent({ path: notebookPath, ...event })
    })
    this.kernels.set(notebookPath, kernel)
    try {
      await kernel.start()
    } catch (err) {
      this.kernels.delete(notebookPath)
      /* `start` creates the kernel on the server and *then* opens a socket to
         it. A connect that fails after the POST succeeded leaves a live Python
         process the server knows about and this app no longer names — so it
         could not be shut down, interrupted or restarted, and it sat there
         holding its memory until the whole server was torn down. `dispose`
         knows the id if there is one and issues the DELETE. */
      await kernel.dispose().catch(() => {})
      throw err
    }
    return kernel
  }

  get (notebookPath) {
    return this.kernels.get(notebookPath) || null
  }

  async shutdown (notebookPath) {
    /* A kernel that is still starting is one this would otherwise walk past,
       leaving the process it is about to become running for a notebook that
       has been closed — or, when the reader is swapping kernels, alongside its
       replacement. */
    const starting = this.starting.get(notebookPath)
    if (starting) await starting.catch(() => {})

    const kernel = this.kernels.get(notebookPath)
    if (!kernel) return false
    this.kernels.delete(notebookPath)
    await kernel.dispose().catch(() => {})
    return true
  }

  /** Everything, for quitting and for closing a window. Kernels first so the
   *  server is not torn down under a live execute. */
  async dispose () {
    /* Claimed up front, before the first await. This runs on a vault switch,
       and a vault switch is immediately followed by windows reopening their
       documents — so a `kernel:start` can land while the two awaits below are
       in flight and put a *new* server promise in `this.server`. Reading the
       field afterwards then killed the new one and left the old process, the
       one this was called to stop, running against a folder nobody is looking
       at any more with no handle on it anywhere. */
    const mine = this.server
    this.server = null
    this.serverChild = null

    const all = [...this.kernels.values()]
    this.kernels.clear()
    await Promise.all(all.map((kernel) => kernel.dispose().catch(() => {})))
    const host = mine ? await mine.catch(() => null) : null
    if (host?.child) killTree(host.child, 'SIGTERM')
  }

  /** Synchronous and best-effort, for `before-quit`, which does not wait. */
  disposeSync () {
    for (const kernel of this.kernels.values()) kernel.closeSocket()
    this.kernels.clear()
    /* The child itself, not the promise of it. A server still working through
       its startup poll has no resolved promise to hand anything over, and the
       `.then` this used to rely on never ran before the process went — which
       is exactly the case that leaked, because quitting during a slow first
       start is what people do when it feels stuck. */
    const child = this.serverChild
    this.server = null
    this.serverChild = null
    if (child) killTree(child, 'SIGKILL')
  }
}

/* -------------------------------------------------------------- one kernel */

/* The messages worth forwarding. Everything else on the iopub channel is
   bookkeeping the viewer has no use for — `execute_input` is echoed back to
   us, comm traffic belongs to widgets this app does not draw.

   `update_display_data` is not an output the file records, but it is an
   instruction about one: "the thing you drew under this id is now this". A
   library that redraws in place — sympy stepping through a derivation, a
   progress display that is not a widget, an animation frame — sends its first
   frame as `display_data` and every frame after it as an update. Dropping
   those left the first frame on screen for ever, which is the wrong answer
   told confidently. The viewer turns it back into the output it replaces. */
const OUTPUT_TYPES = new Set([
  'stream', 'display_data', 'update_display_data', 'execute_result', 'error', 'clear_output'
])

class Kernel {
  constructor ({ host, name, displayName, notebookPath, rootDir, substituted, onEvent }) {
    this.host = host
    this.name = name
    this.displayName = displayName
    this.notebookPath = notebookPath
    this.rootDir = rootDir
    this.substituted = substituted
    this.onEvent = onEvent
    this.id = null
    this.socket = null
    this.session = crypto.randomUUID()
    this.pending = new Map()    // msg_id -> { resolve, reject }
    /* Shell questions that are not cells: completion and inspection. Their own
       map because they settle on their reply rather than on the kernel going
       idle, and because failing them when the kernel dies must not look like a
       cell that finished. */
    this.asks = new Map()       // msg_id -> { replyType, settle, fail }
    /* The one `input_request` a kernel can have outstanding, and the header to
       answer it with. One, not a queue: a kernel blocked on `input()` is not
       running anything else, so a second request cannot exist until this one
       is answered. */
    this.stdin = null           // { parent, msgId }
    this.state = 'starting'
  }

  /** Everything anyone is waiting on, told that it is not coming. Three kinds
   *  of waiting, and a socket that goes takes all three with it. */
  #failEverything (err) {
    for (const [, waiter] of this.pending) waiter.reject(err)
    this.pending.clear()
    for (const [, ask] of this.asks) ask.fail(err)
    this.asks.clear()
    this.stdin = null
  }

  #url (suffix = '') {
    return `${this.host.base}/api/kernels${this.id ? `/${this.id}` : ''}${suffix}`
  }

  #setState (state) {
    if (this.state === state) return
    this.state = state
    this.onEvent({ kind: 'state', state, kernel: this.displayName })
  }

  async start () {
    /* The kernel's working directory, so that `read_csv("data.csv")` in a
       notebook means the file beside it — which is what it means in Jupyter,
       and the only reading of it that survives moving the notebook. Relative
       to the server root, and only when the notebook is under it. */
    const body = { name: this.name }
    if (this.rootDir && this.notebookPath) {
      const relative = path.relative(this.rootDir, path.dirname(this.notebookPath))
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        body.path = relative.split(path.sep).join('/')
      }
    }

    const reply = await fetch(this.#url(), {
      method: 'POST',
      headers: { ...this.host.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!reply.ok) {
      throw new Error(`The ${this.displayName} kernel would not start (${reply.status}).`)
    }
    this.id = (await reply.json()).id
    await this.#connect()
    this.#setState('idle')
    if (this.substituted) {
      this.onEvent({
        kind: 'notice',
        text: `This notebook asks for the “${this.substituted}” kernel, which is not ` +
              `installed. Running it with ${this.displayName} instead.`
      })
    }
  }

  #connect () {
    if (typeof WebSocket !== 'function') {
      return Promise.reject(new Error('This build has no WebSocket, so kernels cannot be reached.'))
    }
    const url = `ws://127.0.0.1:${this.host.port}/api/kernels/${this.id}/channels` +
      `?session_id=${this.session}&token=${this.host.token}`
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.onopen = () => { this.socket = socket; resolve() }
      socket.onerror = () => reject(new Error('Could not connect to the kernel.'))
      socket.onclose = () => {
        this.socket = null
        /* Whatever was mid-flight will never be answered now. Failing them is
           the difference between a cell that says what happened and a cell
           that says "Running…" until the app is restarted. */
        this.#failEverything(new Error('The kernel stopped.'))
        this.#setState('dead')
      }
      socket.onmessage = (event) => {
        let message
        try { message = JSON.parse(event.data) } catch { return }
        this.#receive(message)
      }
    })
  }

  #receive (message) {
    const parent = message.parent_header?.msg_id
    const type = message.msg_type
    const content = message.content || {}

    if (type === 'status') {
      /* Busy and idle describe the kernel, not the request — but an `idle`
         whose parent is our request is the protocol's own statement that
         everything for it has been sent. That, not the reply on the shell
         channel, is when a cell is finished. */
      if (content.execution_state === 'idle' && this.pending.has(parent)) {
        const waiter = this.pending.get(parent)
        this.pending.delete(parent)
        waiter.resolve({ status: waiter.status, executionCount: waiter.executionCount })
      }
      this.#setState(content.execution_state === 'busy' ? 'busy' : 'idle')
      return
    }

    const ask = this.asks.get(parent)
    if (ask) {
      if (type === ask.replyType) ask.settle(content)
      return
    }

    const waiter = this.pending.get(parent)
    if (!waiter) return

    /* `input()` reached. The kernel is now blocked until something answers it,
       which is why this is forwarded rather than refused: the viewer draws a
       line to type into, and `respondInput` below is where the answer goes. */
    if (type === 'input_request') {
      this.stdin = { parent: message.header, msgId: parent }
      this.onEvent({
        kind: 'input',
        msgId: parent,
        prompt: String(content.prompt ?? ''),
        password: content.password === true
      })
      return
    }

    if (type === 'execute_input') {
      waiter.executionCount = content.execution_count ?? null
      this.onEvent({
        kind: 'count',
        msgId: parent,
        executionCount: waiter.executionCount
      })
      return
    }

    if (type === 'execute_reply') {
      waiter.status = content.status || 'ok'
      if (content.execution_count != null) waiter.executionCount = content.execution_count
      return
    }

    if (OUTPUT_TYPES.has(type)) {
      if (type === 'error') waiter.status = 'error'
      /* Forwarded as the type and the content, not as a built output: the
         shapes are the viewer's to make, and it is the side with the tests
         for them. */
      this.onEvent({ kind: 'output', msgId: parent, msgType: type, content })
    }
  }

  /** One wire message, in the envelope every channel wants. */
  #envelope (msgType, content, { channel = 'shell', parent = {}, msgId = null } = {}) {
    return {
      header: {
        msg_id: msgId || crypto.randomUUID(),
        session: this.session,
        username: 'tulip',
        date: new Date().toISOString(),
        msg_type: msgType,
        version: '5.3'
      },
      parent_header: parent,
      metadata: {},
      channel,
      content
    }
  }

  /**
   * Run one cell.
   *
   * Returns the request's id straight away and a `done` that settles when the
   * kernel goes idle for it. Both halves matter: the id is how the viewer
   * knows which cell the output events belong to, and it has to be knowable
   * before any of them arrive. Output never comes back through `done` — a cell
   * that prints for ten seconds should be readable for ten seconds rather than
   * all at once at the end.
   */
  execute (code) {
    if (!this.socket) throw new Error('The kernel is not running.')
    const msgId = crypto.randomUUID()
    const message = this.#envelope('execute_request', {
      code: String(code ?? ''),
      silent: false,
      store_history: true,
      user_expressions: {},
      /* Allowed, because there is now somewhere to type the answer: an
         `input_request` becomes a line under the running cell, and
         `respondInput` sends back what was typed. Refusing it used to be the
         honest thing to do — a kernel waiting on an answer that could never
         come is a cell that hangs for no visible reason — but the honest
         answer to `input()` is a prompt, not an exception. */
      allow_stdin: true,
      stop_on_error: true
    }, { msgId })

    const done = new Promise((resolve, reject) => {
      this.pending.set(msgId, { resolve, reject, status: 'ok', executionCount: null })
    })
    try {
      this.socket.send(JSON.stringify(message))
    } catch (err) {
      this.pending.delete(msgId)
      throw err
    }
    return { msgId, done }
  }

  /**
   * Answer the `input()` a cell is blocked on.
   *
   * Nothing is remembered about the answer here: the prompt and what was typed
   * belong in the cell's output, which is the viewer's to write — and which is
   * what the kernel itself echoes to stdout anyway.
   */
  respondInput (value) {
    if (!this.socket || !this.stdin) return false
    const { parent } = this.stdin
    this.stdin = null
    this.socket.send(JSON.stringify(
      this.#envelope('input_reply', { value: String(value ?? '') }, { channel: 'stdin', parent })
    ))
    return true
  }

  /**
   * A question with one answer: what completes here, and what is this.
   *
   * Unlike `execute` these are wanted whole and wanted quickly — nothing is
   * drawn until the reply lands — so the reply content comes straight back
   * rather than through the event stream. Bounded by a timeout because a wedged
   * kernel must not leave a Tab key hanging for ever; a completion that does
   * not arrive is simply no completion.
   */
  #askShell (msgType, content, timeoutMs = 4000) {
    if (!this.socket) return Promise.reject(new Error('The kernel is not running.'))
    const msgId = crypto.randomUUID()
    const replyType = msgType.replace('_request', '_reply')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.asks.delete(msgId)
        reject(new Error(`The kernel did not answer the ${msgType}.`))
      }, timeoutMs)
      this.asks.set(msgId, {
        replyType,
        settle: (reply) => { clearTimeout(timer); this.asks.delete(msgId); resolve(reply) },
        fail: (err) => { clearTimeout(timer); this.asks.delete(msgId); reject(err) }
      })
      try {
        this.socket.send(JSON.stringify(this.#envelope(msgType, content, { msgId })))
      } catch (err) {
        clearTimeout(timer)
        this.asks.delete(msgId)
        reject(err)
      }
    })
  }

  complete (code, cursorPos) {
    return this.#askShell('complete_request', {
      code: String(code ?? ''),
      cursor_pos: Number(cursorPos) || 0
    })
  }

  /** `detail_level: 0` is the one-screen summary — a signature and the first
   *  paragraph of the docstring. Level 1 is the source, which is a different
   *  question than the one ⇧Tab asks. */
  inspect (code, cursorPos) {
    return this.#askShell('inspect_request', {
      code: String(code ?? ''),
      cursor_pos: Number(cursorPos) || 0,
      detail_level: 0
    })
  }

  async interrupt () {
    if (!this.id) return false
    /* A kernel blocked on `input()` is interrupted out of the read, so the
       request it was blocked on is answered by nobody and must not be left
       looking answerable. */
    this.stdin = null
    const reply = await fetch(this.#url('/interrupt'), { method: 'POST', headers: this.host.headers })
    return reply.ok
  }

  /** A restart is the only way back from a kernel that is wedged, and it is
   *  also the thing that throws away every variable — so the viewer asks
   *  before calling it, and says which of those two it is doing. */
  async restart () {
    if (!this.id) return false
    const reply = await fetch(this.#url('/restart'), { method: 'POST', headers: this.host.headers })
    if (!reply.ok) return false
    this.#failEverything(new Error('The kernel was restarted.'))
    /* The old socket belongs to the old process. Reconnecting is not optional
       tidiness: messages sent down it after a restart are answered by nobody. */
    this.closeSocket()
    await this.#connect()
    this.#setState('idle')
    return true
  }

  closeSocket () {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.onclose = null
    socket.onmessage = null
    socket.onerror = null
    try { socket.close() } catch { /* already closed */ }
  }

  async dispose () {
    this.closeSocket()
    this.#failEverything(new Error('The kernel was shut down.'))
    if (!this.id) return
    const id = this.id
    this.id = null
    await fetch(`${this.host.base}/api/kernels/${id}`, {
      method: 'DELETE',
      headers: this.host.headers
    }).catch(() => {})
  }
}

module.exports = { KernelHost }
