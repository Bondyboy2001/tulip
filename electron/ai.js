'use strict'

/**
 * The assistant, as a subprocess.
 *
 * Neither vendor sells API access on a personal subscription, but both ship a
 * CLI that authenticates against one — so the assistant is `claude` or `codex`
 * run headlessly with the vault as its working directory, rather than an HTTP
 * client holding a key. That decision buys the file access for nothing: the
 * agent reads and writes notes through its own tools, and Tulip's job is
 * narrowed to relaying what it says and noticing what it touched.
 *
 * The two CLIs speak different event streams. Everything below funnels them
 * into one vocabulary — see `emit` calls for the whole of it — so the renderer
 * never learns which one is answering.
 */

const path = require('node:path')
const { spawn } = require('node:child_process')

/* Read-and-write over the vault, and nothing else. Claude takes a tool
   allowlist directly; Codex has no per-tool switch, so its shell is fenced in
   by the sandbox instead — see the flags in `startCodexTurn`.

   Turning writing off withdraws the tools rather than asking the model not to
   use them, so "just answer, don't touch my notes" is a fact about the process
   and not a request it can talk itself out of. */
const CLAUDE_TOOLS = {
  write: 'Read,Edit,Write,Glob,Grep,TodoWrite',
  read: 'Read,Glob,Grep'
}

/* The vault's own path is stated rather than left to be inferred. A CLI that
   finds itself inside a git checkout takes the repository root as the project
   root, which for a vault stored in one — a notes repo, or Tulip's own sample
   vault — silently widens the agent's idea of where the notes are, and it
   starts globbing the wrong tree. */
const systemPrompt = (dir) => `You are the assistant inside Tulip, a markdown \
notes app. The user's vault is the directory ${dir}, and every .md file under \
it is a note. Work only inside that directory, and resolve every relative path \
against it — not against any enclosing project or git repository.

Conventions of this vault:
- Notes link to each other with [[Wikilinks]] — the note's name, without the path or extension.
- Attachments live in .images/<Note name>/ and are embedded with ![[name.png]].
- A note may open with YAML frontmatter between --- fences.
- Fenced code blocks are runnable in the app, so keep their language tags accurate.

Edit notes in place with the Edit tool rather than rewriting them with Write — \
the user is watching the file change in their editor as you work, and a whole-file \
rewrite reads as a flash rather than an edit. Keep prose replies short; the user \
can see the note.`

let emit = () => {}
let vault = null
let session = null   // { provider, model, proc, busy, thread }

/* A GUI app inherits a PATH that has never seen a login shell, and both CLIs
   install somewhere only a profile knows about. Main lends us the one it
   already resolves for running fenced code. */
let resolvePath = () => process.env.PATH

/** Where the renderer is told to look. Relative to the vault, so the paths
 *  match the ones the note tree already uses. */
function relative (abs) {
  if (!abs || !vault) return abs || ''
  const rel = path.relative(vault, abs)
  return rel.startsWith('..') ? abs : rel
}

/* ------------------------------------------------------------------ Claude */

/**
 * One process for the whole conversation. `--input-format stream-json` keeps
 * stdin open for turn after turn, which is the only way to hold session state
 * without paying to replay the transcript on every message.
 */
function startClaude (model, write) {
  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', write ? 'acceptEdits' : 'plan',
    '--tools', write ? CLAUDE_TOOLS.write : CLAUDE_TOOLS.read,
    '--add-dir', vault,
    '--system-prompt', systemPrompt(vault)
  ]
  if (model) args.push('--model', model)

  const proc = spawn('claude', args, {
    cwd: vault,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: resolvePath() }
  })

  // Tool calls are announced with their arguments some time before the result
  // that says they finished, so the id has to carry the path across the gap.
  const pending = new Map()

  readLines(proc.stdout, (msg) => onClaudeMessage(msg, pending))
  return proc
}

