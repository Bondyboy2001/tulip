/* The conversation's own books: what a message, a conversation and a stored
   copy of one look like, and the cap that keeps a transcript from growing
   without end. Pure bookkeeping — no panel state, no DOM beyond the node a
   message already carries, no reads or writes. Split out of src/copilot.js so
   the cap, the digest and the on-disk shape are testable and cannot drift from
   the restore path that reads them back. */

/**
 * @typedef {object} Message
 * Everything a transcript row holds. `t` says which kind — `'you'` and
 * `'bot'` are the prose, `'step'` a tool call, `'think'` the reasoning,
 * `'note'` a notice, `'warn'` a failure with a way out, `'review'` the turn's
 * file changes — and the other fields are the kinds' own, optional because a
 * row is built up as its events arrive rather than all at once. `node` and
 * `html` are this window's drawing of the row and never mean anything to the
 * next window.
 *
 * @property {string} t
 * @property {string} [text]
 * @property {any} [id]             The tool call a step row answers to.
 * @property {string} [name]
 * @property {string} [path]
 * @property {boolean} [error]
 * @property {boolean} [done]
 * @property {string} [detail]      What a tool said. Kept only for a failure,
 *                                  and shortened — see `stored`.
 * @property {number} [added]
 * @property {number} [removed]
 * @property {number} [line]
 * @property {boolean} [queued]     Asked, waiting for the turn in front of it.
 * @property {boolean} [dropped]    Never went out (stopped, quit, withdrawn).
 * @property {boolean} [starter]    The empty-chat invitation — UI, not history.
 * @property {boolean} [resume]
 * @property {boolean} [retry]      A failure with an "ask again" way out.
 * @property {string[]} [attachments]
 * @property {boolean} [live]       Thinking, still streaming.
 * @property {number} [tokens]
 * @property {{ id: string, changes: { path: string }[] }} [operation]
 * @property {boolean} [bookmarked]
 * @property {boolean} [accepted]
 * @property {HTMLElement | null} [node]
 * @property {string | null} [html]
 *
 * @typedef {object} Convo
 * @property {string} id
 * @property {string | null} thread        The CLI session to resume.
 * @property {string | null} threadOf      Which CLI issued that session.
 * @property {number} used                 Context the conversation carries.
 * @property {boolean} [usedEstimated]     Whether `used` is our own estimate.
 * @property {number} cost                 What its turns have cost, if told.
 * @property {any} [contextOptions]
 * @property {string} seed                 Digest carried into the next chat.
 * @property {boolean} [suggested]         Whether "getting long" was said.
 * @property {boolean} [granted]           Ask-mode grant, held for the window.
 * @property {number} at                   Last touched, for the history.
 * @property {Message[]} messages
 * @property {Map<any, Message> | null} [steps]   Tool-call id → row.
 * @property {any} [run]                   The turn in flight — never stored.
 */

/* Enough to scroll back through, bounded so a vault worked in for a year does
   not turn into a transcript archive nobody asked for. */
export const MAX_MESSAGES = 150
/* What is said, as opposed to what was done. A turn that edits forty files
   writes eighty rows, and with one cap over both it was the questions and the
   answers that fell off the top — the panel then disagreed with the CLI's own
   thread about what had been said in the conversation. So the machinery is
   trimmed first and prose is only ever dropped once there is this much of it. */
export const MAX_PROSE = 60
export const MAX_NOTES = 60
/* Conversations kept per note; the oldest fall off. */
export const MAX_CHATS = 20

/* The copilots Tulip no longer runs. Their threads cannot be resumed and their
   context readings are about conversations nothing here can reopen, so a
   restored chat of theirs comes back with its gauge cleared — see `ingest` in
   copilot-store.js. */
export const gone = new Set(['codex', 'claude', 'devin'])

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
export const VAULT_CHAT = '\u0000vault'
export const chatKey = (path) => path || VAULT_CHAT

/* Ids only have to be unique within this vault's history file; a counter
   alongside the clock keeps two chats started in the same millisecond apart. */
let seq = 0

/** A conversation, empty and ready to be spoken into. @returns {Convo} */
export function newChat () {
  return {
    id: `c${Date.now().toString(36)}${(seq++).toString(36)}`,
    thread: null,
    threadOf: null,
    used: 0,
    // What a turn has cost, added up. Only some CLIs report it; a conversation
    // with nobody keeping the bill stays at zero and says nothing.
    cost: 0,
    // A digest of the conversation this one continues — see `summarise`.
    seed: '',
    at: Date.now(),
    messages: []
  }
}

/** Prose — what either party actually said. Everything else is a record of
    work, and is what the cap sheds first. */
const prose = (msg) => msg.t === 'you' || msg.t === 'bot'

/* The empty-chat invitation is UI, not conversation history. Older saved
   chats contain it as an ordinary note, so recognise both the new marker and
   that exact legacy shape while cleaning them up. */
