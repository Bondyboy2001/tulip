'use strict'

/**
 * The copilot, as a subprocess.
 *
 * None of the three vendors sells API access on a personal subscription, but
 * each ships a CLI that authenticates against one — so the copilot is
 * `claude`, `codex` or `opencode` run headlessly with the vault as its working
 * directory, rather than an HTTP client holding a key. That decision buys the
 * file access for nothing: the agent reads and writes notes through its own
 * tools, and Tulip's job is narrowed to relaying what it says and noticing what
 * it touched.
 *
 * The three CLIs speak different event streams. Everything below funnels them
 * into one vocabulary — see `emit` calls for the whole of it — so the renderer
 * never learns which one is answering.
 */

const path = require('node:path')
const { spawn, execFile } = require('node:child_process')
const VAULT_CONTRACT = require('./vault-contract.json')
const RUNNABLE = require('./runnable-languages.json')

/* The three CLIs and what they offer before they are asked. Shared with the
   renderer (src/models.js) rather than restated here: the same fact deciding
   what the dropdown shows and what this process will accept is how the two come
   to disagree. Same arrangement as vault-contract.json and zoom-steps.json. */
const CATALOGUE = require('./ai-models.json')
const MODEL_FALLBACKS = CATALOGUE.fallbacks
/* Keyed by id, for the two facts this file needs about a provider that are not
   its models: the binary to run, and the name to call it in an error. Taken
   from the catalogue rather than written out beside each `spawn`, so there is
   one answer to "what is Codex" and the settings pane reads the same one. */
const PROVIDERS = Object.fromEntries(CATALOGUE.providers.map((p) => [p.id, p]))
const IS_WINDOWS = process.platform === 'win32'

/* opencode names its tools in lower case and has a couple the other two do not.
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
 * The three CLIs hand this back in three shapes — a string, a list of content
 * blocks, or an object with the output on a field of its own — so the shapes are
 * flattened here and the panel is given one thing to show. Trimmed to the limit
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

/* Kept compact because these rules accompany every turn. Repeating them makes
   them reach resumed Codex/opencode threads and outweigh older reply patterns. */
const TURN_RULES = `Writing rules:
- New notes are plain Markdown. Add YAML frontmatter only when explicitly \
requested. Tulip displays the filename as the page title, so do not repeat it \
as a \`#\` heading; start with the body or first useful section.
- Write mathematical notation as LaTeX (\`$…$\` inline, \`$$…$$\` displayed), \
not HTML, italics or Unicode look-alikes.
- For PDF-derived claims, cite extracted page markers as \`[page 12]\` or \
\`[pages 12–14]\`; for another file use \`[Paper.pdf page 12]\`. For bibliographic \
citations, read the adjacent \`references.bib\` and use \`[@key]\` or \
\`[@key, p. 4]\`; never invent keys.
- Edit existing notes in place rather than rewriting the whole file. Keep the \
reply short; the user can see the note.`

/* The vocabulary table's columns, read off the template the app actually
   builds those tables from. Named in the briefing below, and a renamed column
   has to reach the agent or it will keep writing the old one. */
const VOCABULARY_COLUMNS = VAULT_CONTRACT.languageTableTemplates.vocabulary
  .split('\n')[0].split('|').map((cell) => cell.trim()).filter(Boolean)

/* Which fence languages the app itself does something with — the first alias of
   each runner, and the fences that draw a picture rather than run. Both read off
   the file the Run button and the drawing modules are built from, so a fence
   added to the app is a fence the copilot hears about. Told to the agent because
   a model that does not know what this app understands writes `graphviz` where
   `mermaid` would have drawn, and `text` where a block would have run. */
const RUNNABLE_LANGUAGES = Object.values(RUNNABLE.runners).map((names) => names[0])
const DRAWN_LANGUAGES = Object.values(RUNNABLE.drawn)

/* The callout kinds, off the table src/callouts.js draws them from — for the
   same reason as the two lists above. An unknown kind still renders, in the
   neutral tone, so naming them is about the agent reaching for one that has a
   colour and an icon rather than about refusing the rest. */
const CALLOUT_KINDS = require('./callout-kinds.json').kinds.map((kind) => kind.id)

