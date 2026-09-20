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

   The sidecar. A save that knows which keys moved does not pay to serialize
   the ones that did not: it appends one JSON line per key to `<file>.delta`
   — `["key", entry]` to upsert, `["key", null]` to forget — and the next
   load replays the lines over the main file, last one winning. Replaying can
   only ever cost a re-read of a note: a stale or out-of-place line is caught
   by the same mtime/size check in `syncIndex` that judges every entry here,
   so it is never a wrong answer. The main file keeps its format untouched —
   an older version of the app reading this directory simply never sees the
   sidecar, and re-reads the notes it misses. A sidecar grown too large stops
   being cheaper than the write it avoids, and the next flush compacts it
   into that write.
*/

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { makeCoalescedWriter } = require('./atomic-store')

/* Bumped when the shape of an entry changes. A cache from an older version is
   dropped whole rather than migrated: it can always be rebuilt from the vault
   in the time one search takes, and a migration is code that can be wrong.
   The sidecar changes none of this — it is not a new format, just a journal
   of the same four fields the file already holds. */
const VERSION = 2

/* Past this, writing and reading the cache stops being cheaper than reading the
   notes. Measured against the serialized form, which is what the disk sees. */
const MAX_CACHE_BYTES = 64 * 1024 * 1024

/* The sidecar's budget. An append that would grow it past this has stopped
   being cheaper than the write it avoids — and replaying it at launch would
   cost what the cache costs — so it compacts into a full write instead. The
   same number, halved, is also the largest entry worth a line of its own: a
   note past that appended whole is a full write wearing a smaller file's
   name. */
const DELTA_MAX_BYTES = 4 * 1024 * 1024

const fileFor = (dir, vaultPath) =>
  path.join(dir, `${crypto.createHash('sha1').update(vaultPath).digest('hex').slice(0, 16)}.json`)

/**
 * A cache of note text for one vault, kept in `dir`.
 *
 * @param dir        where cache files live — main passes a folder under userData
 * @param vaultPath  the absolute vault path, which names the file
 */
/* How long the index has to have been still before it is written, and how
   long a write may be put off while it keeps moving. The writer below
   coalesces a synchronous burst and nothing longer: a sync client landing a
   file every second, or an agent writing one per tool call, had the whole
   vault serialized and fsynced once per file. The cache is a boot
   accelerator; a write that is a few seconds late costs nothing, and one
   lost with the process costs a re-read of the notes it missed. */
const QUIET_MS = 2000
const MAX_WAIT_MS = 20_000

