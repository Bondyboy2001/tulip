import MarkdownIt from 'markdown-it'

import { dropdown } from './dropdown.js'
import { el as element } from './dom.js'
import { diffBlock } from './history.js'
import { when } from './time.js'
import { mathPlugin } from './math.js'
import { citePlugin } from './cite.js'
import { routeAnchor, revealAnchorTarget } from './links.js'
import { assetKind, assetUrl } from './assets.js'
import { isLanguageTablePath } from './language-table.js'
import {
  DEFAULT_CATALOGUE,
  asOptions, effortLabel, effortsFor, modelFromConfig, nearestEffort,
  offeredModels, providerGrant, providerLabel, splitKey,
  COPILOT_MODES, COPILOT_MODE_ORDER, copilotModeFromConfig, copilotModeLabel
} from './models.js'
import {
  NOTE_EXT, isChatAttachment, isTexPath, isPdfPath, isSitePath, isWhiteboardPath,
  noteName
} from './vault-paths.js'
import { fileIcon } from './file-icons.js'
import { newTurnId, ownsTurn } from './copilot-turns.js'

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
  Rename: ['Renaming', 'Renamed'],
  Fetch: ['Fetching', 'Fetched'],
  Task: ['Delegating', 'Delegated']
}

/* The busy strip's account of a tool call: what is being done, and to what.
   The row underneath the strip says as much, but the strip is the line being
   read during the stretch when nothing else on screen moves — and "Working"
   held for the two minutes of a wide search is exactly the reading that makes
   a turn look hung. The name and the path are already in hand when the call is
   announced; this only spends them.

   Bounded, because the strip is one line and shares it with the timer: a file
   is named by its own name, and a command or a pattern — which have no such
   short form — is cut. */
const PHASE_LIMIT = 44
const NAMED_FILE = { Read: true, Edit: true, Write: true }

function phaseOf (event) {
  const verb = TOOL_VERB[event.name]?.[0] || event.name || 'Working'
  const what = !event.path
    ? ''
    : NAMED_FILE[event.name] ? event.path.split('/').pop() : event.path
  if (!what) return verb
  return `${verb} ${what.length > PHASE_LIMIT ? `${what.slice(0, PHASE_LIMIT - 1)}…` : what}`
}

/* A step saved before this existed has no `done`, and every one of them is over
   — nothing in a transcript read back from disk is still running. */
const running = (msg) => msg.done === false
const verbFor = (msg) =>
  TOOL_VERB[msg.name]?.[running(msg) ? 0 : 1] || msg.name

/* A step that goes somewhere when clicked: a write that landed, which the
   editor can open at the line it changed. */
const jumps = (msg) =>
  (msg.name === 'Edit' || msg.name === 'Write' || msg.name === 'Rename') &&
  !!msg.path && !msg.error

/* A step that opens instead, on what the tool said. Everything that does not
   jump — searches, commands, reads, and writes that failed, which are the ones
   whose reason is worth reading and whose file did not change. */
const opens = (msg) => !!msg.detail && !jumps(msg)

/* Enough to scroll back through, bounded so a vault worked in for a year does
   not turn into a transcript archive nobody asked for. */
const MAX_MESSAGES = 150
/* What is said, as opposed to what was done. A turn that edits forty files
   writes eighty rows, and with one cap over both it was the questions and the
   answers that fell off the top — the panel then disagreed with the CLI's own
   thread about what had been said in the conversation. So the machinery is
   trimmed first and prose is only ever dropped once there is this much of it. */
const MAX_PROSE = 60
const MAX_NOTES = 60
const MAX_CHATS = 20   // conversations kept per note; the oldest fall off

