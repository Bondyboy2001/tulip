'use strict'

/**
 * The copilot, as a subprocess.
 *
 * No vendor here sells API access on a personal subscription, but opencode
 * ships a CLI that authenticates against one — so the copilot is `opencode`
 * run headlessly with the vault as its working directory, rather than an HTTP
 * client holding a key. That decision buys the file access for nothing: the
 * agent reads and writes notes through its own tools, Tulip's job is narrowed
 * to relaying what it says and noticing what it touched, and there is no key of
 * ours anywhere in it. Every model, and every gateway — OpenRouter, z.ai — is
 * configured inside that CLI, which is where its key already lives.
 *
 * Its event stream is translated into one vocabulary of Tulip's own — see
 * `publish` calls for the whole of it — so the renderer never learns whose
 * events they were. That indirection is what let a second CLI be added and
 * later dropped without the panel noticing either.
 */

const path = require('node:path')
const fs = require('node:fs')
const { spawn, execFile } = require('node:child_process')
const { killTree } = require('./kill-tree.js')
const { systemPrompt, promptFor, nothingSent } = require('./prompt.js')

/* The CLI and what it offers before it is asked. Shared with the renderer
   (src/models.js) rather than restated here: the same fact deciding what the
   dropdown shows and what this process will accept is how the two come to
   disagree. Same arrangement as vault-contract.json and zoom-steps.json. */
const CATALOGUE = require('./ai-models.json')
/* Keyed by id, for the facts this file needs about a provider that are not its
   models: the binary to run, the name to call it in an error, and how to ask it
   whether it is signed in. Taken from the catalogue rather than written out
   beside each `spawn`, so there is one answer to "what is opencode" and the
   settings pane reads the same one. */
const PROVIDERS = Object.fromEntries(CATALOGUE.providers.map((p) => [p.id, p]))
const PERMISSION_MODES = new Set(['read', 'ask', 'auto'])

/* opencode names its tools in lower case. Mapped here rather than in the
   renderer, so the panel goes on knowing one vocabulary. */
const OPENCODE_TOOLS = {
  read: 'Read', edit: 'Edit', write: 'Write', patch: 'Edit',
  bash: 'Bash', grep: 'Grep', glob: 'Glob', list: 'Glob',
  todowrite: 'TodoWrite', todoread: 'TodoWrite',
  webfetch: 'Fetch', task: 'Task'
}

/** Which of the shared tool names mean the file on disk has changed. */
const wrote = (name) => name === 'Edit' || name === 'Write'

/**
 * What the agent may reach for, as a fact about the process.
 *
 * `--agent plan` makes read-only read-only, and that was once the whole of the
 * fence — which left every other question to whatever opencode defaulted to.
 * opencode has no per-tool flag on `run`, but it does read a whole config out
 * of the environment, so the policy is spelled there and travels with the
 * spawn rather than being a file written into somebody's vault.
 *
 * What the three modes are actually about is the vault: whether notes change,
 * and how far a command may reach. Reading the web is not one of the questions
 * — every mode fetches — and the shell is drawn between looking and doing,
 * not between doing and doing it anywhere.
 *
 * Every grant is allow or deny, never ask. `run` is headless, so a question has
 * nowhere to go and comes back as "the user rejected permission to use this
 * specific tool call" — a refusal the panel then shows for a permission nobody
 * was ever offered. Whatever a mode does not decide here is decided against it.
 *
 * Which is how auto came to refuse the thing it is named for. Leaving the
 * working directory is a grant of its own, separate from `bash` and asked
 * about by default, so `cd /tmp && curl …` died on the step out of the vault
 * while the shell it ran in was allowed.
 */
const TOOL_POLICY = {
  /* Reading the web is reading. What read mode is a promise about is the vault
     — that nothing in it changes — and a page fetched into the reply changes
     nothing. */
  read: { bash: 'deny', webfetch: 'allow', external_directory: 'deny' },
  /* Ask has the shell, and the vault is the extent of it: `external_directory`
     is what makes "inside the vault" a fact about the process rather than a
     line in the prompt, and it is the whole of the difference from auto. */
  ask: {
    bash: 'allow', webfetch: 'allow', edit: 'allow', write: 'allow',
    external_directory: 'deny'
  },
  auto: {
    bash: 'allow', webfetch: 'allow', edit: 'allow', write: 'allow',
    external_directory: 'allow'
  }
}

/**
 * The policy, as the environment opencode reads it out of.
 *
 * Merged into whatever the user already has rather than replacing it —
 * `OPENCODE_CONFIG_CONTENT` is the inline config, so a user's own
 * `opencode.json` still applies and only these keys are stated on top. A name
 * that is not a mode states nothing and passes the variable through untouched.
 */
function policyEnv (mode) {
  const permission = TOOL_POLICY[mode]
  if (!permission) return {}
  let base = {}
  try {
    const had = process.env.OPENCODE_CONFIG_CONTENT
    if (had) base = JSON.parse(had) || {}
  } catch { /* an inline config we cannot read is one we do not extend */ }
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...base,
      permission: { ...(base.permission || {}), ...permission }
    })
  }
}

/* How much of what a tool said travels to the panel. Enough to read why a
   command failed or what a search turned up; not so much that a Read of a long
   note is copied across the bridge and then into a transcript kept on disk. */
const DETAIL_LIMIT = 2000

/**
 * What a tool reported, as text.
 *
 * A CLI hands this back in one of three shapes — a string, a list of blocks, or
 * an object with the output on a field of its own — so the shapes are flattened
 * here and the panel is given one thing to show. Trimmed to the limit
 * with a line saying so, because a truncation nobody is told about reads as a
 * tool that stopped early.
 */