export const isStarter = (msg) => msg?.starter === true ||
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
 *
 * @param {Convo} convo
 * @param {Message} msg
 * @param {number} [at]
 * @param {{keepNode?: boolean}} [options]
 */
export function drop (convo, msg, at = convo.messages.indexOf(msg), { keepNode = false } = {}) {
  if (at !== -1) convo.messages.splice(at, 1)
  if (msg.t === 'step' && convo.steps?.get(msg.id) === msg) convo.steps.delete(msg.id)
  /* A caller about to replace the whole log has no use for a node-by-node
     teardown of it — `repaint` empties the log wholesale — but the reference
     still has to go, or the row is drawn twice the next time it is filed. */
  if (!keepNode) msg.node?.remove()
  msg.node = null
}

/** Every invitation still standing, taken down — somebody has spoken.
    @returns {boolean} whether anything was removed. */
export function dismissStarters (convo) {
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
 *
 * @param {Convo} convo
 */
export function trim (convo) {
  while (convo.messages.length > MAX_MESSAGES) {
    // One pass for both questions: how much prose there is, and where the
    // oldest thing that is not prose sits.
    let spoken = 0
    let oldest = -1
    for (let at = 0; at < convo.messages.length; at++) {
      if (prose(convo.messages[at])) spoken++
      else if (oldest === -1) oldest = at
    }
    let at = spoken > MAX_PROSE || oldest === -1 ? 0 : oldest
    if (convo.messages[at]?.bookmarked) at = convo.messages.findIndex((message) => !message.bookmarked)
    if (at < 0) break
    const goneMsg = convo.messages[at]
    if (!goneMsg) break
    drop(convo, goneMsg, at)
  }
}

/** The rows of a conversation that a tool call can land on, by call id.
 *
 *  Built lazily and kept on the conversation. Every event of a turn came
 *  through as a linear scan of the transcript — up to `MAX_MESSAGES` of them,
 *  on a turn that may report hundreds of calls — to answer a question the id
 *  already settles. The two places a row leaves a conversation — the cap, and
 *  `/new` emptying a chat nobody has spoken in — say so via `drop`, so a call
 *  id can never resolve to a row the transcript no longer holds.
 *
 *  @param {Convo} convo
 */
export function stepsIn (convo) {
  if (!convo.steps) {
    convo.steps = new Map()
    for (const msg of convo.messages) {
      if (msg.t === 'step' && msg.id != null) convo.steps.set(msg.id, msg)
    }
  }
  return convo.steps
}

/** A conversation, named by the first thing that was asked in it.
    @param {Convo} convo */
export function title (convo) {
  const first = convo.messages.find((m) => m.t === 'you')
  const text = (first?.text || '').replace(/\s+/g, ' ').trim()
  if (!text) return 'Empty chat'
  return text.length > 64 ? `${text.slice(0, 64)}…` : text
}

/* What is written down of a message that is a bar of gold in memory.
   `node` is this window's DOM and `html` its render of it, neither of which
   means anything to the next window. `detail` is what a tool said, and most
   of it is a file the agent read: keeping every one would put a copy of half
   the vault in the history file, several times over, to be reread on every
   launch. So only a failure's reason is kept, and shortened — that is the
   part still worth reading a week later. */
const KEPT_DETAIL = 600

/**
 * The message as it is written down.
 *
 * A question waiting its turn is waiting in memory: the queue itself is never
 * written down, and nothing re-drains it on launch. So a `queued` flag that
 * survived the write would grey the message out for good — in every window
 * that ever opened that chat, under a promise the panel has no machinery left
 * to keep. Stop already turns the queue into "not sent" when it empties it; a
 * quit mid-turn ends the same way, and this is where it says so.
 *
 * @param {Message} msg
 * @returns {Message} the stored copy
 */
export function stored (msg) {
  const copy = { ...msg }
  if (copy.queued) copy.dropped = true
  delete copy.queued
  delete copy.node
  delete copy.html
  // Only a failure's reason is kept, and shortened — the rest of what a tool
  // said is a file the agent read, and a copy of half the vault does not
  // belong in the history file.
  if (copy.detail && copy.error) copy.detail = copy.detail.slice(0, KEPT_DETAIL)
  else delete copy.detail
  return copy
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
 *
 * @param {Convo} convo
 * @returns {string} the digest, empty when there is nothing to carry
 */
export function summarise (convo) {
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
      const line = `- ${(m.text || '').replace(/\s+/g, ' ').slice(0, 300)}`
      const began = answerTo(m)
      return began ? `${line}\n  answered: ${began}` : line
    }),
    ...listed('Files you already read in that conversation, most recent first', read),
    ...listed('Files you already changed in that conversation — do not redo those edits', written),
    ...(tail ? ['', 'How your last reply ended:', tail] : [])
  ].join('\n')
}