function makeIndexCache ({ dir, vaultPath, quietMs = QUIET_MS, maxWaitMs = MAX_WAIT_MS, deltaMaxBytes = DELTA_MAX_BYTES }) {
  const target = fileFor(dir, vaultPath)
  /* The journal beside the file — see the header. Named from the same hash,
     so it belongs to exactly the vault its neighbour does. */
  const deltaTarget = `${target}.delta`
  const writer = makeCoalescedWriter()
  let lastWrite = Promise.resolve()
  /* Every fs op this module does goes through this one chain. The writer's
     own lane only serializes what it is asked for, and the sidecar's appends
     and removals bypass it — so without a shared queue an append could land
     between a full write's rename and its removal of the very file the
     append was writing to. */
  let writing = Promise.resolve()
  const enqueue = (op) => {
    const run = writing.then(() => op())
    /* The chain swallows failures: an op that failed still ran, and what
       waits behind it waits on it having run, not on it having worked. */
    writing = run.catch(() => {})
    return run
  }

  /* What a full write puts down, planned rather than serialized: the size
     estimate `save` reports, the over-budget trimming, and the lazy body the
     writer calls only once a write really happens. A delta save keeps the
     same plan against the day its sidecar has to compact into the write it
     was avoiding. */
  const planFull = (entries) => {
    /* Sized by adding up, not by serializing to find out. The old way built
       the whole body here, synchronously, on every sync of the index — a
       `JSON.stringify` of every note in the vault, on the main process, to
       learn a length — and then handed a closure returning that body to a
       writer whose entire purpose is to serialize lazily and once per burst.
       The estimate is an upper bound on what JSON adds per entry (the key,
       the field names, the quoting); the text dominates and is exact. */
    const cost = (key, entry) => key.length + entry.name.length + entry.text.length + 80
    let estimate = 0
    for (const [key, entry] of entries) estimate += cost(key, entry)

    /* What the serializer will walk: the live map, unless the estimate is
       over budget and it becomes the survivors of the drop below. */
    let source = entries
    let dropped = 0
    if (estimate > MAX_CACHE_BYTES) {
      /* Over budget, the old behaviour was to skip the write and leave any
         existing file in place — which silently froze the cache at whatever
         launch last fit, forever. Dropping the largest notes instead keeps
         the cache alive for the rest of the vault: a dropped note is not a
         wrong answer, it is one re-read on the first search, the same as any
         mtime mismatch. Largest first because one 4MB note costs the budget
         of a thousand ordinary ones. */
      source = [...entries]
      source.sort((a, b) => b[1].text.length - a[1].text.length)
      while (source.length && estimate > MAX_CACHE_BYTES) {
        const drop = Math.max(1, Math.ceil(source.length * 0.1))
        const removed = source.splice(0, drop)
        for (const [key, entry] of removed) estimate -= cost(key, entry)
        dropped += removed.length
      }
      if (!source.length) return null
    }

    /* The four-field clone is deferred to the serializer rather than done in
       `save` above: it is work for a write that actually happens, and the
       writer coalesces bursts, so a save another save replaces before the
       flush used to pay to memoise a body nobody ever serialized.

       Only the four fields `load` will accept. The in-memory index picks up
       ride-along fields over a session — search writes `kind` and `fileTags`
       onto entries, alias resolution writes `aliases` — and serializing those
       put bytes on disk that the load path immediately threw away. */
    const serialize = () => {
      const kept = []
      for (const [key, entry] of source) {
        kept.push([key, { name: entry.name, text: entry.text, mtime: entry.mtime, size: entry.size }])
      }
      return JSON.stringify({
        version: VERSION,
        vaultPath,
        at: Date.now(),
        entries: Object.fromEntries(kept)
      })
    }
    return { serialize, estimate, dropped }
  }

  /* The two shapes a flush takes.

     Full: the body atomically renamed in, and only then the sidecar removed.
     The order is the safety — a crash between them this way replays a stale
     delta onto a file already newer than it, a re-read per line and never a
     wrong answer, where the other order loses changes the delta was still
     the only copy of. */
  const writeFull = (current) =>
    /* Atomic still — temp file and rename — but deliberately not fsynced:
       the module contract is that a lost cache costs a slower first search,
       and the whole point of writing it is to be quick. */
    writer.flush(target, current.serialize, { durable: false })
      .then(() => fs.rm(deltaTarget, { force: true }))

  /* Delta: one JSONL line per changed key, appended. The values are read off
     `current.entries` now — the map is live, so a key whose note moved again
     since its save writes its newest text, and one the map no longer holds
     writes a tombstone. A crash mid-append can tear the last line; load
     parses each line on its own and skips what will not parse. */
  const appendDelta = async (current) => {
    /* A sidecar that has grown to the size of the write it avoids stops being
       the cheap option, so it compacts the way a log does: the changes it
       carried become the next full write. */
    const stat = await fs.stat(deltaTarget).catch(() => null)
    if (stat && stat.size > deltaMaxBytes) return writeFull(current)
    const lines = []
    for (const key of current.changed || []) {
      const entry = current.entries.get(key)
      /* The same four fields the full body writes — the only four `load`
         accepts. Absent from the map means deleted: the line is a tombstone
         and replaying it forgets the key. */
      lines.push(JSON.stringify(entry
        ? [key, { name: entry.name, text: entry.text, mtime: entry.mtime, size: entry.size }]
        : [key, null]))
    }
    await fs.mkdir(path.dirname(deltaTarget), { recursive: true })
    await fs.appendFile(deltaTarget, `${lines.join('\n')}\n`, 'utf8')
  }

  /* The write waiting out its quiet period: the timer, the shape the flush
     will take — a `changed` key set means an append, and `serialize` is kept
     regardless because it is also what a compaction falls back to — when the
     wait began, and the promise `idle` hands out for it. */
  /** @type {{ serialize: () => string, changed: Set<string> | null, entries: Map<string, any>, settle: () => void, since: number, timer: any, done: Promise<void> } | null} */
  let pending = null
  const flushPending = () => {
    const current = pending
    if (!current) return
    clearTimeout(current.timer)
    pending = null
    enqueue(() => current.changed ? appendDelta(current) : writeFull(current))
      .catch(() => {})
      .then(() => current.settle())
  }
  /** @param {{ serialize: () => string, changed: Set<string> | null, entries: Map<string, any> }} job */
  const schedule = (job) => {
    let current = pending
    if (!current) {
      let settle = () => {}
      /** @type {Promise<void>} */
      const done = new Promise((resolve) => { settle = () => resolve() })
      current = { ...job, settle, since: Date.now(), timer: null, done }
      pending = current
      lastWrite = done
    } else {
      /* A burst becomes one flush. Two delta saves merge their key sets —
         the map the lines are read off is live, so the union still writes
         each key's newest text — while a full save anywhere in the burst
         makes the flush a full write: it already says everything the
         sidecar would. Either way the newest save's serializer is the one
         that stands. */
      if (current.changed && job.changed) {
        for (const key of job.changed) current.changed.add(key)
      } else {
        current.changed = null
      }
      current.serialize = job.serialize
      current.entries = job.entries
      clearTimeout(current.timer)
    }
    const waited = Date.now() - current.since
    const delay = Math.max(0, Math.min(quietMs, maxWaitMs - waited))
    current.timer = setTimeout(flushPending, delay)
    return current.done
  }

  return {
    /* The file this vault's cache lives in, so a caller can say where — and so
       the tests have something to look at. */
    path: target,

    /**
     * What was cached last time, as a Map ready to be validated entry by entry.
     * Empty for anything that is not a cache this version wrote: a missing
     * file, an unparseable one, one belonging to another vault, one from an
     * older shape. Whatever the sidecar has to say lands on top, line by line.
     */
    async load () {
      /** @type {any} */
      let parsed = null
      try {
        parsed = JSON.parse(await fs.readFile(target, 'utf8'))
      } catch {
        /* Missing or unreadable, which is the ordinary state on a first run
           and is not worth distinguishing from a corrupt one — and not worth
           skipping the sidecar over either, since it may still be this
           vault's own. The replay below runs on an empty base. */
      }

      /* The filename is a hash and hashes collide in principle; the path is
         written into the file so that a collision is a miss and not a vault
         reading another vault's notes. The check covers the sidecar too: a
         file naming another path means the delta beside it is that vault's
         as well, and neither is read. */
      if (parsed && parsed.vaultPath && parsed.vaultPath !== vaultPath) return new Map()

      const out = new Map()
      if (parsed?.version === VERSION && parsed.entries && typeof parsed.entries === 'object') {
        for (const [key, entry] of Object.entries(parsed.entries)) {
          /* Shape-checked one at a time. A single mangled entry costs one
             note a re-read; letting it through would put a `undefined` where
             the search expects a string. */
          if (typeof entry?.name !== 'string') continue
          if (typeof entry.text !== 'string') continue
          if (typeof entry.mtime !== 'number' || typeof entry.size !== 'number') continue
          out.set(key, { name: entry.name, text: entry.text, mtime: entry.mtime, size: entry.size })
        }
      }

      /* Then the lines saved since that file was written, replayed in order
         so the newest wins. Each parses on its own — a crash mid-append can
         tear the tail, and one malformed line costs its own entry, never the
         lines that landed before it. A null forgets the key; an entry faces
         the same shape check the main file's did. */
      /** @type {string | null} */
      let delta = null
      try {
        delta = await fs.readFile(deltaTarget, 'utf8')
      } catch {
        /* No sidecar, or one that cannot be read — the main file alone is a
           fine place to start. */
      }
      if (delta) {
        for (const line of delta.split('\n')) {
          if (!line) continue
          let change
          try { change = JSON.parse(line) } catch { continue }
          if (!Array.isArray(change)) continue
          const [key, entry] = change
          if (typeof key !== 'string') continue
          if (entry === null) { out.delete(key); continue }
          if (typeof entry?.name !== 'string') continue
          if (typeof entry.text !== 'string') continue
          if (typeof entry.mtime !== 'number' || typeof entry.size !== 'number') continue
          out.set(key, { name: entry.name, text: entry.text, mtime: entry.mtime, size: entry.size })
        }
      }
      return out
    },

    /**
     * Write the index out. Coalesced, because a vault being watched can settle
     * several times in a second and none of those passes is worth a write of
     * its own.
     *
     * `changedKeys` — the keys of `entries` that moved since the last flush —
     * is what lets a save be cheap: known, the change goes to the sidecar as
     * one line per key and the vault's bytes stay where they lie. Two kinds
     * of change make the sidecar the wrong tool and take the ordinary path:
     * one naming most of the vault, where a line per key is a serialize in
     * disguise, and one carrying an entry past half the sidecar's budget,
     * where the append is a full write wearing a smaller file's name.
     *
     * Returns what was decided, so the caller can log it: `{ written }` with
     * the byte count, or `{ skipped: 'too large' }`.
     *
     * @param {Map<string, any>} entries  the live index — read at flush time,
     *   so what lands is the newest text, not what `save` saw
     * @param {Iterable<string> | null} [changedKeys]  what moved, if known
     */
    save (entries, changedKeys = null) {
      if (changedKeys != null) {
        const changed = new Set(changedKeys)
        /* Nothing moved is nothing to write — not even a scheduling. */
        if (!changed.size) return { written: 0 }
        let deltaOk = changed.size <= entries.size / 2
        if (deltaOk) {
          for (const key of changed) {
            const entry = entries.get(key)
            if (entry && entry.text.length > deltaMaxBytes / 2) { deltaOk = false; break }
          }
        }
        if (deltaOk) {
          /* The full plan rides along unused unless the sidecar ever has to
             compact into the write it was avoiding — and if the vault is past
             caching at all, a sidecar is not the place to keep it either. */
          const plan = planFull(entries)
          if (!plan) return { skipped: 'too large' }
          /* What the append will cost, for the same log `written` has always
             fed: a line per key — the entry's bytes, or the few a tombstone
             takes when the map no longer holds it. */
          let estimate = 0
          for (const key of changed) {
            const entry = entries.get(key)
            estimate += key.length + (entry ? entry.name.length + entry.text.length + 60 : 8)
          }
          schedule({ serialize: plan.serialize, changed, entries })
          return { written: estimate }
        }
      }
      const plan = planFull(entries)
      if (!plan) return { skipped: 'too large' }
      /* Not awaited by the caller — see the call site in `syncIndex` — but the
         promise is answered here so a rejection is not an unhandled one. A
         cache that failed to write is a slower first search next time and
         nothing else. Serialized by the writer, when it writes: a burst of
         syncs pays for one body, not one each. */
      schedule({ serialize: plan.serialize, changed: null, entries })
      return plan.dropped ? { written: plan.estimate, dropped: plan.dropped } : { written: plan.estimate }
    },

    /** Write what is waiting now rather than after the quiet period — for
     *  quitting. Settles when it has landed. */
    flush () {
      flushPending()
      return lastWrite
    },

    /** Settles when the last save has reached the disk — for the tests, which
     *  read the file back and used to guess at how long that takes. */
    idle: () => lastWrite,

    /** Forget this vault's cache entirely — file and sidecar. */
    async clear () {
      /* A save still waiting out its quiet period would fire after the rm and
         put the cache straight back, so the pending flush is cancelled first —
         its `done` settles unanswered, which is fine: nothing awaits it that
         is not also being torn down. */
      if (pending) {
        clearTimeout(pending.timer)
        pending.settle()
        pending = null
      }
      await enqueue(async () => {
        await fs.rm(target, { force: true }).catch(() => {})
        await fs.rm(deltaTarget, { force: true }).catch(() => {})
      })
    }
  }
}

module.exports = { makeIndexCache, MAX_CACHE_BYTES, DELTA_MAX_BYTES }