function detailOf (value) {
  const parts = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.map((block) => (typeof block === 'string' ? block : block?.text || ''))
      : [String(value?.text ?? value?.output ?? '')]

  /* Joined only as far as the limit. A Read of a long note arrives here whole,
     and building the whole string to then throw all but the first two thousand
     characters away is the copy this function exists to avoid — the point is
     that the note does not travel across the bridge, not that it travels once
     more before being cut. The tail is still measured, because "and 40,000
     more" is most of what the truncation has to say. */
  let text = ''
  let over = 0
  for (const part of parts) {
    if (text.length < DETAIL_LIMIT + 1) text += (text ? '\n' : '') + part
    else over += part.length + 1
  }
  const trimmed = text.trim()
  const rest = Math.max(0, trimmed.length - DETAIL_LIMIT) + over
  return rest
    ? `${trimmed.slice(0, DETAIL_LIMIT)}\n… ${rest.toLocaleString()} more characters`
    : trimmed
}

let emit = () => {}
let vault = null

/**
 * One copilot per conversation, kept by the key the panel files it under.
 *
 * There used to be a single `session`, and with it a single copilot: a turn
 * running about one note was the whole app's turn, and a question asked about
 * another had to wait for it. A conversation is the unit the panel already
 * thinks in — its own transcript, its own thread to resume — so it is the unit
 * a process belongs to as well, and two notes can now be worked on at once.
 *
 * Everything below that used to read this global takes its session as an
 * argument instead. That is not ceremony: a process outlives its own session by
 * a few lines of stdout, and `mine()` — still the whole answer to "whose turn is
 * this?" — can only ask the question against the session the handler was built
 * for.
 */
const sessions = new Map()   // key -> { key, provider, model, effort, mode, write, proc, busy, thread, used, turnId }

/* A vault worked in all day opens more conversations than it closes, and each
   one that ever sent a message would otherwise keep a session object for the
   life of the app. Idle ones are dropped oldest-first; a busy one is never
   taken, because something is still streaming into it. */
const MAX_SESSIONS = 12

/** The key a call names, as a small printable string. `''` is a real key — the
 *  one an older renderer, which knew only one copilot, sends. */
const sessionKey = (value) => {
  const key = String(value ?? '').trim()
  return key.length <= 120 ? key : key.slice(0, 120)
}

const sessionFor = (key) => sessions.get(sessionKey(key)) || null

/** Every copilot there is, for the two callers that mean "all of them": a vault
 *  change and the app quitting. */
const allSessions = () => [...sessions.values()]

/**
 * What each thread has already been told, kept by thread rather than by session.
 *
 * A session is replaced whenever the model, the effort, the mode or the
 * conversation changes — and the replacement *resumes the same thread*, so
 * everything the old session had put in front of the model is still there. Held
 * on the session, the memory went with it: nudging the effort slider re-sent the
 * whole open note, the turn rules and the ranked PDF pages into a thread that
 * already carried all three. `send` already trusts a resumed thread for the
 * system prompt; this is the same trust, spent on the rest of the briefing.
 *
 * Keyed by thread id, which is the only identity that survives a respawn. A
 * thread with no id yet — the first turn of a conversation — gets a memory of
 * its own, filed under the id the moment the CLI issues one.
 *
 * Bounded, because a vault worked in all day opens threads faster than it
 * closes them and none of this is worth remembering forever. Oldest out first:
 * a thread nobody has spoken in for a hundred conversations is one whose next
 * message can afford to quote the note again.
 */
const MEMOS = new Map()   // thread id -> the `sent` record for that thread
const MAX_MEMOS = 100

function memoFor (thread) {
  if (!thread) return nothingSent()
  const had = MEMOS.get(thread)
  if (had) {
    // Freshest last, so the eviction below drops the least recently used.
    MEMOS.delete(thread)
    MEMOS.set(thread, had)
    return had
  }
  const made = nothingSent()
  MEMOS.set(thread, made)
  if (MEMOS.size > MAX_MEMOS) MEMOS.delete(MEMOS.keys().next().value)
  return made
}

/** The thread has a name now. File this session's memory under it, so the next
 *  session resuming that thread picks up what has already been said. */
function rememberThread (self) {
  const thread = self?.thread
  if (!thread || MEMOS.get(thread) === self.sent) return
  MEMOS.set(thread, self.sent)
  if (MEMOS.size > MAX_MEMOS) MEMOS.delete(MEMOS.keys().next().value)
}

/** Whether the running session may change files. Main asks before taking the
 *  before/after snapshots a review is built from: a read-only turn cannot have
 *  written anything, so the pair is two walks of the vault for a guaranteed
 *  empty diff. */
const canWrite = (key) => !!sessionFor(key)?.write

/** Every event carries the turn that caused it. Main may hold a terminal event
 * while it snapshots the vault, and without this identity an older completion
 * can arrive after a queued turn has begun and settle the newer one. */
function publish (event, owner) {
  emit({ ...event, turnId: event?.turnId || owner?.turnId || null })
}

/**
 * What the thread is carrying, counted for the turns nobody counts for us.
 *
 * opencode reports a running total on most of its models and says nothing at
 * all on some — and the panel hides its context ring for anything that reports
 * nothing, which left a conversation filling up with no way to watch it do so
 * until the turn that failed for want of room. Every character sent and every
 * character streamed back is added up here instead, and a turn ending with no
 * figure of the CLI's own reports this one, marked as the estimate it is.
 *
 * The reading is rough, and rough is the point: it is a number to watch climb,
 * not a bill. See `tokensIn` for what "rough" is worth here.
 */
function account (self, text) {
  if (self && text) self.tokens += tokensIn(text)
}

/**
 * What a tool put in front of the model, for the count above.
 *
 * A CLI reports output in the same three shapes `detailOf` flattens, and only
 * the string one was ever counted — so a provider handing back blocks filled
 * the context with the ring reading as if nothing had been sent. Weighed
 * rather than joined: what is wanted here is a number, and building the string
 * to throw it away is the copy `detailOf` already avoids.
 */

function accountOutput (self, value) {
  if (self) self.tokens += tokensOf(value)
}

