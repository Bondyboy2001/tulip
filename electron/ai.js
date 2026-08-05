'use strict'

/**
 * The copilot, as a subprocess.
 *
 * None of these vendors sells API access on a personal subscription, but each
 * ships a CLI that authenticates against one — so the copilot is `devin` or
 * `opencode` run headlessly with the vault as its working directory, rather
 * than an HTTP client holding a key. That decision buys the file access
 * for nothing: the agent reads and writes notes through its own tools, Tulip's
 * job is narrowed to relaying what it says and noticing what it touched, and
 * there is no key of ours anywhere in it. A gateway — OpenRouter, z.ai — is
 * configured inside one of these CLIs, which is where its key already lives.
 *
 * The CLIs speak different event streams — and one of them, devin, speaks no
 * event stream at all. Everything below funnels them into one vocabulary — see
 * `publish` calls for the whole of it — so the renderer never learns which one
 * is answering.
 */

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { spawn, execFile } = require('node:child_process')
const { systemPrompt, promptFor } = require('./prompt.js')

/* The CLIs and what they offer before they are asked. Shared with the renderer
   (src/models.js) rather than restated here: the same fact deciding what the
   dropdown shows and what this process will accept is how the two come to
   disagree. Same arrangement as vault-contract.json and zoom-steps.json. */
const CATALOGUE = require('./ai-models.json')
/* Keyed by id, for the facts this file needs about a provider that are not its
   models: the binary to run, the name to call it in an error, and how to ask it
   whether it is signed in. Taken from the catalogue rather than written out
   beside each `spawn`, so there is one answer to "what is devin" and the
   settings pane reads the same one. */
const PROVIDERS = Object.fromEntries(CATALOGUE.providers.map((p) => [p.id, p]))
const PERMISSION_MODES = new Set(['read', 'ask', 'auto'])

/* opencode names its tools in lower case and has a couple the others do not.
   Mapped here rather than in the renderer, so the panel goes on knowing one
   vocabulary. */
const OPENCODE_TOOLS = {
  read: 'Read', edit: 'Edit', write: 'Write', patch: 'Edit',
  bash: 'Bash', grep: 'Grep', glob: 'Glob', list: 'Glob',
  todowrite: 'TodoWrite', todoread: 'TodoWrite',
  webfetch: 'Fetch', task: 'Task'
}

/** Which of the shared tool names mean the file on disk has changed. */
const wrote = (name) => name === 'Edit' || name === 'Write'

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
let session = null   // { provider, model, effort, mode, write, proc, busy, thread, used, turnId }

/** Every event carries the turn that caused it. Main may hold a terminal event
 * while it snapshots the vault, and without this identity an older completion
 * can arrive after a queued turn has begun and settle the newer one. */
function publish (event, owner = session) {
  emit({ ...event, turnId: event?.turnId || owner?.turnId || null })
}

/* A GUI app inherits a PATH that has never seen a login shell, and both of
   these CLIs install somewhere only a profile knows about. Main lends us the one it
   already resolves for running fenced code. */
let resolvePath = () => process.env.PATH

/** Where the renderer is told to look. Relative to the vault, so the paths
 *  match the ones the note tree already uses. */
function relative (abs) {
  if (!abs || !vault) return abs || ''
  const rel = path.relative(vault, abs)
  return rel.startsWith('..') ? abs : rel
}

/* ---------------------------------------------------------------- running */

/**
 * A CLI, started.
 *
 * They are spawned alike — the vault as the working directory, a login shell's
 * PATH, and a process group of their own so `stop` takes their tool
 * subprocesses with them — and they die alike, so all of that is here and the
 * `start…` functions below are left holding only their own arguments.
 *
 * The session is captured rather than read back off the module: `stop` nulls it
 * and `start` immediately builds another, so a SIGTERMed process can outlive
 * its own session by a few lines of stdout. Every event, every mutation and
 * every end-of-turn below is gated on this process still being the session's,
 * which is the whole of the answer to "whose turn is this?" — the handlers
 * underneath never have to ask.
 */
