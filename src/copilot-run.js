/* A conversation's run: what it has in flight, and the three verbs that move
   it between states.

   All of this used to be one set of fields on the panel's state, which said
   what the panel was doing — and a panel can only do one thing at a time. So
   a turn about one note was the whole app's turn: ask about another and the
   question was queued behind it, however unrelated the two were.

   Here instead, because a conversation is what a turn actually belongs to.
   The CLI is started per conversation as well (see `ensureSession` in
   copilot.js), so two notes are two processes and two threads, and neither
   waits on the other. What is still one of is the panel: the strip at the foot
   of the log, the Stop button and the elapsed counter all describe the
   conversation on screen, and the ones running behind it are named in a line
   of their own.

   Kept on the conversation rather than in a map beside it, so it cannot
   outlive what it is about: a chat trimmed out of memory takes its run with
   it. Nothing here is written down — the store names the fields it saves, and
   this is not among them.

   The invariants, said once:

   - Exactly one of `turn` and `stopping` names the turn whose events still
     belong to this conversation. `turn` while it runs; `stopping` after Stop
     has let go of it but before its last events have been settled.
   - `busy` is true if and only if a turn is being answered: set by
     `beginTurn`, cleared by `settleRun` — and by nothing else.
   - `settleRun` is the only place `turn` goes back to null after a turn, and
     it runs the settling in a fixed order — thinking, stream, steps, the
     reply's last row, the id, the drain — because each of those looks at the
     turn the one before it is still holding on to.
   - Everything that reads "the turn being settled" reads `ownTurn`, which is
     `turn || stopping`: Stop parks the turn in `stopping` precisely so the
     settling can still find the conversation it belongs to.
   - A caller resuming from an await re-checks `superseded(run, to)` — a newer
     turn owns the panel by then, and settling it would put down a strip that
     belongs to something still running.
*/

/**
 * @typedef {import('./copilot-chat.js').Convo} Convo
 * @typedef {import('./copilot-chat.js').Message} Message
 * @typedef {import('./copilot-chat.js').Message} StepMessage
 *
 * @typedef {object} Turn
 * A turn in flight, captured the moment the message is sent. Every event of
 * that turn routes to it — never to whichever note happens to be on screen
 * when it arrives.
 * @property {string} id               Issued by `deliver`, the routing key.
 * @property {string} path             The note the turn is filed under.
 * @property {Convo} convo
 * @property {Run} run
 *
 * @typedef {object} Run
 * What a conversation has in flight: its copilot, the turn it is answering,
 * the reply being written into it, and the questions waiting behind that.
 * @property {Convo} convo
 * @property {boolean} busy
 * @property {boolean} started     Whether main is holding a copilot for this
 *                                 conversation.
 * @property {number} settings     The settings reading its process started at.
 * @property {boolean} stale       Set by `/new` emptying a chat in place: the
 *                                 id is the same, so nothing else would notice
 *                                 that the thread it resumes is one this
 *                                 conversation has just thrown away.
 * @property {Turn | null} turn
 * @property {Turn | null} stopping
 * @property {Message | null} stream    The reply being written into.
 * @property {Message | null} think     The thinking block for the turn.
 * @property {{text: string, attachments: any[], contextMode: string | null,
 *             msg: Message, path: string, convo: Convo, captured: Promise<any>}[]} queue
 *                                      Questions asked while busy, in order.
 * @property {number} at                When the running turn began.
 * @property {string} phase
 */

/** The run of a conversation that has never had one. @returns {Run} */
function freshRun (convo) {
  return {
    convo,
    busy: false,
    started: false,
    settings: -1,
    stale: false,
    turn: null,
    stopping: null,
    stream: null,
    think: null,
    queue: [],
    at: 0,
    phase: 'Working'
  }
}

/** A conversation's run, made on first ask. */
export function runOf (convo) {
  if (!convo.run) convo.run = freshRun(convo)
  return convo.run
}

/** The turn this run is settling — running, or stopped and not yet closed. */
export const ownTurn = (run) => run.turn || run.stopping

/** Whether the turn that is resuming from an await still owns the panel.
    A false answer is the quiet case: a newer turn owns it, or Stop took it. */
export const superseded = (run, to) => run.turn !== to

/**
 * A turn begins. The four fields that say "this conversation is being
 * answered" move together, or a strip can be up with no turn behind it.
 *
 * @param {Run} run
 * @param {Turn} to
 */
export function beginTurn (run, to) {
  run.turn = to
  run.busy = true
  run.at = Date.now()
  run.phase = 'Working'
}

/**
 * Stop lets go of the turn before it awaits main. The events that stop
 * produces still belong to the conversation it ended, so the turn is parked
 * in `stopping` rather than dropped — `settleRun` closes it out from there.
 *
 * @param {Run} run
 * @returns {Turn | null} the turn that was running
 */
export function releaseTurn (run) {
  const to = run.turn
  run.turn = null
  run.stopping = to
  return to
}

/**
 * A turn is over, whoever ended it — the reply landed, the send failed, the
 * process died, or Stop was pressed.
 *
 * The order is the invariant. The thinking and the stream are settled while
 * the turn is still findable, the last reply row is repainted (the answer is
 * whole now, so the row that ends it gains its copy button — `settleStream`
 * only covers a turn that stopped while writing; one that ended on a tool
 * call left its last words rendered mid-turn, and mid-turn is exactly when
 * that button is withheld), the id is forgotten only once its events can no
 * longer arrive, and the queue drains on a microtask rather than here: every
 * caller is in the middle of closing a turn out, and starting the next one
 * from inside that would have the two overlap in the same run.
 *
 * @param {Run} run
 * @param {object} hooks
 * @param {(run: Run) => void} hooks.settleThinking
 * @param {(run: Run) => void} hooks.settleStream
 * @param {(run: Run) => void} hooks.settleSteps
 * @param {(run: Run) => void} hooks.repaintEnded
 * @param {(id: string) => void} hooks.forget
 * @param {(run: Run) => void} hooks.drain
 */
export function settleRun (run, { settleThinking, settleStream, settleSteps, repaintEnded, forget, drain }) {
  run.busy = false
  settleThinking(run)
  settleStream(run)
  settleSteps(run)
  repaintEnded(run)
  const ending = ownTurn(run)
  // The id is only of interest while its events can still arrive.
  if (ending?.id) forget(ending.id)
  run.turn = null
  queueMicrotask(() => drain(run))
}