/**
 * Characters to tokens, weighted by what the characters actually were.
 *
 * Four to a token is the English prose rule, and this ring is the only warning
 * a model whose CLI publishes no count ever gets — so being wrong by half in
 * the direction of "plenty of room left" is the one failure that costs a turn.
 * CJK runs closer to one character per token, and code and heavily punctuated
 * text closer to two and a half, both of which a vault has a great deal of.
 *
 * So the wide characters are counted apart and the rest is divided by a figure
 * that leans towards code rather than prose. Still an estimate, and still shown
 * with a `≈` beside it — the point is that it now errs towards saying the
 * conversation is fuller than it is, which is the harmless direction.
 */
const WIDE = /[ᄀ-ᇿ⺀-꓏가-퟿豈-﫿︰-﹏＀-｠￠-￦]|[\uD840-\uD87F][\uDC00-\uDFFF]/g

/** Roughly how many tokens this text is worth. Kept beside `account`, which is
 *  what feeds it, and exported for the tests that pin the ratios. */
function tokensIn (text) {
  const source = String(text || '')
  if (!source) return 0
  const wide = (source.match(WIDE) || []).length
  // A wide character is about a token on its own; the rest is nearer three
  // characters to a token once code and punctuation are in the mix.
  return Math.round(wide + (source.length - wide) / 3)
}

/** The same weighting over the three shapes a tool reports in — see `measure`.
 *  Summed per block rather than over a join, for the same reason `detailOf`
 *  does not build the whole string either. */
function tokensOf (value) {
  if (typeof value === 'string') return tokensIn(value)
  if (Array.isArray(value)) {
    let total = 0
    for (const block of value) total += tokensIn(typeof block === 'string' ? block : block?.text || '')
    return total
  }
  return tokensIn(String(value?.text ?? value?.output ?? ''))
}

/* A count, or nothing. Every figure a CLI reports about its own usage arrives
   as "a number if it bothered to send one", and the three ways that can fail —
   absent, unparseable, negative — all mean the same thing here: it did not say.
   Shared by both halves of `usageOf` so the total and its components are read
   to the same standard. */
const positive = (value) => {
  const result = Number(value)
  return Number.isFinite(result) && result > 0 ? result : 0
}

/** The usage shape emitted by OpenCode's `step-finish` event. */
function usageOf (tokens) {
  if (!tokens || typeof tokens !== 'object') return null

  /* A total, where one is published, is the CLI's own arithmetic and beats
     ours. Only when it is missing are the parts added up — and they are added
     up rather than picked from, because a component left out is a conversation
     reported as emptier than it is, which is the direction that surprises. */
  const direct = positive(tokens.total ?? tokens.totalTokens)
  if (direct) return { used: Math.round(direct) }

  const cache = tokens.cache || {}
  const used = positive(tokens.input ?? tokens.inputTokens) +
    positive(cache.read ?? tokens.cachedReadTokens) +
    positive(cache.write ?? tokens.cachedWriteTokens) +
    positive(tokens.output ?? tokens.outputTokens) +
    positive(tokens.reasoning ?? tokens.thoughtTokens)
  return used > 0 ? { used: Math.round(used) } : null
}

/* Already in tokens: the weighting is applied as each piece of text arrives,
   which is the only point at which what kind of text it was is still known. */
const estimated = (owner) => Math.round(owner?.tokens || 0)

/* A GUI app inherits a PATH that has never seen a login shell, and the CLI
   installs somewhere only a profile knows about. Main lends us the one it
   already resolves for running fenced code. */
let resolvePath = () => process.env.PATH

/* ----------------------------------------------------- running on Windows */

const WINDOWS = process.platform === 'win32'

/* Windows has no execute bit — a command is a file wearing one of the PATHEXT
   suffixes, and `opencode` installed through npm is really `opencode.cmd`,
   which neither spawn nor access will find under its bare name. */
const executableSuffixes = () =>
  (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)

/** The files the OS would consider for this name. A name already wearing a
 *  suffix is only itself, and so is every name away from Windows. The two
 *  trailing parameters exist for the tests, which run on neither platform in
 *  particular. */
function commandCandidates (file, windows = WINDOWS, suffixes = executableSuffixes()) {
  if (!windows || /\.[^\\/.]+$/.test(file)) return [file]
  return suffixes.map((ext) => file + ext)
}

/** The first candidate that exists and can be run, or nothing. On Windows the
 *  X_OK bit does not exist and access() answers for existence, which together
 *  with the suffix is the whole of what "executable" means there. */
function runnableAt (file) {
  for (const candidate of commandCandidates(file)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch { /* keep looking */ }
  }
  return ''
}

/** Where the command actually lives, walked over the same PATH the spawn
 *  uses. Empty when it is nowhere — which the caller treats as "spawn the
 *  name as given and let ENOENT tell the story". */
function resolveCommand (command) {
  if (command.includes(path.sep) || (WINDOWS && command.includes('/'))) {
    return runnableAt(command)
  }
  for (const dir of String(resolvePath() || '').split(path.delimiter)) {
    if (!dir) continue
    const found = runnableAt(path.join(dir, command))
    if (found) return found
  }
  return ''
}

/**
 * The command and arguments, as this platform can actually run them.
 *
 * Unix spawns the name as given. Windows is why this exists: a CLI installed
 * through npm is a `.cmd` shim, which CreateProcess will not run and Node
 * refuses outright without a shell — so the call is rewritten through
 * cmd.exe, every argument escaped the way cmd unescapes it. A command that
 * resolves to a real executable runs directly, shell-free, which is both
 * faster and immune to all of that quoting.
 */
function invocation (command, args) {
  if (!WINDOWS) return { file: command, args, options: {} }
  const found = resolveCommand(command)
  if (!found || !/\.(cmd|bat)$/i.test(found)) {
    return { file: found || command, args, options: {} }
  }
  const line = [escapeForCmd(found, false), ...args.map((arg) => escapeForCmd(arg, true))].join(' ')
  return {
    file: process.env.comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true }
  }
}