const systemPrompt = (dir) => `You are Copilot inside Tulip, a Markdown notes app.

Scope:
- The vault root is ${dir}. Work only inside it and resolve relative paths \
against it, never an enclosing repository.
- Every \`.md\` file is a note. Read only files relevant to the request; do not \
survey the vault for style or conventions.
- The note named in \`<open-note>\` is merely on screen. Read or edit it only \
when the request concerns it.
- Unless told otherwise, create a new note at the vault root and name it for \
its subject.

Vault conventions:
- Link notes as \`[[Note]]\`, without path or extension.
- Files ending in ${VAULT_CONTRACT.languageTableSuffix} are language tables. Their first Markdown table \
uses the columns ${VOCABULARY_COLUMNS.join(', ')}. Preserve those column names \
and keep one vocabulary item per row; ${VOCABULARY_COLUMNS[0]} and \
${VOCABULARY_COLUMNS[1]} generate study cards.
- Put attachments in ${VAULT_CONTRACT.attachmentDirectory}/<Note name>/ and \
embed them as \`![[name.png]]\`; optional image sizes are \`|400\` or \`|400x260\`.
- Embed notes as \`![[Note]]\`, sections as \`![[Note#Heading]]\`, and blocks as \
\`![[Note#^block-id]]\`; define a block id by ending the block with \`^block-id\`.
- Runnable fence languages: ${RUNNABLE_LANGUAGES.join(', ')}. Drawn fence \
languages: ${DRAWN_LANGUAGES.join(', ')}. Other fence tags display as code.
- Callouts use \`> [!kind] Title\`; known kinds: ${CALLOUT_KINDS.join(', ')}.
- \`#tag\` is a tag and \`==text==\` is a highlight. Use either only when wanted.
- Label display equations with \`\\label{eq:name}\`, link them with \
\`\\eqref{eq:name}\`, and override the number with \`\\tag{...}\`.
- Do not open binary PDFs. Their extracted text is \
${VAULT_CONTRACT.annotationDirectory}/<name>.pdf${VAULT_CONTRACT.pdfTextSuffix}; \
highlights are ${VAULT_CONTRACT.annotationDirectory}/<name>.pdf.json. Never write \
inside ${VAULT_CONTRACT.annotationDirectory}/; Tulip owns it.

${TURN_RULES}`

/**
 * How much of the context window a turn left in play, as one number.
 *
 * The three CLIs count differently — Claude reports the fresh and the cached
 * halves of the prompt separately, Codex reports a total with the cached part
 * folded in, and opencode reports a running total per step. Summing every field
 * either of them fills in reconciles all three: the ones a CLI does not report
 * are absent rather than zero, so the same addition is right for each. The
 * panel is handed a token count and never learns whose it is.
 */
const used = (usage) =>
  (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) +
  (usage?.cache_read_input_tokens || 0) + (usage?.output_tokens || 0)

let emit = () => {}
let vault = null
let session = null   // { provider, model, effort, write, proc, busy, thread, said, used }

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

/* ---------------------------------------------------------------- running */

/**
 * A CLI, started.
 *
 * The three are spawned alike — the vault as the working directory, a login
 * shell's PATH, and a process group of their own so `stop` takes their tool
 * subprocesses with them — and they die alike, so all of that is here and the
 * three `start…` functions below are left holding only their own arguments.
 *
 * The session is captured rather than read back off the module: `stop` nulls it
 * and `start` immediately builds another, so a SIGTERMed process can outlive
 * its own session by a few lines of stdout. Every event, every mutation and
 * every end-of-turn below is gated on this process still being the session's,
 * which is the whole of the answer to "whose turn is this?" — the handlers
 * underneath never have to ask.
 */
