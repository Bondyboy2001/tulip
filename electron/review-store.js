/* ============================================================ review store
   What the scheduler remembers between sessions.

   In the vault, not beside the app: this is the reader's own work. Months of
   review history is worth more than the notes it is about — a vocabulary list
   can be retyped in an afternoon, and a year of knowing when to show each word
   cannot — so it belongs wherever the notes are backed up and synced to, under
   `.tulip/`, which the vault walk skips for the same reason it skips
   `.attachments`.

   Two files, because they answer different questions:

     review.json   the current state of every card, rewritten whole
     reviews.jsonl one line per answer, only ever appended

   The state file holds latest values only, so it cannot say how many cards were
   reviewed last Tuesday or whether recall is improving. The log can, costs a
   line per answer, and is never rewritten — which also makes it the record of
   last resort if the state file is ever lost.

   ⚠️ The wipe this file exists to prevent. An earlier version of this idea, in
   the Swift app, dropped state for any card a scan did not find and wrote the
   result immediately. An empty scan — an unmounted volume, iCloud placeholders
   not yet downloaded, a permission prompt still open, a vault switched
   mid-scan — therefore overwrote the file with nothing and destroyed every
   card's history, with no undo. `prune` below refuses an empty scan and refuses
   one that would drop more than a fifth of what it knows, and says so rather
   than doing it quietly. Deleting a note is not a prune and goes through
   `remove`, which is deliberate and unguarded.
   ================================================================== */

const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')

/** Everything Tulip keeps inside a vault that is not a note. */
const STATE_DIR = '.tulip'
const STATE_FILE = 'review.json'
const LOG_FILE = 'reviews.jsonl'

/* A prune that would drop more of the deck than this is refused. Chosen to be
   generous — deleting a fifth of a vocabulary list in one sitting is a thing
   somebody might really do, and anything larger is far more likely to be a
   vault that is not all there yet. */
const MAX_PRUNE_FRACTION = 0.2

/* A log this big is read at launch and appended to all day; past this it is
   rolled once rather than growing without end. Around a hundred thousand
   answers, which is years of daily review. */
const MAX_LOG_BYTES = 8 * 1024 * 1024

/**
 * A card's identity: which note it came from, which term, and which way round
 * it is being asked.
 *
 * The direction is part of it because recognising a word and producing it are
 * genuinely different pieces of knowledge that are learned at different rates —
 * so they schedule separately, and one being easy must not hide the other being
 * hard. The note's path is vault-relative so that the whole store travels with
 * the vault.
 */
const cardId = (notePath, term, direction) => `${notePath}|${term}|${direction}`

/** Split an id back into its parts, tolerating a term containing a bar. */
function splitId (id) {
  const first = String(id).indexOf('|')
  const last = String(id).lastIndexOf('|')
  if (first < 0 || last <= first) return null
  return {
    path: id.slice(0, first),
    term: id.slice(first + 1, last),
    direction: id.slice(last + 1)
  }
}