/**
 * One argument, as cmd.exe will read it back out.
 *
 * The backslash-and-quote dance is msvcrt's parsing rule and the caret pass
 * is cmd's own — applied twice for arguments, because a `.cmd` shim expands
 * its `%*` through cmd a second time. The command itself gets the caret pass
 * alone: quoting the program name would hide it from cmd's own lookup.
 */
function escapeForCmd (text, argument) {
  let out = String(text)
  if (argument) {
    out = out.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
    out = `"${out}"`
  }
  out = out.replace(/([()%!^"<>&|;, *?])/g, '^$1')
  if (argument) out = out.replace(/([()%!^"<>&|;, *?])/g, '^$1')
  return out
}

/* Where the last catalogue this CLI gave is kept between launches — main names
   it, because only main knows where the app's state lives. See `models`. */
let catalogueFile = ''

/** Where the renderer is told to look. Relative to the vault, so the paths
 *  match the ones the note tree already uses. */
function relative (abs) {
  if (!abs || !vault) return abs || ''
  const rel = path.relative(vault, abs)
  if (rel.startsWith('..')) return abs
  // The renderer's vault paths are '/'-separated on every platform — the same
  // spelling main.js hands the tree — so a Windows tool report has to arrive
  // in it too, or no step row would ever match the note it touched.
  return rel.split(path.sep).join('/')
}

/* ---------------------------------------------------------------- running */

/**
 * The CLI, started.
 *
 * Spawning is the same story every turn — the vault as the working directory, a
 * login shell's PATH, and a process group of its own so `stop` takes the CLI's
 * tool subprocesses with it — so all of that is here and the `start…` function
 * below is left holding only its own arguments.
 *
 * The session is handed in rather than read back off the map: `stop` deletes it
 * and `start` immediately files another under the same key, so a SIGTERMed
 * process can outlive its own session by a few lines of stdout. Every event,
 * every mutation and every end-of-turn below is gated on this process still
 * being the session's, which is the whole of the answer to "whose turn is
 * this?" — the handlers underneath never have to ask.
 */
/* How long a turn may say nothing at all — no stream event, not even a line of
   logging — before it is taken as wedged. Generous, because the quietest
   legitimate stretch is a long-running shell command that opencode only
   reports once it finishes. */
const TURN_WATCHDOG_MS = 10 * 60 * 1000

/**
 * The graceful kill, in one place: the exit is flagged as ordered, stdin is
 * closed, and the signal lands on the whole tree, escalating for a process
 * that will not go. `stop` and the turn-failed path below both end processes,
 * and two spellings of the escalation is how the grace window drifts.
 */
function reap (proc, signal = 'SIGTERM') {
  // Said before the signal lands, so the exit is read as the one we ordered.
  proc.ending = true
  proc.stdin?.end()
  /* The whole tree, not the process: what was spawned is `npx`, and the CLI
     doing the work is its child. See electron/kill-tree.js. */
  killTree(proc, signal)
  if (signal !== 'SIGKILL') {
    setTimeout(() => killTree(proc, 'SIGKILL'), 2000).unref?.()
  }
}

function launch (provider, args, onMessage, { self, prompt = null, isRetry = false }) {
  const run = invocation(PROVIDERS[provider].command, args)
  const proc = spawn(run.file, run.args, {
    cwd: vault,
    stdio: ['pipe', 'pipe', 'pipe'],
    /* Its own process group, so `stop` can take the CLI's tool subprocesses
       with it rather than leaving them orphaned. Unix only: Windows has no
       groups — kill-tree walks the tree with taskkill instead — and a
       detached child there gets a console window of its own. */
    detached: !WINDOWS,
    windowsHide: true,
    // The tool fence rides the environment — see `policyEnv`. Taken from the
    // session rather than from an argument, so every turn a session spawns is
    // fenced the same way the mode it was started in says it should be.
    env: { ...process.env, PATH: resolvePath(), ...policyEnv(self?.mode) },
    ...run.options
  })

  const mine = () => sessions.get(self.key) === self && self.proc === proc

  /* A process that dies mid-turn has to close the turn out, or `busy` stays set
     and every later message is refused with "still working" — the reply it is
     waiting for is never coming. A turn the CLI counted for itself reports its
     figure; one it said nothing about reports ours — see `account`. */
  const endTurn = () => {
    if (!mine()) return
    self.proc = null
    if (!self.busy) return
    self.busy = false
    publish({
      k: 'turn-end',
      used: self.used || estimated(self),
      // Said, so the panel can show a count nobody vouched for as one.
      estimated: !self.used
    }, self)
  }

  // A line of JSON at a time.
  let spoke = false
  readLines(proc.stdout, (msg) => { spoke = true; if (mine()) onMessage(msg, self) })

  /* Writing to a CLI that has already died is an EPIPE on stdin, and an
     unhandled stream error takes the whole main process down. Treated as the
     death it is, and left at that: every CLI here spawns per turn, so the exit
     handler is already telling that story and the stream's own complaint has
     nothing to add. */
  proc.stdin.on('error', () => endTurn())
  if (prompt != null) proc.stdin.end(prompt)

  proc.on('error', (err) => {
    /* Gated like every handler above it. A spawn failure arrives asynchronously,
       by which time the session may already have been replaced — and a dead
       process must not report its death as the current session's, nor `stop`
       the one that took its place. */
    if (!mine()) return
    publish({
      k: 'error',
      message: err.code === 'ENOENT'
        ? `The \`${PROVIDERS[provider].command}\` command is not on your PATH. Install it and sign in with your subscription.`
        : err.message
    }, self)
    stop(self.key)
  })

  // Only the tail is kept, because a turn against a long document can put a
  // great deal down this pipe and none of it is worth more than its last words.
  let stderr = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096) })

  /* The watchdog, for a CLI that neither answers nor exits. Nothing else here
     can end that turn: `stop` waits on a button nobody may be at, and every
     other closing path starts from something the process said or did. Fed by
     both pipes rather than by parsed events, because a wedged process is
     defined by its silence — a long tool call that is getting anywhere still
     logs, streams, or finishes inside this window. A timestamp and a slow
     patrol rather than a timer re-armed per chunk: a streaming reply delivers
     many chunks a second, and each would have cancelled and rebuilt a
     ten-minute timer that all but never fires. */
  let lastHeard = Date.now()
  const alive = () => { lastHeard = Date.now() }
  const starved = setInterval(() => {
    if (!mine()) { clearInterval(starved); return }
    if (Date.now() - lastHeard < TURN_WATCHDOG_MS) return
    clearInterval(starved)
    publish({
      k: 'error',
      message: `The copilot went quiet for ${Math.round(TURN_WATCHDOG_MS / 60000)} minutes and was stopped.`
    }, self)
    stop(self.key)
  }, 30000)
  starved.unref?.()
  proc.stdout.on('data', alive)
  proc.stderr.on('data', alive)

  proc.on('exit', (code) => {
    clearInterval(starved)
    /* One silent retry for a CLI that died before saying anything at all — a
       crash at startup, a transient network refusal — which is the failure
       shape where trying again is free: no tool has run, no text has
       streamed, so nothing can happen twice. A process that spoke and then
       died gets no retry, because whatever it did may already have happened.
       Once, because a second identical death is an answer, not bad luck. */
    if (!proc.ending && code && !spoke && !isRetry && mine() && self.busy) {
      self.proc = launch(provider, args, onMessage, { self, prompt, isRetry: true })
      return
    }
    endTurn()
    // A kill we asked for is not a failure. Without this the stop button
    // answers itself with "The copilot exited (143)" — 143 being the SIGTERM
    // `stop` just sent — and so does every settings change, which replaces the
    // process. Worse than the wrong words: the renderer takes an `error` as the
    // process being gone and forgets a session that had only just started.
    if (proc.ending || !code) return
    publish({ k: 'error', message: stderr.trim().slice(-400) || `The copilot exited (${code}).` }, self)
  })

  return proc
}


/* ---------------------------------------------------------------- opencode */

/**
 * A process per turn: `run` resumes a thread by id rather than holding one
 * open, which is also what makes a chat survive the app being closed.
 *
 * opencode has no system-prompt flag, so the briefing rides the first
 * message — see `send`. What it does have is agents, and the built-in `plan`
 * agent is read-only, which is how "don't touch my notes" is made a fact about
 * the process rather than a request the model could talk itself out of.
 */
function startOpencodeTurn (text, self) {
  const args = ['run', '--format', 'json', '--dir', vault,
                '--model', self.model]
  /* `--thinking` only *shows* the reasoning stream — the spend is `--variant`'s
     to decide. Without it the reasoning arrives as nothing at all, and a model
     that thinks for a minute looks hung; at `none` there is no reasoning to
     show and the flag is noise on the command line. */
  if (self.effort !== 'none') args.push('--thinking')
  if (!self.write) args.push('--agent', 'plan')
  // Spelled as a model variant here. The level came from this model's own
  // `variants`, so it is a name opencode gave us rather than one we invented.
  if (self.effort) args.push('--variant', self.effort)
  if (self.thread) args.push('--session', self.thread)

  // The prompt goes over stdin. As a positional argument it would ride the
  // command line, which a long question and a quoted selection can overrun.
  // opencode announces no end of turn either; the process ending is the end of
  // turn, which is what `launch` does with an exit anyway.
  return launch('opencode', args, onOpencodeMessage, { self, prompt: text })
}

function onOpencodeMessage (msg, self) {
  // Every event carries the thread it belongs to, so the id is picked up from
  // whichever arrives first rather than from an event of its own.
  if (msg.sessionID && msg.sessionID !== self.thread) {
    self.thread = msg.sessionID
    rememberThread(self)
    publish({ k: 'thread', thread: self.thread }, self)
  }

  const part = msg.part || {}
  switch (msg.type) {
    case 'reasoning':
      account(self, part.text)
      publish({ k: 'thinking', text: part.text || '', tokens: 0 }, self)
      break

    case 'text':
      // Delivered whole rather than in deltas.
      account(self, part.text)
      publish({ k: 'text', text: part.text || '' }, self)
      break

    case 'tool_use': {
      const state = part.state || {}
      const input = state.input || {}
      const name = OPENCODE_TOOLS[part.tool] || part.tool || 'Tool'
      const where = input.filePath || input.pattern || input.command || input.path || ''
      const needle = input.oldString || input.old_string || ''
      const id = part.callID || part.id
      publish({ k: 'tool', id, name, path: relative(where), needle }, self)
      // A tool call is announced already finished in the common case; the
      // guard is for the builds that report it running first.
      if (state.status === 'completed' || state.status === 'error') {
        const failed = state.status === 'error'
        /* Counted whole, before `detailOf` cuts it to what the panel shows: the
           whole of it is what the model's context is carrying. Every shape a
           tool reports in, not only the string one — see `measure`. */
        accountOutput(self, state.output)
        publish({
          k: wrote(name) && !failed ? 'edited' : 'tool-done',
          id,
          name,
          path: relative(where),
          error: failed,
          // opencode files the output under `output` on the completed state, and
          // the reason under `error` on the failed one.
          detail: detailOf(failed ? (state.error ?? state.output) : state.output)
        }, self)
      }
      break
    }

    case 'step_finish': {
      const usage = usageOf(part.tokens)
      if (usage) self.used = usage.used
      break
    }

    case 'error': {
      self.busy = false
      publish({
        k: 'turn-end',
        used: self.used || estimated(self),
        estimated: !self.used,
        error: msg.error?.data?.message || msg.error?.name || 'The turn failed.'
      }, self)
      /* The CLI has said the turn failed; it is not also trusted to exit. Left
         alone, one that lingered kept running behind the next turn's process —
         `stop` only ever reaches the newest — so the failed turn's tree goes
         now. Let go of before the kill: the exit handler must not read this
         process as the session's and report the death a second time. */
      const proc = self.proc
      self.proc = null
      if (proc) reap(proc)
      break
    }
  }
}

/* ------------------------------------------------------------------ plumbing */

/* A line that never ends would grow the buffer below for the length of a
   turn, on the main process. Nothing legitimate comes close — the payloads
   inside a line are bounded by what a model can say — so past this the line
   is dropped whole: when its newline finally lands, the remainder fails to
   parse and is ignored, which is the treatment garbage already gets. */
const LINE_LIMIT = 8 * 1024 * 1024

/**
 * JSON per line, and a line can be split across two reads.
 *
 * The read cursor moves rather than the buffer being re-sliced per line: one
 * chunk can carry hundreds of stream events, and re-copying the remainder after
 * each of them is quadratic in the size of the chunk — on the main process,
 * while a reply streams.
 */
function readLines (stream, onMessage) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    let at = 0
    let cut
    while ((cut = buffer.indexOf('\n', at)) !== -1) {
      const line = buffer.slice(at, cut).trim()
      at = cut + 1
      if (!line) continue
      try { onMessage(JSON.parse(line)) } catch { /* not ours to read */ }
    }
    if (at) buffer = buffer.slice(at)
    if (buffer.length > LINE_LIMIT) buffer = ''
  })
}