function launch (provider, args, onMessage, { prompt = null, stream = readLines } = {}) {
  const self = session
  const proc = spawn(PROVIDERS[provider].command, args, {
    cwd: vault,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own process group, so `stop` can take the CLI's tool subprocesses
    // with it rather than leaving them orphaned.
    detached: true,
    env: { ...process.env, PATH: resolvePath() }
  })

  const mine = () => session === self && self.proc === proc

  /* A process that dies mid-turn has to close the turn out, or `busy` stays set
     and every later message is refused with "still working" — the reply it is
     waiting for is never coming. Only the CLIs that report a running total ever
     fill in `used`; the panel ignores a zero. */
  const endTurn = () => {
    if (!mine()) return
    self.proc = null
    if (self.busy) { self.busy = false; publish({ k: 'turn-end', used: self.used || 0 }, self) }
  }

  /* A line of JSON for most of them, and for devin — which publishes no event
     stream — the prose itself, as it arrives. */
  stream(proc.stdout, (msg) => { if (mine()) onMessage(msg) })

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
    stop()
  })

  // Only the tail is kept, because a turn against a long document can put a
  // great deal down this pipe and none of it is worth more than its last words.
  let stderr = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096) })

  proc.on('exit', (code) => {
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


/* ------------------------------------------------------------------- Devin */

/**
 * A process per turn, and no event stream at all: devin's print mode answers in
 * prose on standard output, so what the panel is shown is the prose, relayed as
 * it arrives. There are no tool rows for a devin turn — the CLI does not
 * publish them — and the panel simply has nothing to draw in that column.
 *
 * The prompt goes in a file rather than on the command line: devin reads no
 * prompt from standard input (it panics), and a long question with a quoted
 * selection in it would overrun `argv`. The file is written where the OS puts
 * temporary things and removed once the process has taken it.
 */
function startDevinTurn (text) {
  const file = path.join(os.tmpdir(), `tulip-devin-${process.pid}-${Date.now()}.md`)
  // Readable by this user alone: the prompt carries whatever note the question
  // was asked about, and a shared temporary directory is not the place to
  // publish it.
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })

  const args = ['--print', '--prompt-file', file,
                 // Read-only auto-approves the tools that only look; every
                 // write-capable UI mode uses the provider's edit permission.
                 '--permission-mode', session.write ? 'accept-edits' : 'auto']
  /* Devin spells the reasoning level into the model name, so the catalogue
     leaves a slot in the id and the slider fills it — see `parseDevin`. With no
     level chosen the slot comes out altogether, which leaves the family's own
     name: `claude-opus-5`, which is what devin calls the default of that
     family anyway. */
  const model = session.effort
    ? session.model.replace('{effort}', session.effort)
    : session.model.replace('-{effort}', '')
  if (model) args.push('--model', model)
  /* Devin threads a conversation per directory rather than by id, so the second
     turn onwards continues the one this vault already has. That is as far as it
     goes: two chats held open against devin at once are the same conversation
     to it, because the vault is one directory and `--continue` means "the most
     recent one here". The id below records only that a conversation is going. */
  if (session.thread) args.push('--continue')

  const proc = launch('devin', args, (chunk) => publish({ k: 'text', text: chunk }),
    { stream: readText })
  if (!session.thread) {
    session.thread = 'devin'
    publish({ k: 'thread', thread: session.thread })
  }
  proc.on('exit', () => { try { fs.unlinkSync(file) } catch { /* already gone */ } })
  return proc
}

/* ---------------------------------------------------------------- opencode */

/**
 * A process per turn, like devin: `run` resumes a thread by id rather than
 * holding one open.
 *
 * opencode has no system-prompt flag either, so the briefing rides the first
 * message — see `send`. What it does have is agents, and the built-in `plan`
 * agent is read-only, which is how "don't touch my notes" is made a fact about
 * the process rather than a request the model could talk itself out of.
 */
function startOpencodeTurn (text) {
  const args = ['run', '--format', 'json', '--dir', vault,
                '--model', session.model,
                // Without this the reasoning arrives as nothing at all, and a
                // model that thinks for a minute looks hung.
                '--thinking']
  if (!session.write) args.push('--agent', 'plan')
  // Spelled as a model variant here. The level came from this model's own
  // `variants`, so it is a name opencode gave us rather than one we invented.
  if (session.effort) args.push('--variant', session.effort)
  if (session.thread) args.push('--session', session.thread)

  // The prompt goes over stdin. As a positional argument it would ride the
  // command line, which a long question and a quoted selection can overrun.
  // opencode announces no end of turn either; the process ending is the end of
  // turn, which is what `launch` does with an exit anyway.
  return launch('opencode', args, onOpencodeMessage, { prompt: text })
}