function launch (provider, args, onMessage, { prompt = null, reportStdinError = false } = {}) {
  const self = session
  const proc = spawn(PROVIDERS[provider].command, args, {
    cwd: vault,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own process group, so `stop` can take the CLI's tool subprocesses
    // with it rather than leaving them orphaned.
    detached: true,
    windowsHide: true,
    // npm-installed CLIs are .cmd shims on Windows. Node cannot execute those
    // directly, so let cmd.exe unwrap the fixed provider command and flags.
    shell: IS_WINDOWS,
    env: { ...process.env, PATH: resolvePath() }
  })

  const mine = () => session === self && self.proc === proc

  /* A process that dies mid-turn has to close the turn out, or `busy` stays set
     and every later message is refused with "still working" — the reply it is
     waiting for is never coming. Only opencode ever fills in `used`; the panel
     ignores a zero. */
  const endTurn = () => {
    if (!mine()) return
    self.proc = null
    if (self.busy) { self.busy = false; emit({ k: 'turn-end', used: self.used || 0 }) }
  }

  readLines(proc.stdout, (msg) => { if (mine()) onMessage(msg) })

  /* Writing to a CLI that has already died is an EPIPE on stdin, and an
     unhandled stream error takes the whole main process down. Treated as the
     death it is — though for the two that spawn per turn the exit handler is
     already telling that story, and the stream's own complaint has nothing to
     add. */
  proc.stdin.on('error', (err) => {
    const ours = mine()
    endTurn()
    if (ours && reportStdinError) {
      emit({ k: 'error', message: `The copilot is no longer running (${err.code || err.message}).` })
    }
  })
  if (prompt != null) proc.stdin.end(prompt)

  proc.on('error', (err) => {
    /* Gated like every handler above it. A spawn failure arrives asynchronously,
       by which time the session may already have been replaced — and a dead
       process must not report its death as the current session's, nor `stop`
       the one that took its place. */
    if (!mine()) return
    emit({
      k: 'error',
      message: err.code === 'ENOENT'
        ? `The \`${PROVIDERS[provider].command}\` command is not on your PATH. Install it and sign in with your subscription.`
        : err.message
    })
    stop()
  })

  // Only the tail is kept: a Claude process lives as long as the conversation,
  // and an unbounded accumulator would grow with it.
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
    emit({ k: 'error', message: stderr.trim().slice(-400) || `The copilot exited (${code}).` })
  })

  return proc
}

/* ------------------------------------------------------------------ Claude */

/**
 * One process for the whole conversation. `--input-format stream-json` keeps
 * stdin open for turn after turn, which is the only way to hold session state
 * without paying to replay the transcript on every message.
 */
function startClaude () {
  const { model, effort, write, thread } = session
  const args = [
    '--print',
    '--model', model,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    // Read-only is enforced by the tool list below, not by the mode. Plan mode
    // would do it too, but it also sends the agent off to write a plan file in
    // the user's home directory — work outside the vault that nobody asked for.
    '--permission-mode', write ? 'acceptEdits' : 'dontAsk',
    '--tools', write ? CLAUDE_TOOLS.write : CLAUDE_TOOLS.read,
    '--add-dir', vault,
    '--system-prompt', systemPrompt(vault)
  ]
  if (effort) args.push('--effort', effort)
  if (thread) args.push('--resume', thread)

  // Tool calls are announced with their arguments some time before the result
  // that says they finished, so the id has to carry the path across the gap.
  const pending = new Map()
  // The arguments of a call still being written, by content-block index. This
  // is what the note being typed into is read from, long before `pending`.
  const drafting = new Map()
  return launch('claude', args, (msg) => onClaudeMessage(msg, pending, drafting),
    { reportStdinError: true })
}

/* The escapes JSON spells with a backslash. `\u` is handled separately, since
   it is the only one that is not a single character. */
const JSON_ESCAPES = {
  '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t'
}

/**
 * The fields of a JSON object that is still being written.
 *
 * Tool arguments arrive as a stream of fragments, and the one worth watching —
 * the text going into the note — is the last and by far the longest. `JSON.parse`
 * can say nothing about a document until its final brace lands, which for a long
 * write is the whole point missed. This reads what has arrived: every field that
 * has closed, plus the tail of the one still open, unescaped as far as it goes.
 *
 * The name of the open field comes back as `writing`, because a value that is
 * still growing and one that is finished mean different things to the caller.
 *
 * @param {string} text  the concatenated `partial_json` fragments so far
 * @returns {Record<string, string> & {writing?: string}}
 */