/* -------------------------------------------------------------------- API */

function setVault (dir) {
  if (dir !== vault) stopAll()
  vault = dir
}

function attach (fn, pathFn, cacheFile = '') {
  emit = fn
  if (pathFn) resolvePath = pathFn
  if (cacheFile) catalogueFile = String(cacheFile)
}

/** How long a catalogue query gets before it is taken as no answer. */
const ASK_TIMEOUT_MS = 15000

/** One CLI asked for its catalogue. An empty answer is the answer: `allModels`
 *  in the renderer substitutes the built-in list for a provider that gives
 *  nothing, so a GUI launched before the CLI is installed still shows one. */
function ask (command, args, parse) {
  const run = invocation(command, args)
  return new Promise((resolve) => {
    execFile(run.file, run.args, {
      env: { ...process.env, PATH: resolvePath() },
      maxBuffer: 8 * 1024 * 1024,
      /* A CLI that asks for a login, or one that hangs against a network that
         is not there, otherwise never calls back — and Settings waits on this
         to draw its model list. An empty answer is already a valid one here
         (the built-in list stands in), so a slow catalogue costs a stale list
         rather than a pane that never fills. */
      timeout: ASK_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      windowsHide: true,
      ...run.options
    }, (error, stdout) => {
      if (error) { resolve([]); return }
      try { resolve(parse(stdout)) } catch { resolve([]) }
    })
  })
}