function onOpencodeMessage (msg) {
  // Every event carries the thread it belongs to, so the id is picked up from
  // whichever arrives first rather than from an event of its own.
  if (msg.sessionID && msg.sessionID !== session.thread) {
    session.thread = msg.sessionID
    publish({ k: 'thread', thread: session.thread })
  }

  const part = msg.part || {}
  switch (msg.type) {
    case 'reasoning':
      publish({ k: 'thinking', text: part.text || '', tokens: 0 })
      break

    case 'text':
      // Delivered whole rather than in deltas.
      publish({ k: 'text', text: part.text || '' })
      break

    case 'tool_use': {
      const state = part.state || {}
      const input = state.input || {}
      const name = OPENCODE_TOOLS[part.tool] || part.tool || 'Tool'
      const where = input.filePath || input.pattern || input.command || input.path || ''
      const needle = input.oldString || input.old_string || ''
      const id = part.callID || part.id
      publish({ k: 'tool', id, name, path: relative(where), needle })
      // A tool call is announced already finished in the common case; the
      // guard is for the builds that report it running first.
      if (state.status === 'completed' || state.status === 'error') {
        const failed = state.status === 'error'
        publish({
          k: wrote(name) && !failed ? 'edited' : 'tool-done',
          id,
          name,
          path: relative(where),
          error: failed,
          // opencode files the output under `output` on the completed state, and
          // the reason under `error` on the failed one.
          detail: detailOf(failed ? (state.error ?? state.output) : state.output)
        })
      }
      break
    }

    case 'step_finish': {
      // No end-of-turn event to carry this, so the running total is kept and
      // reported when the process exits.
      const total = part.tokens?.total
      if (total) session.used = total
      break
    }

    case 'error':
      session.busy = false
      publish({
        k: 'turn-end',
        error: msg.error?.data?.message || msg.error?.name || 'The turn failed.'
      })
      break
  }
}

/* ------------------------------------------------------------------ plumbing */

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
  })
}

/** And the same stream read as what it is — prose — for the CLI that publishes
 *  no events. Handed on as it arrives, so a long answer appears as it is
 *  written rather than in one piece at the end. */
function readText (stream, onChunk) {
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => { if (chunk) onChunk(chunk) })
}

/* -------------------------------------------------------------------- API */

function setVault (dir) {
  if (dir !== vault) stop()
  vault = dir
}

function attach (fn, pathFn) {
  emit = fn
  if (pathFn) resolvePath = pathFn
}

/** One CLI asked for its catalogue. An empty answer is the answer: `allModels`
 *  in the renderer substitutes the built-in list for a provider that gives
 *  nothing, so a GUI launched before the CLI is installed still shows one. */
function ask (command, args, parse) {
  return new Promise((resolve) => {
    execFile(command, args, {
      env: { ...process.env, PATH: resolvePath() },
      maxBuffer: 8 * 1024 * 1024
    }, (error, stdout) => {
      if (error) { resolve([]); return }
      try { resolve(parse(stdout)) } catch { resolve([]) }
    })
  })
}

/** The effort names any CLI here might use, for spotting one inside a model
 *  id. The catalogue's own list, so a level nobody has heard of yet is still
 *  recognised the day it is added to it. */
const EFFORT_IDS = new Set(CATALOGUE.efforts.map((level) => level.id))

/**
 * Devin lists its models as families, each with its variants indented beneath:
 *
 *     Claude Opus 5 (claude-opus-5)
 *       aliases: opus
 *       claude-opus-5-high         Claude Opus 5 High  [1M context, $5 / MTok In …]
 *       claude-opus-5-high-fast    Claude Opus 5 High Fast  [1M context, …]
 *
 * Those are not eleven models. Devin spells the reasoning level into the id
 * rather than taking it as a flag, so a family arrives as one row per level —
 * and listing them as models put the effort dial in the model list, where the
 * reader has to scroll past five copies of a thing to reach the next thing.
 *
 * So the level is taken back out. A row is read as `base-level[-variant]`: the
 * base and the variant are the model, the level joins that model's effort
 * ladder, and the id keeps a `{effort}` in the level's place for
 * `startDevinTurn` to fill in from whatever the slider says. What was eleven
 * rows is two — "Claude Opus 5" and "Claude Opus 5 Fast" — each with five
 * levels on the dial where levels belong.
 *
 * A row with no level in its id is a model with no dial, and is listed as it
 * came — unless the same base also arrived with levels, in which case it is the
 * same model said twice and the plain one is dropped.
 */