function onClaudeMessage (msg, pending) {
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        session.thread = msg.session_id
        emit({ k: 'ready', provider: 'claude', model: session.model })
      }
      break

    case 'stream_event': {
      const ev = msg.event
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        emit({ k: 'text', text: ev.delta.text })
      } else if (ev?.type === 'content_block_start' &&
                 ev.content_block?.type === 'thinking') {
        emit({ k: 'thinking' })
      }
      break
    }

    // The full tool call, arguments included — the last word before the tool
    // runs, and the only place the file path is complete.
    case 'assistant':
      for (const block of msg.message?.content || []) {
        if (block.type !== 'tool_use') continue
        const file = block.input?.file_path || block.input?.path || ''
        pending.set(block.id, { name: block.name, path: relative(file) })
        emit({ k: 'tool', id: block.id, name: block.name, path: relative(file) })
      }
      break

    // A tool result coming back is what makes an edit real: the file on disk
    // has changed by now, so this is the moment worth reloading it.
    case 'user':
      for (const block of msg.message?.content || []) {
        if (block.type !== 'tool_result') continue
        const call = pending.get(block.tool_use_id)
        pending.delete(block.tool_use_id)
        if (!call) continue
        const wrote = call.name === 'Edit' || call.name === 'Write'
        emit({
          k: wrote && !block.is_error ? 'edited' : 'tool-done',
          id: block.tool_use_id,
          name: call.name,
          path: call.path,
          error: !!block.is_error
        })
      }
      break

    case 'rate_limit_event':
      emit({ k: 'limit', info: msg.rate_limit_info })
      break
  }

  // The turn's closing summary arrives without a `type` in some builds, so it
  // is recognised by what only it carries.
  if (msg.type === 'result' || typeof msg.num_turns === 'number') {
    session.busy = false
    emit({
      k: 'turn-end',
      error: msg.is_error ? (msg.result || 'The assistant stopped early.') : null,
      cost: msg.total_cost_usd,
      usage: msg.usage
    })
  }
}

/* ------------------------------------------------------------------- Codex */

/**
 * A process per turn. Codex resumes a thread by id rather than holding one
 * open, and its stdin is for the prompt alone, so there is nothing to keep
 * alive between messages.
 */
function startCodexTurn (text) {
  const args = ['exec', '--json', '--cd', vault, '--skip-git-repo-check',
                '--sandbox', session.write ? 'workspace-write' : 'read-only',
                '-c', 'approval_policy="never"']
  if (session.model) args.push('--model', session.model)
  if (session.thread) args.splice(1, 0, 'resume', session.thread)
  // `-` sends the prompt over stdin. As an argument it would ride the command
  // line, which a long question and a quoted selection can overrun.
  args.push('-')

  const proc = spawn('codex', args, {
    cwd: vault,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: resolvePath() }
  })
  proc.stdin.end(text)

  readLines(proc.stdout, onCodexMessage)
  proc.on('exit', () => {
    if (session?.busy) { session.busy = false; emit({ k: 'turn-end' }) }
    if (session) session.proc = null
  })
  return proc
}

function onCodexMessage (msg) {
  switch (msg.type) {
    case 'thread.started':
      // Recorded, not announced: the panel was told the provider was ready
      // when it was chosen. This is only where the id to resume from arrives.
      session.thread = msg.thread_id
      break

    case 'item.completed': {
      const item = msg.item || {}
      if (item.type === 'agent_message') {
        // Codex delivers prose whole rather than in deltas, so a completed
        // message is the first and last the renderer hears of it.
        emit({ k: 'text', text: item.text || '' })
      } else if (item.type === 'reasoning') {
        emit({ k: 'thinking' })
      } else if (item.type === 'file_change') {
        for (const change of item.changes || []) {
          const file = relative(change.path || change.file || '')
          emit({ k: 'tool', id: item.id, name: 'Edit', path: file })
          emit({ k: 'edited', id: item.id, name: 'Edit', path: file })
        }
      } else if (item.type === 'command_execution') {
        emit({ k: 'tool', id: item.id, name: 'Bash', path: item.command || '' })
      } else if (item.type === 'error') {
        // Codex reports its startup warnings on the same channel as real
        // failures, and it starts up once per turn — so an unfiltered relay
        // repeats the same two paragraphs after every message. Each distinct
        // message is worth saying once per conversation.
        const message = item.message || ''
        if (message && !session.said.has(message)) {
          session.said.add(message)
          emit({ k: 'notice', message })
        }
      }
      break
    }

    case 'turn.completed':
      session.busy = false
      emit({ k: 'turn-end', usage: msg.usage })
      break

    case 'turn.failed':
      session.busy = false
      emit({ k: 'turn-end', error: msg.error?.message || 'The turn failed.' })
      break
  }
}