/**
 * opencode answers with one `provider/model` per line, and the provider is
 * half the name: `glm-5.2` alone says nothing about whether it is coming from
 * the user's opencode subscription or their own OpenRouter key. So the line is
 * the id, the part after the first slash is the label, and the part before it
 * groups the list — which is the only thing that makes a catalogue this size
 * navigable in the settings pane.
 *
 * `--verbose` follows each of those lines with the model's JSON, which is where
 * its variants live — the levels that model's `--variant` will take. Most have
 * none, and a model with none is one the effort control has nothing to say
 * about. The same parser reads the plain output too: the id lines are identical
 * in both, and nothing inside the JSON can pass for one.
 */
function parseOpencode (stdout) {
  const lines = stdout.split('\n')
  const models = []

  for (let at = 0; at < lines.length; at++) {
    const line = lines[at].trim()
    if (!/^[^\s/]+\/\S+$/.test(line)) continue

    const cut = line.indexOf('/')
    const model = {
      id: line,
      label: line.slice(cut + 1),
      group: line.slice(0, cut),
      efforts: [],
      effort: '',
      context: 0
    }
    models.push(model)

    // The block beneath it, if this is the verbose form. Brace depth rather
    // than a parser: the object is pretty-printed, one token per line.
    if (lines[at + 1]?.trim() !== '{') continue
    let depth = 0
    const block = []
    while (++at < lines.length) {
      block.push(lines[at])
      depth += (lines[at].match(/{/g) || []).length - (lines[at].match(/}/g) || []).length
      if (depth === 0) break
    }
    try {
      const spec = JSON.parse(block.join('\n'))
      const efforts = Object.keys(spec.variants || {})
      model.efforts = efforts
      model.effort = efforts.includes('high') ? 'high' : (efforts[0] || '')
      model.context = spec.limit?.context || 0
    } catch { /* a block we cannot read is a model without variants */ }
  }
  return models
}

/** A context window as a CLI writes it — `1M`, `272K`, `128,000` — as a
 *  number. Zero for anything unreadable, which the panel takes as "nobody
 *  said" and leaves the ring away. */
function contextSize (text) {
  const m = /^(\d+(?:\.\d+)?)\s*([KM])?$/i.exec(String(text || '').replace(/,/g, ''))
  if (!m) return 0
  const n = Number(m[1])
  return m[2] ? (m[2].toUpperCase() === 'M' ? Math.round(n * 1000000) : Math.round(n * 1000)) : Math.round(n)
}

/**
 * Every model the CLI offers, which is what the settings pane chooses from.
 *
 * Held once it has been read. Two callers want this — the panel when it
 * restores, and the settings pane every time it opens — and neither knew about
 * the other, so a habit of opening ⌘, was a pair of subprocesses and most of a
 * megabyte of JSON re-parsed each time, for an answer that had not changed. The
 * promise is cached rather than the result, so two callers arriving together
 * share one spawn. Kept for long enough to cover a session of settings-poking,
 * and no longer: installing a model is something the user does and then expects
 * the app to notice.
 */
