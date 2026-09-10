/* The conversations' store: everything filed under a note, kept in memory and
   written to the history file in per-note deltas.

   Split out of src/copilot.js so the persistence contract — what is written,
   when, what survives a failed write, what is let go of under the caps — is
   one module with one set of invariants, testable without a window.

   The panel hands over three facts about itself rather than a share of its
   state: where the write goes (`persist`), which entry is on screen and must
   never be evicted (`keepKey`), and whether a conversation still has a turn
   in flight (`entryBusy`) — the one kind of entry that cannot be let go of,
   because its reply would drop as it arrived. */

import {
  MAX_CHATS, MAX_MESSAGES, MAX_NOTES, VAULT_CHAT, chatKey, gone, newChat, stored
} from './copilot-chat.js'

/* Written on a timer rather than per message — and never on a text delta at
   all: a save per delta would serialise the whole multi-note history every
   800ms for as long as a reply streams. The deltas are picked up at the
   turn's end, at each tool call, and when the window blurs or the note
   switches. */
const SAVE_WAIT = 800
/* A ceiling on the debounce. A turn that calls a tool every half second used
   to push the write out ahead of itself for the whole turn, so a transcript
   minutes long existed nowhere but in this window until the turn ended. */
const SAVE_CEILING = 5000

/**
 * @typedef {import('./copilot-chat.js').Convo} Convo
 * @typedef {import('./copilot-chat.js').Message} Message
 */

/**
 * @param {object} args
 * @param {(payload: { notes: Record<string, any>, remove: string[] }) => Promise<any>} args.persist
 *   The bridge's `ai.history.save` — which merges per-note deltas into what is
 *   already on disk.
 * @param {() => string} args.keepKey The chat key on screen; never evicted.
 * @param {(entry: any) => boolean} args.entryBusy Whether any of an entry's
 *   conversations has a turn in flight.
 * @param {(err: unknown, unloading: boolean) => void} [args.onWriteError]
 */