function draftFields (text) {
  const out = {}
  let i = 0
  const space = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i++ }

  /** The string starting at `i`, and whether its closing quote has arrived. */
  const string = () => {
    i++
    let value = ''
    while (i < text.length) {
      const ch = text[i]
      if (ch === '"') { i++; return { value, closed: true } }
      if (ch !== '\\') { value += ch; i++; continue }
      const escape = text[i + 1]
      // A backslash at the very end is half an escape: the rest is in the next
      // fragment, and guessing at it would put a stray character in the note.
      if (escape === undefined) break
      if (escape !== 'u') {
        value += JSON_ESCAPES[escape] ?? escape
        i += 2
        continue
      }
      const hex = text.slice(i + 2, i + 6)
      if (hex.length < 4) break
      value += String.fromCharCode(parseInt(hex, 16))
      i += 6
    }
    return { value, closed: false }
  }

  space()
  if (text[i] !== '{') return out
  i++
  while (i < text.length) {
    space()
    if (text[i] === ',') { i++; continue }
    if (text[i] !== '"') break        // `}`, or a key that has not arrived yet
    const key = string()
    if (!key.closed) break
    space()
    if (text[i] !== ':') break
    i++
    space()
    if (text[i] === '"') {
      const value = string()
      out[key.value] = value.value
      if (!value.closed) { out.writing = key.value; break }
      continue
    }
    /* Anything else — a number, a boolean, `replace_all` — is skipped whole.
       Nothing here reads them, and stopping at the wrong comma would strand
       every field after it.

       A string inside the value is stepped over rather than scanned, because a
       bracket in one is not a bracket: `["a]b"]` counted naively closes the
       array a character early, the loop then stops on the real `]`, and every
       field after it is lost. Nothing Edit or Write takes is shaped like that
       today — their arguments are strings and one boolean — which is the only
       reason this has never been seen. */
    const from = i
    let depth = 0
    while (i < text.length) {
      const ch = text[i]
      // `string` leaves `i` past the closing quote, or at the end of what has
      // arrived when the quote has not.
      if (ch === '"') { string(); continue }
      if (ch === '[' || ch === '{') depth++
      else if (ch === ']' || ch === '}') { if (!depth) break; depth-- }
      else if (ch === ',' && !depth) break
      i++
    }
    if (i >= text.length) break
    out[key.value] = text.slice(from, i).trim()
  }
  return out
}

/* One frame's worth. The fragments arrive faster than the screen can show
   them, and a relay per fragment is a message per token for frames nobody
   paints. */
const DRAFT_INTERVAL = 40

/**
 * A write in progress, relayed as it is composed.
 *
 * Only Edit and Write, and only once their target and the text they are
 * replacing have closed — before that there is nothing the renderer could
 * anchor the preview to.
 *
 * What goes across is the tail written since the last relay, never the whole
 * text: the decoded text only grows, and sending all of it each time would cost
 * a copy of the note per frame — quadratic over a long write, on the bridge the
 * rest of the window shares.
 */
function draftEdit (call, { last = false } = {}) {
  if (call.name !== 'Edit' && call.name !== 'Write') return
  const now = Date.now()
  if (!last && now - call.at < DRAFT_INTERVAL) return

  const fields = draftFields(call.json)
  const file = fields.file_path || fields.path || ''
  const text = call.name === 'Write' ? fields.content : fields.new_string
  if (!file || text == null) return
  // An Edit whose `old_string` is still arriving has nowhere to go yet.
  if (call.name === 'Edit' && fields.writing === 'old_string') return
  // Nothing decoded since the last relay — a fragment that was all escape.
  if (call.sent && text.length <= call.sent) return

  call.at = now
  const start = !call.sent
  const chunk = text.slice(call.sent)
  call.sent = text.length
  emit({
    k: 'typing',
    id: call.id,
    name: call.name,
    path: relative(file),
    needle: call.name === 'Edit' ? (fields.old_string || '') : '',
    start,
    chunk
  })
}