const CATALOGUE_TTL = 5 * 60 * 1000
let held = null      // { at, promise }

/**
 * And across launches.
 *
 * The five-minute hold above is per process, so every cold start paid a
 * subprocess and most of a megabyte of JSON before the model list was anything
 * but the built-in one — on the startup path, where the panel is restoring and
 * the settings pane may already be waiting. The answer is written beside the
 * app's other state and read back on the next launch, which makes the first
 * catalogue free.
 *
 * Stale by design: the file is served immediately and a real query is started
 * behind it, so installing a model shows up on the launch after the one that
 * noticed it rather than never. A day is the outer bound — past that the saved
 * copy is not worth trusting even as a first draft.
 */
const CATALOGUE_DISK_TTL = 24 * 60 * 60 * 1000

function readCatalogueFile () {
  if (!catalogueFile) return null
  try {
    const saved = JSON.parse(fs.readFileSync(catalogueFile, 'utf8'))
    if (!saved || typeof saved !== 'object') return null
    if (!(Date.now() - Number(saved.at) < CATALOGUE_DISK_TTL)) return null
    // An empty answer is one the renderer already substitutes a built-in list
    // for, and is not worth a launch's worth of trust.
    return Array.isArray(saved.models?.opencode) && saved.models.opencode.length
      ? saved.models
      : null
  } catch { return null }
}

function writeCatalogueFile (models) {
  if (!catalogueFile || !models?.opencode?.length) return
  try {
    fs.mkdirSync(path.dirname(catalogueFile), { recursive: true })
    fs.writeFileSync(catalogueFile, JSON.stringify({ at: Date.now(), models }))
  } catch { /* a catalogue that cannot be cached is simply asked for again */ }
}

/** Ask the CLI, and remember what it said. */
function askCatalogue () {
  return ask('opencode', ['models', '--verbose'], parseOpencode)
    .then((opencode) => {
      const models = { opencode }
      writeCatalogueFile(models)
      return models
    })
    .catch((error) => {
      // A rejection must not be cached, or the app spends the rest of its life
      // handing out the same failure.
      held = null
      throw error
    })
}

function models ({ fresh = false } = {}) {
  if (!fresh && held && Date.now() - held.at < CATALOGUE_TTL) return held.promise

  /* Keyed by provider, as the renderer expects: it is a catalogue per CLI on
     that side, and was once two. An empty answer — a CLI that is not installed,
     or one whose output has changed shape — leaves the renderer to fall back to
     what this file's catalogue already said the provider offers. */
  const saved = fresh ? null : readCatalogueFile()
  if (saved) {
    /* Served now, refreshed behind. The refresh replaces the held answer rather
       than being awaited by anyone, so the caller that arrived at launch gets
       the saved list at once and the one that opens ⌘, a minute later gets the
       real one. Its failure is the saved list's to absorb. */
    const promise = Promise.resolve(saved)
    held = { at: Date.now(), promise }
    askCatalogue().then((models) => {
      if (held?.promise === promise) held = { at: Date.now(), promise: Promise.resolve(models) }
    }).catch(() => {})
    return promise
  }

  const promise = askCatalogue()
  held = { at: Date.now(), promise }
  return promise
}

function probe (command, args) {
  const run = invocation(command, args)
  return new Promise((resolve) => {
    execFile(run.file, run.args, {
      env: { ...process.env, PATH: resolvePath() },
      timeout: 5000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      ...run.options
    }, (error, stdout, stderr) => resolve({
      ok: !error,
      text: String(stdout || stderr || '').trim()
    }))
  })
}

/**
 * Whether a command exists, without running it.
 *
 * Asking a CLI its version is not the same question as whether it is there, and
 * conflating them has been wrong before: a CLI whose `--version` is killed on
 * some machines runs perfectly, and the pane reported the whole copilot
 * missing. This walks the same PATH the spawn would and looks for something
 * executable, which is the question that was meant.
 */
function onPath (command) {
  return !!resolveCommand(command)
}

/** A redacted readiness check: only availability, version and whether the
 * provider reports credentials. Account names, tokens and command output never
 * cross IPC. */
function doctor () {
  return Promise.all(CATALOGUE.providers.map(async (provider) => {
    const installed = onPath(provider.command)
    const [version, auth] = await Promise.all([
      probe(provider.command, ['--version']),
      // A CLI with no way to be asked — one that keeps its credentials behind
      // an interactive wizard — is taken as ready once it is installed, which
      // is all this check can honestly claim about it.
      provider.auth ? probe(provider.command, provider.auth) : Promise.resolve({ ok: true, text: '' })
    ])
    const signedIn = auth.ok && provider.id === 'opencode'
      ? !/(?:0 credentials|no credentials)/i.test(auth.text)
      : auth.ok
    return {
      id: provider.id,
      label: provider.label,
      installed,
      // Said only when the CLI answered; one that will not say is still
      // installed, and a blank version is the honest way to put that.
      version: version.ok ? version.text.split(/\r?\n/, 1)[0].slice(0, 100) : '',
      signedIn: installed && signedIn,
      status: !installed ? 'CLI not found' : (signedIn ? 'Ready' : 'Sign in required')
    }
  }))
}

