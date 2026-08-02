import MarkdownIt from 'markdown-it'

import { dropdown } from './dropdown.js'
import { el as element } from './blocks.js'
import { diffBlock } from './history.js'
import { when } from './time.js'
import { mathPlugin } from './math.js'
import { routeAnchor, revealAnchorTarget } from './links.js'
import {
  DEFAULT_CATALOGUE, DEFAULT_MODEL,
  asOptions, effortLabel, effortsFor, modelFromConfig, nearestEffort,
  offeredModels, providerLabel, splitKey
} from './models.js'

/**
 * The copilot panel.
 *
 * It holds no opinion about files. The agent has the vault open on the other
 * side of the bridge and edits notes itself; what arrives here is a narration
 * of that — prose to show, and the name of each note it touched, which goes
 * straight back to the renderer so the open buffer can follow along.
 *
 * A conversation belongs to a note. Switching notes swaps the transcript on
 * screen and, at the next message, resumes that note's own session — so asking
 * about one note never drags in what you were discussing about another. A note
 * may have many conversations; one of them is open, and `/new` and `/history`
 * in the message box are how you start another or go back to an old one.
 *
 * The transcript is data, not DOM. Every message is a plain object that knows
 * how to draw itself, which is what lets a conversation be written to disk and
 * read back weeks later rather than dying with the window.
 */

/**
 * A citation: the page of the open document an answer came from.
 *
 * `[p. 12]`, `[pp. 12–14]`, `[page 12]`, and — when the answer ranges over more
 * than the document on screen — `[Paper.pdf p. 12]`. The copilot is asked for
 * this shape in the system prompt (electron/ai.js), but the pattern is
 * deliberately the one a person would write anyway: a model that has never
 * heard the instruction still lands on it half the time, and a reply from
 * before the instruction existed becomes clickable when it is read back.
 *
 * Sticky rather than anchored-and-sliced: this is tried at every `[` in a reply
 * that is re-rendered on every frame while it streams, and slicing the tail of
 * the message each time is a copy per bracket.
 */
const CITE = /\[(?:([^[\]|<>]{1,120}?\.pdf)[,;]?\s+)?(pp?\.|pages?|p)\s*(\d{1,5})(?:\s*(?:–|—|-|to)\s*(\d{1,5}))?\]/iy

function citePlugin (md) {
  /* After `link`, so `[p. 12](https://…)` stays the link it was written as —
     the rules are tried in order at each position, and the first to claim the
     bracket keeps it. */
  md.inline.ruler.after('link', 'cite', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x5B) return false   // '['
    CITE.lastIndex = state.pos
    const match = CITE.exec(state.src)
    if (!match) return false

    if (!silent) {
      const token = state.push('cite', '', 0)
      token.content = match[0].slice(1, -1).trim()
      token.meta = { path: match[1] || '', page: Number(match[3]) }
    }
    state.pos += match[0].length
    return true
  })

  md.renderer.rules.cite = (tokens, i) => {
    const { path, page } = tokens[i].meta
    const where = path ? ` data-cite-path="${md.utils.escapeHtml(path)}"` : ''
    return `<a class="ai-cite" href="#" data-cite-page="${page}"${where}>` +
           `${md.utils.escapeHtml(tokens[i].content)}</a>`
  }
}

/**
 * `<sub>` and `<sup>`, as the two tags rather than as raw HTML.
 *
 * HTML is off in chat prose and stays off. But a model writing about
 * mathematics reaches for `Q<sub>A</sub>` whether or not it was asked to, and
 * with the tags escaped the reply reads as markup instead of as an index. So
 * exactly these two are understood, with plain text inside and no nesting —
 * which is all either is ever used for, and small enough that letting them
 * through is not the same as letting HTML through.
 */
const SCRIPT_TAG = /<(sub|sup)>([^<>&]{1,60})<\/\1>/iy

function scriptPlugin (md) {
  md.inline.ruler.before('escape', 'sub_sup', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x3C) return false   // '<'
    SCRIPT_TAG.lastIndex = state.pos
    const match = SCRIPT_TAG.exec(state.src)
    if (!match) return false

    if (!silent) {
      const token = state.push('sub_sup', '', 0)
      token.tag = match[1].toLowerCase()
      token.content = match[2]
    }
    state.pos += match[0].length
    return true
  })

  md.renderer.rules.sub_sup = (tokens, i) =>
    `<${tokens[i].tag}>${md.utils.escapeHtml(tokens[i].content)}</${tokens[i].tag}>`
}

/* Chat prose is not a note: no Run buttons on its fences, no wikilinks, no
   embeds. A plain renderer, kept apart from the one the reading view uses —
   but sharing its maths, because an answer about a paper is mostly formulae
   and `\frac{1}{2}` set as prose is an answer nobody can read. */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: true })
  .use(mathPlugin)
  .use(scriptPlugin)
  .use(citePlugin)

/* What each tool is doing, and what it did. A call is announced with its
   arguments well before its result comes back — often a minute before, for a
   command or a wide search — and naming both states in the past tense made a
   call still running indistinguishable from one that had finished. Two `Edited`
   rows on one file, one of them with no diff beside it, is that ambiguity: the
   second had not happened yet. */
const TOOL_VERB = {
  Read: ['Reading', 'Read'],
  Edit: ['Editing', 'Edited'],
  Write: ['Writing', 'Wrote'],
  Glob: ['Searching', 'Searched'],
  Grep: ['Searching', 'Searched'],
  TodoWrite: ['Planning', 'Planned'],
  Bash: ['Running', 'Ran'],
  Fetch: ['Fetching', 'Fetched'],
  Task: ['Delegating', 'Delegated']
}

/* A step saved before this existed has no `done`, and every one of them is over
   — nothing in a transcript read back from disk is still running. */
const running = (msg) => msg.done === false
const verbFor = (msg) =>
  TOOL_VERB[msg.name]?.[running(msg) ? 0 : 1] || msg.name

/* Enough to scroll back through, bounded so a vault worked in for a year does
   not turn into a transcript archive nobody asked for. */
const MAX_MESSAGES = 150
const MAX_NOTES = 60
const MAX_CHATS = 20   // conversations kept per note; the oldest fall off

