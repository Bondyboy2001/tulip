import MarkdownIt from 'markdown-it'

import { el as element, reason } from './dom.js'
import { diffBlock } from './history.js'
import { when } from './time.js'
import { mathPlugin } from './math.js'
import { citePlugin } from './cite.js'
import { routeAnchor, revealAnchorTarget } from './links.js'
import { assetKind, assetUrl } from './assets.js'
import { isLanguageTablePath } from './language-table.js'
import {
  DEFAULT_CATALOGUE,
  effortLabel, effortsFor, modelByKey, modelFromConfig, nearestEffort,
  offeredModels, providerGrant, providerLabel, searchModels, splitKey,
  COPILOT_MODES, COPILOT_MODE_ORDER, CONTEXT_MODES, copilotModeFromConfig, copilotModeLabel
} from './models.js'
import {
  NOTE_EXT, isChatAttachment, isTexPath, isPdfPath, isSitePath, isWhiteboardPath,
  noteName
} from './vault-paths.js'
import { fileIcon } from './file-icons.js'
import { highlightInto } from './highlight.js'
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
 * A conversation also has its own copilot. Ask about one file, move to another
 * and ask there, and both are being answered at once: two CLI processes, two
 * threads, neither waiting on the other. What is still single is the panel, so
 * everything it shows — the working strip, the Stop button, the counter — is
 * about the chat on screen, and the ones running behind it are named in a line
 * of their own at the foot of the log. See `runOf` for where a turn's state
 * lives now, and `ensureSession` for the process behind it.
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
  onCite, onOpen, onRestore, onAccept, onWarn, onPermission, willSlide
}) {
  const state = {
    open: false,
    /* The default level of the model's own ladder, not the top of it: high
       reasoning burns thinking tokens on every turn — including turns that
       only want a summary — and ⌃T is one keystroke away for the turns that
       do want it. */
    effort: 'medium',
    /* One choice, not two: `provider:id` names the CLI and the model together,
       so the panel has a single control where it used to have a pair. Empty
       until Settings says otherwise — there is no model nobody chose. */
    model: '',
    catalogue: DEFAULT_CATALOGUE,
    // Which of the catalogue the dropdown offers — chosen in Settings, because
    // opencode alone answers with hundreds.
    enabled: [],
    mode: COPILOT_MODES.READ,

    /* Bumped whenever a setting every copilot was started with changes — the
       model, the effort, the permission mode. Nothing restarts on the spot: a
       conversation whose process was started at an older reading is replaced at
       its next message, when the wait is expected anyway. Restarting on the
       change itself made a held-down ⌃T kill and respawn a CLI per keystroke.

       A generation rather than the single `stale` flag this replaces: there is
       a copilot per conversation now, and one flag could only ever describe
       one of them. */
    settings: 0,

    notePath: '',
    // note path -> { at, active, convos: [{ id, thread, at, messages }] }
    chats: new Map(),

    /* Everything about a turn in flight — the process, the reply being written,
       the questions waiting behind it — belongs to the conversation it is
       happening in. See `runOf`. */

    /* The question the Edit button lifted into the composer, so the next send
       can stand in its place rather than repeat it at the foot. { msg, convo },
       held only until something is sent. */
    editing: null,
    contextMode: null
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
  /* The panel's live region — see the note on `#ai-log`. This is the one thing
     here worth announcing: a short line that changes a few times a turn and
     says whether the copilot is thinking, reading, writing or done. `polite`
     because none of it is urgent enough to cut across what is being read. */
  busyRow.setAttribute('role', 'status')
  busyRow.setAttribute('aria-live', 'polite')
  const busySpinner = element('span', 'ai-spinner')
  const busyLabel = element('span', 'ai-busy-label')
  const busyTime = element('span', 'ai-busy-time')
  /* Out of the live region, though not off the screen. The phase is worth
     announcing and changes a few times a turn; the counter beside it changes
     every second for the length of the turn, and announcing that is the same
     firehose the log itself was. Sighted readers keep the reassurance, and
     nobody has "forty-one seconds, forty-two seconds" read to them. */
  busyTime.setAttribute('aria-hidden', 'true')
  busySpinner.setAttribute('aria-hidden', 'true')
  const busyCaret = element('span', 'ai-busy-caret', '▸')
  busyCaret.setAttribute('aria-hidden', 'true')
  busyRow.append(busySpinner, busyLabel, busyTime, busyCaret)
  el.log.append(busyRow)

  /* The strip is also the switch for the reasoning streaming in above it.
     Live thinking is folded away by default — a wall of half-formed prose
     scrolling under every reply is the wrong default — and clicking "Working"
     opens it for this turn and the ones after, until it is clicked shut. The
     choice outlives the session, since wanting to watch the model think is a
     disposition rather than a whim. */
  const THINK_KEY = 'tulip.copilot.showThinking'
  let showThinking = false
  try { showThinking = localStorage.getItem(THINK_KEY) === '1' } catch {}
  function paintThinkingSwitch () {
    el.log.dataset.think = showThinking ? 'open' : 'shut'
    busyRow.setAttribute('aria-pressed', showThinking ? 'true' : 'false')
    busyRow.title = showThinking ? 'Hide thinking' : 'Show thinking'
  }
  paintThinkingSwitch()
  busyRow.tabIndex = 0
  busyRow.addEventListener('click', () => {
    showThinking = !showThinking
    try { localStorage.setItem(THINK_KEY, showThinking ? '1' : '0') } catch {}
    paintThinkingSwitch()
    if (following) el.log.scrollTop = el.log.scrollHeight
  })
  busyRow.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); busyRow.click() }
  })

  /* The turns running in other conversations. With one copilot there was
     nothing to say — the strip above was the only turn there was. With one per
     note, a reply can be arriving in a chat that is not on screen, and a panel
     that said nothing about it would look idle while it worked. Each name opens
     the file it belongs to, which is also how you go and read the answer. */
  const elsewhereRow = element('div', 'ai-elsewhere')
  elsewhereRow.hidden = true
  el.log.append(elsewhereRow)

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

  /* One timer for the panel, not one per turn: it repaints the strip on screen,
     and there is only ever one of those however many turns are running. */
  let busyTick = 0

  function paintBusy () {
    const run = visibleRun()
    const rephrased = busyLabel.textContent !== run.phase
    busyLabel.textContent = run.phase
    busyRow.classList.toggle('has-think', !!run.think?.text)
    const seconds = Math.round((Date.now() - (run.at || Date.now())) / 1000)
    // Silent for the first couple of seconds: a timer on a reply that arrives
    // straight away is noise, not reassurance.
    const said = seconds >= 2 ? `${seconds}s` : ''
    const grew = rephrased || said.length !== busyTime.textContent.length
    busyTime.textContent = said
    /* Reading `scrollHeight` is a forced layout, and this runs on a one-second
       timer for the whole of a turn. The strip only changes size when the timer
       gains a digit or the phase changes — a counter ticking from 8s to 9s
       moves nothing — so the rest of the time there is nothing to scroll to. */
    if (following && grew) el.log.scrollTop = el.log.scrollHeight
  }

  /** Which phase a turn is in. Cheap enough to call on every event. */
  function phase (run, what) {
    if (!run.busy || what === run.phase) return
    run.phase = what
    if (run === visibleRun()) paintBusy()
  }

  /**
   * The panel, told what is running: the strip and the Stop button for the
   * conversation on screen, and a line naming the ones working behind it.
   *
   * Called both when a turn starts or ends and when the reader moves to another
   * note — the same paint answers both, because what it draws is a fact about
   * the chat in front of them rather than about the turn that changed.
   */
  function paintWorking () {
    const run = visibleRun()
    // The button is never disabled — while a turn runs it is the stop button,
    // which is exactly when you are most likely to want it.
    el.panel.dataset.busy = run.busy ? 'yes' : 'no'
    el.send.setAttribute('aria-label', run.busy ? 'Stop' : 'Send')
    busyRow.hidden = !run.busy
    if (run.busy) paintBusy()

    const others = workingRuns().filter((other) => other !== run)
    elsewhereRow.hidden = !others.length
    if (others.length) {
      elsewhereRow.replaceChildren(...others.map((other) => {
        const name = other.turn?.path ? displayName(other.turn.path) : 'the vault'
        const go = element('button', 'ai-elsewhere-note')
        go.type = 'button'
        go.textContent = name
        go.title = `Working on ${name} — open it`
        go.addEventListener('click', () => {
          if (other.turn?.path) onOpen?.(other.turn.path)
        })
        return go
      }))
      elsewhereRow.prepend(element('span', 'ai-elsewhere-label',
        others.length === 1 ? 'Also working on' : `Also working on ${others.length} files:`))
    }

    /* The counter ticks for as long as anything is running, because the reader
       may be watching any one of them. */
    const anyone = run.busy || others.length
    if (anyone && !busyTick) busyTick = setInterval(paintBusy, 1000)
    if (!anyone && busyTick) { clearInterval(busyTick); busyTick = 0 }
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
  function announce (run, to, trouble = '') {
    if (!run.busy || !run.at || Date.now() - run.at < NOTIFY_AFTER) return
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

  /**
   * The name a conversation with no note open is filed under.
   *
   * `greet` invites one — "open a note, or ask about anything else in the
   * vault" — and until this existed every word of it was lost with the window:
   * a chat filed under the empty string was skipped by `save`, filtered out of
   * `flush`, and so never reached disk. A NUL is not a character any vault path
   * can contain, so the key cannot collide with a real note, and it survives the
   * round trip through the history file as an ordinary JSON key.
   */
  const VAULT_CHAT = '\u0000vault'
  const chatKey = (path) => path || VAULT_CHAT

  /** Everything filed under a note: its conversations, and which one is open. */
  function file (path = state.notePath) {
    const key = chatKey(path)
    let entry = state.chats.get(key)
    if (!entry) {
      const convo = newChat()
      entry = { at: convo.at, active: convo.id, convos: [convo] }
      state.chats.set(key, entry)
    }
    return entry
  }

  /** The conversation on screen. */
  function chat (path = state.notePath) {
    const entry = file(path)
    return entry.convos.find((c) => c.id === entry.active) || entry.convos[0]
  }

  /* ------------------------------------------------------------- the runs */

  /**
   * What a conversation has in flight: its copilot, the turn it is answering,
   * the reply being written into it, and the questions waiting behind that.
   *
   * All of this used to be one set of fields on `state`, which said what the
   * panel was doing — and a panel can only do one thing at a time. So a turn
   * about one note was the whole app's turn: ask about another and the question
   * was queued behind it, however unrelated the two were.
   *
   * Here instead, because a conversation is what a turn actually belongs to.
   * The CLI is started per conversation as well (see `ensureSession`), so two
   * notes are two processes and two threads, and neither waits on the other.
   * What is still one of is the panel: the strip at the foot of the log, the
   * Stop button and the elapsed counter all describe the conversation on
   * screen, and the ones running behind it are named in a line of their own.
   *
   * Kept on the conversation rather than in a map beside it, so it cannot
   * outlive what it is about: a chat trimmed out of memory takes its run with
   * it. Nothing here is written down — `flush` names the fields it saves, and
   * this is not among them.
   */
  function runOf (convo) {
    if (!convo.run) {
      convo.run = {
        convo,
        busy: false,
        // Whether main is holding a copilot for this conversation, and the
        // settings reading it was started with.
        started: false,
        settings: -1,
        /* Set by `/new` emptying a chat in place: the id is the same, so
           nothing else would notice that the thread it resumes is one this
           conversation has just thrown away. */
        stale: false,
        /* The turn this conversation is answering, captured the moment the
           message is sent. Every event of that turn routes here — never to
           whichever note happens to be on screen when it arrives. */
        turn: null,       // { id, path, convo, run }
        // Stop lets go of `turn` before it awaits main, but the events that
        // stop produces still belong to the conversation it ended.
        stopping: null,
        stream: null,     // the copilot message currently being written into
        think: null,      // the thinking message for the turn in progress
        /* Questions asked while this conversation was busy, in order. Each is
           already in the transcript, greyed. Per conversation, so a follow-up
           about one note is never delivered into another. */
        queue: [],
        at: 0,            // when the running turn began, for the counter
        phase: 'Working'
      }
    }
    return convo.run
  }

  /** The run the panel's controls describe. */
  const visibleRun = () => runOf(chat())

  /** Every run there is, for the handful of questions that are about all of
   *  them: what is still working, and what a rename has to follow. */
  function allRuns () {
    const out = []
    for (const entry of state.chats.values()) {
      for (const convo of entry.convos) if (convo.run) out.push(convo.run)
    }
    return out
  }

  const workingRuns = () => allRuns().filter((run) => run.busy)

  /* Every turn in flight, by the id it was issued. How an event coming back
     from main finds the conversation it belongs to — with several running at
     once, "the turn" is no longer a question the panel can answer on its own. */
  const turns = new Map()

  /**
   * The session id to resume with, if this conversation has one worth using.
   *
   * A thread belongs to the CLI that issued it: an id one program opened is an
   * argument another has never seen, and the turn fails — then fails again on
   * every later message, because the id is still there. So each id is filed
   * with the program that made it and offered back only to that one, which is
   * also what quietly retires the threads of a copilot Tulip no longer runs. An
   * id from before this was recorded has no owner, and is not resumed.
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

  /**
   * Take a message out of a conversation, and out of the window with it.
   *
   * Three things have to happen together and used to be remembered separately
   * at each of the four places that drop a row: the message leaves `messages`,
   * a step stops being findable in the `steps` index that points at it, and the
   * node leaves the document — because a row still on screen after the
   * conversation has let go of it is a transcript that disagrees with itself.
   * The step line in particular was present at two of those four sites and
   * absent at the other two, which is the kind of invariant that survives only
   * as long as whoever adds the fifth site happens to look at the right one.
   *
   * `at` is passed when the caller already knows where the message sits, which
   * is every caller that is walking the array anyway.
   */
  function drop (convo, msg, at = convo.messages.indexOf(msg), { keepNode = false } = {}) {
    if (at !== -1) convo.messages.splice(at, 1)
    if (msg.t === 'step' && convo.steps?.get(msg.id) === msg) convo.steps.delete(msg.id)
    /* A caller about to replace the whole log has no use for a node-by-node
       teardown of it — `repaint` empties the log wholesale — but the reference
       still has to go, or the row is drawn twice the next time it is filed. */
    if (!keepNode) msg.node?.remove()
    msg.node = null
  }

  function dismissStarters (convo) {
    let removed = false
    for (let at = convo.messages.length - 1; at >= 0; at--) {
      if (!isStarter(convo.messages[at])) continue
      drop(convo, convo.messages[at], at)
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
      const at = spoken > MAX_PROSE || oldest === -1 ? 0 : oldest
      const gone = convo.messages[at]
      if (!gone) break
      drop(convo, gone, at)
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
    save(path)
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
    if (msg === streamOnScreen()) return paintStream(node, msg.text || '')
    /* A question is built rather than rendered — its attachments are cards, not
       markdown — so redrawing one through `html` alone dropped the files it was
       asked with. Which is what happens the moment a queued question goes out:
       the row loses its attachments at exactly the point it stops being grey. */
    if (msg.t === 'you') return paintUserMessage(node, msg)
    if (msg.t === 'think' && paintThink(node, msg)) return
    node.innerHTML = html(msg)
    dressCode(node)
  }

  /**
   * Colour the fenced code in freshly written prose.
   *
   * `highlightInto` is the reading view's own painter: the same lezer parsers
   * over the same token spec, landing on the same `.hl-*` classes the
   * stylesheet already colours globally. So a rust block quoted back at you in
   * the panel and the block it was read from in the note are the same colours,
   * and neither has a palette of its own to drift from the other.
   *
   * markdown-it's fence rule writes the fence's word onto the `<code>` as
   * `language-<word>` and nowhere else, so that class is what the language is
   * read back from here. A block with no word — a command's output, a stack
   * trace — has no class, is asked about nothing, and stays plain, which is
   * both what it was before and what it should be: `error[E0381]` is not rust.
   * An unknown word answers false the same way.
   */
  function dressCode (root) {
    for (const code of root.querySelectorAll('pre > code[class*="language-"]')) {
      const lang = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1]
      if (lang) highlightInto(code, code.textContent, lang).catch(() => {})
    }
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
   * How long the unsettled tail may get before it stops being re-rendered as
   * markdown on every frame.
   *
   * `settledCut` will not cut inside a fence, which is right — half a code
   * block set as prose is worse than no seam at all. But it means a reply that
   * is *one long fence* has no seam anywhere, so the whole accumulated block
   * was parsed and rendered again per frame for as long as it streamed: exactly
   * the quadratic the seam exists to prevent, in the case where replies run
   * longest. Past this the tail is appended as plain text — which is what a
   * fence's contents are — and `settleStream` gives the finished reply the one
   * clean render that turns it back into a code block.
   */
  const LIVE_TAIL_LIMIT = 4000

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
      live.plain = false
    }
    if (head.renderedPrefix !== prefix) {
      head.renderedPrefix = prefix
      head.innerHTML = prefix ? md.render(prefix) : ''
      /* The settled half only. The tail is re-rendered on every frame, and a
         block still being typed is a different string each time — so it would
         miss the token cache on every one of them and pay a fresh parse per
         frame, which is the cost the seam above exists to avoid. A finished
         block is in the head by the next seam, and the last one is coloured by
         the whole-reply render `settleStream` does. */
      dressCode(head)
    }

    /* Past the limit the tail is appended as plain text rather than re-rendered
       — see `LIVE_TAIL_LIMIT`. The text only ever grows, so what is already on
       screen is already right and the frame's work is the characters that
       arrived since; a tail that shrank is a reply that was replaced, and
       starts over. */
    if (tail.length > LIVE_TAIL_LIMIT) {
      if (!live.plain) {
        live.plain = true
        live.replaceChildren(element('pre', 'stream-plain'))
        live.shown = 0
      }
      const block = live.firstElementChild
      if (live.shown > tail.length) { block.textContent = ''; live.shown = 0 }
      block.append(tail.slice(live.shown))
      live.shown = tail.length
      return
    }
    live.plain = false
    live.innerHTML = md.render(tail)
  }

  /** The reply is no longer being streamed into: give the finished text the
   *  one clean whole render the fast path deferred, seam and split removed. */
  function settleStream (run) {
    const msg = run.stream
    run.stream = null
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

  /* The two things worth doing to a message that has already been said: take a
     copy of an answer, and put a question back in the box to ask differently.
     Drawn into the message rather than appended to its node, because every
     repaint replaces that node's contents — a button hung on the outside
     survived exactly until the reply finished streaming. */
  const COPY_MARK =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/>' +
    '<path d="M10.5 3.5h-7a1 1 0 0 0-1 1v7"/></svg>'
  const EDIT_MARK =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M3 11.75V13h1.25l7.7-7.7-1.25-1.25zM9.9 4.85l1.25 1.25"/></svg>'
  const CANCEL_MARK =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8"/></svg>'

  const actions = (...rows) =>
    `<div class="msg-actions">${rows.filter(Boolean).join('')}</div>`

  const action = (kind, label, mark) =>
    `<button type="button" class="icon-btn msg-action ai-${kind}" ` +
    `title="${escape(label)}" aria-label="${escape(label)}">${mark}</button>`

  /* An answer is one reply to the reader and several messages to the panel: a
     tool call ends the paragraph before it, so a turn that searches twice while
     it explains itself lands as three `bot` rows. Which is why the reply is a
     span rather than a message — everything the copilot wrote since the last
     question, however many tool calls it broke over. */
  function replySpan (msg) {
    const messages = chat().messages
    const at = messages.indexOf(msg)
    if (at < 0) return [msg]
    let from = at
    while (from > 0 && messages[from - 1].t !== 'you') from--
    let to = at
    while (to + 1 < messages.length && messages[to + 1].t !== 'you') to++
    return messages.slice(from, to + 1).filter((m) => m.t === 'bot')
  }

  /* Whether a turn is still writing into the conversation on screen. Nothing on
     screen belongs to another one: an offscreen conversation is only ever
     redrawn once it is opened. */
  const writing = () => {
    const run = visibleRun()
    return !!(run.turn || run.stopping)
  }

  /* The reply's last word, which is where its copy button goes — one button per
     answer rather than one per paragraph, and none until the answer is whole.
     A button on each `bot` row put three of them down the side of a single
     reply and made each copy a third of it. */
  const endsReply = (msg) => {
    if (writing()) return false
    const span = replySpan(msg)
    return span[span.length - 1] === msg
  }

  function render (msg) {
    /* A reply carries a copy button; a question carries one and an edit, which
       puts it back in the composer to be asked again differently. Neither is
       drawn on an empty message, and neither on a question that never went. */
    if (msg.t === 'bot') {
      return md.render(msg.text || '') +
        (msg.text && endsReply(msg)
          ? actions(action('copy', 'Copy this reply', COPY_MARK))
          : '')
    }
    if (msg.t === 'you') return md.render(msg.text || '')
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
    if (msg === streamOnScreen()) paintStream(node, msg.text || '')
    else if (msg.t === 'you') paintUserMessage(node, msg)
    else { node.innerHTML = html(msg); dressCode(node) }
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
    node.replaceChildren()
    const attached = Array.isArray(msg.attachments) ? msg.attachments : []
    if (attached.length) {
      const strip = element('div', 'msg-attachments')
      for (const path of attached) strip.append(attachmentCard(path))
      node.append(strip)
    }
    if (msg.text) {
      const copy = element('div', 'msg-you-copy')
      copy.innerHTML = html(msg)
      dressCode(copy)
      node.append(copy)
    }
    /* Edit puts the question back in the box — the words and the files both —
       so the next attempt is the same question with a word changed rather than
       one retyped from memory. Not offered on a question that never went out:
       there is nothing to ask differently, and the composer is where it already
       is. */
    if (!msg.text && !attached.length) return
    /* A queued question can still be taken back — the one mercy a message
       waiting on a long turn has. A dropped one is already history. */
    if (msg.queued) {
      const strip = element('div', 'msg-actions')
      strip.innerHTML = action('unqueue', 'Cancel this queued message', CANCEL_MARK)
      node.append(strip)
      return
    }
    if (msg.dropped) return
    const strip = element('div', 'msg-actions')
    strip.innerHTML = action('edit', 'Edit this question and ask again', EDIT_MARK) +
      (msg.text ? action('copy', 'Copy this question', COPY_MARK) : '')
    node.append(strip)
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
    /* Row per changed file, kept by path so the one Diff control can open all
       of them. The file itself is context, not another action: the
       transcript's `Edited …` row already provides the direct jump. */
    const rowFor = new Map()
    for (const summary of operation.changes) {
      const row = element('div', 'ai-review-file')
      const path = element('span', 'ai-review-path', summary.path)
      path.title = summary.path
      row.append(path)
      rowFor.set(summary.path, row)
      files.append(row)
    }

    const actions = element('div', 'ai-review-actions')

    /* One Diff for the turn rather than one per file. A turn is accepted or
       rejected whole — those two controls have always been about all of it —
       and reading it should work the same way, in one click, beside them.
       Fetching once also replaces N round trips with one for a turn that
       touched several files. */
    const diff = element('button', 'ghost is-compact ai-review-diff', 'Diff')
    diff.type = 'button'
    diff.title = operation.changes.length === 1
      ? 'Show what changed'
      : `Show what changed in all ${operation.changes.length} files`
    diff.addEventListener('click', async () => {
      const open = files.querySelector('.history-diff, .ai-review-gone')
      if (open) {
        for (const shown of files.querySelectorAll('.history-diff, .ai-review-gone')) shown.remove()
        diff.classList.remove('is-open')
        return
      }
      let detail = null
      try {
        detail = await api.trust.operation(operation.id)
      } catch {
        // Falls through to the same line as a missing change: from the
        // reader's side, a history that cannot be read and one that no
        // longer holds this turn are the same answer.
      }
      diff.classList.add('is-open')
      for (const [path, row] of rowFor) {
        const change = detail?.changes.find((item) => item.path === path)
        /* A turn old enough to have been evicted from the history — it holds
           whole before/after texts and is capped — has no diff left to show.
           Saying so beats a button that answers a click with nothing, which
           reads as broken rather than as expired. */
        row.append(change
          ? diffBlock(change)
          : element('div', 'ai-review-gone', 'That change is no longer in the history.'))
      }
    })
    actions.append(diff)
    /* Reject is the single rollback for the whole turn. Main snapshots the
       vault before the message goes out, so no per-file restore controls are
       needed here. */
    const reject = element('button', 'ghost is-compact is-danger', 'Reject')
    reject.type = 'button'
    reject.title = `Reject changes to all ${operation.changes.length} files`
    reject.addEventListener('click', () => {
      Promise.resolve(onRestore?.(operation, null)).catch((err) => {
        onWarn?.(reason(err, 'Those changes could not be rejected.'))
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
      Promise.resolve(onAccept?.(operation))
        .then(save)
        .catch((err) => {
          /* Put back. Accepting only clears the diff marks, so nothing is lost
             when it fails — but a button that says "Accepted" over changes
             that were not is the transcript telling the reader something
             untrue, and it is the record they come back to. Reported the same
             way Reject reports, rather than swallowed. */
          msg.accepted = false
          node.classList.remove('is-accepted')
          keep.textContent = 'Accept changes'
          keep.disabled = false
          onWarn?.(reason(err, 'Those changes could not be accepted.'))
        })
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
  /**
   * The rows of a conversation that a tool call can land on, by call id.
   *
   * Built lazily and kept on the conversation. Every event of a turn came
   * through here as a linear scan of the transcript — up to `MAX_MESSAGES` of
   * them, on a turn that may report hundreds of calls — to answer a question
   * the id already settles. Trimming and `/new` drop rows behind its back, so
   * The two places a row leaves a conversation — the cap, and `/new` emptying a
   * chat nobody has spoken in — say so, so a call id can never resolve to a row
   * the transcript no longer holds.
   */
  function stepsIn (convo) {
    if (!convo.steps) {
      convo.steps = new Map()
      for (const msg of convo.messages) {
        if (msg.t === 'step' && msg.id != null) convo.steps.set(msg.id, msg)
      }
    }
    return convo.steps
  }

  function step (event, to = null) {
    const convo = to?.convo ?? chat()
    const steps = stepsIn(convo)
    const candidate = event.id == null ? null : steps.get(event.id)
    const found = candidate && (!event.path || !candidate.path || candidate.path === event.path)
      ? candidate
      : null
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
      const made = push({ t: 'step', id: event.id, ...fields }, to)
      if (event.id != null) steps.set(event.id, made)
      return made
    }
    Object.assign(found, fields)
    redraw(found)
    save(to?.path ?? state.notePath)
    return found
  }

  /**
   * The thinking block.
   *
   * The CLI hands back little of the reasoning itself — a short summary at
   * best, and on many models nothing. So this shows the shape of the thinking
   * rather than its content: live while it runs, and afterwards a single quiet
   * line saying how long it went on for.
   */
  function thinking (run, event, to = null) {
    if (!run.think) run.think = push({ t: 'think', tokens: 0, text: '', live: true }, to)
    const think = run.think
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
  function settleSteps (run) {
    /* `stopping` as well as `turn`: Stop lets go of the turn before it awaits
       main, so by the time this runs the only thing still naming the
       conversation being settled is the one Stop parked there. Falling through
       to `chat()` settled whatever was on screen instead, and left the stopped
       conversation reading `Editing …` for good — which is the exact state this
       function exists to prevent. */
    const convo = (run.turn || run.stopping)?.convo || run.convo
    for (const msg of convo.messages) {
      if (msg.t === 'step' && msg.done === false) {
        msg.done = true
        redraw(msg)
      }
    }
  }

  /** The thinking is over — collapse it to its epitaph. */
  function settleThinking (run) {
    if (!run.think) return
    run.think.live = false
    redraw(run.think)
    run.think = null
    save(pathOf(run))
  }

  /** Which note a run's messages are filed under, for the writes that follow
   *  them. The turn carries it; a stopped one is still the turn being settled. */
  const pathOf = (run) => (run.turn || run.stopping)?.path ?? state.notePath

  /** The reply being streamed into the conversation on screen, if there is one.
   *  Only that one gets the cheap append-only paint — an offscreen reply has no
   *  node to append to. */
  const streamOnScreen = () => visibleRun().stream

  function setBusy (run, busy) {
    run.busy = busy
    if (busy) {
      run.at = Date.now()
      run.phase = 'Working'
    } else {
      settleThinking(run)
      settleStream(run)
      settleSteps(run)
      /* The answer is whole now, so the row that ends it gains its copy button.
         `settleStream` only covers a turn that stopped while writing; one that
         ended on a tool call left its last words rendered mid-turn, and mid-turn
         is exactly when that button is withheld. */
      const ending = run.turn || run.stopping
      const ended = [...(ending?.convo?.messages || [])].reverse().find((m) => m.t === 'bot')
      if (ended) redraw(ended)
      // The id is only of interest while its events can still arrive.
      if (ending?.id) turns.delete(ending.id)
      run.turn = null
    }
    paintWorking()
    /* Whatever was asked while this turn ran goes out now. On a microtask
       rather than here: every caller of `setBusy(run, false)` is in the middle
       of closing a turn out, and starting the next one from inside that would
       have the two overlap in the same run. */
    if (!busy) queueMicrotask(() => drain(run))
  }

  /**
   * The three things in a transcript that are worth clicking.
   *
   * A citation goes to the page it names — the whole point of asking for them.
   * A link opens in the browser rather than in this window: the log is inside
   * the app's only page, and letting an anchor follow itself would replace the
   * app with a website, with no way back.
   */
  /** The message a control inside the transcript belongs to. */
  function messageAt (node) {
    const row = node?.closest('.msg')
    return row ? chat().messages.find((msg) => msg.node === row) || null : null
  }

  /**
   * Taken to the clipboard as the words that were written, not as the markup
   * they were drawn into: the reply is markdown on the way in and markdown is
   * what is wanted on the way out — pasted into a note it goes on being a list
   * and a code block rather than arriving as a wall of prose.
   */
  async function copyMessage (button) {
    const msg = messageAt(button)
    if (!msg?.text) return
    /* The button sits on the reply's last row and copies the whole reply — the
       paragraphs a tool call broke it into as well, in the order they were
       written, with the blank line between them that markdown wants. */
    const text = msg.t === 'bot'
      ? replySpan(msg).map((m) => m.text || '').filter(Boolean).join('\n\n')
      : msg.text
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // A clipboard the window is not allowed to touch is worth saying so
      // about; there is nothing else the panel can do with the text.
      onWarn?.('That could not be copied to the clipboard.')
      return
    }
    /* Said on the button itself, and only for a moment. A note in the
       transcript for every copy would be a conversation about copying. */
    button.classList.add('is-done')
    clearTimeout(button.doneTimer)
    button.doneTimer = setTimeout(() => button.classList.remove('is-done'), 1200)
  }

  /**
   * A question put back in the box to be asked differently.
   *
   * The composer is loaded with the question and its files, and the message is
   * remembered: when the reworded version is sent, it takes the original's
   * place in the transcript rather than repeating it at the foot. The thread on
   * the other side keeps what was actually said either way — only the
   * transcript treats the resend as a revision rather than a new question.
   */
  function editMessage (button) {
    const msg = messageAt(button)
    if (!msg) return
    if (msg.text) quote(msg.text)
    const attached = Array.isArray(msg.attachments) ? msg.attachments : []
    if (attached.length) addAttachments(attached, true)
    state.editing = { msg, convo: chat() }
    el.input.focus()
  }

  /**
   * A queued question withdrawn before it went out.
   *
   * Off the queue and out of the transcript both: a row left grey reads as
   * still waiting, and one stamped "not sent" reads as a failure. The reader
   * changed their mind, so the transcript treats it as never asked.
   */
  function cancelQueued (button) {
    const msg = messageAt(button)
    if (!msg?.queued) return
    const queue = visibleRun().queue
    const at = queue.findIndex((item) => item.msg === msg)
    if (at !== -1) queue.splice(at, 1)
    drop(chat(), msg)
    save()
  }

  /* How long a followed edit shows its own diff for. Long enough to read a
     few lines, short enough that it is plainly a glance and not a panel the
     reader now has to close. The fade is CSS; this only has to outlast it. */
  const STEP_DIFF_MS = 4000
  let stepDiffTimer = null

  /**
   * Show the diff for one step row, under it, for a moment.
   *
   * Only ever one at a time — following three edits in a row should leave the
   * transcript as it found it, not three diffs deep.
   */
  async function flashStepDiff (row, path, operationId) {
    clearTimeout(stepDiffTimer)
    for (const old of el.log.querySelectorAll('.step-diff')) old.remove()
    if (!operationId || !path) return

    let detail = null
    try {
      detail = await api.trust.operation(operationId)
    } catch {
      // Nothing to glance at, and nothing worth a warning for a glance.
    }
    const change = detail?.changes.find((item) => item.path === path)
    if (!change || !row.isConnected) return

    const flash = element('div', 'step-diff')
    flash.append(diffBlock(change))
    row.insertAdjacentElement('afterend', flash)
    /* Removed on a timer rather than on the animation ending: the animation is
       decoration and a reader with reduced motion turns it off, which would
       otherwise leave the diff on screen for good. */
    stepDiffTimer = setTimeout(() => {
      flash.classList.add('is-going')
      setTimeout(() => flash.remove(), 260)
    }, STEP_DIFF_MS)
  }

  el.log.addEventListener('click', (event) => {
    const again = event.target.closest('.ai-again')
    if (again) { askAgain(again.closest('.msg-warn')); return }

    const copy = event.target.closest('.ai-copy')
    if (copy) { copyMessage(copy); return }

    const edit = event.target.closest('.ai-edit')
    if (edit) { editMessage(edit); return }

    const unqueue = event.target.closest('.ai-unqueue')
    if (unqueue) { cancelQueued(unqueue); return }

    const edited = event.target.closest('.msg-step.can-open')
    if (edited) {
      const path = edited.dataset.path || ''
      const messages = chat().messages
      const at = messages.findIndex((message) => message.node === edited)
      const reviews = at < 0 ? [] : messages.slice(at + 1).filter((message) =>
        message.t === 'review' &&
        message.operation?.changes?.some((change) => change.path === path))
      const review = reviews.find((message) => !message.accepted)
      onOpen?.(
        path,
        edited.dataset.line ? Number(edited.dataset.line) : null,
        review?.operation?.id || null
      )
      /* And show what the row is claiming. The tally on it says `+46 −0`; the
         lines behind that number are one click away everywhere else in the
         panel and were not here. Shown in passing rather than left open: the
         row is a jump, not a disclosure, and a diff that stayed would push the
         rest of the transcript down every time one was followed. Any review
         will do — including an accepted one, which still holds the text. */
      flashStepDiff(edited, path, (review || reviews[0])?.operation?.id || null)
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

  /**
   * Which notes have said something since the last write, and which have left.
   *
   * A write used to be the whole of this vault's history however little of it
   * had changed: sixty notes, twenty conversations apiece, every message
   * rebuilt into a stored copy, structured-cloned across the bridge and
   * serialised again on the other side — all so one tool call could be recorded.
   * The write fires on blur, on every note switch, and at least every five
   * seconds for the length of a turn, so the cost was paid constantly and almost
   * always for one note's worth of change.
   *
   * So a write says which notes it is about and main merges them into what is
   * already on disk. That also makes the file better than the window: a
   * conversation the panel has let go of to stay under its own cap is no longer
   * dropped from disk merely by not being in memory when something else is
   * saved.
   */
  const dirtyNotes = new Set()
  const removedNotes = new Set()

  function save (path = state.notePath) {
    unsaved = true
    dirtyNotes.add(chatKey(path))
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
       exactly the ones this is here to let go of. The two kinds that cannot go
       are the note on screen and any conversation still being answered — of
       which there may now be several at once. */
    for (const [path, entry] of ranked.slice(MAX_NOTES)) {
      if (path === chatKey(state.notePath)) continue
      // A conversation with a turn in flight is being written into; letting it
      // out of memory would drop the reply as it arrived.
      if (entry.convos.some((convo) => convo.run?.busy || convo.run?.stopping)) continue
      state.chats.delete(path)
    }

    /* Blur, `beforeunload` and every note switch ask for a write, and most of
       the time nothing has changed since the last one. */
    if (!unsaved) return
    unsaved = false

    const notes = [...dirtyNotes]
    const remove = [...removedNotes]
    dirtyNotes.clear()
    removedNotes.clear()

    const out = {}
    for (const path of notes) {
      const entry = state.chats.get(path)
      /* Gone from memory since — trimmed by the cap above, or renamed away.
         Its absence here is not a reason to take it off disk: the window's
         sixty notes are a working set, not the record. */
      if (!path || !entry) continue
      /* An empty chat is launch state, which `restore` already refuses to read
         back. Writing one would put it over a real conversation that is on disk
         and no longer in memory — a note revisited after the cap let go of it
         opens a fresh chat, and that fresh chat must not be what survives. */
      const convos = entry.convos.filter((convo) => convo.messages.some((m) => m.t === 'you'))
      if (!convos.length) continue
      out[path] = {
        at: entry.at,
        active: entry.active,
        convos: convos.map((convo) => ({
          id: convo.id,
          thread: convo.thread,
          threadOf: convo.threadOf || null,
          used: convo.used || 0,
          // Whether that figure is the CLI's own or ours — kept, or a restored
          // chat's reading loses the sign that says nobody vouched for it.
          usedEstimated: !!convo.usedEstimated,
          cost: convo.cost || 0,
          seed: convo.seed || '',
          at: convo.at,
          messages: convo.messages.map(stored)
        }))
      }
    }
    // Nothing to add and nothing to take away — the ordinary case for a blur.
    if (!Object.keys(out).length && !remove.length) return

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
    return api.ai.history.save({ notes: out, remove }).catch((err) => {
      unsaved = true
      // Back on the list, or the next write would report nothing to do and this
      // note's transcript would exist only in the window.
      for (const path of notes) dirtyNotes.add(path)
      for (const path of remove) removedNotes.add(path)
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
    /* Which turn this belongs to, asked of the id rather than of the panel.
       Several conversations can be being answered at once, so "the running
       turn" is no longer a thing the panel knows — the id issued by `deliver`
       is the only thing that decides, and an event whose turn has already been
       settled has nowhere left to go. */
    const to = turns.get(String(event?.turnId || ''))
    if (!ownsTurn(to, event)) return
    const run = to.run
    switch (event.k) {
      case 'ready':
      case 'thread':
        run.started = true
        // Filed against the conversation being discussed, so coming back to it
        // later picks the same session up rather than starting over.
        if (event.thread) {
          to.convo.thread = event.thread
          to.convo.threadOf = provider()
          save(to.path)
        }
        break

      case 'thinking':
        thinking(run, event, to)
        phase(run, 'Thinking')
        break

      case 'preparing-pdf':
        phase(run, 'Preparing PDF')
        break

      case 'text':
        settleThinking(run)
        if (!run.stream) run.stream = push({ t: 'bot', text: '' }, to)
        run.stream.text += event.text
        redraw(run.stream)
        phase(run, 'Writing')
        break

      case 'tool':
        // A fresh tool call ends the paragraph before it; the next prose the
        // copilot writes belongs in a message of its own.
        settleThinking(run)
        settleStream(run)
        // Capture the note before the tool changes it. The renderer keeps this
        // separate from the transcript so it can draw a live, unsaved diff.
        // The turn id rides along: a provider can announce a Write after the
        // file has already changed, and the turn's own baseline is then the
        // only copy of "before" left — see rememberAgentBefore.
        if ((event.name === 'Edit' || event.name === 'Write') && event.path) {
          onEditing?.(event.path, event.needle || '', event.name, event.turnId)
        }
        step({ ...event, done: false }, to)
        // A tool running is the quietest part of a turn and the one that most
        // looks like a hang, so the strip says which tool and on what rather
        // than leaving a timer to answer that on its own.
        phase(run, phaseOf(event))
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
        settleThinking(run)
        settleStream(run)
        step({ ...event, name: 'Rename', done: true }, to)
        Promise.resolve(onRenamed?.(event)).catch((err) => {
          onWarn?.(reason(err, 'The file was renamed but the window could not follow it.'))
        })
        break

      case 'rename-failed':
        note(event.message || 'The Copilot rename could not be completed.', 'warn', to)
        onWarn?.(event.message || 'The Copilot rename could not be completed.')
        break

      case 'review':
        push({ t: 'review', operation: event.operation, accepted: false }, to)
        save(to.path)
        break

      // The process is gone — it exited, or was never there to begin with.
      // Forgetting it here is what lets the next message start a fresh one
      // instead of talking to a corpse.
      case 'error':
        run.started = false
        failed(event.message || 'Something went wrong.', to)
        announce(run, to, event.message || 'Something went wrong.')
        setBusy(run, false)
        break

      case 'turn-end':
        if (event.used) {
          to.convo.used = event.used
          /* Some CLIs count for themselves and some are counted for — the
             reading is the same ring either way, and the difference is said in
             the readout rather than left for the user to guess at. */
          to.convo.usedEstimated = !!event.estimated
        }
        // Only some CLIs report what a turn cost; the rest say nothing and the
        // readout stays away rather than showing a zero as if it were free.
        if (event.cost) to.convo.cost = (to.convo.cost || 0) + event.cost
        if (event.used || event.cost) paintContext(to)
        if (event.error) failed(event.error, to)
        // Before `setBusy`, which is what lets go of the turn this is about.
        announce(run, to, event.error || '')
        setBusy(run, false)
        /* The deltas since the last tool call are only in memory until now.
           Named, because `setBusy` has just let go of the turn: the reader may
           have browsed on, and this write is about the note the reply landed
           in rather than the one now on screen. */
        save(to.path)
        break
    }
  })

  /* -------------------------------------------------------------- session */

  const settings = (convo, turnId) => {
    const { provider, id } = splitKey(state.model)
    return {
      /* Which copilot this is. One per conversation, so the key is the
         conversation's own id — see electron/ai.js. */
      key: convo.id,
      provider,
      model: id,
      effort: state.effort,
      mode: state.mode,
      write: state.mode !== COPILOT_MODES.READ,
      resume: resumeFor(convo, provider),
      /* Where this conversation had got to. A session is replaced whenever the
         model, the effort or the note changes, and without this the context
         reading started again from nothing each time while the thread it
         resumed carried on growing. */
      used: convo.used || 0,
      turnId
    }
  }

  /**
   * Makes this conversation's copilot match the settings — the chosen model,
   * effort and permission mode. Called just before a message goes out, never on
   * the change itself.
   *
   * A conversation keeps its own process, so this no longer has to ask whether
   * the one that is running belongs to somebody else: starting one for this
   * chat replaces this chat's, and leaves every other note's turn alone. What
   * it does still ask is whether the settings have moved since — the reader
   * changing model or effort makes every copilot out of date, and each is
   * replaced at its own next message.
   */
  async function ensureSession (run, turnId) {
    /* The panel is not always the way in — a Fix button asks a question with
       the panel still closed — and a turn about to be sent is as good a reason
       to know the real catalogue as a control about to be drawn. */
    readCatalogue()
    if (run.started && !run.stale && run.settings === state.settings) return true
    const result = await api.ai.start(settings(run.convo, turnId))
    run.started = !!result?.ok
    run.stale = false
    run.settings = state.settings
    if (!result?.ok) failed(result?.error || 'The copilot could not start.', run.turn)
    return run.started
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
    },
    {
      name: 'model',
      hint: 'Choose who answers — /model followed by a name',
      /* Primed rather than left bare: the catalogue is a list, not a query,
         so there is something to show before a word is typed. */
      run: () => { quote('/model '); offerMenu() }
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
      current.steps = null
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
  /**
   * The same move, made without being asked.
   *
   * The panel used to wait for the red ring before acting, and by then the
   * conversation had already paid for every turn it spent getting there —
   * twice over, because the CLI re-sends the whole thread on each one. The
   * digest costs nothing but the transcript it is built from, so it is made
   * while carrying it over is still cheap: at `ROOMY`, before the ring has
   * anything alarming to say.
   *
   * At the moment a message is sent rather than when the ring turns, which is
   * what makes it safe: nothing is running, the reader is looking at the panel,
   * and the message they just typed goes into the fresh conversation rather
   * than being the last thing squeezed into the full one. Returns the
   * conversation the caller should actually file into.
   */
  function compactIfFull (path) {
    const convo = chat(path)
    /* Only for the note on screen. `startChat` works on what is showing — it
       resets the panel and greets into it — so compacting a queued follow-up's
       off-screen chat from here would rotate the visible conversation and
       leave the full one untouched. That chat is compacted instead by its own
       next on-screen send. */
    if (path !== state.notePath) return convo
    const room = currentModel()?.context || 0
    if (!room || !convo.used || convo.used / room < ROOMY) return convo

    const digest = summarise(convo)
    if (!digest) return convo
    startChat()
    const fresh = chat(path)
    if (fresh === convo) return convo   // `startChat` refused — a turn is running
    fresh.seed = digest
    note('That chat was getting long — every turn re-sends all of it — so this ' +
         'is a fresh one carrying a summary of it. /history has the old one.')
    save(path)
    return fresh
  }

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

  /* How many files the digest is willing to name. Enough to save the re-reads
     that matter, few enough that a turn which swept the vault does not spend
     the fresh context listing it. Newest first, because what was touched last
     is what the next question is most likely about. */
  const RECALLED_FILES = 12

  /**
   * Enough of the old conversation for the new one to pick up the thread.
   *
   * What was asked, how the last answer ended — and what the agent had already
   * been through to answer it. That last part was the expensive omission: a
   * compacted chat began knowing the questions but not one file it had read, so
   * its first move was always to re-read its way back to where it had been.
   * Paths only, which is what makes it worth naming — the contents are what the
   * context ran out of room for, and the agent can open any of them again for
   * the price of one tool call instead of the dozen it took to find them.
   */
  function summarise (convo) {
    const asked = convo.messages.filter((m) => m.t === 'you').slice(-8)
    const last = [...convo.messages].reverse().find((m) => m.t === 'bot')
    if (!asked.length) return ''
    const tail = (last?.text || '').slice(-1200)

    /* How each answer began — which is where a conclusion is usually stated,
       and the difference between a digest that carries the topics and one
       that carries what was worked out about them. First line only: the
       detail is what the context ran out of room for. */
    const answerTo = (question) => {
      for (let at = convo.messages.indexOf(question) + 1; at < convo.messages.length; at++) {
        const msg = convo.messages[at]
        if (msg.t === 'you') return ''
        if (msg.t === 'bot' && msg.text) {
          return msg.text.split('\n', 1)[0].replace(/\s+/g, ' ').slice(0, 200)
        }
      }
      return ''
    }

    /* Read and written are kept apart: one says where the answer came from, the
       other says what the conversation has already changed — and a fresh
       session that mistakes the second for the first will happily make the same
       edit twice. Newest first, deduped, and a file that was written is not
       also listed as read. */
    const written = new Set()
    const read = new Set()
    for (let at = convo.messages.length - 1; at >= 0; at--) {
      const msg = convo.messages[at]
      if (msg.t !== 'step' || !msg.path || msg.error) continue
      const into = (msg.name === 'Edit' || msg.name === 'Write') ? written : read
      if (into === read && written.has(msg.path)) continue
      if (into.size < RECALLED_FILES) into.add(msg.path)
    }
    for (const path of written) read.delete(path)

    const listed = (label, paths) =>
      paths.size ? ['', `${label}: ${[...paths].join(', ')}`] : []

    return [
      'Some background — this continues an earlier conversation, which has been',
      'cut short because it grew too long. Do not answer any of it again.',
      '',
      'What was asked, oldest first — each with how its answer began:',
      ...asked.map((m) => {
        const line = `- ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`
        const began = answerTo(m)
        return began ? `${line}\n  answered: ${began}` : line
      }),
      ...listed('Files you already read in that conversation, most recent first', read),
      ...listed('Files you already changed in that conversation — do not redo those edits', written),
      ...(tail ? ['', 'How your last reply ended:', tail] : [])
    ].join('\n')
  }

  /* ------------------------------------------------------- chat history */

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
    if (!visibleRun().busy) return false
    note('The copilot is still working — stop it first.')
    return true
  }

  /** Whatever was on screen is no longer what we are looking at. */
  function reset () {
    const run = visibleRun()
    run.stream = null
    run.think = null
    state.editing = null
    state.contextMode = null
    /* The process is left alone; the next message replaces it with one resuming
       whichever session this conversation belongs to.

       Said here and not in `setNote`, which looks like the same event and is
       not: `/new` into a chat nobody has spoken in yet keeps that chat's id and
       empties it, thread and all, so the comparison `ensureSession` makes would
       see the conversation it is already running and carry on answering out of
       the history this just threw away. */
    run.stale = true
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
    el.input.setAttribute('aria-expanded', 'false')
    el.input.removeAttribute('aria-activedescendant')
  }

  function paintMenu () {
    el.menu.replaceChildren(...menu.rows.map((row, at) => {
      const node = element('button', 'ai-menu-row')
      const on = at === menu.at
      node.type = 'button'
      node.id = `ai-menu-opt-${at}`
      node.setAttribute('role', 'option')
      node.setAttribute('aria-selected', on ? 'true' : 'false')
      node.classList.toggle('is-on', on)
      node.dataset.at = String(at)
      node.append(element('span', 'ai-menu-name', row.label),
                  element('span', 'ai-menu-hint', row.hint || ''))
      return node
    }))
    el.menu.hidden = false
    el.input.setAttribute('aria-expanded', 'true')
    el.input.setAttribute('aria-activedescendant', `ai-menu-opt-${menu.at}`)
    el.menu.children[menu.at]?.scrollIntoView({ block: 'nearest' })
  }

  /** Move the highlight without rebuilding the rows — this runs per arrow
   *  key, and nothing about the rows changed, only which of them is lit. */
  function moveMenu (by) {
    const count = menu.rows.length
    const was = el.menu.children[menu.at]
    menu.at = (menu.at + by + count) % count
    const on = el.menu.children[menu.at]
    if (!on) { paintMenu(); return }
    was?.classList.remove('is-on')
    was?.setAttribute('aria-selected', 'false')
    on.classList.add('is-on')
    on.setAttribute('aria-selected', 'true')
    el.input.setAttribute('aria-activedescendant', on.id)
    on.scrollIntoView({ block: 'nearest' })
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
  const MENTION_ROWS = 8

  function offerMentions (typed, from) {
    const wanted = typed.toLowerCase()
    /* The two ranks are collected apart rather than sorted together, which is
       what lets the scan stop honestly. A single list cut at four hundred
       matches stopped wherever the vault's own order happened to reach — so a
       note whose name *begins* with what was typed could be dropped before it
       was ever ranked, in favour of four hundred that merely contained it. The
       prefix matches are what the picker is for, so the scan runs until it has
       a menu's worth of those and only then gives up on the rest. */
    const begins = []
    const contains = []
    for (const entry of mentionable()) {
      const at = entry.folded.indexOf(wanted)
      if (at === -1) continue
      // A name that begins with what was typed is what was meant; one that
      // merely contains it is a second thought.
      if (at === 0) begins.push(entry)
      else if (contains.length < 400) contains.push(entry)
      if (begins.length >= MENTION_ROWS && contains.length >= 400) break
    }
    if (!begins.length && !contains.length) { hideMenu(); return }

    const byName = (a, b) => a.name.localeCompare(b.name)
    begins.sort(byName)
    contains.sort(byName)
    showMenu([...begins, ...contains].slice(0, MENTION_ROWS).map((entry) => ({
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

  /* `/model`, with or without a name after it. The space is what separates the
     command being *typed* from the command being *used*: `/mode` is still on
     its way to being a word and belongs in the command list, while `/model `
     has been said and its own rows take the menu over. */
  const MODEL = /^\/model(?:\s+([^\n]*))?$/i

  /* How many models a menu shows. The catalogue runs to several hundred, and a
     list longer than the panel is scrolling rather than choosing — the answer
     to not seeing what you want here is another word, not another page. */
  const MODEL_ROWS = 12

  /** The catalogue, searched as it is typed — see `searchModels`. */
  function showModels (query) {
    const rows = searchModels(state.catalogue, query, MODEL_ROWS).map((model) => ({
      /* The model's own name leads, and the shelf it sits on goes to the aside
         with the rest. Qualified the other way round — `openrouter ·
         anthropic/claude-…`, the way the readout spells it — every row began
         with the same word and was cut off before the one that told them
         apart. */
      label: model.label,
      /* Then the two things worth knowing beyond the name: who is serving it,
         and how much it holds. Kept to two because the panel is a column — at
         this width a third fact is paid for out of the name, and the name is
         what is being searched. */
      hint: [
        model.group,
        model.context ? `${Math.round(model.context / 1000)}k` : ''
      ].filter(Boolean).join(' · '),
      run: () => pickModel(model.key)
    }))
    if (!rows.length) { hideMenu(); return }
    showMenu(rows)
  }

  /** A model chosen from the menu: taken, and the line that chose it cleared. */
  function pickModel (key) {
    hideMenu()
    el.input.value = ''
    sizeInput()
    chooseModel(key)
    el.input.focus()
  }

  /** Which menu, if any, belongs over the box right now. */
  function offerMenu () {
    const box = el.input
    const trimmed = box.value.trim()
    /* Before the command list, and only once a space has been typed: until then
       `/model` is a name being completed like any other. */
    const naming = MODEL.exec(box.value)
    if (naming && box.value.length > '/model'.length) { showModels(naming[1] || ''); return }
    if (SLASH.test(trimmed)) { offerCommands(trimmed); return }

    const upto = box.value.slice(0, box.selectionStart ?? box.value.length)
    const at = MENTION.exec(upto)
    if (!at) { hideMenu(); return }
    offerMentions(at[1], upto.length - at[1].length - 1)
  }

  /* The menu is an autocomplete over the composer, said as one: the box names
     the list it drives and the lit row rides `aria-activedescendant`, so a
     screen reader announces the selection as the arrows move it without focus
     ever leaving the box. */
  el.input.setAttribute('aria-autocomplete', 'list')
  el.input.setAttribute('aria-controls', 'ai-menu')
  el.input.setAttribute('aria-expanded', 'false')

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
  function enqueue (text, attachments, contextMode = null) {
    const path = state.notePath
    const convo = chat(path)
    const msg = push({ t: 'you', text, attachments, queued: true }, { path, convo })
    /* On the conversation's own queue. Only a question about *this* chat waits
       for this chat: one asked about another note is another copilot's, and
       goes out straight away. */
    runOf(convo).queue.push({ text, attachments, contextMode, msg, path, convo })
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
        grant: providerGrant(provider(), state.mode),
        model: currentModel()?.label || state.model
      }) !== false
    } catch (error) {
      onWarn?.(error?.message || 'The Copilot permission request failed.')
      return false
    }
  }

  function markNotSent (msg, path = state.notePath) {
    if (!msg) return
    delete msg.queued
    msg.dropped = true
    redraw(msg)
    save(path)
  }

  /**
   * The queued questions, once the copilot is free to hear them.
   *
   * Everything waiting for the same conversation goes out as one turn rather
   * than as one turn each. The CLIs resume their threads, so every turn re-sends
   * the whole conversation to the model: two follow-ups typed during a long
   * reply cost two round trips and two copies of everything said so far, to ask
   * something the model can perfectly well read as one message. They stay
   * separate rows in the transcript — what was asked is what was asked — and it
   * is only the delivery that is joined.
   *
   * Everything on one conversation's queue was asked about that conversation,
   * so the whole of it goes out together.
   */
  function drain (run) {
    if (run.busy || !run.queue.length) return

    const batch = []
    while (run.queue.length) {
      const next = run.queue[0]
      // The conversation it was asked in may have been emptied by `/new` since.
      if (!next.convo.messages.includes(next.msg)) { run.queue.shift(); continue }
      batch.push(run.queue.shift())
    }
    if (!batch.length) return

    const [first] = batch
    if (batch.length > 1) {
      // The rows above are no longer waiting either, whichever of them carried
      // the words that go out.
      for (const item of batch.slice(1)) {
        if (!item.msg?.queued) continue
        delete item.msg.queued
        redraw(item.msg)
        /* Written down, or a transcript read back later would call these
           "not sent" — which is what `stored` makes of anything still queued,
           and the opposite of what just happened to them. */
        save(item.path)
      }
    }
    const contextMode = batch.every((item) => item.contextMode === CONTEXT_MODES.CODE_TASK)
      ? CONTEXT_MODES.CODE_TASK
      : null
    deliver({
      msg: first.msg,
      path: first.path,
      convo: convoFor(first.path, contextMode, batch),
      text: batch.map((item) => item.text).filter(Boolean).join('\n\n'),
      attachments: [...new Set(batch.flatMap((item) => item.attachments || []))],
      contextMode
    }).catch(() => {})
  }

  /**
   * Which conversation a turn belongs in.
   *
   * One rule, stated once, for the two ways a question reaches `deliver`. A
   * code task is self-contained — the fix for one block, carrying everything it
   * needs in its own words — so it gets a chat of its own rather than paying to
   * re-send a conversation it does not draw on. Everything else goes into the
   * open chat, compacted first if that chat has grown expensive.
   *
   * Said here rather than at each entry point because the two had already
   * drifted: the queued path kept the history the typed path had learned to
   * drop, and any rule added later ("code tasks skip the digest", "cap them per
   * note") would have had to be written twice and kept in step by hand.
   *
   * `carrying` is the queued case: rows already filed in the old conversation,
   * which have to travel to the new one rather than be left behind in a
   * transcript nobody is looking at any more.
   */
  function convoFor (path, contextMode, carrying = null) {
    if (contextMode !== CONTEXT_MODES.CODE_TASK) return compactIfFull(path)
    /* Only for a conversation still open on its own note. `startChat` works on
       what is on screen — it resets the panel and greets into it — so a reader
       who has browsed away in the meantime would have a chat they are not
       looking at replaced, and the rows moved out from under the one they are. */
    const rows = (carrying || []).map((item) => item.msg).filter(Boolean)
    const from = carrying?.[0]?.convo
    if (rows.length && (path !== state.notePath || from !== chat(path))) return from

    /* Taken out before `startChat` rather than after, so a chat whose only
       questions were these is recognised as one nobody has spoken in and
       reused, instead of being filed away as history for the sake of the rows
       that are about to leave it. The nodes are kept out of it: `reset` empties
       the log wholesale a moment later, so removing them one at a time is work
       the screen never shows. */
    for (const msg of rows) drop(from, msg, undefined, { keepNode: true })
    startChat()
    const convo = chat(path)
    for (const msg of rows) push(msg, { path, convo })
    return convo
  }

  let submitting = false

  /* One at a time. In Ask mode `permissionFor` holds a submit open on a
     dialog with the composer still full, and a second Enter there would ask —
     and send — the same question twice. Dropped rather than queued: the
     second press is the reader leaning on the key, not a new message. */
  async function submit () {
    if (submitting) return
    submitting = true
    try {
      await submitNow()
    } finally {
      submitting = false
    }
  }

  async function submitNow () {
    const text = el.input.value.trim()
    const attachments = [...pendingAttachments]
    if (!text && !attachments.length) return

    // Typed straight through without the menu — a command all the same.
    const found = command(text)
    if (found) { el.input.value = ''; sizeInput(); hideMenu(); found.run(); return }

    /* Selected files and pasted pictures are already in the vault. Their paths
       travel beside the reader's words and never have to appear inside them. */
    /* Only this conversation being mid-turn queues anything. A turn running
       about another note is another copilot, and this question goes out
       beside it. */
    if (visibleRun().busy) {
      /* Mid-turn the transcript is being written into — the stream, the
         thinking row — and rows behind the running turn cannot be pulled out
         from under it. A queued edit goes out as an ordinary follow-up. */
      state.editing = null
      const contextMode = state.contextMode
      state.contextMode = null
      el.input.value = ''
      clearAttachments()
      sizeInput()
      enqueue(text, attachments, contextMode)
      return
    }

    const path = state.notePath
    /* Ask before clearing the composer, so declining leaves the question and its
       attachments ready to edit or send after changing the mode. */
    if (!await permissionFor(path)) return
    /* After the permission and before the question is filed: a conversation with
       no room left is replaced rather than asked to hold one more turn, and a
       question that was never going out does not get a fresh chat opened for
       it. */
    const contextMode = state.contextMode
    const convo = convoFor(path, contextMode)
    state.contextMode = null
    el.input.value = ''
    clearAttachments()
    sizeInput()
    /* A resend of an edited question stands where the original stood: the old
       row and everything under it — the reply it drew, the steps — leave the
       transcript before the new version is filed. Guarded on the conversation
       still holding the message, because `/new`, `/compact` or a trim may have
       taken it in the meantime, and then there is nothing to stand in for. */
    const editing = state.editing
    state.editing = null
    if (editing?.convo === convo) {
      const at = convo.messages.indexOf(editing.msg)
      /* Spliced in one go and then let go of one at a time: `drop` is given the
         message it has already removed, so it is only the index and the node
         that are still its business. */
      if (at !== -1) for (const gone of convo.messages.splice(at)) drop(convo, gone, -1)
    }
    const msg = push({ t: 'you', text, attachments }, { path, convo })
    await deliver({ text, attachments, msg, path, convo, contextMode, approved: true })
  }

  /**
   * One turn, sent.
   *
   * Split from `submit` because a queued follow-up arrives here too, minutes
   * later and possibly with the reader looking at another note — so everything
   * this needs is passed in rather than read off what happens to be on screen.
   */
  async function deliver ({ text, attachments, path, convo, msg, contextMode = null, approved = false }) {
    if (!approved && !await permissionFor(path)) {
      markNotSent(msg, path)
      return
    }
    if (msg?.queued) {
      delete msg.queued
      redraw(msg)
    }
    // The turn is anchored to this conversation before anything can answer,
    // so browsing away while it runs cannot redirect what comes back.
    const run = runOf(convo)
    const to = { id: newTurnId(), path, convo, run }
    run.turn = to
    /* Registered before anything can be said about it: main answers on one
       channel for every conversation at once, and this is how each event finds
       its way back to the one that asked. */
    turns.set(to.id, to)
    setBusy(run, true)

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
      await sendTurn(to, { text, attachments, convo, contextMode })
    } catch (err) {
      if (run.turn === to) {
        run.started = false
        failed(reason(err, 'The copilot could not be reached.'), to)
        setBusy(run, false)
      }
    }
  }

  /** The body of a turn — everything `deliver` guards. */
  async function sendTurn (to, { text, attachments, convo, contextMode = null }) {
    const run = to.run
    /* No model — never chosen, or everything unticked in Settings — is not a
       copilot to start: spawning with an empty provider is a crash in main.
       Said in the transcript rather than swallowed, so it reads as a refusal
       with a reason and a retry instead of a question that vanished. */
    if (!state.model) {
      failed('No model selected — pick one in Settings, or above the message box.', to)
      setBusy(run, false)
      return
    }
    if (!await ensureSession(run, to.id)) { setBusy(run, false); return }
    /* Stop may have been pressed while the session was starting — `halt` has
       nothing to signal yet at that point, so it settles the panel and returns,
       and without this the turn it thought it had cancelled would carry on
       from here: a reply and a run of file edits with no working strip, no way
       to stop them, and the run already let go of the turn, so every event
       would be filed against whichever note happened to be on screen when it
       landed. The test is the turn's identity, not a flag: a *new* turn started
       in the meantime owns this conversation now, and this one is equally
       stale. */
    if (run.turn !== to) return

    // Awaited: the renderer flushes the open buffer here, so the agent reads
    // the note as it is on screen rather than as it was at the last autosave.
    /* The window rides along so the renderer can size the whole-note quote to
       the model actually chosen — see noteExcerpt. Zero when the catalogue
       does not say, which the renderer reads as its old fixed ceiling. */
    const context_ = await context({ mode: contextMode, window: currentModel()?.context || 0 })
    if (run.turn !== to) return

    /* A chat started by `/compact` carries a digest of the one it replaced, and
       it rides the first message rather than being sent as one of its own: a
       turn that says only "here is what we were discussing" spends a whole
       round trip to be answered with "thank you". */
    const opening = convo.seed ? `${convo.seed}\n\n${text}` : text

    const result = await api.ai.send(convo.id, opening, { ...context_, attachments }, to.id)
    /* Stop can be pressed while main is preparing a PDF or taking the turn's
       safety snapshot. The IPC call still has to return, but its failure then
       belongs to the cancelled turn and must not add a second warning after
       the explicit “Stopped.” row. */
    if (run.turn !== to) return
    // Spent only once it has actually gone out: a send that failed leaves the
    // digest for the message that tries again.
    if (result?.ok) convo.seed = ''
    if (!result?.ok) {
      // Whatever went wrong, the session is no longer one we can trust; the
      // next message starts over rather than failing the same way again.
      run.started = false
      failed(result?.error || 'The copilot could not be reached.', to)
      setBusy(run, false)
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
    // A composer wiped by hand is the edit being walked away from: whatever is
    // typed next is a new question, not a revision of the lifted one.
    if (!el.input.value && state.editing) state.editing = null
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
      note(reason(err, 'That image could not be attached.'), 'warn')
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
    /* An IME still composing owns the keyboard: its Enter confirms the word
       being typed and its arrows move the candidate list, and neither is meant
       for the panel. 229 is the keyCode every composition key reports, for the
       engines that say that instead of `isComposing`. */
    if (e.isComposing || e.keyCode === 229) return
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
  el.send.addEventListener('click', () => (visibleRun().busy ? halt() : submit()))

  /** Stop one conversation's copilot — the one on screen, unless another is
   *  named. The other notes' turns are somebody else's work and go on. */
  async function halt (run = visibleRun()) {
    const to = run.turn
    /* Let go of the turn before the await, not after. `deliver` checks its own
       turn against this one at every point it resumes, so clearing it here is
       what makes a Stop pressed during startup actually stop: the send that
       was about to happen sees the turn has moved on and never goes out. */
    run.turn = null
    run.stopping = to
    /* Stop means stop, follow-ups included — sending them anyway is the one
       thing the button cannot be read as meaning. They stay in the transcript,
       still greyed, so what was asked and never sent is at least visible. */
    const waiting = run.queue.splice(0)
    for (const item of waiting) {
      item.msg.queued = false
      item.msg.dropped = true
      redraw(item.msg)
      // Each was asked in its own conversation, which may not be this one.
      save(item.path)
    }
    await api.ai.stop(run.convo.id, to?.id)
    run.started = false
    setBusy(run, false)   // settles the stream and lets go of the turn
    /* Let go of it only once the panel has been settled. `setBusy(false)` is
       what closes the truncated reply, the thinking block and any tool call
       left running, and every one of those has to be filed against the
       conversation that was stopped rather than the one on screen. */
    run.stopping = null
    if (to?.id) turns.delete(to.id)
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
   * How much of the model's context the conversation is carrying — the CLI's
   * own figure where it publishes one, and Tulip's estimate of what it has sent
   * and been sent otherwise. A model that reports no context window at all has
   * nothing to be a proportion of, and the ring stays out of view for it.
   *
   * A ring rather than a number, because the question it answers is "how much
   * room is left" — a proportion, which a circle states at a glance and a token
   * count makes you do arithmetic for. The exact figures are in the tooltip.
   *
   * Hidden until a turn has reported something, and for any model whose CLI
   * does not publish a window: an unfilled ring on a model nobody can measure
   * would be a claim, not a reading.
   */
  // Where the ring turns red. A reading, not a trigger: compaction acts at
  // `ROOMY`, well before this, so red is the rare single-turn overshoot.
  const FULL = 0.85
  /* Where compacting is still cheap. A conversation carried over at six parts
     in ten costs a summary built from the transcript and nothing else; one
     carried over at the red ring has already paid for every turn it spent
     getting there, twice over — the CLIs resume their threads, so a full
     context is re-sent whole on every turn that follows it. */
  const ROOMY = 0.6

  /**
   * The ring, and the two things it is worth saying out loud.
   *
   * Those are about different conversations, which is why `to` is here. The
   * ring reads the chat on screen — it sits beside the composer, and the
   * composer writes into whatever is open. The warnings are about the chat
   * whose context just grew, which during a long turn the reader may well have
   * browsed away from; said with a bare `note()` they landed in whichever
   * transcript happened to be on screen, telling the wrong conversation it was
   * nearly full.
   */
  function paintContext (to = null) {
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
    /* Approximately, when nobody counted but us — see `account` in ai.js. The
       sign is the whole of the caveat: a figure this app worked out from what
       it sent and was sent back is a reading to watch climb, not a receipt. */
    const about = convo.usedEstimated ? '≈' : ''
    const said = `${about}${used.toLocaleString()} of ${room.toLocaleString()}`
    /* What the conversation has cost, when its provider reports one. Beside
       the context because they are the two running totals a turn adds to; an
       unavailable total is simply omitted. */
    const spent = convo.cost
      ? ` · $${convo.cost < 0.01 ? convo.cost.toFixed(4) : convo.cost.toFixed(2)}`
      : ''
    el.contextPop.textContent = said + spent
    el.context.setAttribute('aria-label', `Context used: ${said}${spent}`)

    /* The conversation the reading is *about*, which is the turn's if there is
       one. Its own figures, not the visible chat's — a turn filing into another
       note must be measured against what that note's chat is carrying. */
    const grew = to?.convo || convo
    const grewRoom = grew === convo ? room : (currentModel()?.context || 0)
    if (!grewRoom || !(grew.used > 0)) return
    const grewShare = grew.used / grewRoom

    /* Said once, when the mechanism arms — `compactIfFull` acts at this same
       threshold, so the note only tells the reader what the next message will
       do. One notice, not two: a second warning at the red ring promised the
       same sentence in the same words, and the ring turning red already says
       the rest on its own. */
    if (grewShare >= ROOMY && !grew.suggested) {
      grew.suggested = true
      note('This chat is getting long, and each turn re-sends all of it. The ' +
           'next message starts a fresh chat carrying a summary — /new starts ' +
           'over instead.', 'note', to)
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
    /* The two ways to change what it reads, on the thing that reads it —
       neither of which is a control, so this text is the only place either one
       is written down. */
    el.config.title = hasEffort
      ? 'Thinking level — ⌃T to step through it · /model to change the model'
      : '/model to change the model'
    paintContext()
  }

  /**
   * The model, chosen by name at the message box — see the `/model` command.
   *
   * There is no picker beside the composer any more. A dropdown has to be a
   * shortlist to be usable, so the one here could only ever offer what Settings
   * had ticked, and choosing anything else meant leaving the conversation to go
   * and tick it. Typing the name reaches the whole catalogue and is quicker
   * than opening a menu even when the model is in it. What is left in the
   * corner is the readout: which model is answering, and how hard.
   *
   * Any model the CLIs offer may be chosen this way, ticked or not — a choice
   * made by name is the same evidence of intent that a tick is, and
   * `offeredModels` keeps whatever is selected in view regardless.
   */
  function chooseModel (key) {
    if (key === state.model) return
    if (!modelByKey(state.catalogue, key)) return
    state.model = key
    state.settings++
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


  /**
   * Effort, as the levels this model actually takes.
   *
   * Not a fixed four: a model offers the variants it was published with, and
   * most of the catalogue has no such dial at all — in which case there is
   * nothing to step through and ⌃T says so rather than moving something.
   *
   * There is no control for it. It was a slider in a popover, which meant a
   * chord for the people who knew it and three gestures for everyone else,
   * over a setting with two or three stops; the chord is the whole of it now,
   * and the composer's readout is where the change shows.
   *
   * Nothing restarts the copilot — the level is a flag on the process,
   * applied when the next message replaces it, which is why picking one is
   * free.
   */
  const levels = () => effortsFor(currentModel())

  function setEffort (at, persist = false) {
    const offered = levels()
    if (!offered.length) return
    const next = offered[Math.max(0, Math.min(offered.length - 1, at))]
    if (!next) return
    if (next !== state.effort) {
      state.effort = next
      state.settings++
      paintConfig()
    }
    if (persist) persistConfig({ aiEffort: state.effort })
  }

  /** The chosen level, made to fit the model — see `nearestEffort`. */
  function settleEffort () {
    const model = currentModel()
    if (model) state.effort = nearestEffort(model, state.effort)
  }

  /**
   * ⌃T walks the model's ladder, a step at a time, wrapping at the top.
   *
   * The level is the setting that changes mid-conversation — a question you
   * expected to be cheap turns out to be hard, and the answer is one more step
   * of thinking — so it is a chord and nothing else, rather than a popover to
   * open and a slider to find in it. ⇧ steps back down for the reverse.
   *
   * Wrapping rather than stopping at the ends: with two or three levels on
   * most models, a dial you can spin is quicker than one you have to reverse,
   * and the readout says where you have landed.
   *
   * Only while the panel is open, because that is the only time the setting is
   * on screen: a chord that silently changes an unseen setting is a chord that
   * gets pressed by accident. The panel's own text fields would otherwise take
   * ⌃T as transpose-characters, which is what `preventDefault` is for.
   */
  function cycleEffort (by = 1) {
    const offered = levels()
    if (!offered.length) {
      onWarn?.(`${currentModel()?.label || 'This model'} has no thinking levels.`)
      return
    }
    const at = Math.max(0, offered.indexOf(state.effort))
    setEffort((at + by + offered.length) % offered.length, true)
    bumpConfig()
  }

  /* The readout is where the change shows, and it sits in the corner of a panel
     the reader is not looking at — so it says so itself. The class is taken off
     when the animation ends, and again before it is put back on, so holding the
     chord down flashes once per press rather than once. */
  function bumpConfig () {
    el.config.classList.remove('is-bumped')
    // Reading a layout value between the two is what restarts a CSS animation.
    void el.config.offsetWidth
    el.config.classList.add('is-bumped')
  }
  el.config.addEventListener('animationend', () => el.config.classList.remove('is-bumped'))

  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.metaKey || event.altKey) return
    // `code`, not `key`: ⌃⇧T is `T` on one keyboard layout and `t` on another.
    if (event.code !== 'KeyT') return
    if (el.app.dataset.ai !== 'open') return
    event.preventDefault()
    cycleEffort(event.shiftKey ? -1 : 1)
  })


  let changingMode = false

  async function chooseMode (next) {
    if (!COPILOT_MODE_ORDER.includes(next) || next === state.mode || changingMode) return
    changingMode = true
    try {
      state.mode = next
      state.settings++
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
    const may = providerGrant(provider(), mode)
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
    /* Before the level is drawn: the choice belongs to the model, and until it
       has been fitted to the model's own levels it may be one the model has
       never offered. */
    settleEffort()
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
      note(reason(err, 'Those files could not be attached.'), 'warn')
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
    /* Nothing is let go of here. The reply being written and the thinking
       behind it belong to the conversation that asked, which goes on being
       answered while the reader reads something else — and is still mid-turn
       when they come back to it. */
    repaint()
    if (state.open) greet()
  }

  /* The conversation whose nodes are in the log. Remembered so the one leaving
     the screen can be stripped of them — a rendered subtree per message, kept
     across every note switch, is most of a transcript's weight. */
  let shown = null

  /* How many rows a repaint draws. A chat at the cap is a hundred and fifty
     messages of markdown, KaTeX and code colouring, and every note switch paid
     for all of them when what the reader sees is the last screenful. The rest
     stay data — drawn only when the row standing in for them is asked. */
  const DRAWN_ROWS = 40

  function repaint () {
    dropDirty()
    const convo = chat()
    /* Upgrade transcripts saved before starters were marked. Once somebody
       has spoken, the invitation has done its job and does not come back on
       the next launch or note switch. */
    if (convo.messages.some((msg) => msg.t === 'you') && dismissStarters(convo)) save()
    if (shown && shown !== convo) for (const msg of shown.messages) msg.node = null
    shown = convo
    const from = Math.max(0, convo.messages.length - DRAWN_ROWS)
    /* The rows above the fold keep no node: a stale one from an earlier paint
       of this same conversation would have `redraw` and `drop` writing to
       elements no longer in the document. */
    for (let at = 0; at < from; at++) convo.messages[at].node = null
    el.log.replaceChildren(
      ...(from ? [earlierRow(convo, from)] : []),
      ...convo.messages.slice(from).map(draw),
      busyRow,
      elsewhereRow
    )
    following = true
    el.log.scrollTop = el.log.scrollHeight
    // The count belongs to the conversation, so it changes with it.
    paintContext()
    /* And so does everything about the turn: this conversation may be mid-reply
       while the one just left was idle, or the other way about. */
    paintWorking()
  }

  /** The row standing in for the messages a repaint left undrawn. Clicking it
   *  draws them all — the reader asked for the history, and a second fold
   *  inside it would be a page nobody asked to keep turning. */
  function earlierRow (convo, count) {
    const row = element('button', 'msg msg-earlier')
    row.type = 'button'
    row.textContent = `Show ${count} earlier message${count === 1 ? '' : 's'}`
    row.addEventListener('click', () => {
      if (chat() !== convo) { row.remove(); return }
      /* Trimming may have taken some since; whatever the conversation still
         holds undrawn is what the fold was hiding. Scroll is kept where it
         stands, measured from the bottom — the half that does not move. */
      const keep = el.log.scrollHeight - el.log.scrollTop
      row.replaceWith(...convo.messages.filter((msg) => !msg.node).map(draw))
      el.log.scrollTop = el.log.scrollHeight - keep
    })
    return row
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
    // A load that failed — the CLI mid-install, a PATH not there yet — is not
    // an answer: let the next opening ask again rather than serving the
    // built-in list for the rest of the window's life.
    loadModels().catch(() => { catalogued = false })
  }

  function open () {
    state.open = true
    /* Before the attribute, because the width the stage is about to lose has
       to be measured while the column still has it. See freezePanelSlide in
       renderer.js for what the pinning is protecting. */
    if (el.app.dataset.ai !== 'open') willSlide?.(true)
    el.app.dataset.ai = 'open'
    api.config.set({ ai: 'open' })
    readCatalogue()
    greet()
    el.input.focus()
  }

  function close () {
    hideMenu()
    state.open = false
    if (el.app.dataset.ai === 'open') willSlide?.(false)
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

    Object.assign(state, { model, enabled, effort, mode, settings: state.settings + 1 })
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
        // The vault-wide chat is filed under a name no rename can reach, and
        // handing it to the renderer's rule would be asking what a note that
        // does not exist was renamed to.
        if (path === VAULT_CHAT) continue
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
        /* The write is per note now, so a rename has to say both halves of what
           it did: the new name has a conversation to record, and the old one is
           a file entry nothing will ask for again. Said in that order, and
           `remove` is applied first on the other side, so a move onto a name
           that is being written in the same breath cannot delete it. */
        removedNotes.add(path)
        dirtyNotes.add(next)
      }
      if (!touched) return

      state.notePath = moved(state.notePath)
      // A turn in flight files into a conversation, not a path — but the path
      // it carries decides which chats survive the next trim, and names the
      // file in the "also working on" line.
      for (const run of allRuns()) {
        if (run.turn) run.turn.path = moved(run.turn.path)
        if (run.stopping) run.stopping.path = moved(run.stopping.path)
        for (const item of run.queue) item.path = moved(item.path)
      }
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
    ask: (text, options = {}) => {
      if (!text) return
      state.contextMode = options.contextMode || null
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
      /* Closing the window also closes its agents — all of them, one per
         conversation being answered. Stopped while the renderer is still alive
         so main can finish each turn-scoped safety snapshot and file each
         review in the right conversation before transcripts are written.
         Killing them from `BrowserWindow.closed` is too late for both. */
      await Promise.all(workingRuns().map((run) => halt(run)))
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
                 figure on read so their chats do not retain a false gauge. A
                 devin chat is in the same position — its thread is not one
                 opencode can resume, so what that ring said is about a
                 conversation nothing here can reopen. */
              const gone = new Set(['codex', 'claude', 'devin'])
              const stale = gone.has(convo.threadOf)
              return {
                id: convo.id || newChat().id,
                thread: convo.thread || null,
                threadOf: convo.threadOf || null,
                used: stale ? 0 : (convo.used || 0),
                usedEstimated: !stale && !!convo.usedEstimated,
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