function start ({
  key = '', provider = 'opencode', model, effort = '', mode = null, write = null,
  resume = null, used = 0, turnId = null
} = {}) {
  if (!vault) return { ok: false, error: 'Open a vault first.' }
  const id = sessionKey(key)
  /* Only this conversation's copilot. Starting one used to end whichever was
     running, which is exactly what made the panel single-file: the second note
     asked a question and the first note's turn died for it. */
  stop(id)
  evictIdleSessions()
  /* Taken at its word. The catalogue is an account property this file cannot
     check a name against, so a model the renderer offers is a model this
     spawns, and a name it does not know is the CLI's to refuse. */
  const selectedModel = model || ''
  /* Older renderer callers sent only `write`; migrate those requests to Ask,
     while a missing permission entirely is now safely read-only. */
  const selectedMode = PERMISSION_MODES.has(mode)
    ? mode
    : write === true ? 'ask' : 'read'
  const canWrite = selectedMode !== 'read'
  const session = {
    key: id,
    provider, model: selectedModel, effort, mode: selectedMode, write: canWrite,
    proc: null, busy: false, thread: resume || null, used: 0,
    /* What the *thread* has already been told, not what this session has — see
       `memoFor`. A session replaced to change the effort resumes the same
       thread, and everything quoted into it is still in front of the model. */
    sent: memoFor(resume || null),
    /* Where the conversation had got to, so a resumed thread's ring starts from
       what it was reading rather than from zero. Already a token count — the
       panel sends back the figure it was last shown. */
    tokens: Math.max(0, Math.round(Number(used) || 0)),
    turnId: String(turnId || '') || null,
    // Least-recently-used, for the eviction above.
    at: Date.now()
  }
  sessions.set(id, session)

  // It spawns per turn, so there is nothing to start until there is something
  // to say.
  publish({ k: 'ready', thread: session.thread }, session)
  return { ok: true, provider, model: selectedModel, effort,
    mode: selectedMode, turnId: session.turnId }
}

/** Room for the one about to be made. A session with a process on it is a turn
 *  in flight and is never taken; the rest are a few fields each, and the oldest
 *  of them is the conversation least likely to be spoken in next. */
function evictIdleSessions () {
  const idle = allSessions().filter((one) => !one.busy && !one.proc)
  const spare = sessions.size - MAX_SESSIONS + 1
  if (spare <= 0) return
  idle.sort((a, b) => a.at - b.at)
  for (const one of idle.slice(0, spare)) sessions.delete(one.key)
}

/** Each CLI by the function that starts a turn against it. One, now; the map is
 *  what keeps `send` from having to know that. */
const TURN_STARTERS = {
  opencode: startOpencodeTurn
}

function send (key, text, context, turnId = null) {
  // Deliberately not started here: only the panel knows which copilot, which
  // effort and which write mode the user picked, so an implicit start would
  // quietly answer as somebody else.
  const session = sessionFor(key)
  if (!session) return { ok: false, error: 'The copilot is not running.' }
  /* Per conversation, which is the whole of the rule: two notes may be answered
     at once, one note may not be asked twice at once — the second question is a
     follow-up, and the panel queues it. */
  if (session.busy) return { ok: false, error: 'The copilot is still working.' }
  session.at = Date.now()

  /* Start's id names the turn it was called for. The id of every later message
     is installed here, immediately before the provider can emit anything about
     it. */
  session.turnId = String(turnId || '') || session.turnId

  const prompt = promptFor(text, context, session.sent)

  session.busy = true

  /* Reset in place rather than replaced: the record is shared with the memo
     kept for this thread, and swapping this session's reference for a fresh
     object would leave the memo still claiming the note had been quoted. */
  const forgetSent = () => Object.assign(session.sent, nothingSent())

  const startTurn = TURN_STARTERS[session.provider]
  if (!startTurn) {
    session.busy = false
    forgetSent()
    return { ok: false, error: `Tulip has no way to run ${session.provider}.` }
  }

  // opencode has no system-prompt flag, so the briefing rides the first message
  // of the thread; every turn after resumes and still has it.
  const opening = session.thread
    ? prompt
    : `${systemPrompt(vault)}\n\n---\n\n${prompt}`
  /* A starter that throws on the way out — a spawn that fails synchronously, a
     PATH that is not a string — left `busy` set with no process to clear it,
     and the panel said "the copilot is still working" until the app was
     restarted. Every other exit from this function puts `busy` back; so does
     this one. */
  try {
    session.proc = startTurn(opening, session)
  } catch (err) {
    session.busy = false
    session.proc = null
    /* Nothing reached the model, so nothing has been said before: the next turn
       carries the whole context again rather than naming a copy that is not
       there. */
    forgetSent()
    return { ok: false, error: err?.message || `${session.provider} could not be started.` }
  }
  account(session, opening)
  return { ok: true }
}

/**
 * The kill lands on the process group — the CLI plus whatever tools it has
 * spawned — with a SIGKILL escalation for one that will not go. On quit main
 * passes SIGKILL directly, because the escalation timer would never fire.
 */
function stop (key, signal = 'SIGTERM') {
  const session = sessionFor(key)
  if (!session) return { ok: false }
  if (session.proc) reap(session.proc, signal)
  sessions.delete(session.key)
  return { ok: true }
}

/** Every copilot at once — the vault changing under all of them, and the app
 *  quitting. On quit main passes SIGKILL directly, because the escalation timer
 *  would never fire. */
function stopAll (signal = 'SIGTERM') {
  let stopped = false
  for (const session of allSessions()) stopped = stop(session.key, signal).ok || stopped
  return { ok: stopped }
}

/* What main talks to — and, under a name that says why they are here, the pure
   functions underneath it. They are the fragile half of this file: hand-rolled
   readers of the CLI's output, none of it reachable through the six calls above
   and none of it exercised by anything short of running that program.
   `scripts/test-ai.mjs` is what they are exported for. */
module.exports = {
  setVault,
  attach,
  models,
  doctor,
  start,
  send,
  stop,
  stopAll,
  canWrite,
  /** Whether this conversation's copilot is mid-turn. Main asks so a stop for
   *  one chat cannot be read as the app having gone quiet. */
  isBusy: (key) => !!sessionFor(key)?.busy,
  parsers: {
    detailOf, tokensIn, tokensOf, usageOf, readLines, parseOpencode, contextSize,
    policyEnv, commandCandidates, escapeForCmd, invocation
  }
}