function makeStore ({ vault }) {
  const dir = () => path.join(vault(), STATE_DIR)
  const stateFile = () => path.join(dir(), STATE_FILE)
  const logFile = () => path.join(dir(), LOG_FILE)

  /* Held in memory once read. Every caller wants the whole deck — the queue is
     built by asking which of several hundred cards are due — so there is
     nothing to gain by going back to disk, and a great deal to lose by having
     two readers disagree about what a card's state is. */
  let cards = null
  let loadedFor = null

  async function load () {
    if (cards && loadedFor === vault()) return cards
    cards = {}
    loadedFor = vault()
    let raw
    try {
      raw = await fs.readFile(stateFile(), 'utf8')
    } catch {
      return cards                        // no history yet, which is ordinary
    }
    try {
      const parsed = JSON.parse(raw)
      /* Two-part ids come from before direction was part of a card's identity;
         they meant the recognition card, so that is what they become. */
      for (const [id, state] of Object.entries(parsed?.cards || {})) {
        const key = splitId(id) ? id : `${id}|f`
        if (state && typeof state === 'object') cards[key] = state
      }
    } catch (err) {
      /* Unreadable, which for this file is the serious case: writing over it
         would finish the job. It is moved aside intact so the history can still
         be recovered by hand, and the log beside it is untouched regardless. */
      console.error('review state unreadable', err)
      await fs.rename(stateFile(), `${stateFile()}.corrupt`).catch(() => {})
    }
    return cards
  }

  /** The whole deck to disk, atomically and durably. */
  async function flush () {
    await fs.mkdir(dir(), { recursive: true })
    const body = JSON.stringify({ version: 1, cards: cards || {} }, null, 1)
    const tmp = `${stateFile()}.${process.pid}.tmp`
    /* Written through a temp file and renamed, the way notes are: a review
       state half-written over by a crash would lose the deck, and the rename
       makes it either the old file or the new one. Durable, unlike the chat
       log — this is the reader's work, not a transcript of it. */
    const handle = await fs.open(tmp, 'w')
    try {
      await handle.writeFile(body, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, stateFile())
  }

  return {
    load,

    /** Every card's state, as a plain object the renderer can hold. */
    async all () {
      return { ...(await load()) }
    },

    /**
     * Record the answers of a session: the new state of each card, and a line
     * per answer in the log.
     *
     * Taken as a batch rather than one at a time because a review session is a
     * burst — twenty answers in three minutes — and each one would otherwise be
     * an fsync of the whole deck.
     */
    async record (entries) {
      const list = Array.isArray(entries) ? entries : []
      if (!list.length) return { ok: true, written: 0 }
      await load()

      const lines = []
      for (const entry of list) {
        if (!entry?.id || !entry.state) continue
        cards[entry.id] = entry.state
        lines.push(JSON.stringify({
          id: entry.id,
          at: entry.at || Date.now(),
          grade: entry.grade || 0,
          due: entry.state.due || 0,
          // What the card knew at the moment it was answered, so the log can
          // reconstruct a curve the state file has long since moved past.
          stability: entry.state.stability || 0,
          difficulty: entry.state.difficulty || 0
        }))
      }

      await flush()
      /* The log is appended after the state is safely down. If the append
         fails, the schedule is still correct and only the statistics lose a
         line — the other order would risk the reverse, which matters more. */
      try {
        await fs.mkdir(dir(), { recursive: true })
        await rollLogIfHuge()
        await fs.appendFile(logFile(), lines.join('\n') + '\n', 'utf8')
      } catch (err) {
        console.error('review log append failed', err)
      }
      return { ok: true, written: lines.length }
    },

    /**
     * Forget the cards of a note that has been deleted.
     *
     * Unguarded, unlike `prune`: this is somebody saying "that note is gone",
     * not a scan concluding it. Also used when a note is emptied of its table.
     */
    async remove (notePath) {
      await load()
      const prefix = `${notePath}|`
      let dropped = 0
      for (const id of Object.keys(cards)) {
        if (id.startsWith(prefix) || id.startsWith(`${notePath}/`)) {
          delete cards[id]
          dropped++
        }
      }
      if (dropped) await flush()
      return { dropped }
    },

    /**
     * Follow a note that has been renamed or moved.
     *
     * Without this a rename resets every card in the table to never-seen, which
     * is the same loss as deleting the history and harder to notice — the words
     * are all still there, and only the schedule has been thrown away.
     */
    async relocate (from, to) {
      await load()
      let moved = 0
      for (const id of Object.keys(cards)) {
        const parts = splitId(id)
        if (!parts) continue
        const isFile = parts.path === from
        const isInFolder = parts.path.startsWith(`${from}/`)
        if (!isFile && !isInFolder) continue
        const nextPath = isFile ? to : to + parts.path.slice(from.length)
        const nextId = cardId(nextPath, parts.term, parts.direction)
        cards[nextId] = cards[id]
        delete cards[id]
        moved++
      }
      if (moved) await flush()
      return { moved }
    },

    /**
     * Drop state for cards no longer in any table — refusing when the scan
     * looks like it failed rather than like the deck really shrank.
     *
     * @param {string[]} knownIds every card the vault currently contains
     */
    async prune (knownIds) {
      await load()
      const ids = Object.keys(cards)
      if (!ids.length) return { pruned: 0, refused: false }

      const known = new Set(Array.isArray(knownIds) ? knownIds : [])
      // An empty scan is never trustworthy: a vault with cards in it that
      // suddenly reports none has not been emptied, it has failed to be read.
      if (!known.size) {
        return { pruned: 0, refused: true, reason: 'the vault reported no cards at all' }
      }

      const doomed = ids.filter((id) => !known.has(id))
      if (!doomed.length) return { pruned: 0, refused: false }

      const fraction = doomed.length / ids.length
      if (fraction > MAX_PRUNE_FRACTION) {
        return {
          pruned: 0,
          refused: true,
          reason: `it would forget ${doomed.length} of ${ids.length} cards`
        }
      }

      for (const id of doomed) delete cards[id]
      await flush()
      return { pruned: doomed.length, refused: false }
    },

    /** Every answer ever given, newest last, for the statistics. */
    async history (limit = 20000) {
      let raw
      try { raw = await fs.readFile(logFile(), 'utf8') } catch { return [] }
      const out = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try { out.push(JSON.parse(line)) } catch { /* a torn last line */ }
      }
      return out.slice(-limit)
    }
  }

  /* Rolled rather than trimmed: the old file keeps its name with `.1` on the
     end, so nothing is thrown away and the reader can still add it up by hand.
     Only ever one generation back — this is a safety net, not an archive. */
  async function rollLogIfHuge () {
    let size = 0
    try { size = fsSync.statSync(logFile()).size } catch { return }
    if (size < MAX_LOG_BYTES) return
    await fs.rename(logFile(), `${logFile()}.1`).catch(() => {})
  }
}

module.exports = { makeStore, cardId, splitId, STATE_DIR }
