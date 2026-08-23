'use strict'

/* ======================================================= vault index cache
   The search index, kept between launches.

   `syncIndex` in main holds every note's text in memory, keyed by path and
   validated against the file's mtime and size. Within a session that is a good
   cache: the second search costs nothing. Across sessions it was no cache at
   all — the Map died with the process, so the first search after every launch,
   and the copilot's first turn, read the whole vault off disk again.

   This writes that Map out and reads it back. What it is NOT is a second source
   of truth: nothing here is ever trusted on its own. Every entry is still
   checked against the real file the way an in-memory one is, by mtime and size,
   and a mismatch means the note is re-read. The cache can therefore be deleted,
   truncated, corrupted or left over from a version that wrote it differently,
   and the worst outcome is a slower first search.

   ⚠️ The failure worth naming. A stale entry that is *believed* is a note whose
   text search looks in but which no longer says that — a note quietly missing
   from a result list that still looks complete. That is why validation stays
   where it was, in the caller, and why this module holds no logic beyond
   reading and writing a file. The only assumption added over the in-memory
   version is that a file which changed also changed its mtime or its size, and
   that assumption was already being made.

   Beside the app, not in the vault: a cache is not the reader's work, it is
   derived from it, and a vault carried to another machine should not arrive
   carrying a copy of itself. One file per vault, named by a hash of its path.

   Sized rather than unbounded. A vault of ordinary notes comes to a few
   megabytes; a vault that would not is one where reading the cache costs as
   much as reading the notes, and the answer there is to keep no cache at all
   rather than a large one.
*/

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { makeCoalescedWriter } = require('./atomic-store')

/* Bumped when the shape of an entry changes. A cache from an older version is
   dropped whole rather than migrated: it can always be rebuilt from the vault
   in the time one search takes, and a migration is code that can be wrong. */
const VERSION = 2

/* Past this, writing and reading the cache stops being cheaper than reading the
   notes. Measured against the serialized form, which is what the disk sees. */
const MAX_CACHE_BYTES = 64 * 1024 * 1024

const fileFor = (dir, vaultPath) =>
  path.join(dir, `${crypto.createHash('sha1').update(vaultPath).digest('hex').slice(0, 16)}.json`)

/**
 * A cache of note text for one vault, kept in `dir`.
 *
 * @param dir        where cache files live — main passes a folder under userData
 * @param vaultPath  the absolute vault path, which names the file
 */
function makeIndexCache ({ dir, vaultPath }) {
  const target = fileFor(dir, vaultPath)
  const writer = makeCoalescedWriter()

  return {
    /* The file this vault's cache lives in, so a caller can say where — and so
       the tests have something to look at. */
    path: target,

    /**
     * What was cached last time, as a Map ready to be validated entry by entry.
     * Empty for anything that is not a cache this version wrote: a missing
     * file, an unparseable one, one belonging to another vault, one from an
     * older shape.
     */
    async load () {
      let parsed
      try {
        parsed = JSON.parse(await fs.readFile(target, 'utf8'))
      } catch {
        /* Missing or unreadable, which is the ordinary state on a first run
           and is not worth distinguishing from a corrupt one: both mean there
           is nothing to start from. */
        return new Map()
      }

      if (parsed?.version !== VERSION) return new Map()
      /* The filename is a hash and hashes collide in principle; the path is
         written into the file so that a collision is a miss and not a vault
         reading another vault's notes. */
      if (parsed.vaultPath !== vaultPath) return new Map()
      if (!parsed.entries || typeof parsed.entries !== 'object') return new Map()

      const out = new Map()
      for (const [key, entry] of Object.entries(parsed.entries)) {
        /* Shape-checked one at a time. A single mangled entry costs one note a
           re-read; letting it through would put a `undefined` where the search
           expects a string. */
        if (typeof entry?.name !== 'string') continue
        if (typeof entry.text !== 'string') continue
        if (typeof entry.mtime !== 'number' || typeof entry.size !== 'number') continue
        out.set(key, { name: entry.name, text: entry.text, mtime: entry.mtime, size: entry.size })
      }
      return out
    },

    /**
     * Write the index out. Coalesced, because a vault being watched can settle
     * several times in a second and none of those passes is worth a write of
     * its own.
     *
     * Returns what was decided, so the caller can log it: `{ written }` with
     * the byte count, or `{ skipped: 'too large' }`.
     */
    save (entries) {
      /* Only the four fields `load` will accept. The in-memory index picks up
         ride-along fields over a session — search writes `kind` and `fileTags`
         onto entries, alias resolution writes `aliases` — and serializing those
         put bytes on disk that the load path immediately threw away. */
      const kept = []
      for (const [key, entry] of entries) {
        kept.push([key, { name: entry.name, text: entry.text, mtime: entry.mtime, size: entry.size }])
      }

      const serialize = () => JSON.stringify({
        version: VERSION,
        vaultPath,
        at: Date.now(),
        entries: Object.fromEntries(kept)
      })

      /* Sized by adding up, not by serializing to find out. The old way built
         the whole body here, synchronously, on every sync of the index — a
         `JSON.stringify` of every note in the vault, on the main process, to
         learn a length — and then handed a closure returning that body to a
         writer whose entire purpose is to serialize lazily and once per burst.
         The estimate is an upper bound on what JSON adds per entry (the key,
         the field names, the quoting); the text dominates and is exact. */
      const cost = ([key, entry]) => key.length + entry.name.length + entry.text.length + 80
      let estimate = 0
      for (const item of kept) estimate += cost(item)
      let dropped = 0
      if (estimate > MAX_CACHE_BYTES) {
        /* Over budget, the old behaviour was to skip the write and leave any
           existing file in place — which silently froze the cache at whatever
           launch last fit, forever. Dropping the largest notes instead keeps
           the cache alive for the rest of the vault: a dropped note is not a
           wrong answer, it is one re-read on the first search, the same as any
           mtime mismatch. Largest first because one 4MB note costs the budget
           of a thousand ordinary ones. */
        kept.sort((a, b) => b[1].text.length - a[1].text.length)
        while (kept.length && estimate > MAX_CACHE_BYTES) {
          const drop = Math.max(1, Math.ceil(kept.length * 0.1))
          for (const item of kept.splice(0, drop)) estimate -= cost(item)
          dropped += drop
        }
        if (!kept.length) return { skipped: 'too large' }
      }
      /* Not awaited by the caller — see the call site in `syncIndex` — but the
         promise is answered here so a rejection is not an unhandled one. A
         cache that failed to write is a slower first search next time and
         nothing else. Serialized by the writer, when it writes: a burst of
         syncs pays for one body, not one each. */
      writer.flush(target, serialize).catch(() => {})
      return dropped ? { written: estimate, dropped } : { written: estimate }
    },

    /** Forget this vault's cache entirely. */
    async clear () {
      await fs.rm(target, { force: true }).catch(() => {})
    }
  }
}

module.exports = { makeIndexCache, MAX_CACHE_BYTES }