export function mountCopilot ({
  el, api, context, onEditing, onEdited, onTyping, onConfig, onCite, onOpen,
  onRestore, onAccept, onWarn
}) {
  const state = {
    open: false,
    effort: 'high',
    /* One choice, not two: `provider:id` names the CLI and the model together,
       so the panel has a single control where it used to have a pair. */
    model: DEFAULT_MODEL,
    catalogue: DEFAULT_CATALOGUE,
    // Which of the catalogue the dropdown offers — chosen in Settings, because
    // opencode alone answers with hundreds.
    enabled: [],
    write: true,      // may the copilot edit notes, or only read them
    busy: false,
    started: false,

    /* Set whenever a setting changes or the note does. Nothing restarts on the
       spot: the process is replaced at the next message, when the wait is
       expected anyway. Restarting on the change itself made the effort slider
       kill and respawn a CLI under the user's thumb. */
    stale: false,

    notePath: '',
    // note path -> { at, active, convos: [{ id, thread, at, messages }] }
    chats: new Map(),

    stream: null,       // the copilot message currently being written into
    think: null,        // the thinking message for the turn in progress

    /* The conversation the running turn files into, captured the moment the
       message is sent. Every event of that turn routes here — never to
       whichever note happens to be on screen when it arrives — so switching
       notes mid-reply cannot misfile the answer. */
    turn: null          // { path, convo }
  }
  const persistConfig = (patch) =>
    onConfig ? onConfig(patch) : api.config.set(patch)

  /**
   * The turn's heartbeat, at the foot of the transcript.
   *
   * A reply can be minutes of tool calls with nothing to show for them, and the
   * question that gets asked in that silence is whether the thing has died. So
   * this runs for the whole turn rather than only while the model is thinking —
   * it says which phase the turn is in, and counts, because a number that keeps
   * going up is the difference between waiting and wondering.
   *
   * Not a message: it is a fact about right now, and writing it into the
   * transcript would mean saving and reloading a spinner that stopped hours ago.
   */
  const busyRow = element('div', 'ai-busy')
  busyRow.hidden = true
  const busySpinner = element('span', 'ai-spinner')
  const busyLabel = element('span', 'ai-busy-label')
  const busyTime = element('span', 'ai-busy-time')
  busyRow.append(busySpinner, busyLabel, busyTime)
  el.log.append(busyRow)

  let busyAt = 0
  let busyTick = 0
  let busyPhase = 'Working'

  function paintBusy () {
    busyLabel.textContent = busyPhase
    const seconds = Math.round((Date.now() - busyAt) / 1000)
    // Silent for the first couple of seconds: a timer on a reply that arrives
    // straight away is noise, not reassurance.
    busyTime.textContent = seconds >= 2 ? `${seconds}s` : ''
    if (following) el.log.scrollTop = el.log.scrollHeight
  }

  /** Which phase the turn is in. Cheap enough to call on every event. */
  function phase (what) {
    if (what === busyPhase || !state.busy) return
    busyPhase = what
    paintBusy()
  }

  /* ------------------------------------------------------------ the model */

  /* Ids only have to be unique within this vault's history file; a counter
     alongside the clock keeps two chats started in the same millisecond apart. */
  let seq = 0
  const newChat = () => ({
    id: `c${Date.now().toString(36)}${(seq++).toString(36)}`,
    thread: null,
    threadOf: null,
    used: 0,
    at: Date.now(),
    messages: []
  })

  /** Everything filed under a note: its conversations, and which one is open. */
  function file (path = state.notePath) {
    let entry = state.chats.get(path)
    if (!entry) {
      const convo = newChat()
      entry = { at: convo.at, active: convo.id, convos: [convo] }
      state.chats.set(path, entry)
    }
    return entry
  }

  /** The conversation on screen. */
  function chat (path = state.notePath) {
    const entry = file(path)
    return entry.convos.find((c) => c.id === entry.active) || entry.convos[0]
  }

  /**
   * The session id to resume with, if this conversation has one worth using.
   *
   * A thread belongs to the CLI that issued it: handing `claude --resume` an id
   * opencode opened is an argument it has never seen, and the turn fails — then
   * fails again on every later message, because the id is still there. So each
   * id is filed with the program that made it and offered back only to that
   * one. An id from before this was recorded has no owner, and is not resumed.
   *
   * This replaced dropping every thread whenever the model changed, which lost
   * conversations that switching back would have picked up again.
   */
  const resumeFor = (convo, cli) => (convo.threadOf === cli && convo.thread) || null

  /** Add a message to a conversation — the open one, unless a running turn
   *  says otherwise — and draw it only if that conversation is on screen. */
  function push (msg, to = null) {
    const path = to?.path ?? state.notePath
    const convo = to?.convo ?? chat(path)
    convo.messages.push(msg)
    convo.at = file(path).at = Date.now()
    if (convo.messages.length > MAX_MESSAGES) {
      // The DOM child leaves with its message, or the cap trims only the data.
      const gone = convo.messages.shift()
      gone.node?.remove()
      gone.node = null
    }
    if (convo === chat()) {
      el.log.insertBefore(draw(msg), busyRow)
      scrollDown()
    }
    save()
    return msg
  }

  /**
   * Redraw one message after its contents changed — a reply being streamed
   * into, a tool call that has finished, thinking that has stopped.
   *
   * The work is put off to the next frame. A reply changes on every delta, and
   * rendering markdown and replacing a subtree per delta is work the screen
   * never shows: it paints once a frame whatever we do. Collecting the changed
   * messages and drawing them once turns a render per token into one per
   * frame, which is what keeps the rest of the window responsive while the
   * copilot is writing.
   */
  const dirty = new Set()
  let frame = 0

  function redraw (msg) {
    // Every path that changes a message comes through here, which is what makes
    // this the one place the rendered copy has to be let go of.
    msg.html = null
    if (!msg.node) return
    dirty.add(msg)
    if (!frame) frame = requestAnimationFrame(paintDirty)
  }

  function paintDirty () {
    frame = 0
    for (const msg of dirty) repaintMessage(msg)
    dirty.clear()
    scrollDown()
  }

  /* Nothing collected is worth drawing once the log has been replaced. */
  function dropDirty () {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    dirty.clear()
  }

  /**
   * The element is updated rather than swapped, and updated no deeper than the
   * change reaches. A reply being streamed into repaints once a frame, and
   * rebuilding the whole bubble each time tore the DOM out from under the
   * pointer — the cursor flickered over the panel for as long as a turn ran,
   * and any selection being made in the reply was dropped per frame. The
   * settled part of a stream and the standing parts of a thinking row keep
   * their nodes; only what actually changed is written.
   */
  function repaintMessage (msg) {
    const node = msg.node
    if (!node || !node.isConnected) return
    node.className = classOf(msg)
    if (msg.t === 'step' && node.matches('button.msg-step')) {
      node.dataset.path = msg.path || ''
      if (msg.line != null) node.dataset.line = String(msg.line)
      else delete node.dataset.line
    }
    if (msg === state.stream) return paintStream(node, msg.text || '')
    if (msg.t === 'think' && paintThink(node, msg)) return
    node.innerHTML = html(msg)
  }

  /* A live thinking row keeps its two children — the head and the body — and
     has its text replaced inside them. Returns false when the node is not in
     that shape (an old transcript drawn before this existed), and the caller
     rebuilds it whole once. */
  function paintThink (node, msg) {
    const label = node.querySelector('.think-label')
    const count = node.querySelector('.think-count')
    const body = node.querySelector('.think-body')
    if (!label || !count || !body) return false
    label.textContent = msg.live ? 'Thinking' : (msg.tokens ? 'Thought for' : 'Thought')
    count.textContent = msg.tokens ? `${msg.tokens.toLocaleString()} tokens` : ''
    body.textContent = String(msg.text ?? '')
    return true
  }

  const FENCE = /^\s*(?:```|~~~)/

  /**
   * Where the settled part of a streaming reply ends: the last blank line that
   * is not inside an open fence or an open `$$` block, since cutting inside
   * either would render half of it as prose.
   *
   * One forward pass, resumed where the last frame left off. The reply only
   * ever grows, so the fences and `$$` before the cut cannot change — but the
   * scan used to run backwards from the end and re-count every fence in a fresh
   * copy of the prefix at each candidate blank line. On a reply whose code block
   * is longer than the prose above it, that is quadratic work per frame, for as
   * long as the block streams, on the thread the rest of the window lives on.
   *
   * The state rides on the node rather than the message because it describes the
   * text that has been drawn, and the node is what holds the drawing.
   */
  function settledCut (node, text) {
    let scan = node.streamScan
    // A reply that shrank is a reply that was replaced: start the scan over.
    if (!scan || scan.at > text.length) {
      scan = node.streamScan = { at: 0, cut: -1, fenced: false, maths: false }
    }
    for (;;) {
      const stop = text.indexOf('\n', scan.at)
      // The last line is still being typed. Its fences are not counted until it
      // is whole, and nothing after this point can be cut at anyway.
      if (stop === -1) return scan.cut
      const line = text.slice(scan.at, stop)
      if (FENCE.test(line)) {
        scan.fenced = !scan.fenced
      } else if (!scan.fenced) {
        // `$$…$$` on one line toggles twice and so leaves the block closed.
        for (let at = line.indexOf('$$'); at !== -1; at = line.indexOf('$$', at + 2)) {
          scan.maths = !scan.maths
        }
        // A blank line outside both is the seam: the `\n\n` ends one character
        // before this empty line begins.
        if (!line && !scan.maths && scan.at) scan.cut = scan.at - 1
      }
      scan.at = stop + 1
    }
  }

  /**
   * The markdown of a reply still being streamed.
   *
   * Everything before the settled cut is prose that will not change again:
   * rendered once into a node that then stays put, with only the trailing chunk
   * re-rendered on each frame — because rendering the whole accumulated reply
   * per frame is O(n²) over a long one. The seam gets one clean whole-reply
   * render when the stream settles.
   */
  function paintStream (node, text) {
    const cut = settledCut(node, text)
    const prefix = cut === -1 ? '' : text.slice(0, cut + 2)
    const tail = cut === -1 ? text : text.slice(cut + 2)

    let head = node.firstElementChild
    let live = node.lastElementChild
    if (!head?.classList.contains('stream-head') || !live?.classList.contains('stream-tail')) {
      node.innerHTML = '<div class="stream-head"></div><div class="stream-tail"></div>'
      head = node.firstElementChild
      live = node.lastElementChild
      head.renderedPrefix = ''
    }
    if (head.renderedPrefix !== prefix) {
      head.renderedPrefix = prefix
      head.innerHTML = prefix ? md.render(prefix) : ''
    }
    live.innerHTML = md.render(tail)
  }

  /** The reply is no longer being streamed into: give the finished text the
   *  one clean whole render the fast path deferred, seam and split removed. */
  function settleStream () {
    const msg = state.stream
    state.stream = null
    if (msg) redraw(msg)
  }

  /** What a message wears, which changes with it: a tool call that failed,
   *  thinking that has finished and can therefore be opened. */
  function classOf (msg) {
    if (msg.t === 'review') return `msg msg-review${msg.accepted ? ' is-accepted' : ''}`
    if (msg.t === 'step') {
      const opens = (msg.name === 'Edit' || msg.name === 'Write') && msg.path
      return ['msg msg-step', msg.error && 'is-error', running(msg) && 'is-running',
              opens && 'can-open is-edit'].filter(Boolean).join(' ')
    }
    if (msg.t !== 'think') return `msg msg-${msg.t}`
    return ['msg msg-think', msg.live && 'is-live', msg.text && 'has-text',
            !msg.live && msg.text && 'can-open'].filter(Boolean).join(' ')
  }

  const escape = (text) => md.utils.escapeHtml(String(text ?? ''))

  function render (msg) {
    if (msg.t === 'you' || msg.t === 'bot') return md.render(msg.text || '')
    if (msg.t === 'step') {
      const verb = verbFor(msg)
      const tally = msg.added != null || msg.removed != null
        ? '<span class="step-tally">' +
          `<span class="is-add">+${Number(msg.added || 0).toLocaleString()}</span>` +
          `<span class="is-del">−${Number(msg.removed || 0).toLocaleString()}</span></span>`
        : ''
      if ((msg.name === 'Edit' || msg.name === 'Write') && msg.path) {
        return '<span class="step-edit-mark" aria-hidden="true">' +
          '<svg viewBox="0 0 16 16"><path d="M3 11.75V13h1.25l7.7-7.7-1.25-1.25zM9.9 4.85l1.25 1.25"/></svg></span>' +
          '<span class="step-copy"><span class="step-action">' + escape(verb) + '</span>' +
          `<span class="step-path">${escape(msg.path)}</span></span>${tally}` +
          '<span class="step-jump" aria-hidden="true">→</span>'
      }
      const label = escape(msg.path ? `${verb} ${msg.path}` : verb)
      return `<span class="step-label">${label}</span>${tally}`
    }
    if (msg.t !== 'think') return escape(msg.text)

    const label = msg.live ? 'Thinking' : (msg.tokens ? 'Thought for' : 'Thought')
    const count = msg.tokens ? `${msg.tokens.toLocaleString()} tokens` : ''
    return '<div class="think-head"><span class="think-dot"></span>' +
           `<span class="think-label">${escape(label)}</span>` +
           `<span class="think-count">${escape(count)}</span></div>` +
           `<div class="think-body">${escape(msg.text)}</div>`
  }

  /**
   * A message as HTML, kept on the message once it has been rendered.
   *
   * Markdown with KaTeX in it is the expensive part of this panel, and the same
   * message is rendered again every time the log is rebuilt — which is once per
   * note opened, over a transcript of up to `MAX_MESSAGES`. `redraw` is what
   * lets the copy go, and every path that changes a message goes through it.
   * The reply being streamed into is the exception: it changes on every frame,
   * and `paintStream` holds its settled half in the DOM instead.
   */
  function html (msg) {
    if (msg.html == null) msg.html = render(msg)
    return msg.html
  }

  /**
   * A message, as an element. The node is remembered on the message so a
   * streaming reply or a tool call that has finished can be updated where it
   * stands rather than appended to again.
   */
  function draw (msg) {
    if (msg.t === 'review') return drawReview(msg)
    const clickable = msg.t === 'step' && (msg.name === 'Edit' || msg.name === 'Write') && msg.path
    const node = element(clickable ? 'button' : 'div', classOf(msg))
    if (clickable) {
      node.type = 'button'
      node.dataset.path = msg.path
      if (msg.line != null) node.dataset.line = String(msg.line)
    }
    if (msg === state.stream) paintStream(node, msg.text || '')
    else node.innerHTML = html(msg)
    msg.node = node
    return node
  }

  function drawReview (msg) {
    const operation = msg.operation
    const node = element('section', classOf(msg))
    const head = element('div', 'ai-review-head')
    head.append(element(
      'strong', '',
      `${operation.changes.length} file${operation.changes.length === 1 ? '' : 's'} changed`
    ))
    const files = element('div', 'ai-review-files')
    for (const summary of operation.changes) {
      const row = element('div', 'ai-review-file')
      // The changed file is context, not another action. The transcript's
      // `Edited …` row already provides the direct jump to the edit.
      const path = element('span', 'ai-review-path', summary.path)
      const diff = element('button', 'ghost is-compact', 'Diff')
      diff.type = 'button'
      diff.addEventListener('click', async () => {
        const old = row.querySelector('.history-diff')
        if (old) { old.remove(); return }
        const detail = await api.trust.operation(operation.id)
        const change = detail?.changes.find((item) => item.path === summary.path)
        if (!change) return
        row.append(diffBlock(change))
      })
      const restore = element('button', 'ghost is-compact is-accent', 'Restore')
      restore.type = 'button'
      restore.addEventListener('click', () => onRestore?.(operation, summary.path))
      row.append(path, diff, restore)
      files.append(row)
    }
    const actions = element('div', 'ai-review-actions')
    const keep = element('button', 'ai-review-keep', msg.accepted ? 'Accepted' : 'Accept changes')
    keep.type = 'button'
    keep.disabled = !!msg.accepted
    keep.addEventListener('click', () => {
      msg.accepted = true
      node.classList.add('is-accepted')
      keep.textContent = 'Accepted'
      keep.disabled = true
      Promise.resolve(onAccept?.(operation)).catch(() => {})
      save()
    })
    actions.append(keep)
    node.append(head, files, actions)
    msg.node = node
    return node
  }

  /**
   * Pinned to the bottom, unless the reader has deliberately scrolled up.
   *
   * Whether we are still following is answered by the last scroll rather than
   * measured here: measuring means reading layout back immediately after
   * writing to it, which forces the frame's layout early — the one thing a
   * streaming reply must not do on every update.
   */
  let following = true
  el.log.addEventListener('scroll', () => {
    following = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 140
  }, { passive: true })

  function scrollDown () {
    if (following) el.log.scrollTop = el.log.scrollHeight
  }

  const note = (text, t = 'note', to = null) => push({ t, text }, to)

  /** One line per tool call, updated in place when it finishes. */
  function step (event, to = null) {
    const convo = to?.convo ?? chat()
    const found = convo.messages.find((m) =>
      m.t === 'step' && m.id === event.id && (!event.path || !m.path || m.path === event.path))
    const fields = {
      name: event.name,
      path: event.path,
      error: !!event.error,
      ...(event.done != null ? { done: event.done } : {}),
      ...(event.added != null ? { added: event.added } : {}),
      ...(event.removed != null ? { removed: event.removed } : {}),
      ...(event.line != null ? { line: event.line } : {})
    }
    if (!found) {
      return push({ t: 'step', id: event.id, ...fields }, to)
    }
    Object.assign(found, fields)
    redraw(found)
    save()
    return found
  }

  /**
   * The thinking block.
   *
   * Neither CLI hands back the reasoning itself — Claude reports only how much
   * of it there was, and Codex a short summary. So this shows the shape of the
   * thinking rather than its content: live while it runs, and afterwards a
   * single quiet line saying how long it went on for.
   */
  function thinking (event, to = null) {
    if (!state.think) state.think = push({ t: 'think', tokens: 0, text: '', live: true }, to)
    const think = state.think
    if (event.tokens) think.tokens = Math.max(think.tokens, event.tokens)
    if (event.text) think.text += event.text
    redraw(think)
    // Not saved per delta — the turn's end and the tool calls cover it.
  }

  /**
   * A call the turn ended without a result for is not going to get one — the
   * process was stopped, or died, or simply never reported back. Left as it
   * was, it would still read `Editing` in a transcript opened a week later.
   */
  function settleSteps () {
    const convo = state.turn?.convo || chat()
    for (const msg of convo.messages) {
      if (msg.t === 'step' && msg.done === false) {
        msg.done = true
        redraw(msg)
      }
    }
  }

  /** The thinking is over — collapse it to its epitaph. */
  function settleThinking () {
    if (!state.think) return
    state.think.live = false
    redraw(state.think)
    state.think = null
    save()
  }

  function setBusy (busy) {
    state.busy = busy
    // The button is never disabled — while a turn runs it is the stop button,
    // which is exactly when you are most likely to want it.
    el.panel.dataset.busy = busy ? 'yes' : 'no'
    el.send.setAttribute('aria-label', busy ? 'Stop' : 'Send')

    clearInterval(busyTick)
    busyRow.hidden = !busy
    if (busy) {
      busyAt = Date.now()
      busyPhase = 'Working'
      paintBusy()
      busyTick = setInterval(paintBusy, 1000)
    } else {
      busyTick = 0
      settleThinking()
      settleStream()
      settleSteps()
      state.turn = null
    }
  }

  /**
   * The three things in a transcript that are worth clicking.
   *
   * A citation goes to the page it names — the whole point of asking for them.
   * A link opens in the browser rather than in this window: the log is inside
   * the app's only page, and letting an anchor follow itself would replace the
   * app with a website, with no way back.
   */
  el.log.addEventListener('click', (event) => {
    const edited = event.target.closest('.msg-step.can-open')
    if (edited) {
      const path = edited.dataset.path || ''
      const messages = chat().messages
      const at = messages.findIndex((message) => message.node === edited)
      const review = at < 0 ? null : messages.slice(at + 1).find((message) =>
        message.t === 'review' && !message.accepted &&
        message.operation?.changes?.some((change) => change.path === path))
      onOpen?.(
        path,
        edited.dataset.line ? Number(edited.dataset.line) : null,
        review?.operation?.id || null
      )
      return
    }

    const cite = event.target.closest('.ai-cite')
    if (cite) {
      event.preventDefault()
      onCite?.({ path: cite.dataset.citePath || '', page: Number(cite.dataset.citePage) })
      return
    }

    /* Same terms as the reading view: an in-page jump is shown where it
       landed, the web schemes go to the browser, and nothing else a transcript
       carries may navigate the app. */
    if (revealAnchorTarget(event)) return
    if (routeAnchor(event, (url) => api.openExternal(url))) return
    if (event.target.closest('a[href]')) return   // swallowed, not followed

    // Clicking a finished thinking block opens it, when there is anything inside.
    const block = event.target.closest('.msg-think.can-open')
    if (block) block.classList.toggle('is-open')
  })

  /* --------------------------------------------------------- persistence */

  /* Written on a timer rather than per message — and never on a text delta at
     all: a save per delta would serialise the whole multi-note history every
     800ms for as long as a reply streams. The deltas are picked up at the
     turn's end, at each tool call, and when the window blurs or the note
     switches. */
  let saveTimer = null
  let saveSince = 0
  let unsaved = false

  /* A ceiling on the debounce. A turn that calls a tool every half second used
     to push the write out ahead of itself for the whole turn, so a transcript
     minutes long existed nowhere but in this window until the turn ended. */
  const SAVE_WAIT = 800
  const SAVE_CEILING = 5000

  function save () {
    unsaved = true
    if (!saveSince) saveSince = Date.now()
    clearTimeout(saveTimer)
    const left = saveSince + SAVE_CEILING - Date.now()
    saveTimer = setTimeout(flush, Math.max(0, Math.min(SAVE_WAIT, left)))
  }

  function flush () {
    clearTimeout(saveTimer)
    saveTimer = null
    saveSince = 0

    // Oldest conversations fall off the end rather than accumulating forever.
    const ranked = [...state.chats.entries()]
      .filter(([path]) => path)
      .sort((a, b) => b[1].at - a[1].at)

    /* Out of memory as well as out of the file. Dropping them from the write
       alone left every note visited since launch resident for the life of the
       window, and re-sorted on every save. The two that cannot go are the one
       on screen and the one a running turn is filing into. Done before the
       question of whether to write at all: browsing notes with the panel shut
       makes entries without changing anything worth saving, and those are
       exactly the ones this is here to let go of. */
    for (const [path] of ranked.slice(MAX_NOTES)) {
      if (path !== state.notePath && path !== state.turn?.path) state.chats.delete(path)
    }

    /* Blur, `beforeunload` and every note switch ask for a write, and most of
       the time nothing has changed since the last one — while the write itself
       is a serialisation of every conversation in the vault, sent whole across
       the bridge. */
    if (!unsaved) return
    unsaved = false

    const out = {}
    for (const [path, entry] of ranked.slice(0, MAX_NOTES)) {
      out[path] = {
        at: entry.at,
        active: entry.active,
        convos: entry.convos.map((convo) => ({
          id: convo.id,
          thread: convo.thread,
          threadOf: convo.threadOf || null,
          used: convo.used || 0,
          at: convo.at,
          // `node` is this window's DOM and `html` its render of the message;
          // neither means anything to the next window.
          messages: convo.messages.map(({ node: _node, html: _html, ...rest }) => rest)
        }))
      }
    }
    /* A write that fails here is the one kind of loss nothing on screen shows:
       the conversations are still in memory and still on the panel, and the
       next launch simply opens without them.

       So it is reported — and `unsaved` goes back up. Clearing the flag before
       the write was what made a single failure permanent: every later flush
       saw nothing to do and returned, so a transient error (a full disk, a
       vault on a volume that had gone away) dropped the history for the rest
       of the session rather than for one attempt. */
    /* Returned so a caller that can wait — the quit handshake — knows when the
       transcripts are actually on disk rather than merely asked for. */
    return api.ai.history.save(out).catch((err) => {
      unsaved = true
      console.error('saving the copilot history failed', err)
      // During unload there is no window left to show it in, and the console
      // line above is the record.
      if (!unloading) onWarn?.('The assistant’s history could not be saved.')
    })
  }

  let unloading = false
  window.addEventListener('beforeunload', () => { unloading = true; flush() })
  // A blurred window is a natural settling point, and catches the deltas the
  // streaming path deliberately never schedules a save for.
  window.addEventListener('blur', flush)

  /* -------------------------------------------------------------- events */

  api.on('ai:event', (event) => {
    /* The turn that is running owns these events, wherever the reader has
       wandered since sending it; events arriving outside a turn belong to
       whatever is on screen. Resolved once and in full, so nothing below has to
       spell the fallback out again — it used to be spelled four ways, and two
       of them named the default differently. */
    const to = state.turn || { path: state.notePath, convo: chat() }
    switch (event.k) {
      case 'ready':
      case 'thread':
        state.started = true
        // Filed against the conversation being discussed, so coming back to it
        // later picks the same session up rather than starting over.
        if (event.thread) {
          to.convo.thread = event.thread
          to.convo.threadOf = provider()
          save()
        }
        break

      case 'thinking':
        thinking(event, to)
        phase('Thinking')
        break

      case 'answering':
        settleThinking()
        break

      case 'text':
        settleThinking()
        if (!state.stream) state.stream = push({ t: 'bot', text: '' }, to)
        state.stream.text += event.text
        redraw(state.stream)
        phase('Writing')
        break

      /* The copilot is composing a write. Nothing has happened to the file yet
         — this is the argument of a tool call still being spelled out — so it
         goes to the editor as a preview and never into the transcript. */
      case 'typing':
        settleThinking()
        onTyping?.(event)
        phase('Writing')
        break

      case 'tool':
        // A fresh tool call ends the paragraph before it; the next prose the
        // copilot writes belongs in a message of its own.
        settleThinking()
        settleStream()
        // Capture the note before the tool changes it. The renderer keeps this
        // separate from the transcript so it can draw a live, unsaved diff.
        if ((event.name === 'Edit' || event.name === 'Write') && event.path) {
          onEditing?.(event.path, event.needle || '', event.name)
        }
        step({ ...event, done: false }, to)
        // A tool running is the quietest part of a turn and the one that most
        // looks like a hang.
        phase('Working')
        break

      // Nothing was written — a read finishing, or a write that failed. Either
      // way the preview is now a promise the file did not keep.
      case 'tool-done':
        onTyping?.(null)
        step({ ...event, done: true }, to)
        break

      // The file on disk has changed. Whether that is visible depends on
      // whether it is the note on screen — the renderer decides.
      case 'edited': {
        const edit = { ...event, name: event.name || 'Edit', done: true }
        step(edit, to)
        Promise.resolve(onEdited?.(event.path)).then((summary) => {
          if (summary) step({ ...edit, ...summary }, to)
        }).catch(() => {})
        break
      }

      case 'review':
        push({ t: 'review', operation: event.operation, accepted: false }, to)
        save()
        break

      case 'limit':
        if (event.info?.status && event.info.status !== 'allowed') {
          note(`Rate limit: ${event.info.status}.`, 'warn', to)
        }
        break

      case 'notice':
        if (event.message) note(event.message, 'note', to)
        break

      // The process is gone — it exited, or was never there to begin with.
      // Forgetting it here is what lets the next message start a fresh one
      // instead of talking to a corpse.
      case 'error':
        state.started = false
        onTyping?.(null)
        note(event.message || 'Something went wrong.', 'warn', to)
        setBusy(false)
        break

      case 'turn-end':
        // The backstop. A write that lands clears its own preview by changing
        // the document; one that never lands would otherwise sit there.
        onTyping?.(null)
        if (event.used) {
          to.convo.used = event.used
          paintContext()
        }
        if (event.error) note(event.error, 'warn', to)
        setBusy(false)
        // The deltas since the last tool call are only in memory until now.
        save()
        break
    }
  })

  /* -------------------------------------------------------------- session */

  const settings = () => {
    const { provider, id } = splitKey(state.model)
    return {
      provider,
      model: id,
      effort: state.effort,
      write: state.write,
      resume: resumeFor(chat(), provider)
    }
  }

  /**
   * Makes the running process match what is on screen — the chosen copilot,
   * the chosen effort, and the note being discussed. Called just before a
   * message goes out, never on the change itself.
   */
  async function ensureSession () {
    /* The panel is not always the way in — a Fix button asks a question with
       the panel still closed — and a turn about to be sent is as good a reason
       to know the real catalogue as a control about to be drawn. */
    readCatalogue()
    if (state.started && !state.stale) return true
    if (state.stale) await api.ai.stop()
    const result = await api.ai.start(settings())
    state.started = !!result?.ok
    state.stale = false
    if (!result?.ok) note(result?.error || 'The copilot could not start.', 'warn')
    return state.started
  }

  /* ------------------------------------------------------------ commands */

  /**
   * Slash commands.
   *
   * A message that is nothing but `/word` is an instruction to the panel, not
   * something to send. Anything else — including a message that merely starts
   * with a slash and goes on — is prose, and goes to the copilot untouched.
   */
  const COMMANDS = [
    { name: 'new', hint: 'Start a new chat about this note', run: startChat },
    { name: 'history', hint: 'Open a past chat about this note', run: showHistory }
  ]

  const SLASH = /^\/([a-z]*)$/i

  /** A conversation, named by the first thing that was asked in it. */
  function title (convo) {
    const first = convo.messages.find((m) => m.t === 'you')
    const text = (first?.text || '').replace(/\s+/g, ' ').trim()
    if (!text) return 'Empty chat'
    return text.length > 64 ? `${text.slice(0, 64)}…` : text
  }

  /**
   * Put the open conversation away and start another about the same note.
   *
   * A chat nobody has spoken in yet is already a new one, so it is reused
   * rather than left behind as an empty entry in the history.
   */
  function startChat () {
    if (busyNow()) return
    const entry = file()
    const current = chat()

    if (current.messages.some((m) => m.t === 'you')) {
      const convo = newChat()
      entry.convos.push(convo)
      entry.active = convo.id
      entry.at = convo.at
      // The oldest go first, and the one just started is the youngest there is.
      if (entry.convos.length > MAX_CHATS) {
        entry.convos.sort((a, b) => a.at - b.at).splice(0, entry.convos.length - MAX_CHATS)
      }
    } else {
      current.messages.length = 0
      current.thread = null
      current.threadOf = null
      current.used = 0
    }

    reset()
    greet()
    save()
  }

  /** Go back to a past conversation about this note. */
  function openChat (id) {
    if (busyNow()) return
    const entry = file()
    if (entry.active === id || !entry.convos.some((c) => c.id === id)) return
    entry.active = id
    reset()
    save()
  }

  /** The history, newest first, as menu rows. */
  function showHistory () {
    const entry = file()
    const rows = [...entry.convos]
      .sort((a, b) => b.at - a.at)
      .filter((convo) => convo.messages.some((m) => m.t === 'you') || convo.id === entry.active)
      .map((convo) => ({
        label: title(convo),
        hint: convo.id === entry.active ? 'Open now' : when(convo.at),
        run: () => openChat(convo.id)
      }))

    if (rows.length < 2) { note('There is only this one chat about this note.'); return }
    el.input.value = ''
    sizeInput()
    showMenu(rows)
  }

  /* Nothing may be swapped out from under a turn that is still running: the
     events still arriving belong to the conversation that asked for them. */
  function busyNow () {
    if (!state.busy) return false
    note('The copilot is still working — stop it first.')
    return true
  }

  /** Whatever was on screen is no longer what we are looking at. */
  function reset () {
    state.stream = null
    state.think = null
    // The process is left alone; the next message replaces it with one resuming
    // whichever session this conversation belongs to.
    state.stale = true
    repaint()
    el.input.focus()
  }

  /** The command a bare `/word` names, if it names one. */
  const command = (text) => COMMANDS.find((c) => `/${c.name}` === text.toLowerCase())

  /* ---------------------------------------------------------- the menu */

  /* The list floating above the message box: either the commands matching what
     has been typed, or the conversations `/history` offers. One thing at a
     time, so the keys that drive it never have to ask which. */
  let menu = null   // { rows: [{ label, hint, run }], at }

  function showMenu (rows) {
    if (!rows.length) { hideMenu(); return }
    menu = { rows, at: 0 }
    paintMenu()
  }

  function hideMenu () {
    if (!menu) return
    menu = null
    el.menu.hidden = true
    el.menu.replaceChildren()
  }

  function paintMenu () {
    el.menu.replaceChildren(...menu.rows.map((row, at) => {
      const node = element('button', 'ai-menu-row')
      const on = at === menu.at
      node.type = 'button'
      node.setAttribute('role', 'option')
      node.setAttribute('aria-selected', on ? 'true' : 'false')
      node.classList.toggle('is-on', on)
      node.dataset.at = String(at)
      node.append(element('span', 'ai-menu-name', row.label),
                  element('span', 'ai-menu-hint', row.hint || ''))
      return node
    }))
    el.menu.hidden = false
    el.menu.children[menu.at]?.scrollIntoView({ block: 'nearest' })
  }

  function moveMenu (by) {
    const count = menu.rows.length
    menu.at = (menu.at + by + count) % count
    paintMenu()
  }

  function pickMenu (at = menu.at) {
    const row = menu.rows[at]
    hideMenu()
    row?.run()
  }

  /** The commands worth offering for what has been typed so far. */
  function offerCommands (text) {
    const match = SLASH.exec(text)
    if (!match) { hideMenu(); return }
    const typed = match[1].toLowerCase()
    showMenu(COMMANDS
      .filter((c) => c.name.startsWith(typed))
      .map((c) => ({ label: `/${c.name}`, hint: c.hint, run: () => { el.input.value = ''; sizeInput(); c.run() } })))
  }

  // A click lands before the textarea loses focus, so the box keeps the caret.
  el.menu.addEventListener('mousedown', (event) => event.preventDefault())
  el.menu.addEventListener('click', (event) => {
    const row = event.target.closest('.ai-menu-row')
    if (row && menu) pickMenu(Number(row.dataset.at))
  })

  /* --------------------------------------------------------------- input */

  async function submit () {
    const text = el.input.value.trim()
    if (!text || state.busy) return

    // Typed straight through without the menu — a command all the same.
    const found = command(text)
    if (found) { el.input.value = ''; sizeInput(); hideMenu(); found.run(); return }

    el.input.value = ''
    sizeInput()
    push({ t: 'you', text })
    // The turn is anchored to this conversation before anything can answer,
    // so browsing away while it runs cannot redirect what comes back.
    state.turn = { path: state.notePath, convo: chat() }
    const to = state.turn
    setBusy(true)

    if (!await ensureSession()) { setBusy(false); return }
    /* Stop may have been pressed while the session was starting — `halt` has
       nothing to signal yet at that point, so it settles the panel and returns,
       and without this the turn it thought it had cancelled would carry on
       from here: a reply and a run of file edits with no working strip, no way
       to stop them, and `state.turn` already let go of, so every event would
       be filed against whichever note happened to be on screen when it landed.
       The test is the turn's identity, not a flag: a *new* turn started in the
       meantime owns the session now, and this one is equally stale. */
    if (state.turn !== to) return

    // Awaited: the renderer flushes the open buffer here, so the agent reads
    // the note as it is on screen rather than as it was at the last autosave.
    const context_ = await context()
    if (state.turn !== to) return

    const result = await api.ai.send(text, context_)
    if (!result?.ok) {
      // Whatever went wrong, the session is no longer one we can trust; the
      // next message starts over rather than failing the same way again.
      state.started = false
      note(result?.error || 'The copilot could not be reached.', 'warn', to)
      setBusy(false)
    }
  }

  /** Text put into the message box, after whatever is already there, with the
   *  caret left at the end — where the reader's own words go. */
  function quote (text) {
    if (!text) return
    const box = el.input
    const gap = box.value && !box.value.endsWith('\n') ? '\n\n' : ''
    box.value = `${box.value}${gap}${text}`
    sizeInput()
    box.focus()
    box.setSelectionRange(box.value.length, box.value.length)
    box.scrollTop = box.scrollHeight
  }

  /** Grows with the message, up to a point, then scrolls. */
  function sizeInput () {
    el.input.style.height = 'auto'
    el.input.style.height = `${Math.min(el.input.scrollHeight, 190)}px`
  }

  el.input.addEventListener('input', () => {
    sizeInput()
    offerCommands(el.input.value.trim())
  })

  el.input.addEventListener('keydown', (e) => {
    // While the menu is up it owns the keys that mean "move" and "choose";
    // everything else still types into the box beneath it.
    if (menu) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveMenu(1); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveMenu(-1); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMenu(); return }
      if (e.key === 'Escape') { e.preventDefault(); hideMenu(); return }
    }
    // Enter sends, because this is a chat box. A newline is still a keystroke
    // away, which is the right way round for messages that are mostly one line.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  })

  el.input.addEventListener('blur', () => hideMenu())
  el.send.addEventListener('click', () => (state.busy ? halt() : submit()))

  async function halt () {
    const to = state.turn
    /* Let go of the turn before the await, not after. `submit` checks its own
       turn against this one at every point it resumes, so clearing it here is
       what makes a Stop pressed during startup actually stop: the send that
       was about to happen sees the turn has moved on and never goes out. */
    state.turn = null
    await api.ai.stop()
    state.started = false
    setBusy(false)   // settles the stream and lets go of the turn
    // Filed where the truncated reply went, so the transcript says why it ends.
    note('Stopped.', 'note', to)
  }

  /* ------------------------------------------------------------ settings */

  /** The models on offer, and the one chosen among them. */
  const currentModels = () =>
    offeredModels(state.catalogue, state.enabled, state.model)

  const currentModel = () =>
    currentModels().find((model) => model.key === state.model)

  const provider = () => splitKey(state.model).provider

  /**
   * How much of the model's context the conversation is carrying.
   *
   * A ring rather than a number, because the question it answers is "how much
   * room is left" — a proportion, which a circle states at a glance and a token
   * count makes you do arithmetic for. The exact figures are in the tooltip.
   *
   * Hidden until a turn has reported something, and for any model whose CLI
   * does not publish a window: an unfilled ring on a model nobody can measure
   * would be a claim, not a reading.
   */
  function paintContext () {
    const model = currentModel()
    const used = chat().used || 0
    const room = model?.context || 0
    const show = used > 0 && room > 0
    el.contextWrap.hidden = !show
    if (!show) return

    el.context.style.setProperty('--used', String(Math.min(1, used / room)))
    el.context.classList.toggle('is-full', used / room >= 0.85)

    /* The exact counts, grouped. Rounding to `5k` loses the thing the reading
       is for — watching the number climb — and a percentage is what the ring
       already says without needing to be read. */
    const said = `${used.toLocaleString()} of ${room.toLocaleString()}`
    el.contextPop.textContent = said
    el.context.setAttribute('aria-label', `Context used: ${said}`)
  }

  /** The always-visible readout: who is answering, and how hard. */
  function paintConfig () {
    const model = currentModel()
    el.configModel.textContent = model ? model.label : splitKey(state.model).id
    // A model with no such dial says nothing about effort rather than "High".
    const hasEffort = !!levels().length
    el.configEffort.textContent = hasEffort ? effortLabel(state.effort) : ''
    el.configEffort.hidden = !hasEffort
    el.configSep.hidden = !hasEffort
    paintContext()
  }

  /* The menu is drawn by the app, not by the system — see dropdown.js. It
     reports only what the user picks, so painting it from state cannot loop
     back round as a change. */
  const modelMenu = dropdown({
    label: 'Model',
    className: 'is-wide',
    value: state.model,
    onChange: (key) => chooseModel(key)
  })
  el.model.append(modelMenu.root)

  function paintModel () {
    const options = asOptions(currentModels())
    // `set` settles on the first entry when the stored model is not in the
    // list — a catalogue can lose an entry between launches, and unticking a
    // model in Settings takes it out of this one.
    state.model = modelMenu.set(options, state.model) || DEFAULT_MODEL
  }

  function chooseModel (key) {
    if (key === state.model) return
    if (!currentModels().some((model) => model.key === key)) return
    state.model = key
    state.stale = true
    /* The levels are the model's, so the choice moves with it: kept where the
       new model takes it, nudged to the nearest it does otherwise — which
       `repaintControls` settles before it draws. Written down in the same
       breath as the model, or the two disagree at the next start. */
    repaintControls()
    persistConfig({ aiModel: key, aiEffort: state.effort })
    save()
  }

  /**
   * The real catalogue, read once when the panel restores. There is no button
   * for it: a list that reads itself is never stale enough to be worth a
   * control sitting beside the select for the life of the app.
   */
  async function loadModels () {
    /* Taken whole — a provider that answers with nothing keeps its built-in
       list, but `allModels` already applies that rule for everyone. */
    state.catalogue = await api.ai.models()
    /* Until now the levels were guesses from the built-in list; this is the
       first moment the model's real ones are known, so the choice is fitted to
       them before the controls are drawn. */
    repaintControls()
  }


  function openPop (open) {
    el.pop.hidden = !open
    el.config.setAttribute('aria-expanded', open ? 'true' : 'false')
  }

  el.config.addEventListener('click', (event) => {
    event.stopPropagation()
    openPop(el.pop.hidden)
  })

  // Anywhere outside dismisses it, the way a menu does. The popover's own
  // clicks are stopped below so changing a setting does not close it.
  el.pop.addEventListener('click', (event) => event.stopPropagation())
  document.addEventListener('click', () => openPop(false))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.pop.hidden) { openPop(false); el.config.focus() }
  })

  /**
   * Effort, as the levels this model actually takes.
   *
   * Not a fixed four: Claude states five and applies them to everything, Codex
   * publishes a different set per model — up to `ultra` — and most of
   * opencode's catalogue has no such dial at all, in which case the row goes
   * away rather than offering a control that would be ignored. So the buttons
   * are built here rather than written into index.html.
   *
   * Nothing restarts the copilot — the level is a flag on the process,
   * applied when the next message replaces it, which is why picking one is
   * free.
   */
  const levels = () => effortsFor(currentModel())

  function paintEffort () {
    const offered = levels()
    // The whole row, label included, so nothing is left labelling an absence.
    el.effortRow.hidden = !offered.length
    if (!offered.length) { el.effort.replaceChildren(); return }

    el.effort.replaceChildren(...offered.map((level) => {
      const button = element('button', '', effortLabel(level))
      button.type = 'button'
      button.setAttribute('role', 'radio')
      button.dataset.effort = level
      const on = level === state.effort
      button.setAttribute('aria-checked', on ? 'true' : 'false')
      /* Roving tabindex: a radiogroup is one stop in the tab order, and the
         arrow keys move within it. Tabbing through every button to reach the
         thing after them is what makes a segmented control tiresome. */
      button.tabIndex = on ? 0 : -1
      return button
    }))
  }

  function setEffort (at, { focus = false } = {}) {
    const offered = levels()
    if (!offered.length) return
    const next = offered[Math.max(0, Math.min(offered.length - 1, at))]
    if (!next || next === state.effort) return
    state.effort = next
    state.stale = true
    repaintControls()
    persistConfig({ aiEffort: state.effort })
    if (focus) el.effort.querySelector('[aria-checked="true"]')?.focus()
  }

  /** The chosen level, made to fit the model — see `nearestEffort`. */
  function settleEffort () {
    const model = currentModel()
    if (model) state.effort = nearestEffort(model, state.effort)
  }

  el.effort.addEventListener('click', (event) => {
    const button = event.target.closest('[data-effort]')
    if (button) setEffort(levels().indexOf(button.dataset.effort))
  })

  el.effort.addEventListener('keydown', (event) => {
    const offered = levels()
    const at = offered.indexOf(state.effort)
    const to = {
      ArrowLeft: at - 1, ArrowDown: at - 1,
      ArrowRight: at + 1, ArrowUp: at + 1,
      Home: 0, End: offered.length - 1
    }[event.key]
    if (to === undefined) return
    event.preventDefault()
    setEffort(to, { focus: true })
  })


  el.write.addEventListener('click', () => {
    state.write = !state.write
    state.stale = true
    paintWrite()
    persistConfig({ aiWrite: state.write })
  })

  function paintWrite () {
    el.write.setAttribute('aria-pressed', state.write ? 'true' : 'false')
    el.write.title = state.write
      ? 'The copilot can edit notes — click to make it read-only'
      : 'The copilot can only read notes — click to let it edit'
  }

  /**
   * Every control in the header, redrawn from `state`.
   *
   * Written out in full at four call sites before this, which is how one of
   * them came to be missing the write toggle — an omission nothing can see
   * until the toggle is the thing that is wrong. Adding a control is now one
   * line here rather than a hunt for the sites that list them all.
   */
  function repaintControls () {
    paintModel()
    /* Before the level is drawn: the choice belongs to the model, and until it
       has been fitted to the model's own levels it may be one the model has
       never offered. */
    settleEffort()
    paintEffort()
    paintWrite()
    paintConfig()
  }

  /* The open document, named the way the vault names it, so the agent can
     resolve it the same way a wikilink would. A PDF and a website are named by
     their paths instead: a wikilink means a note, and neither of those is one
     — the agent opens both as files. */
  el.attach.addEventListener('click', async () => {
    const { note: path, kind } = await context()
    if (!path) { note('Nothing is open.'); return }
    const gap = el.input.value && !el.input.value.endsWith(' ') ? ' ' : ''
    el.input.value += kind === 'pdf' || kind === 'site'
      ? `${gap}\`${path}\` `
      : `${gap}[[${displayName(path)}]] `
    sizeInput()
    el.input.focus()
  })

  /* ---------------------------------------------------------- the panel */

  /**
   * Point the panel at a different note: put this conversation away, take out
   * that one's. The process is not touched — the next message resumes the
   * right session, and until there is one there is nothing to resume.
   */
  function setNote (path) {
    if (path === state.notePath) return
    flush()
    hideMenu()
    state.notePath = path || ''
    /* A running turn keeps its stream and its thinking: they belong to the
       conversation captured when it started, and the reply goes on landing
       there while the reader browses. Only an idle panel lets go of them. */
    if (!state.busy) { state.stream = null; state.think = null }
    state.stale = true
    repaint()
    if (state.open) greet()
  }

  /* The conversation whose nodes are in the log. Remembered so the one leaving
     the screen can be stripped of them — a rendered subtree per message, kept
     across every note switch, is most of a transcript's weight. */
  let shown = null

  function repaint () {
    dropDirty()
    const convo = chat()
    if (shown && shown !== convo) for (const msg of shown.messages) msg.node = null
    shown = convo
    el.log.replaceChildren(...convo.messages.map(draw), busyRow)
    following = true
    el.log.scrollTop = el.log.scrollHeight
    // The count belongs to the conversation, so it changes with it.
    paintContext()
  }

  /** A vault path as the vault names it — the file's own name, without the
   *  extension that says whether it is a note, a PDF or a website. */
  const displayName = (path) => path.split('/').pop().replace(/\.[^./]+$/, '')

  /** Said once per note, and only into an empty transcript. */
  function greet () {
    if (chat().messages.length) return
    note(state.notePath
      ? `Ask about ${displayName(state.notePath)}, or anything else in the vault. You will see it edit. Type / for commands.`
      : `${providerLabel(provider())} has your vault open. Open a note to start a conversation about it.`)
  }

  /* The real catalogue costs two CLI subprocesses and a megabyte of JSON, and
     it is only worth them once there is a model control on screen to show it.
     Until then the built-in list is what the controls read, which is what makes
     the first paint correct without it. */
  let catalogued = false
  function readCatalogue () {
    if (catalogued) return
    catalogued = true
    loadModels().catch(() => {})
  }

  function open () {
    state.open = true
    el.app.dataset.ai = 'open'
    api.config.set({ ai: 'open' })
    readCatalogue()
    greet()
    el.input.focus()
  }

  function close () {
    hideMenu()
    state.open = false
    el.app.dataset.ai = 'closed'
    api.config.set({ ai: 'closed' })
  }

  /**
   * The same three dials, changed from somewhere else.
   *
   * Settings (⌘,) carries them too, and two controls for one fact have to
   * agree — so the panel is told rather than left to discover it at the next
   * restart. Nothing restarts here: the process is replaced at the next
   * message, which is the same bargain the popover's own controls make.
   */
  function applyConfig (cfg) {
    const model = modelFromConfig(cfg, state.model)
    const enabled = Array.isArray(cfg.aiModels) ? cfg.aiModels : state.enabled
    const effort = cfg.aiEffort || state.effort
    const write = cfg.aiWrite !== false
    if (model === state.model && effort === state.effort && write === state.write &&
        enabled.join('\n') === state.enabled.join('\n')) return

    Object.assign(state, { model, enabled, effort, write, stale: true })
    repaintControls()
  }

  repaintControls()

  return {
    open,
    close,
    setNote,
    toggle: () => (state.open ? close() : open()),

    /**
     * A passage the reader wants to ask about, put in the box for them.
     *
     * Not sent: what they want to know about it is the part only they can
     * write, and a question that arrived without it would be answered with a
     * summary nobody asked for. The caret is left after the quote, which is
     * where the question goes.
     */
    quote,

    /**
     * A question that is already complete, asked on the reader's behalf.
     *
     * Sent, where `quote` is not — a failed run is a question with nothing left
     * for the reader to add, and a Fix button that only typed for you would be
     * a letdown. It still goes through the box rather than around it, so
     * whatever was half-typed there is carried along instead of lost, and the
     * transcript shows what was actually asked.
     *
     * Mid-turn it is left in the box and said out loud: interrupting the reply
     * you are waiting for to ask something else is never what the click meant.
     */
    ask: (text) => {
      if (!text) return
      quote(text)
      if (state.busy) { note('Queued in the message box — Copilot is still working.'); return }
      submit()
    },

    applyConfig,

    /**
     * Get the transcripts to disk, now, and say when they are there.
     *
     * `beforeunload` also calls `flush`, but by then main has already resolved
     * the close and called `app.quit()` — the write is an async IPC round trip
     * racing process exit, and a reply that arrived in the last few hundred
     * milliseconds (the settling save is debounced) loses that race. Main holds
     * the window open for `app:flush`, so this is the one place a transcript
     * can be written with something waiting for it.
     */
    flush: () => flush(),

    /**
     * Settings and stored conversations are applied before the panel is ever
     * opened, so the first thing shown is where the user left off.
     *
     * The settings half is `applyConfig` — the same four keys with the same
     * defaults, and a second reading of them here is a second thing to keep in
     * step. It paints only what changed, and at startup nothing has, so the
     * controls are drawn afterwards regardless.
     */
    restore: async (cfg) => {
      applyConfig(cfg)
      repaintControls()

      try {
        const stored = await api.ai.history.load()
        for (const [path, entry] of Object.entries(stored || {})) {
          // Files written before a note could hold more than one conversation
          // are a single conversation, and read back as one.
          const saved = Array.isArray(entry?.convos)
            ? entry.convos
            : [{ thread: entry?.thread, at: entry?.at, messages: entry?.messages }]

          const history = saved
            .filter((convo) => Array.isArray(convo?.messages))
            .map((convo) => ({
              id: convo.id || newChat().id,
              thread: convo.thread || null,
              threadOf: convo.threadOf || null,
              used: convo.used || 0,
              at: convo.at || 0,
              // The cap is applied on the way in as well as on the way out: a
              // file written before it was lowered is trimmed by reading it.
              messages: convo.messages.slice(-MAX_MESSAGES)
            }))
            // Empty chats are launch state, not history. Dropping them here
            // prevents one blank entry accumulating on every app restart.
            .filter((convo) => convo.messages.some((message) => message.t === 'you'))
          if (!history.length) continue

          /* Reloading begins with a clean chat for every file while the real
             conversations remain behind /history. The fresh entry is reused
             until the first question, so repeated note switches stay clean. */
          const fresh = newChat()
          const convos = [...history, fresh].slice(-MAX_CHATS)
          state.chats.set(path, { at: fresh.at, active: fresh.id, convos })
        }
      } catch { /* a transcript that will not load is not worth a dialog */ }

      repaint()
      if (cfg.ai === 'open') open()
    }
  }
}