export function mountCopilot ({
  el, api, context, files = () => [], onEditing, onEdited, onRenamed, onConfig,
  onCite, onOpen, onRestore, onAccept, onWarn, onPermission, onAutoConfirm
}) {
  const state = {
    open: false,
    effort: 'high',
    /* One choice, not two: `provider:id` names the CLI and the model together,
       so the panel has a single control where it used to have a pair. Empty
       until Settings says otherwise — there is no model nobody chose. */
    model: '',
    catalogue: DEFAULT_CATALOGUE,
    // Which of the catalogue the dropdown offers — chosen in Settings, because
    // opencode alone answers with hundreds.
    enabled: [],
    mode: COPILOT_MODES.READ,
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

    /* Questions asked while a turn was running, in the order they were asked.
       Each is already in the transcript, greyed, and each carries the
       conversation it was asked in — a follow-up typed about one note must not
       be delivered into whichever chat is open when the turn finally ends. */
    queue: [],
    // Which conversation the running process was started for, so a message
    // delivered into a different one knows to replace it first.
    sessionConvo: null,

    /* The conversation the running turn files into, captured the moment the
       message is sent. Every event of that turn routes here — never to
       whichever note happens to be on screen when it arrives — so switching
       notes mid-reply cannot misfile the answer. */
    turn: null,         // { id, path, convo }
    // Stop clears `turn` before awaiting main so startup cannot continue, but
    // events produced by that stop still belong to the conversation it ended.
    stopping: null
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

  /* One top-layer viewer for image attachments in both the composer and sent
     messages. It lives outside the panel so a narrow Copilot column cannot
     clip the image the reader asked to inspect. */
  const attachmentDialog = element('dialog', 'ai-attachment-dialog')
  const attachmentDialogFigure = element('figure', 'ai-attachment-dialog-figure')
  const attachmentDialogImage = document.createElement('img')
  const attachmentDialogCaption = element('figcaption', 'ai-attachment-dialog-caption')
  const attachmentDialogClose = element('button', 'ai-attachment-dialog-close')
  attachmentDialogClose.type = 'button'
  attachmentDialogClose.title = 'Close image preview (Esc)'
  attachmentDialogClose.setAttribute('aria-label', 'Close image preview')
  attachmentDialogClose.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8"/></svg>'
  attachmentDialogFigure.append(attachmentDialogImage, attachmentDialogCaption)
  attachmentDialog.append(attachmentDialogFigure, attachmentDialogClose)
  document.body.append(attachmentDialog)
  let attachmentPreviewFocus = null

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

  /* How long a turn has to have run before its ending is worth saying out loud.
     A reply that arrives in four seconds is one the reader is still sitting in
     front of, and a notification for it is an interruption announcing that
     nothing happened. */
  const NOTIFY_AFTER = 20000

  /**
   * The end of a long turn, in a window nobody is looking at.
   *
   * The transcript is the record either way; this only answers the question
   * being asked from the other application — has it finished — which otherwise
   * costs a trip back to the window to find out that it has not.
   */
  function announce (to, trouble = '') {
    if (!state.busy || !busyAt || Date.now() - busyAt < NOTIFY_AFTER) return
    if (document.hasFocus()) return
    // Nothing waits on it, and a banner that could not be raised is not worth
    // an unhandled rejection in a window the reader is not even looking at.
    Promise.resolve(api.ai.announce?.({
      note: displayName(to?.path || state.notePath),
      trouble
    })).catch(() => {})
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
    // What a turn has cost, added up. Only some CLIs report it; a conversation
    // with nobody keeping the bill stays at zero and says nothing.
    cost: 0,
    // A digest of the conversation this one continues — see `compactChat`.
    seed: '',
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
   * A thread belongs to the CLI that issued it: handing `devin --continue` an
   * id opencode opened is an argument it has never seen, and the turn fails — then
   * fails again on every later message, because the id is still there. So each
   * id is filed with the program that made it and offered back only to that
   * one. An id from before this was recorded has no owner, and is not resumed.
   *
   * This replaced dropping every thread whenever the model changed, which lost
   * conversations that switching back would have picked up again.
   */
  const resumeFor = (convo, cli) => (convo.threadOf === cli && convo.thread) || null

  /* Prose — what either party actually said. Everything else is a record of
     work, and is what the cap sheds first. */
  const prose = (msg) => msg.t === 'you' || msg.t === 'bot'

  /* The empty-chat invitation is UI, not conversation history. Older saved
     chats contain it as an ordinary note, so recognise both the new marker and
     that exact legacy shape while cleaning them up. */
  const isStarter = (msg) => msg?.starter === true ||
    (msg?.t === 'note' &&
      (/^Ask about .+? or anything else in the vault\. You will see it edit\. Type @ for a file, \/ for commands\.$/.test(msg.text) ||
       /has your vault open\. Open a note to start a conversation about it\.$/.test(msg.text)))

  function dismissStarters (convo) {
    let removed = false
    for (let at = convo.messages.length - 1; at >= 0; at--) {
      if (!isStarter(convo.messages[at])) continue
      const [starter] = convo.messages.splice(at, 1)
      starter.node?.remove()
      starter.node = null
      removed = true
    }
    return removed
  }

  /**
   * The cap, applied to a conversation that has just grown.
   *
   * The oldest step, thinking block or notice goes first, and a question or a
   * reply is only dropped once the prose alone is over its own cap. Whatever
   * leaves takes its DOM node with it, or the transcript on screen keeps a row
   * the conversation no longer holds.
   */
  function trim (convo) {
    while (convo.messages.length > MAX_MESSAGES) {
      // One pass for both questions: how much prose there is, and where the
      // oldest thing that is not prose sits.
      let spoken = 0
      let oldest = -1
      for (let at = 0; at < convo.messages.length; at++) {
        if (prose(convo.messages[at])) spoken++
        else if (oldest === -1) oldest = at
      }
      const [gone] = convo.messages.splice(spoken > MAX_PROSE || oldest === -1 ? 0 : oldest, 1)
      if (!gone) break
      gone.node?.remove()
      gone.node = null
    }
  }

  /** Add a message to a conversation — the open one, unless a running turn
   *  says otherwise — and draw it only if that conversation is on screen. */
  function push (msg, to = null) {
    const path = to?.path ?? state.notePath
    const convo = to?.convo ?? chat(path)
    if (msg.t === 'you') dismissStarters(convo)
    convo.messages.push(msg)
    convo.at = file(path).at = Date.now()
    trim(convo)
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
    /* A step turns into a control when its result lands — it gains somewhere to
       jump to, or something to say — and an element cannot change tag in place.
       The rare case, so it is drawn again whole rather than kept in step. */
    if (msg.t === 'step') {
      const wants = jumps(msg) || opens(msg) ? 'BUTTON' : 'DIV'
      if (node.tagName !== wants) { node.replaceWith(draw(msg)); return }
    }
    node.className = classOf(msg)
    if (msg.t === 'step' && jumps(msg)) {
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
      return ['msg msg-step', msg.error && 'is-error', running(msg) && 'is-running',
              jumps(msg) && 'can-open is-edit',
              opens(msg) && 'can-detail'].filter(Boolean).join(' ')
    }
    // A queued question is one the reader has asked and the copilot has not
    // been handed yet — said differently, or it reads as a message that went
    // out and was ignored.
    if (msg.t === 'you') {
      return ['msg msg-you', msg.queued && 'is-queued',
              msg.dropped && 'is-dropped'].filter(Boolean).join(' ')
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
      /* What the tool said, folded away under the row. Kept out of the way
         rather than off the screen: a search that found nothing and one that
         found everything are the same row until you can open it, and a failed
         write is a red line with no reason on it. */
      const detail = msg.detail
        ? `<div class="step-detail">${escape(msg.detail)}</div>`
        : ''
      if (jumps(msg)) {
        return '<span class="step-edit-mark" aria-hidden="true">' +
          '<svg viewBox="0 0 16 16"><path d="M3 11.75V13h1.25l7.7-7.7-1.25-1.25zM9.9 4.85l1.25 1.25"/></svg></span>' +
          '<span class="step-copy"><span class="step-action">' + escape(verb) + '</span>' +
          `<span class="step-path">${escape(msg.path)}</span></span>${tally}` +
          '<span class="step-jump" aria-hidden="true">→</span>'
      }
      const label = escape(msg.path ? `${verb} ${msg.path}` : verb)
      const mark = opens(msg) ? '<span class="step-more" aria-hidden="true">›</span>' : ''
      return `<span class="step-label">${label}</span>${tally}${mark}${detail}`
    }
    // A failure the panel can do something about — see `failed`.
    if (msg.t === 'warn' && msg.retry) {
      return `<span class="warn-text">${escape(msg.text)}</span>` +
             '<button type="button" class="ghost is-compact ai-again">Ask again</button>'
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
    // Both kinds of live step are buttons: one goes to the edit it made, the
    // other opens what the tool said. A row that answers a click is a control,
    // and the keyboard should reach it like one.
    const clickable = msg.t === 'step' && (jumps(msg) || opens(msg))
    const node = element(clickable ? 'button' : 'div', classOf(msg))
    if (clickable) {
      node.type = 'button'
      if (jumps(msg)) {
        node.dataset.path = msg.path
        if (msg.line != null) node.dataset.line = String(msg.line)
      }
    }
    if (msg === state.stream) paintStream(node, msg.text || '')
    else if (msg.t === 'you') paintUserMessage(node, msg)
    else node.innerHTML = html(msg)
    msg.node = node
    return node
  }

  /** A filename, kept intact for the attachment card rather than shortened to
   *  the extensionless document titles used elsewhere in the panel. */
  const attachmentName = (path) => String(path || '').split('/').pop() || 'Attachment'
  const attachmentExtension = (path) => {
    const name = attachmentName(path)
    const dot = name.lastIndexOf('.')
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  }

  function attachmentKind (path) {
    if (isLanguageTablePath(path)) return 'language'
    if (isTexPath(path)) return 'tex'
    if (isPdfPath(path)) return 'pdf'
    if (isSitePath(path)) return 'site'
    if (isWhiteboardPath(path)) return 'whiteboard'
    if (NOTE_EXT.test(path || '')) return 'note'
    return assetKind(path)
  }

  const ATTACHMENT_TYPES = {
    note: 'Markdown',
    language: 'Language table',
    pdf: 'PDF',
    tex: 'TeX',
    site: 'Website',
    whiteboard: 'Whiteboard',
    video: 'Video',
    audio: 'Audio'
  }

  function attachmentType (kind, path) {
    if (ATTACHMENT_TYPES[kind]) return ATTACHMENT_TYPES[kind]
    const suffix = attachmentExtension(path)
    return suffix ? suffix.toUpperCase() : 'File'
  }

  /** The compact visual representation shared by the composer and the sent
   *  message. Images are their own preview; PDFs and other files retain their
   *  useful filename beside a familiar document mark. */
  function attachmentCard (path, removable = false) {
    const kind = attachmentKind(path)
    const card = element('div', `ai-attachment is-${kind}`)
    card.dataset.path = path

    const preview = element(kind === 'image' ? 'button' : 'span', 'ai-attachment-preview')
    if (kind === 'image') {
      preview.type = 'button'
      preview.dataset.previewImage = path
      preview.title = `Preview ${attachmentName(path)}`
      preview.setAttribute('aria-label', `Preview ${attachmentName(path)}`)
      const thumb = document.createElement('img')
      thumb.src = assetUrl(path)
      thumb.alt = ''
      preview.append(thumb)
    } else {
      preview.append(fileIcon(kind))
    }
    card.append(preview)

    if (kind !== 'image') {
      const copy = element('span', 'ai-attachment-copy')
      copy.append(element('span', 'ai-attachment-name', attachmentName(path)))
      copy.append(element('span', 'ai-attachment-type', attachmentType(kind, path)))
      card.append(copy)
    }

    if (removable) {
      const remove = element('button', 'icon-btn ai-attachment-remove')
      remove.type = 'button'
      remove.dataset.removeAttachment = path
      remove.title = `Remove ${attachmentName(path)}`
      remove.setAttribute('aria-label', `Remove ${attachmentName(path)}`)
      remove.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8"/></svg>'
      card.append(remove)
    }
    return card
  }

  function openAttachmentPreview (path, from) {
    attachmentPreviewFocus = from
    attachmentDialogImage.src = assetUrl(path)
    attachmentDialogImage.alt = attachmentName(path)
    attachmentDialogCaption.textContent = attachmentName(path)
    attachmentDialog.showModal()
    attachmentDialogClose.focus()
  }

  function closeAttachmentPreview () {
    if (!attachmentDialog.open) return
    attachmentDialog.close()
  }

  attachmentDialogClose.addEventListener('click', closeAttachmentPreview)
  attachmentDialog.addEventListener('click', (event) => {
    if (event.target === attachmentDialog) closeAttachmentPreview()
  })
  attachmentDialog.addEventListener('close', () => {
    attachmentDialogImage.removeAttribute('src')
    attachmentPreviewFocus?.focus()
    attachmentPreviewFocus = null
  })

  el.panel.addEventListener('click', (event) => {
    const preview = event.target.closest('[data-preview-image]')
    if (preview) openAttachmentPreview(preview.dataset.previewImage, preview)
  })

  function paintUserMessage (node, msg) {
    const attached = Array.isArray(msg.attachments) ? msg.attachments : []
    if (attached.length) {
      const strip = element('div', 'msg-attachments')
      for (const path of attached) strip.append(attachmentCard(path))
      node.append(strip)
    }
    if (msg.text) {
      const copy = element('div', 'msg-you-copy')
      copy.innerHTML = html(msg)
      node.append(copy)
    }
  }

  function drawReview (msg) {
    const operation = msg.operation
    const node = element('section', classOf(msg))
    const head = element('div', 'ai-review-head')
    const summary = element(
      'strong', '',
      `${operation.changes.length} file${operation.changes.length === 1 ? '' : 's'} changed`
    )
    head.append(summary)
    const files = element('div', 'ai-review-files')
    for (const summary of operation.changes) {
      const row = element('div', 'ai-review-file')
      // The changed file is context, not another action. The transcript's
      // `Edited …` row already provides the direct jump to the edit.
      const path = element('span', 'ai-review-path', summary.path)
      path.title = summary.path
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
      row.append(path, diff)
      files.append(row)
    }
    const actions = element('div', 'ai-review-actions')
    /* Reject is the single rollback for the whole turn. Main snapshots the
       vault before the message goes out, so no per-file restore controls are
       needed here. */
    const reject = element('button', 'ghost is-compact', 'Reject')
    reject.type = 'button'
    reject.title = `Reject changes to all ${operation.changes.length} files`
    reject.addEventListener('click', () => {
      Promise.resolve(onRestore?.(operation, null)).catch((err) => {
        onWarn?.(err?.message || 'Those changes could not be rejected.')
      })
    })
    actions.append(reject)
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
    /* The decision belongs beside the change count. Keeping it in a separate
       footer made a one-file review three rows tall and gave empty space more
       weight than the actual file. */
    head.append(actions)
    node.append(head, files)
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

  /**
   * A turn that did not happen, said with a way out of it.
   *
   * The four ways one can fail — the process would not start, the send did not
   * go out, the process died, the turn came back with an error — all end the
   * same way: a warning, and a session nothing can be sent to. The recovery was
   * typing the question again, which is the one thing the panel already has in
   * its hands. So the row carries a button that asks it again, and the next
   * message starts a fresh process because every one of those paths has already
   * let go of the old one.
   */
  const failed = (text, to = null) => push({ t: 'warn', text, retry: true }, to)

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
      // Only when there is one: an `edited` event follows its own `tool-done`
      // with the diff summary and nothing to say, and must not erase it.
      ...(event.detail ? { detail: event.detail } : {}),
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
   * The CLIs hand back little of the reasoning itself — opencode a short
   * summary, devin nothing at all. So this shows the shape of the thinking
   * rather than its content: live while it runs, and afterwards a single quiet
   * line saying how long it went on for.
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
      /* Whatever was asked while this turn ran goes out now. On a microtask
         rather than here: every caller of `setBusy(false)` is in the middle of
         closing a turn out, and starting the next one from inside that would
         have the two overlap in `state`. */
      queueMicrotask(drain)
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
    const again = event.target.closest('.ai-again')
    if (again) { askAgain(again.closest('.msg-warn')); return }

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

    // A step with something to say opens it where it stands.
    const said = event.target.closest('.msg-step.can-detail')
    if (said) { said.classList.toggle('is-open'); return }

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

  /* What is written down of a message that is a bar of gold in memory.
     `node` is this window's DOM and `html` its render of it, neither of which
     means anything to the next window. `detail` is what a tool said, and most
     of it is a file the agent read: keeping every one would put a copy of half
     the vault in the history file, several times over, to be reread on every
     launch. So only a failure's reason is kept, and shortened — that is the
     part still worth reading a week later. */
  const KEPT_DETAIL = 600

  function stored (msg) {
    const { node: _node, html: _html, detail, queued: _queued, ...rest } = msg
    if (detail && msg.error) rest.detail = detail.slice(0, KEPT_DETAIL)
    /* A question waiting its turn is waiting in memory: the queue itself is
       never written down, and nothing re-drains it on launch. So a `queued`
       flag that survived the write would grey the message out for good — in
       every window that ever opened that chat, under a promise the panel has no
       machinery left to keep. Stop already turns the queue into "not sent" when
       it empties it; a quit mid-turn ends the same way, and this is where it
       says so. */
    if (msg.queued) rest.dropped = true
    return rest
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
          cost: convo.cost || 0,
          seed: convo.seed || '',
          at: convo.at,
          messages: convo.messages.map(stored)
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
    const to = state.turn || state.stopping
    /* Main may hold a terminal event while it snapshots the vault. A queued
       turn can begin during that wait, so arrival order is not ownership: only
       the id issued by `deliver` decides which conversation may consume it. */
    if (!ownsTurn(to, event)) return
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

      case 'preparing-pdf':
        phase('Preparing PDF')
        break

      case 'text':
        settleThinking()
        if (!state.stream) state.stream = push({ t: 'bot', text: '' }, to)
        state.stream.text += event.text
        redraw(state.stream)
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
        // looks like a hang, so the strip says which tool and on what rather
        // than leaving a timer to answer that on its own.
        phase(phaseOf(event))
        break

      // Nothing was written — a read finishing, or a write that failed.
      case 'tool-done':
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

      case 'renamed':
        settleThinking()
        settleStream()
        step({ ...event, name: 'Rename', done: true }, to)
        Promise.resolve(onRenamed?.(event)).catch((err) => {
          onWarn?.(err?.message || 'The file was renamed but the window could not follow it.')
        })
        break

      case 'rename-failed':
        note(event.message || 'The Copilot rename could not be completed.', 'warn', to)
        onWarn?.(event.message || 'The Copilot rename could not be completed.')
        break

      case 'review':
        push({ t: 'review', operation: event.operation, accepted: false }, to)
        save()
        break

      // The process is gone — it exited, or was never there to begin with.
      // Forgetting it here is what lets the next message start a fresh one
      // instead of talking to a corpse.
      case 'error':
        state.started = false
        failed(event.message || 'Something went wrong.', to)
        announce(to, event.message || 'Something went wrong.')
        setBusy(false)
        break

      case 'turn-end':
        if (event.used) {
          to.convo.used = event.used
        }
        // Only some CLIs report what a turn cost; the rest say nothing and the
        // readout stays away rather than showing a zero as if it were free.
        if (event.cost) to.convo.cost = (to.convo.cost || 0) + event.cost
        if (event.used || event.cost) paintContext()
        if (event.error) failed(event.error, to)
        // Before `setBusy`, which is what lets go of the turn this is about.
        announce(to, event.error || '')
        setBusy(false)
        // The deltas since the last tool call are only in memory until now.
        save()
        break
    }
  })

  /* -------------------------------------------------------------- session */

  const settings = (convo = chat(), turnId = state.turn?.id) => {
    const { provider, id } = splitKey(state.model)
    return {
      provider,
      model: id,
      effort: state.effort,
      mode: state.mode,
      write: state.mode !== COPILOT_MODES.READ,
      resume: resumeFor(convo, provider),
      turnId
    }
  }

  /**
   * Makes the running process match what is on screen — the chosen copilot,
   * the chosen effort, and the note being discussed. Called just before a
   * message goes out, never on the change itself.
   */
  async function ensureSession (convo = chat(), turnId = state.turn?.id) {
    /* The panel is not always the way in — a Fix button asks a question with
       the panel still closed — and a turn about to be sent is as good a reason
       to know the real catalogue as a control about to be drawn. */
    readCatalogue()
    /* A message going into a conversation the running process was not started
       for has to replace it, or it is answered with another chat's history.
       Ordinarily the note switch has already said so; a queued follow-up
       delivered after the reader moved on has not. */
    if (state.sessionConvo !== convo.id) state.stale = true
    if (state.started && !state.stale) return true
    if (state.stale) await api.ai.stop()
    const result = await api.ai.start(settings(convo, turnId))
    state.started = !!result?.ok
    state.stale = false
    state.sessionConvo = state.started ? convo.id : null
    if (!result?.ok) failed(result?.error || 'The copilot could not start.')
    return state.started
  }

  /* ------------------------------------------------------------ commands */

  /**
   * Slash commands.
   *
   * A message that is nothing but `/word` is an instruction to the panel, not
   * something to send. Anything else — including a message that merely starts
   * with a slash and goes on — is prose, and goes to the copilot untouched, so
   * `/new about the Hilbert space note` is still the question it reads as.
   */
  const COMMANDS = [
    { name: 'new', hint: 'Start a new chat about this note', run: startChat },
    { name: 'history', hint: 'Open a past chat about this note', run: showHistory },
    {
      name: 'compact',
      hint: 'Start again, carrying a summary of this chat',
      run: compactChat
    }
  ]

  const SLASH = /^\/([a-z]*)$/i
  /* Bare, and only bare: every command is the whole of the message that names
     it, so anything following one makes the line prose. */
  const COMMAND = /^\/([a-z]+)$/i

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
      current.cost = 0
      current.seed = ''
    }

    reset()
    greet()
    save()
  }

  /**
   * Start again without starting over.
   *
   * The context fills and there is nothing the panel can do about it: some CLIs
   * compact themselves, and the rest simply fail the turn. So this makes the
   * one move that always works — a fresh session, which is a fresh context —
   * and carries the thread of the conversation across by hand. The digest is
   * built here, out of the transcript, rather than asked of the model: a
   * summary the model has to write is a turn spent on a context that is already
   * too full to spend one.
   */
  function compactChat () {
    if (busyNow()) return
    const previous = chat()
    const digest = summarise(previous)
    if (!digest) { note('There is nothing in this chat to carry over.'); return }

    startChat()
    chat().seed = digest
    note('Started a new chat. The next message carries a summary of the last one.')
    save()
  }

  /* Enough of the old conversation for the new one to pick up the thread: what
     was asked, and how the last answer ended. Whole questions and the tail of
     the final reply, because a question cut in half is worse than one left out.
     Marked as a recap so the model does not answer it again. */
  function summarise (convo) {
    const asked = convo.messages.filter((m) => m.t === 'you').slice(-8)
    const last = [...convo.messages].reverse().find((m) => m.t === 'bot')
    if (!asked.length) return ''
    const tail = (last?.text || '').slice(-1200)
    return [
      'Some background — this continues an earlier conversation, which has been',
      'cut short because it grew too long. Do not answer any of it again.',
      '',
      'What was asked, oldest first:',
      ...asked.map((m) => `- ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`),
      ...(tail ? ['', 'How your last reply ended:', tail] : [])
    ].join('\n')
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
    /* The process is left alone; the next message replaces it with one resuming
       whichever session this conversation belongs to.

       Said here and not in `setNote`, which looks like the same event and is
       not: `/new` into a chat nobody has spoken in yet keeps that chat's id and
       empties it, thread and all, so the comparison `ensureSession` makes would
       see the conversation it is already running and carry on answering out of
       the history this just threw away. */
    state.stale = true
    repaint()
    el.input.focus()
  }

  /** The command this message names, if it names one. */
  function command (text) {
    const found = COMMAND.exec(text.trim())
    if (!found) return null
    return COMMANDS.find((c) => c.name === found[1].toLowerCase()) || null
  }

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

  /* `@` and what has been typed after it, at the caret. Anchored to the start of
     a word so an email address in the middle of a sentence is not a file
     lookup, and stopped by a newline so it cannot run away up the message. */
  const MENTION = /(?:^|\s)@([^@\s]*)$/

  /**
   * The vault's own files, offered by name as they are typed.
   *
   * The alternative was the agent going looking: the briefing tells it not to
   * survey the vault, so a note referred to by name and not by link had it
   * globbing for a file the panel could have named exactly.
   */
  function offerMentions (typed, from) {
    const wanted = typed.toLowerCase()
    const scored = []
    for (const entry of mentionable()) {
      const at = entry.folded.indexOf(wanted)
      if (at === -1) continue
      // A name that begins with what was typed is what was meant; one that
      // merely contains it is a second thought.
      scored.push({ entry, rank: at === 0 ? 0 : 1 })
      if (scored.length > 400) break
    }
    if (!scored.length) { hideMenu(); return }

    scored.sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name))
    showMenu(scored.slice(0, 8).map(({ entry }) => ({
      label: entry.name,
      hint: entry.folder,
      run: () => selectMention(from, entry.path)
    })))
  }

  /* The vault as the picker reads it: display name, folder, folded name to
     match against, and the path the attachment card carries. Built once per
     file list rather than per keystroke — this runs on every character typed
     after an `@`, and a vault of a few thousand notes was a name strip, a
     lower-casing and a path split apiece each time. Keyed on the array the
     renderer hands over, which it replaces wholesale whenever the tree changes,
     so its identity is exactly the right question. Same arrangement as
     `allModels` in models.js. */
  let mentions = { of: null, list: [] }

  function mentionable () {
    const list = files()
    if (mentions.of === list) return mentions.list

    mentions = {
      of: list,
      list: list.map((entry) => {
        // The tree has already stripped the document extension for display.
        // Keep the fallback for callers that only provide a path.
        const name = entry.name || noteName(entry.path)
        const cut = entry.path.lastIndexOf('/')
        return {
          name,
          folded: name.toLowerCase(),
          folder: cut === -1 ? 'vault' : entry.path.slice(0, cut),
          path: entry.path
        }
      })
    }
    return mentions.list
  }

  /** Turn the `@…` selection into the same non-editable card as a paperclip
   *  attachment. The file path is delivery data, not text the user has to
   *  keep intact in the message box. */
  function selectMention (from, path) {
    const box = el.input
    const to = box.selectionStart ?? box.value.length
    box.value = box.value.slice(0, from) + box.value.slice(to)
    box.setSelectionRange(from, from)
    hideMenu()
    addAttachments([path], true)
    sizeInput()
    box.focus()
  }

  /** Which menu, if either, belongs over the box right now. */
  function offerMenu () {
    const box = el.input
    const trimmed = box.value.trim()
    if (SLASH.test(trimmed)) { offerCommands(trimmed); return }

    const upto = box.value.slice(0, box.selectionStart ?? box.value.length)
    const at = MENTION.exec(upto)
    if (!at) { hideMenu(); return }
    offerMentions(at[1], upto.length - at[1].length - 1)
  }

  // A click lands before the textarea loses focus, so the box keeps the caret.
  el.menu.addEventListener('mousedown', (event) => event.preventDefault())
  el.menu.addEventListener('click', (event) => {
    const row = event.target.closest('.ai-menu-row')
    if (row && menu) pickMenu(Number(row.dataset.at))
  })

  /* --------------------------------------------------------------- input */

  /**
   * A question asked while the copilot was still answering the last one.
   *
   * It goes into the transcript where it was asked, greyed, and is delivered
   * when the turn ends. The panel used to say "queued" and mean it as a figure
   * of speech: the words were left in the message box, and a reader who kept
   * typing lost the follow-up under whatever they wrote next.
   */
  function enqueue (text, attachments) {
    const path = state.notePath
    const convo = chat(path)
    const msg = push({ t: 'you', text, attachments, queued: true }, { path, convo })
    state.queue.push({ text, attachments, msg, path, convo })
  }

  /** Ask once for the write-capable provider mode, before a turn starts. */
  async function permissionFor (path) {
    if (state.mode !== COPILOT_MODES.ASK || !state.model) return true
    try {
      return await onPermission?.({
        mode: state.mode,
        path,
        provider: provider(),
        providerLabel: providerLabel(provider()),
        grant: providerGrant(provider(), true),
        model: currentModel()?.label || state.model
      }) !== false
    } catch (error) {
      onWarn?.(error?.message || 'The Copilot permission request failed.')
      return false
    }
  }

  function markNotSent (msg) {
    if (!msg) return
    delete msg.queued
    msg.dropped = true
    redraw(msg)
    save()
  }

  /** The next queued question, once the copilot is free to hear it. */
  function drain () {
    if (state.busy || !state.queue.length) return
    const next = state.queue.shift()
    // The conversation it was asked in may have been emptied by `/new` since.
    if (!next.convo.messages.includes(next.msg)) { drain(); return }
    deliver(next).catch(() => {})
  }

  async function submit () {
    const text = el.input.value.trim()
    const attachments = [...pendingAttachments]
    if (!text && !attachments.length) return

    // Typed straight through without the menu — a command all the same.
    const found = command(text)
    if (found) { el.input.value = ''; sizeInput(); hideMenu(); found.run(); return }

    /* Selected files and pasted pictures are already in the vault. Their paths
       travel beside the reader's words and never have to appear inside them. */
    if (state.busy) {
      el.input.value = ''
      clearAttachments()
      sizeInput()
      enqueue(text, attachments)
      return
    }

    const path = state.notePath
    const convo = chat(path)
    /* Ask before clearing the composer, so declining leaves the question and its
       attachments ready to edit or send after changing the mode. */
    if (!await permissionFor(path)) return
    el.input.value = ''
    clearAttachments()
    sizeInput()
    const msg = push({ t: 'you', text, attachments }, { path, convo })
    await deliver({ text, attachments, msg, path, convo, approved: true })
  }

  /**
   * One turn, sent.
   *
   * Split from `submit` because a queued follow-up arrives here too, minutes
   * later and possibly with the reader looking at another note — so everything
   * this needs is passed in rather than read off what happens to be on screen.
   */
  async function deliver ({ text, attachments, path, convo, msg, approved = false }) {
    if (!approved && !await permissionFor(path)) {
      markNotSent(msg)
      return
    }
    if (msg?.queued) {
      delete msg.queued
      redraw(msg)
    }
    // The turn is anchored to this conversation before anything can answer,
    // so browsing away while it runs cannot redirect what comes back.
    state.turn = { id: newTurnId(), path, convo }
    const to = state.turn
    setBusy(true)

    /* Every way out of the rest of this either settles the panel or hands it to
       a turn that will. A *throw* did neither: `setBusy(true)` is already spent
       above, and the caller's `.catch(() => {})` — drain, askAgain, submit —
       swallowed it, so a bridge that rejected rather than answering left the
       working strip up, the composer showing Stop, and no way back short of
       reopening the app. Anything unforeseen is reported as the failure it is.
       Guarded on the turn's identity for the same reason the returns below are:
       a newer turn owns the panel by then, and settling it would put down a
       strip that belongs to something still running. */
    try {
      await sendTurn(to, { text, attachments, convo })
    } catch (err) {
      if (state.turn === to) {
        state.started = false
        failed(err?.message || 'The copilot could not be reached.', to)
        setBusy(false)
      }
    }
  }

  /** The body of a turn — everything `deliver` guards. */
  async function sendTurn (to, { text, attachments, convo }) {
    /* No model — never chosen, or everything unticked in Settings — is not a
       copilot to start: spawning with an empty provider is a crash in main.
       Said in the transcript rather than swallowed, so it reads as a refusal
       with a reason and a retry instead of a question that vanished. */
    if (!state.model) {
      failed('No model selected — pick one in Settings, or above the message box.', to)
      setBusy(false)
      return
    }
    if (!await ensureSession(convo, to.id)) { setBusy(false); return }
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

    /* A chat started by `/compact` carries a digest of the one it replaced, and
       it rides the first message rather than being sent as one of its own: a
       turn that says only "here is what we were discussing" spends a whole
       round trip to be answered with "thank you". */
    const opening = convo.seed ? `${convo.seed}\n\n${text}` : text

    const result = await api.ai.send(opening, { ...context_, attachments }, to.id)
    /* Stop can be pressed while main is preparing a PDF or taking the turn's
       safety snapshot. The IPC call still has to return, but its failure then
       belongs to the cancelled turn and must not add a second warning after
       the explicit “Stopped.” row. */
    if (state.turn !== to) return
    // Spent only once it has actually gone out: a send that failed leaves the
    // digest for the message that tries again.
    if (result?.ok) convo.seed = ''
    if (!result?.ok) {
      // Whatever went wrong, the session is no longer one we can trust; the
      // next message starts over rather than failing the same way again.
      state.started = false
      failed(result?.error || 'The copilot could not be reached.', to)
      setBusy(false)
    }
  }

  /**
   * The question above a failure, asked again.
   *
   * Read off the transcript rather than kept on the warning: the message that
   * failed is the last thing said before it, the panel is already holding it,
   * and a copy carried on the error row would be a second version of the same
   * words to keep in step. A question that was queued and never sent is skipped
   * — it is not what the failure was about.
   */
  function askAgain (node) {
    if (busyNow()) return
    const convo = chat()
    const at = convo.messages.findIndex((msg) => msg.node === node)
    const asked = [...convo.messages.slice(0, at === -1 ? undefined : at)]
      .reverse().find((msg) => msg.t === 'you' && !msg.dropped)
    if (!asked || (!asked.text && !asked.attachments?.length)) {
      note('There is nothing above this to ask again.')
      return
    }

    const path = state.notePath
    const attachments = Array.isArray(asked.attachments)
      ? [...asked.attachments]
      : attachmentsIn(asked.text)
    const msg = push({ t: 'you', text: asked.text, attachments }, { path, convo })
    deliver({ text: asked.text, attachments, msg, path, convo })
      .catch(() => {})
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
    /* After Send the value is cleared. Measuring `scrollHeight` immediately
       can still report the height of the long prompt that occupied the field
       a moment earlier, especially when the composer is a flex item. Writing
       that stale measurement straight back is what left an empty, maximum-size
       chat box on screen for the whole turn. Rows=1 supplies the compact height
       once the inline height is removed. */
    if (!el.input.value) return
    el.input.style.height = `${Math.min(el.input.scrollHeight, 190)}px`
  }

  el.input.addEventListener('input', () => {
    sizeInput()
    offerMenu()
  })

  /**
   * A picture pasted into the message box.
   *
   * None of the three CLIs takes an image over its message stream — they read
   * files — so the paste becomes a file in the vault first and the message
   * carries its path. The composer shows the resulting file as a removable
   * card, keeping delivery data out of the words the reader is writing.
   */
  el.input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])]
      .filter((file) => file.type.startsWith('image/'))
    if (!files.length) return
    // Only once there is something to file: a paste of ordinary text must go on
    // behaving exactly as the textarea would do it.
    event.preventDefault()
    for (const file of files) attachImage(file).catch(() => {})
  })

  async function attachImage (file) {
    const ext = `.${(/^image\/([a-z0-9.+-]+)$/i.exec(file.type)?.[1] || 'png')
      .toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`
    let result
    try {
      result = await api.ai.attach(ext, new Uint8Array(await file.arrayBuffer()))
    } catch (err) {
      note(err?.message || 'That image could not be attached.', 'warn')
      return
    }
    if (!result?.path) return
    addAttachments([result.path])
  }

  /** Compatibility for a retry of an older transcript whose attachment path
   *  was written into its message text before the composer gained cards. */
  const attachmentsIn = (text) =>
    [...String(text).matchAll(/`([^`\n]+)`/g)]
      .map((found) => found[1].trim())
      .filter(isChatAttachment)

  /* Paths are delivery data, not message copy. The composer keeps them here
     and paints them as cards so a filesystem location never has to masquerade
     as something the reader typed. */
  let pendingAttachments = []

  function paintAttachments () {
    el.attachments.replaceChildren(...pendingAttachments.map((path) => attachmentCard(path, true)))
    el.attachments.hidden = !pendingAttachments.length
  }

  function addAttachments (paths, allowVaultFiles = false) {
    const next = [...pendingAttachments]
    for (const path of paths || []) {
      const isVaultFile = allowVaultFiles && files().some((entry) => entry?.path === path)
      if ((isChatAttachment(path) || isVaultFile) && !next.includes(path)) next.push(path)
    }
    pendingAttachments = next
    paintAttachments()
    el.input.focus()
  }

  function clearAttachments () {
    pendingAttachments = []
    paintAttachments()
  }

  el.attachments.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-attachment]')
    if (!remove) return
    pendingAttachments = pendingAttachments.filter((path) => path !== remove.dataset.removeAttachment)
    paintAttachments()
    el.input.focus()
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
    /* Let go of the turn before the await, not after. `deliver` checks its own
       turn against this one at every point it resumes, so clearing it here is
       what makes a Stop pressed during startup actually stop: the send that
       was about to happen sees the turn has moved on and never goes out. */
    state.turn = null
    state.stopping = to
    /* Stop means stop, follow-ups included — sending them anyway is the one
       thing the button cannot be read as meaning. They stay in the transcript,
       still greyed, so what was asked and never sent is at least visible. */
    const waiting = state.queue.splice(0)
    for (const item of waiting) {
      item.msg.queued = false
      item.msg.dropped = true
      redraw(item.msg)
    }
    await api.ai.stop(to?.id)
    state.stopping = null
    state.started = false
    setBusy(false)   // settles the stream and lets go of the turn
    // Filed where the truncated reply went, so the transcript says why it ends.
    note(waiting.length
      ? `Stopped. ${waiting.length} queued message${waiting.length === 1 ? '' : 's'} were not sent.`
      : 'Stopped.', 'note', to)
  }

  /* ------------------------------------------------------------ settings */

  /** The models on offer, and the one chosen among them. */
  const currentModels = () =>
    offeredModels(state.catalogue, state.enabled, state.model)

  const currentModel = () =>
    currentModels().find((model) => model.key === state.model)

  const provider = () => splitKey(state.model).provider

  /**
   * How much of the model's context the conversation is carrying, when its
   * CLI reports that measurement. opencode does; devin publishes no accounting
   * at all, so the ring stays out of view for it.
   *
   * A ring rather than a number, because the question it answers is "how much
   * room is left" — a proportion, which a circle states at a glance and a token
   * count makes you do arithmetic for. The exact figures are in the tooltip.
   *
   * Hidden until a turn has reported something, and for any model whose CLI
   * does not publish a window: an unfilled ring on a model nobody can measure
   * would be a claim, not a reading.
   */
  /* When the ring is worth acting on rather than merely reading. The same
     threshold the ring turns at, because a warning that arrives at a different
     number than the colour reads as a second, unexplained rule. */
  const FULL = 0.85

  function paintContext () {
    const model = currentModel()
    const convo = chat()
    const used = convo.used || 0
    const room = model?.context || 0
    const show = used > 0 && room > 0
    el.contextWrap.hidden = !show
    if (!show) return

    const share = used / room
    el.context.style.setProperty('--used', String(Math.min(1, share)))
    el.context.classList.toggle('is-full', share >= FULL)

    /* The exact counts, grouped. Rounding to `5k` loses the thing the reading
       is for — watching the number climb — and a percentage is what the ring
       already says without needing to be read. */
    const said = `${used.toLocaleString()} of ${room.toLocaleString()}`
    /* What the conversation has cost, when its provider reports one. Beside
       the context because they are the two running totals a turn adds to; an
       unavailable total is simply omitted. */
    const spent = convo.cost
      ? ` · $${convo.cost < 0.01 ? convo.cost.toFixed(4) : convo.cost.toFixed(2)}`
      : ''
    el.contextPop.textContent = said + spent
    el.context.setAttribute('aria-label', `Context used: ${said}${spent}`)

    /* Said once, when it starts to matter. The ring turning red says the room
       is going; it does not say what to do about it, and by the time the
       conversation stops working the answer costs a turn nobody has the context
       for. Once per conversation — a warning per turn from here on would be the
       same sentence a dozen times at the end of a long chat. */
    if (share >= FULL && !convo.warned) {
      convo.warned = true
      note('This chat has nearly filled the model’s context. ' +
           '/compact starts a fresh one carrying a summary, /new starts over.', 'warn')
    }
  }

  /** The always-visible readout: who is answering, and how hard. */
  function paintConfig () {
    const model = currentModel()
    /* Nothing chosen — never picked, or everything unticked in Settings — is
       said rather than answered with a default nobody chose. */
    el.configModel.textContent = model ? model.label : 'No model selected'
    el.configModel.classList.toggle('is-none', !model)
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
    placeholder: 'No model selected',
    onChange: (key) => chooseModel(key)
  })
  el.model.append(modelMenu.root)

  function paintModel () {
    const options = asOptions(currentModels())
    // `set` settles on the first entry when the stored model is not in the
    // list — a catalogue can lose an entry between launches, and unticking a
    // model in Settings takes it out of this one. An empty choice survives
    // both, and the button keeps its "No model selected" rather than turning
    // into whichever entry came first.
    state.model = modelMenu.set(options, state.model) || ''
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
   * Not a fixed four: devin publishes a different set per family — the levels
   * it spells into its model names — and most of opencode's catalogue has no
   * such dial at all, in which case the row goes away rather than offering a
   * control that would be ignored. So the slider's range and its stops are set
   * here rather than written into index.html.
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
    if (!offered.length) { el.effortStops.replaceChildren(); return }

    const at = Math.max(0, offered.indexOf(state.effort))
    el.effortRange.max = String(offered.length - 1)
    el.effortRange.value = String(at)
    /* The name of the stop, for the screen reader and for the hover — the
       number the input would otherwise announce means nothing, and the slider
       deliberately does not print the name on itself: the composer's readout
       beside the model already carries it. */
    el.effortRange.setAttribute('aria-valuetext', effortLabel(offered[at]))
    el.effortRange.title = effortLabel(offered[at])

    /* How far along, for the filled part of the track. A lone stop is drawn
       empty rather than full: there is nowhere to have come from. */
    el.effort.style.setProperty(
      '--at', offered.length > 1 ? String(at / (offered.length - 1)) : '0'
    )

    /* One dot per stop, so the slider says how many there are — two for a model
       with two, five for most of devin's — rather than pretending to be
       continuous. */
    el.effortStops.replaceChildren(...offered.map((level, i) => {
      /* Stops the fill has reached are marked so the CSS can sink them into
         it — a dot the height of the track reads as debris once the accent
         fill has covered its ground. */
      const lit = i <= at ? ' is-passed' : ''
      const dot = element('span', `ai-effort-stop${level === 'max' ? ' is-top' : ''}${lit}`)
      dot.title = effortLabel(level)
      return dot
    }))
  }

  function setEffort (at, persist = false) {
    const offered = levels()
    if (!offered.length) return
    const next = offered[Math.max(0, Math.min(offered.length - 1, at))]
    if (!next) return
    if (next !== state.effort) {
      state.effort = next
      state.stale = true
      // Rebuilding the searchable model dropdown here made dragging lag.
      paintEffort()
      paintConfig()
    }
    if (persist) persistConfig({ aiEffort: state.effort })
  }

  /** The chosen level, made to fit the model — see `nearestEffort`. */
  function settleEffort () {
    const model = currentModel()
    if (model) state.effort = nearestEffort(model, state.effort)
  }

  /* Dragging, the arrow keys, Home and End are all the input's own — this is
     the whole of the wiring, where the segmented control it replaced needed a
     click handler, a keydown handler and a roving tabindex to be half as
     capable. `input` rather than `change`, so the track fills under the thumb
     as it is dragged rather than when it is let go. */
  el.effortRange.addEventListener('input', () => setEffort(Number(el.effortRange.value)))
  el.effortRange.addEventListener('change', () => setEffort(Number(el.effortRange.value), true))


  let changingMode = false

  async function chooseMode (next) {
    if (!COPILOT_MODE_ORDER.includes(next) || next === state.mode || changingMode) return
    changingMode = true
    try {
      if (next === COPILOT_MODES.AUTO) {
        const allowed = await onAutoConfirm?.({
          provider: provider(),
          providerLabel: providerLabel(provider()) || 'Copilot',
          grant: providerGrant(provider(), true)
        })
        if (allowed === false) return
      }
      state.mode = next
      state.stale = true
      paintWrite()
      /* Keep the old boolean conservative for older builds: only Auto carries
         forward as write-enabled, while Ask becomes read-only there. */
      persistConfig({ aiMode: next, aiWrite: next === COPILOT_MODES.AUTO })
    } catch (error) {
      onWarn?.(error?.message || 'The Copilot permission mode could not be changed.')
    } finally {
      changingMode = false
    }
  }

  el.write.addEventListener('click', () => {
    const at = COPILOT_MODE_ORDER.indexOf(state.mode)
    chooseMode(COPILOT_MODE_ORDER[(at + 1) % COPILOT_MODE_ORDER.length])
  })

  /**
   * What the toggle is actually handing over.
   *
   * One switch, several blast radii: none of these CLIs takes a per-tool
   * allowlist, so each is fenced only by a mode — which leaves them able to run
   * commands inside the vault, and opencode to fetch web pages besides. The
   * toggle used to promise "can edit notes" for all of them. It now names the
   * CLI and says what that CLI may do, which is the difference between a
   * permission granted and a permission assumed.
   */
  function paintWrite () {
    const mode = COPILOT_MODE_ORDER.includes(state.mode) ? state.mode : COPILOT_MODES.READ
    const label = copilotModeLabel(mode)
    const providerName = providerLabel(provider()) || 'Copilot'
    const may = providerGrant(provider(), mode !== COPILOT_MODES.READ)
    const said = may ? `${providerName} may ${may}.` : ''
    const next = COPILOT_MODE_ORDER[(COPILOT_MODE_ORDER.indexOf(mode) + 1) % COPILOT_MODE_ORDER.length]
    el.write.dataset.mode = mode
    el.write.setAttribute('aria-pressed', mode === COPILOT_MODES.READ ? 'false' : 'true')
    if (el.writeLabel) el.writeLabel.textContent = label
    el.write.title = `Permission: ${label}. ${said} Click for ${copilotModeLabel(next)}.`
    el.write.setAttribute('aria-label', `Permission mode: ${label}. ${said} Click for ${copilotModeLabel(next)}.`)
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

  /* Chosen files are copied into the vault, then represented by compact cards
     above the text field. The path remains delivery data rather than appearing
     as message text. */
  el.attach.addEventListener('click', async () => {
    el.attach.disabled = true
    try {
      const paths = await api.ai.pickAttachments()
      if (paths?.length) addAttachments(paths)
    } catch (err) {
      note(err?.message || 'Those files could not be attached.', 'warn')
    } finally {
      el.attach.disabled = false
    }
  })

  /* ---------------------------------------------------------- the panel */

  /**
   * Point the panel at a different note: put this conversation away, take out
   * that one's. The process is not touched — the next message resumes the
   * right session, and until there is one there is nothing to resume.
   *
   * Nothing is marked stale here, deliberately. `ensureSession` compares the
   * conversation about to speak with the one the running process was started
   * for, which is the same question asked exactly: a note switch that comes
   * back where it started (A → B → A) leaves a process that is already
   * resuming A's session. Saying "stale" on the way past made that round trip
   * kill and respawn it — a restart's latency and its cached prompt, spent on
   * arriving where we already were.
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
    /* Upgrade transcripts saved before starters were marked. Once somebody
       has spoken, the invitation has done its job and does not come back on
       the next launch or note switch. */
    if (convo.messages.some((msg) => msg.t === 'you') && dismissStarters(convo)) save()
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
    push({
      t: 'note',
      starter: true,
      text: state.notePath
        ? `Ask about ${displayName(state.notePath)}, or anything else in the vault. You will see it edit. Type @ for a file, / for commands.`
        : `${providerLabel(provider())} has your vault open. Open a note to start a conversation about it.`
    })
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
    const model = modelFromConfig(cfg)
    const enabled = Array.isArray(cfg.aiModels) ? cfg.aiModels : state.enabled
    const effort = cfg.aiEffort || state.effort
    const mode = copilotModeFromConfig(cfg)
    if (!COPILOT_MODE_ORDER.includes(cfg?.aiMode)) {
      /* Store the normalized value once so future launches do not have to
         infer it. The legacy boolean remains conservative for older builds. */
      persistConfig({ aiMode: mode, aiWrite: mode === COPILOT_MODES.AUTO })
    }
    if (model === state.model && effort === state.effort && mode === state.mode &&
        enabled.join('\n') === state.enabled.join('\n')) return

     Object.assign(state, { model, enabled, effort, mode, stale: true })
    repaintControls()
  }

  repaintControls()

  return {
    open,
    close,
    setNote,
    toggle: () => (state.open ? close() : open()),

    /**
     * A note that has moved, and the conversations about it moving with it.
     *
     * Chats are filed under the note's path — in memory and in the history file
     * — so a rename left every conversation about a note under a name nothing
     * would ask for again: unreachable from the panel, and dropped the next
     * time the history was trimmed to its cap.
     *
     * `moved` is the renderer's own rule for what the move did to a path,
     * handed over rather than restated here: it is the same one the tabs, the
     * side pane and the history are retraced by, and it already knows that
     * renaming a folder renames everything under it.
     */
    renamed: (moved) => {
      let touched = false
      for (const path of [...state.chats.keys()]) {
        const next = moved(path)
        if (next === path) continue
        touched = true
        const entry = state.chats.get(path)
        state.chats.delete(path)
        /* Something may be filed under the new name already. Usually it is the
           empty chat the panel opened the instant the renamed note appeared on
           screen — the rename settles the document before it retraces the
           paths — and putting the conversation behind that would be a rename
           that visibly forgets what you were discussing. So an entry nobody has
           spoken in gives way, and a real one keeps both, its own on screen. */
        const had = state.chats.get(next)
        const spoken = had?.convos.some((convo) => convo.messages.some((m) => m.t === 'you'))
        if (!had || !spoken) state.chats.set(next, entry)
        else had.convos.unshift(...entry.convos)
      }
      if (!touched) return

      state.notePath = moved(state.notePath)
      // A turn in flight files into a conversation, not a path — but the path
      // it carries decides which chats survive the next trim.
      if (state.turn) state.turn.path = moved(state.turn.path)
      for (const item of state.queue) item.path = moved(item.path)
      /* And on screen. The renamed note is put on screen before its paths are
         retraced — so by the time this runs the panel has already opened the
         empty chat that belonged to the new name, and the conversation just
         rescued from the old one would sit in `state` unread until the next
         note switch. */
      repaint()
      save()
    },

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
      // Mid-turn it joins the queue like anything else typed while the copilot
      // is working — it used to be left in the box under a promise the panel
      // had no machinery to keep.
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
    flush: async () => {
      /* Closing the window also closes its agent. Stop it while the renderer is
         still alive so main can finish the turn-scoped safety snapshot and the
         review can be filed in the right conversation before transcripts are
         written. Killing it from `BrowserWindow.closed` is too late for both. */
      if (state.busy) await halt()
      await flush()
    },

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
            .map((convo) => {
              /* Older builds saved a cumulative per-turn total as `used` for
                 the CLIs that report one. Those copilots are gone; clear the
                 figure on read so their chats do not retain a false gauge. */
              const stale = convo.threadOf === 'codex' || convo.threadOf === 'claude'
              return {
                id: convo.id || newChat().id,
                thread: convo.thread || null,
                threadOf: convo.threadOf || null,
                used: stale ? 0 : (convo.used || 0),
                cost: convo.cost || 0,
                seed: convo.seed || '',
                at: convo.at || 0,
                // The cap is applied on the way in as well as on the way out: a
                // file written before it was lowered is trimmed by reading it.
                messages: convo.messages.slice(-MAX_MESSAGES)
              }
            })
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