function onClaudeMessage (msg, pending, drafting) {
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        session.thread = msg.session_id
        emit({ k: 'ready', thread: session.thread })
      } else if (msg.subtype === 'thinking_tokens') {
        // The raw chain of thought is never returned — only its size. A count
        // is still worth showing: it is the difference between a copilot
        // that looks hung and one you can watch working.
        emit({ k: 'thinking', tokens: msg.estimated_tokens })
      }
      break

    case 'stream_event': {
      const ev = msg.event
      /* `message_start` also carries the resolved, versioned model id. It is
         deliberately not relayed: the panel shows the alias the user picked,
         and "Opus" turning into a dated id after the first reply reads as the
         control having changed under them. */
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        emit({ k: 'text', text: ev.delta.text })
      } else if (ev?.type === 'content_block_start' &&
                 ev.content_block?.type === 'thinking') {
        emit({ k: 'thinking', tokens: 0 })
      } else if (ev?.type === 'content_block_start' &&
                 ev.content_block?.type === 'text') {
        // Prose has started, so whatever thinking preceded it is over.
        emit({ k: 'answering' })
      } else if (ev?.type === 'content_block_start' &&
                 ev.content_block?.type === 'tool_use') {
        drafting.set(ev.index, {
          id: ev.content_block.id,
          name: ev.content_block.name,
          json: '',
          at: 0,      // when this call was last relayed
          sent: 0     // how much of its decoded text has gone across
        })
      } else if (ev?.type === 'content_block_delta' &&
                 ev.delta?.type === 'input_json_delta') {
        /* The arguments of a call being composed. For a write this is the note
           itself, arriving a few characters at a time — the only chance to show
           the text landing as it is written rather than after the fact. */
        const call = drafting.get(ev.index)
        if (call) {
          call.json += ev.delta.partial_json || ''
          draftEdit(call)
        }
      } else if (ev?.type === 'content_block_stop') {
        const call = drafting.get(ev.index)
        // The last fragment is usually inside the throttle window, and it is
        // the one that completes the text — always relay it.
        if (call) { draftEdit(call, { last: true }); drafting.delete(ev.index) }
      }
      break
    }

    // The full tool call, arguments included — the last word before the tool
    // runs, and the only place the file path is complete.
    case 'assistant':
      for (const block of msg.message?.content || []) {
        if (block.type !== 'tool_use') continue
        const file = block.input?.file_path || block.input?.path || ''
        const needle = block.input?.old_string || block.input?.oldString || ''
        pending.set(block.id, { name: block.name, path: relative(file) })
        emit({ k: 'tool', id: block.id, name: block.name, path: relative(file), needle })
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
        emit({
          k: wrote(call.name) && !block.is_error ? 'edited' : 'tool-done',
          id: block.tool_use_id,
          name: call.name,
          path: call.path,
          error: !!block.is_error,
          /* What the tool actually said. Without it a step that failed is a red
             row with no reason on it, and a search that found nothing looks the
             same as one that found everything. */
          detail: detailOf(block.content)
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
      error: msg.is_error ? (msg.result || 'The copilot stopped early.') : null,
      cost: msg.total_cost_usd,
      used: used(msg.usage)
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
                '--model', session.model,
                '--sandbox', session.write ? 'workspace-write' : 'read-only',
                '-c', 'approval_policy="never"']
  /* Codex spells effort as a config override rather than a flag. The level came
     from this model's own `supported_reasoning_levels`, so `xhigh`, `max` and
     `ultra` reach it as its own words. */
  if (session.effort) {
    args.push('-c', `model_reasoning_effort="${session.effort}"`)
  }
  if (session.thread) args.splice(1, 0, 'resume', session.thread)
  // `-` sends the prompt over stdin. As an argument it would ride the command
  // line, which a long question and a quoted selection can overrun.
  args.push('-')

  return launch('codex', args, onCodexMessage, { prompt: text })
}

/**
 * A Codex item as a tool call, or nothing for the kinds that are not one.
 *
 * The same item is announced twice — running, then finished — and both have to
 * name it the same way or the panel draws two rows where there was one call.
 */
function codexTool (item) {
  switch (item.type) {
    case 'command_execution': return { name: 'Bash', path: item.command || '' }
    case 'file_search': return { name: 'Grep', path: item.query || '' }
    case 'web_search': return { name: 'Fetch', path: item.query || '' }
    default: return null
  }
}

function onCodexMessage (msg) {
  switch (msg.type) {
    case 'thread.started':
      // Announced so the panel can file it against the note: this id is how the
      // conversation is picked up again after switching away and back.
      session.thread = msg.thread_id
      emit({ k: 'thread', thread: session.thread })
      break

    /* A tool call, announced as it starts rather than once it is over.
       A command or a search is most of the wall-clock of a turn and the part
       that most looks like a hang, and until this the panel had nothing at all
       to show for it — the row appeared already finished, however long it ran.
       `item.completed` still announces the call itself, so a build that says
       nothing until it is done goes on working exactly as it did. */
    case 'item.started': {
      const item = msg.item || {}
      const tool = codexTool(item)
      if (tool) emit({ k: 'tool', id: item.id, ...tool })
      break
    }

    case 'item.completed': {
      const item = msg.item || {}
      if (item.type === 'reasoning') {
        emit({ k: 'thinking', text: item.text || '', tokens: 0 })
      } else if (item.type === 'agent_message') {
        // Codex delivers prose whole rather than in deltas, so a completed
        // message is the first and last the renderer hears of it.
        emit({ k: 'text', text: item.text || '' })
      } else if (item.type === 'file_change') {
        for (const change of item.changes || []) {
          const file = relative(change.path || change.file || '')
          emit({ k: 'tool', id: item.id, name: 'Edit', path: file })
          emit({ k: 'edited', id: item.id, name: 'Edit', path: file })
        }
      } else if (item.type === 'command_execution') {
        /* The call is named again alongside its result, for the builds that
           announce nothing until it is over — `step` in the panel matches on
           the id, so the row `item.started` already drew is the row this
           finishes. `exit_code` is the whole of whether it worked. */
        const failed = item.exit_code != null && item.exit_code !== 0
        const tool = codexTool(item)
        emit({ k: 'tool', id: item.id, ...tool })
        emit({
          k: 'tool-done',
          id: item.id,
          ...tool,
          error: failed,
          detail: detailOf(item.aggregated_output ?? item.output ?? '')
        })
      } else if (item.type === 'file_search' || item.type === 'web_search') {
        const tool = codexTool(item)
        emit({ k: 'tool', id: item.id, ...tool })
        emit({ k: 'tool-done', id: item.id, ...tool, detail: detailOf(item.results ?? '') })
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
      emit({ k: 'turn-end', used: used(msg.usage) })
      break

    case 'turn.failed':
      session.busy = false
      emit({ k: 'turn-end', error: msg.error?.message || 'The turn failed.' })
      break
  }
}

/* ---------------------------------------------------------------- opencode */

/**
 * A process per turn, like Codex: `run` resumes a thread by id rather than
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
    emit({ k: 'thread', thread: session.thread })
  }

  const part = msg.part || {}
  switch (msg.type) {
    case 'reasoning':
      emit({ k: 'thinking', text: part.text || '', tokens: 0 })
      break

    case 'text':
      // Delivered whole rather than in deltas, like Codex.
      emit({ k: 'text', text: part.text || '' })
      break

    case 'tool_use': {
      const state = part.state || {}
      const input = state.input || {}
      const name = OPENCODE_TOOLS[part.tool] || part.tool || 'Tool'
      const where = input.filePath || input.pattern || input.command || input.path || ''
      const needle = input.oldString || input.old_string || ''
      const id = part.callID || part.id
      emit({ k: 'tool', id, name, path: relative(where), needle })
      // A tool call is announced already finished in the common case; the
      // guard is for the builds that report it running first.
      if (state.status === 'completed' || state.status === 'error') {
        const failed = state.status === 'error'
        emit({
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
      emit({
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

/* -------------------------------------------------------------------- API */

function setVault (dir) {
  if (dir !== vault) stop()
  vault = dir
}

function attach (fn, pathFn) {
  emit = fn
  if (pathFn) resolvePath = pathFn
}

/**
 * The model a turn will actually be run with.
 *
 * Claude and Codex are held to their published lists, because a typo there is a
 * process that starts and then fails. opencode is not: its catalogue is
 * whatever the user's account can reach — hundreds of models across a dozen
 * providers, none of them known here — so anything the renderer offers is taken
 * at its word.
 */
function modelFor (provider, requested) {
  const allowed = MODEL_FALLBACKS[provider] || []
  if (!allowed.length) return requested || ''
  return allowed.some(({ id }) => id === requested) ? requested : allowed[0].id
}

/** One CLI asked for its catalogue. An empty answer is the answer: `allModels`
 *  in the renderer substitutes the built-in list for a provider that gives
 *  nothing, so a GUI launched before the CLI is installed still shows one. */
function ask (command, args, parse) {
  return new Promise((resolve) => {
    execFile(command, args, {
      env: { ...process.env, PATH: resolvePath() },
      windowsHide: true,
      shell: IS_WINDOWS,
      maxBuffer: 8 * 1024 * 1024
    }, (error, stdout) => {
      if (error) { resolve([]); return }
      try { resolve(parse(stdout)) } catch { resolve([]) }
    })
  })
}

/** Codex answers with a JSON catalogue, and says which entries it means to
 *  show, in what order, and what reasoning each one takes — all three are
 *  honoured. Its levels run past `high` to `xhigh`, `max` and `ultra`. */
function parseCodex (stdout) {
  const parsed = JSON.parse(stdout)
  const catalogue = Array.isArray(parsed) ? parsed : (parsed.models || [])
  return catalogue
    .filter((item) => item.visibility !== 'hide')
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((item) => {
      const id = item.slug || item.id || item.model
      const efforts = (item.supported_reasoning_levels || [])
        .map((level) => level.effort)
        .filter(Boolean)
      return {
        id,
        label: item.display_name || id,
        efforts,
        effort: item.default_reasoning_level || efforts[0] || '',
        context: item.context_window || 0
      }
    })
    .filter((model) => model.id)
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

/**
 * Claude's own answer to what it offers.
 *
 * The CLI prints the current lineup as a table (`claude models list`), newest
 * first — which is the one place the hand-written labels in the fallback list
 * can go stale: an alias like `opus` follows the newest model of that name
 * whether this file has heard about it yet or not, so "Opus 5" quietly means
 * "the label the day it was typed" until someone edits the JSON. Read at
 * catalogue time and merged over the fallback, which still decides the ids
 * offered (an alias the app does not recognise is one it cannot offer
 * sanely) and the efforts each takes (the lineup does not publish them).
 *
 * Answers a Map family → row: `claude-opus-5` lands under `opus`, and the
 * first row of a family is the newest, which is the one an alias means.
 */
function parseClaude (stdout) {
  const newest = new Map()
  for (const line of String(stdout || '').split('\n')) {
    const m = /^\|\s*(?:Claude\s+)?([^|`]+?)\s*\|\s*`?claude-([a-z]+)-[0-9][^`|\s]*`?\s*\|\s*([^|]+?)\s*\|/.exec(line.trim())
    if (!m) continue
    const family = m[2].toLowerCase()
    if (newest.has(family)) continue
    newest.set(family, { label: m[1].trim(), context: contextSize(m[3].trim()) })
  }
  return newest
}

function contextSize (text) {
  const m = /^(\d+(?:\.\d+)?)\s*([KM])?$/i.exec(String(text || '').replace(/,/g, ''))
  if (!m) return 0
  const n = Number(m[1])
  return m[2] ? (m[2].toUpperCase() === 'M' ? Math.round(n * 1000000) : Math.round(n * 1000)) : Math.round(n)
}

/** The fallback list with whatever the CLI said written over it. */
function mergeClaude (fallback, newest) {
  return fallback.map((model) => {
    const row = newest.get(model.id)
    if (!row) return model
    return {
      ...model,
      label: row.label || model.label,
      context: row.context || model.context
    }
  })
}

/**
 * Every model the three CLIs offer, which is what the settings pane chooses
 * from. Claude publishes no catalogue command that predates its own lineup
 * table, so its aliases are stated in the fallback and its labels refreshed
 * from the CLI; the other two are asked, in parallel, because opencode's
 * answer takes a second and there is no reason for Codex to wait behind it.
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
    ask('claude', ['models', 'list'], (stdout) => stdout),
    ask('codex', ['debug', 'models'], parseCodex),
    ask('opencode', ['models', '--verbose'], parseOpencode)
  ]).then(([claudeTable, codex, opencode]) => ({
    /* The CLI's labels written over the fallback's; where a CLI pre-dates the
       command or answers with something unrecognisable, the map is empty and
       the fallback stands unchanged. */
    claude: mergeClaude(MODEL_FALLBACKS.claude, parseClaude(claudeTable || '')),
    codex,
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

function start ({ provider = 'claude', model, effort = 'high', write = true, resume = null } = {}) {
  if (!vault) return { ok: false, error: 'Open a vault first.' }
  stop()
  const selectedModel = modelFor(provider, model)
  session = {
    provider, model: selectedModel, effort, write,
    proc: null, busy: false, thread: resume || null, said: new Set(), used: 0
  }

  if (provider === 'claude') {
    session.proc = startClaude()
  } else {
    // Codex and opencode have nothing to spawn until there is something to say.
    emit({ k: 'ready', thread: session.thread })
  }
  return { ok: true, provider, model: selectedModel, effort }
}

/**
 * What is on screen, as the agent is told it.
 *
 * A PDF says so, and says where in it the reader is: "the selection" from a
 * hundred-page document means little without the page it was on, and the page
 * is also what makes the agent's own reading of the file line up with what the
 * user can see.
 */
function opened (context) {
  /* A selection the renderer had to cut short says so. Silently sending the
     first four thousand characters of a passage would have the agent answer
     confidently about a paragraph it was never shown the end of. */
  const selection = context.selection
    ? `\n\nSelected text${context.truncated ? ' (cut short — ask to read the file for the rest)' : ''}:\n${context.selection}`
    : ''
  /* Where the reader is, for the common question asked with nothing selected.
     "Explain this" in a note of two thousand lines is otherwise a guess, and the
     guess the agent makes is the top of the file. */
  const caret = !context.selection && context.line
    ? `\n\nTheir cursor is on line ${context.line}${context.heading ? `, under the heading “${context.heading}”` : ''}.`
    : ''
  if (context.kind === 'language') {
    return `<open-language-table>${context.note}${selection}</open-language-table>`
  }
  /* A website says which page the reader is on rather than what the file says,
     because the two part company the moment a link is clicked — and the file,
     which the agent can read for itself, would only ever tell it the first. */
  if (context.kind === 'site') {
    const title = context.title ? `\n\nThe page is titled “${context.title}”.` : ''
    return `<open-website>${context.note}\n\nThe reader is looking at ${context.url || 'no page yet'}.${title}</open-website>`
  }
  if (context.kind !== 'pdf') return `<open-note>${context.note}${caret}${selection}</open-note>`

  const where = `\n\nThe reader is on page ${context.page}${context.pages ? ` of ${context.pages}` : ''}.`
  /* Named outright rather than left to the briefing's rule about where a PDF's
     text lives. The whole point of extracting it is that every model can read
     the document, and the weaker ones follow a path they were handed over one
     they have to assemble. */
  const words = `\n\nIts text is in ${VAULT_CONTRACT.annotationDirectory}/${context.note}${VAULT_CONTRACT.pdfTextSuffix}.`
  return `<open-pdf>${context.note}${where}${words}${selection}</open-pdf>`
}

const isPdfAttachment = (file) => path.extname(String(file || '')).toLowerCase() === '.pdf'

function promptFor (text, context) {
  /* What the user is looking at, stated once at the top of the turn. The agent
     can read any note it likes; this only saves it a guess about which one.

     Then the compact writing rules, so resumed conversations receive current
     behavior and older reply patterns do not outweigh it. */
  /* Attachments are named, not carried. All three CLIs read a file for
     themselves, so selected files and pasted pictures are written to the
     vault and reach the agent as the one thing it can always act on: a path. */
  const ordinaryAttachments = Array.isArray(context?.attachments)
    ? context.attachments.filter((file) => !isPdfAttachment(file))
    : []
  const attachments = ordinaryAttachments.length
    ? `The user attached ${ordinaryAttachments.length === 1 ? 'a file' : 'files'}. ` +
      `Open ${ordinaryAttachments.length === 1 ? 'it' : 'them'} with your file-reading tool:\n` +
      ordinaryAttachments.map((file) => `- ${file}`).join('\n')
    : ''

  const pdfs = Array.isArray(context?.pdfDocuments) && context.pdfDocuments.length
    ? `PDF documents are ready as page-marked text${context.pdfDocuments.some((pdf) => pdf.ocrPages) ? ', with Vision OCR where needed' : ''}:\n` +
      context.pdfDocuments.map((pdf) => `- ${pdf.path}: ${pdf.textPath}`).join('\n')
    : ''

  return [
    context?.note ? opened(context) : '', attachments, pdfs,
    context?.pdfContext || '', TURN_RULES, text
  ]
    .filter(Boolean).join('\n\n')
}

function send (text, context) {
  // Deliberately not started here: only the panel knows which copilot, which
  // effort and which write mode the user picked, so an implicit start would
  // quietly answer as somebody else.
  if (!session) return { ok: false, error: 'The copilot is not running.' }
  if (session.busy) return { ok: false, error: 'The copilot is still working.' }

  const prompt = promptFor(text, context)

  session.busy = true

  if (session.provider === 'codex' || session.provider === 'opencode') {
    // Neither has a system-prompt flag, so the same briefing rides the first
    // message of the thread; every turn after resumes and still has it.
    const opening = session.thread
      ? prompt
      : `${systemPrompt(vault)}\n\n---\n\n${prompt}`
    session.proc = session.provider === 'codex'
      ? startCodexTurn(opening)
      : startOpencodeTurn(opening)
    return { ok: true }
  }

  if (!session.proc) session.proc = startClaude()
  session.proc.stdin.write(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] }
  }) + '\n')
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
      if (IS_WINDOWS) {
        try {
          const killer = spawn('taskkill.exe', [
            '/pid', String(proc.pid), '/t', ...(sig === 'SIGKILL' ? ['/f'] : [])
          ], { stdio: 'ignore', windowsHide: true, detached: true })
          killer.unref()
        } catch {
          try { proc.kill() } catch { /* already gone */ }
        }
        return
      }
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
   functions underneath it. They are the fragile half of this file: three
   hand-rolled parsers reading three CLIs' output, none of it reachable through
   the six calls above and none of it exercised by anything short of running all
   three programs. `scripts/test-ai.mjs` is what they are exported for. */
module.exports = {
  setVault,
  attach,
  models,
  start,
  send,
  stop,
  parsers: { draftFields, detailOf, readLines, parseCodex, parseOpencode, parseClaude, mergeClaude, codexTool },
  prompts: { systemPrompt, turnRules: TURN_RULES, promptFor }
}