export function createStore ({ persist, keepKey, entryBusy, onWriteError }) {
  /** note path -> { at, active, convos: Convo[] } */
  const chats = new Map()

  /* Which notes have said something since the last write, and which have left.
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
  /** @type {ReturnType<typeof setTimeout> | null} */
  let saveTimer = null
  let saveSince = 0
  let unsaved = false

  /** Everything filed under a note: its conversations, and which one is open.
      @param {string} [path] */
  function entry (path = '') {
    const key = chatKey(path)
    let found = chats.get(key)
    if (!found) {
      const convo = newChat()
      found = { at: convo.at, active: convo.id, convos: [convo] }
      chats.set(key, found)
    }
    return found
  }

  /** The conversation a note has open. @param {string} [path] */
  function convoAt (path = '') {
    const found = entry(path)
    return found.convos.find((c) => c.id === found.active) || found.convos[0]
  }

  /** Replace a note's entry wholesale — the restore path. */
  function setEntry (path, value) {
    if (value) chats.set(path, value)
    else chats.delete(path)
  }

  /** A note has said something; the write is scheduled, not made. */
  function touch (path) {
    unsaved = true
    dirtyNotes.add(chatKey(path))
    if (!saveSince) saveSince = Date.now()
    if (saveTimer) clearTimeout(saveTimer)
    const left = saveSince + SAVE_CEILING - Date.now()
    saveTimer = setTimeout(flush, Math.max(0, Math.min(SAVE_WAIT, left)))
  }

  /**
   * Get what has changed to disk, and say when it is there.
   *
   * Oldest conversations fall off the end rather than accumulating forever —
   * out of memory as well as out of the file. Dropping them from the write
   * alone left every note visited since launch resident for the life of the
   * window, and re-sorted on every save. The two that cannot go are the one on
   * screen and the one a running turn is filing into. Done before the question
   * of whether to write at all: browsing notes with the panel shut makes
   * entries without changing anything worth saving, and those are exactly the
   * ones this is here to let go of.
   *
   * Returned so a caller that can wait — the quit handshake — knows when the
   * transcripts are actually on disk rather than merely asked for.
   *
   * @param {{ unloading?: boolean }} [when]
   */
  function flush ({ unloading = false } = {}) {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    saveSince = 0

    const ranked = [...chats.entries()].filter(([path]) => path)
      .sort((a, b) => b[1].at - a[1].at)
    for (const [path, found] of ranked.slice(MAX_NOTES)) {
      if (path === keepKey()) continue
      if (entryBusy(found)) continue
      chats.delete(path)
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
      const found = chats.get(path)
      /* Gone from memory since — trimmed by the cap above, or renamed away.
         Its absence here is not a reason to take it off disk: the window's
         sixty notes are a working set, not the record. */
      if (!path || !found) continue
      /* An empty chat is launch state, which the restore already refuses to
         read back. Writing one would put it over a real conversation that is
         on disk and no longer in memory — a note revisited after the cap let
         go of it opens a fresh chat, and that fresh chat must not be what
         survives. */
      const convos = found.convos.filter((c) => c.messages.some((m) => m.t === 'you'))
      if (!convos.length) continue
      out[path] = {
        at: found.at,
        active: found.active,
        convos: convos.map((c) => ({
          id: c.id,
          thread: c.thread,
          threadOf: c.threadOf || null,
          used: c.used || 0,
          // Whether that figure is the CLI's own or ours — kept, or a restored
          // chat's reading loses the sign that says nobody vouched for it.
          usedEstimated: !!c.usedEstimated,
          cost: c.cost || 0,
          seed: c.seed || '',
          contextOptions: c.contextOptions,
          interrupted: !!(c.run?.busy || c.run?.stopping),
          // Whether the "getting long" notice has been given — kept, or it is
          // given again on every launch of a chat that has already heard it.
          suggested: !!c.suggested,
          at: c.at,
          messages: c.messages.map(stored)
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
    return persist({ notes: out, remove }).catch((err) => {
      unsaved = true
      // Back on the list, or the next write would report nothing to do and
      // this note's transcript would exist only in the window.
      for (const path of notes) dirtyNotes.add(path)
      for (const path of remove) removedNotes.add(path)
      console.error('saving the copilot history failed', err)
      // During unload there is no window left to show it in, and the console
      // line above is the record.
      onWriteError?.(err, unloading)
    })
  }

  /**
   * A note that has moved, and the conversations about it moving with it.
   *
   * Chats are filed under the note's path — in memory and in the history file
   * — so a rename left every conversation about a note under a name nothing
   * would ask for again: unreachable from the panel, and dropped the next
   * time the history was trimmed to its cap.
   *
   * Something may be filed under the new name already. Usually it is the
   * empty chat the panel opened the instant the renamed note appeared on
   * screen — the rename settles the document before it retraces the paths —
   * and putting the conversation behind that would be a rename that visibly
   * forgets what you were discussing. So an entry nobody has spoken in gives
   * way, and a real one keeps both, its own on screen.
   *
   * The write is per note, so a rename says both halves of what it did: the
   * new name has a conversation to record, and the old one is a file entry
   * nothing will ask for again. Said in that order, and `remove` is applied
   * first on the other side, so a move onto a name that is being written in
   * the same breath cannot delete it.
   *
   * @param {(path: string) => string} moved the renderer's own rule for what
   *   the move did to a path — it already knows that renaming a folder renames
   *   everything under it.
   * @returns {boolean} whether any entry was touched.
   */
  function rename (moved) {
    let touched = false
    for (const path of [...chats.keys()]) {
      // The vault-wide chat is filed under a name no rename can reach, and
      // handing it to the renderer's rule would be asking what a note that
      // does not exist was renamed to.
      if (path === VAULT_CHAT) continue
      const next = moved(path)
      if (next === path) continue
      touched = true
      const found = chats.get(path)
      chats.delete(path)
      const had = chats.get(next)
      const spoken = had?.convos.some((c) => c.messages.some((m) => m.t === 'you'))
      if (!had || !spoken) chats.set(next, found)
      else had.convos.unshift(...found.convos)
      removedNotes.add(path)
      dirtyNotes.add(next)
    }
    if (touched) unsaved = true
    return touched
  }

  /**
   * Settings and stored conversations are applied before the panel is ever
   * opened, so the first thing shown is where the user left off.
   *
   * @param {Record<string, any>} storedNotes the history file's contents
   * @returns {string[]} the keys that were ingested — the caller repaints.
   */
  function ingest (storedNotes) {
    for (const [path, note] of Object.entries(storedNotes || {})) {
      // Files written before a note could hold more than one conversation
      // are a single conversation, and read back as one.
      const saved = Array.isArray(note?.convos)
        ? note.convos
        : [{ thread: note?.thread, at: note?.at, messages: note?.messages }]

      const history = saved
        .filter((c) => Array.isArray(c?.messages))
        .map((c) => {
          /* Older builds saved a cumulative per-turn total as `used` for the
             CLIs that report one. Those copilots are gone; clear the figure on
             read so their chats do not retain a false gauge. A devin chat is
             in the same position — its thread is not one opencode can resume,
             so what that ring said is about a conversation nothing here can
             reopen. */
          const stale = gone.has(c.threadOf)
          return {
            id: c.id || newChat().id,
            thread: c.thread || null,
            threadOf: c.threadOf || null,
            used: stale ? 0 : (c.used || 0),
            usedEstimated: !stale && !!c.usedEstimated,
            cost: stale ? 0 : (c.cost || 0),
            seed: c.seed || '',
            contextOptions: c.contextOptions,
            suggested: !stale && !!c.suggested,
            at: c.at || 0,
            // The cap is applied on the way in as well as on the way out: a
            // file written before it was lowered is trimmed by reading it.
            messages: [...c.messages.slice(-(MAX_MESSAGES - (c.interrupted ? 1 : 0))).map((message) => ({ ...message, live: false })),
              ...(c.interrupted ? [{ t: 'note', text: 'This request was interrupted when Tulip closed. Resume will inspect current files before continuing.', retry: true, resume: true }] : [])]
          }
        })
        // Empty chats are launch state, not history. Dropping them here
        // prevents one blank entry accumulating on every app restart.
        .filter((c) => c.messages.some((message) => message.t === 'you'))
      if (!history.length) continue

      /* Reloading begins with a clean chat for every file while the real
         conversations remain behind /history. The fresh entry is reused until
         the first question, so repeated note switches stay clean. */
      const fresh = newChat()
      const convos = [...history, fresh].slice(-MAX_CHATS)
      chats.set(path, { at: fresh.at, active: fresh.id, convos })
    }
    return [...chats.keys()]
  }

  return {
    chats, entry, convoAt, setEntry, touch, flush, rename, ingest
  }
}