function parseDevin (stdout) {
  const models = []
  const byKey = new Map()
  const templated = new Set()
  let group = ''
  // The family's own id, in segments. What a family is called is not a level,
  // however much it looks like one: "Nemotron 3 Ultra" is a model's name and
  // `ultra` is also a reasoning level, and only this tells the two apart.
  let familyWords = new Set()

  for (const line of String(stdout || '').split('\n')) {
    const family = /^(\S.*?)\s*\(([a-z0-9][\w.-]*)\)\s*$/.exec(line)
    if (family) {
      group = family[1].trim()
      familyWords = new Set(family[2].toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
      continue
    }

    // Two spaces in, an id, two or more spaces, then its label and, in
    // brackets, what it costs and how much it holds.
    const row = /^\s{2,}([a-z0-9][\w.\-/]*)\s{2,}(.+?)\s*(?:\[(.*)\])?\s*$/.exec(line)
    if (!row || !group) continue

    const id = row[1]
    const context = contextSize(/([\d.]+\s*[KM]?)\s*context/i.exec(row[3] || '')?.[1] || '')

    /* The last segment that names a level, because the level sits at the end of
       an id and anything after it — `fast`, `priority`, `1m` — says which
       arrangement of the same model this is. Segments the family is named after
       are passed over: they were spoken for before any level was. */
    const segments = id.split('-')
    const at = segments.findLastIndex(
      (segment) => EFFORT_IDS.has(segment) && !familyWords.has(segment)
    )
    if (at === -1) {
      models.push({ id, label: row[2].trim(), group, efforts: [], effort: '', context })
      continue
    }

    const base = segments.slice(0, at).join('-')
    const variant = segments.slice(at + 1).join('-')
    const key = `${base}|${variant}`
    templated.add(base)

    let model = byKey.get(key)
    if (!model) {
      model = {
        id: `${base}-{effort}${variant ? `-${variant}` : ''}`,
        // The family's own name, and what this arrangement of it is called —
        // never the row's label, which has the level written into it.
        label: variant ? `${group} ${variantLabel(variant)}` : group,
        group,
        efforts: [],
        effort: '',
        context
      }
      byKey.set(key, model)
      models.push(model)
    }
    if (!model.efforts.includes(segments[at])) model.efforts.push(segments[at])
    model.effort = model.efforts.includes('medium') ? 'medium' : model.efforts[0]
    model.context = model.context || context
  }

  // A base that also arrived with levels has already said everything the plain
  // row says, and two rows with one name is worse than one.
  return models.filter((model) => model.efforts.length || !templated.has(model.id))
}

/** `fast` → `Fast`, `1m` → `1M`: the tail of an id as something to read at the
 *  end of a model's name. */
const variantLabel = (variant) => variant.split('-')
  .map((word) => (/\d/.test(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
  .join(' ')

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
 * Every model the CLIs offer, which is what the settings pane chooses from.
 *
 * Only the two that will print a catalogue are asked — devin and opencode —
 * and they are asked in parallel, because opencode's answer takes a second and
 * there is no reason for devin to wait behind it.
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

function models ({ fresh = false } = {}) {
  if (!fresh && held && Date.now() - held.at < CATALOGUE_TTL) return held.promise

  const promise = Promise.all([
    ask('devin', ['models', 'list'], parseDevin),
    ask('opencode', ['models', '--verbose'], parseOpencode)
  ]).then(([devin, opencode]) => ({
    /* An empty answer — a CLI that is not installed, or one whose output has
       changed shape — leaves the renderer to fall back to what this file's
       catalogue already said the provider offers. */
    devin,
    opencode
  })).catch((error) => {
    // A rejection must not be cached, or the app spends the rest of its life
    // handing out the same failure.
    held = null
    throw error
  })

  held = { at: Date.now(), promise }
  return promise
}

function probe (command, args) {
  return new Promise((resolve) => {
    execFile(command, args, {
      env: { ...process.env, PATH: resolvePath() },
      timeout: 5000,
      maxBuffer: 256 * 1024
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
  if (command.includes(path.sep)) return canRun(command)
  return String(resolvePath() || '').split(path.delimiter)
    .some((dir) => dir && canRun(path.join(dir, command)))
}

function canRun (file) {
  try { fs.accessSync(file, fs.constants.X_OK); return true } catch { return false }
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
    let signedIn = auth.ok
    if (auth.ok && provider.id === 'opencode') {
      signedIn = !/(?:0 credentials|no credentials)/i.test(auth.text)
    } else if (auth.ok && provider.id === 'devin') {
      signedIn = /logged in/i.test(auth.text)
    }
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
  provider = 'devin', model, effort = 'high', mode = null, write = null, resume = null,
  turnId = null
} = {}) {
  if (!vault) return { ok: false, error: 'Open a vault first.' }
  stop()
  /* Taken at its word. Both catalogues are account properties this file cannot
     check a name against, so a model the renderer offers is a model this
     spawns, and a name neither of them knows is the CLI's to refuse. */
  const selectedModel = model || ''
  /* Older renderer callers sent only `write`; migrate those requests to Ask,
     while a missing permission entirely is now safely read-only. */
  const selectedMode = PERMISSION_MODES.has(mode)
    ? mode
    : write === true ? 'ask' : 'read'
  const canWrite = selectedMode !== 'read'
  session = {
    provider, model: selectedModel, effort, mode: selectedMode, write: canWrite,
    proc: null, busy: false, thread: resume || null, used: 0,
    turnId: String(turnId || '') || null
  }

  // Every one of them spawns per turn, so there is nothing to start until
  // there is something to say.
  publish({ k: 'ready', thread: session.thread })
  return { ok: true, provider, model: selectedModel, effort,
    mode: selectedMode, turnId: session.turnId }
}

/** Each CLI by the function that starts a turn against it. */
const TURN_STARTERS = {
  devin: startDevinTurn,
  opencode: startOpencodeTurn
}

function send (text, context, turnId = null) {
  // Deliberately not started here: only the panel knows which copilot, which
  // effort and which write mode the user picked, so an implicit start would
  // quietly answer as somebody else.
  if (!session) return { ok: false, error: 'The copilot is not running.' }
  if (session.busy) return { ok: false, error: 'The copilot is still working.' }

  /* Start's id names the turn it was called for. The id of every later message
     is installed here, immediately before the provider can emit anything about
     it. */
  session.turnId = String(turnId || '') || session.turnId

  const prompt = promptFor(text, context)

  session.busy = true

  const startTurn = TURN_STARTERS[session.provider]
  if (!startTurn) {
    session.busy = false
    return { ok: false, error: `Tulip has no way to run ${session.provider}.` }
  }

  // None of these has a system-prompt flag, so the same briefing rides the
  // first message of the thread; every turn after resumes and still has it.
  const opening = session.thread
    ? prompt
    : `${systemPrompt(vault)}\n\n---\n\n${prompt}`
  session.proc = startTurn(opening)
  return { ok: true }
}

/**
 * The kill lands on the process group — the CLI plus whatever tools it has
 * spawned — with a SIGKILL escalation for one that will not go. On quit main
 * passes SIGKILL directly, because the escalation timer would never fire.
 */
function stop (signal = 'SIGTERM') {
  const proc = session?.proc
  if (proc) {
    // Said before the signal lands, so the exit is read as the one we ordered.
    proc.ending = true
    proc.stdin?.end()
    const kill = (sig) => {
      try { process.kill(-proc.pid, sig) } catch {
        try { proc.kill(sig) } catch { /* already gone */ }
      }
    }
    kill(signal)
    if (signal !== 'SIGKILL') setTimeout(() => kill('SIGKILL'), 2000).unref?.()
  }
  session = null
  return { ok: true }
}

/* What main talks to — and, under a name that says why they are here, the pure
   functions underneath it. They are the fragile half of this file: hand-rolled
   parsers reading several CLIs' output, none of it reachable through the six
   calls above and none of it exercised by anything short of running all of
   those programs. `scripts/test-ai.mjs` is what they are exported for. */
module.exports = {
  setVault,
  attach,
  models,
  doctor,
  start,
  send,
  stop,
  parsers: { detailOf, readLines, readText, parseDevin, parseOpencode, contextSize }
}