/* ------------------------------------------------------------------ plumbing */

/** JSON per line, and a line can be split across two reads. */
function readLines (stream, onMessage) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    let cut
    while ((cut = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, cut).trim()
      buffer = buffer.slice(cut + 1)
      if (!line) continue
      try { onMessage(JSON.parse(line)) } catch { /* not ours to read */ }
    }
  })
}

function watchExit (proc) {
  proc.on('error', (err) => {
    const missing = err.code === 'ENOENT'
    emit({
      k: 'error',
      message: missing
        ? `The \`${session?.provider === 'codex' ? 'codex' : 'claude'}\` command is not on your PATH. Install it and sign in with your subscription.`
        : err.message
    })
    stop()
  })
  let stderr = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk) => { stderr += chunk })
  proc.on('exit', (code) => {
    if (code && code !== 0) {
      emit({ k: 'error', message: stderr.trim().slice(-400) || `The assistant exited (${code}).` })
    }
  })
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

function start ({ provider = 'claude', model = '', write = true } = {}) {
  if (!vault) return { ok: false, error: 'Open a vault first.' }
  stop()
  session = {
    provider, model, write, proc: null, busy: false, thread: null, said: new Set()
  }

  if (provider === 'claude') {
    session.proc = startClaude(model, write)
    watchExit(session.proc)
    session.proc.on('exit', () => { if (session) session.proc = null })
  } else {
    // Codex has nothing to spawn until there is something to say.
    emit({ k: 'ready', provider, model })
  }
  return { ok: true, provider, model }
}

function send (text, context) {
  // Deliberately not started here: only the panel knows which model and which
  // write mode the user picked, so an implicit start would quietly answer as
  // somebody else.
  if (!session) return { ok: false, error: 'The assistant is not running.' }
  if (session.busy) return { ok: false, error: 'The assistant is still working.' }

  // What the user is looking at, stated once at the top of the turn. The agent
  // can read any note it likes; this only saves it a guess about which one.
  const prompt = context?.note
    ? `<open-note>${context.note}${context.selection
        ? `\n\nSelected text:\n${context.selection}`
        : ''}</open-note>\n\n${text}`
    : text

  session.busy = true

  if (session.provider === 'codex') {
    // Codex has no system-prompt flag, so the same briefing rides the first
    // message of the thread; every turn after resumes and still has it.
    session.proc = startCodexTurn(
      session.thread ? prompt : `${systemPrompt(vault)}\n\n---\n\n${prompt}`
    )
    watchExit(session.proc)
    return { ok: true }
  }

  if (!session.proc) {
    session.proc = startClaude(session.model, session.write)
    watchExit(session.proc)
  }
  session.proc.stdin.write(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] }
  }) + '\n')
  return { ok: true }
}

function stop () {
  if (session?.proc) {
    session.proc.stdin?.end()
    session.proc.kill('SIGTERM')
  }
  session = null
  return { ok: true }
}

function status () {
  return {
    vault: !!vault,
    running: !!session,
    busy: !!session?.busy,
    provider: session?.provider || null,
    model: session?.model || '',
    write: session ? session.write : true
  }
}

module.exports = { setVault, attach, start, send, stop, status }
