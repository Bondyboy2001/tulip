'use strict'

/* ======================================================= our own writes

   The vault watcher sees every write, the app's own autosaves included, and
   has to tell those apart from the outside world's — an external edit wakes
   the merge path, while a self-write that did the same would put the merge
   panel up against the reader's own keystrokes.

   The old test was a clock: a path written in the last half second was ours.
   That is exactly the window in which a sync client *reacts* to the write —
   pulls the other side's version over it — and the event for that arrived
   to a stamp that said "ours" and was dropped. The next autosave then
   overwrote the other side without anyone being asked.

   So a write that knows what it produced says so: `writeAtomic` reads the
   finished file's mtime and size off the handle it holds, and an event is
   taken for ours only while the file on disk is still that file. A rename,
   a delete or a temp file has no such stamp and keeps the clock, which is the
   most that can be known about them. */

const fsSync = require('node:fs')
const path = require('node:path')

const SELF_WRITE_MS = 500

/**
 * @param {{ rootFor: () => string|null, now?: () => number, statSync?: typeof fsSync.statSync }} deps
 */
function makeSelfWrites ({ rootFor, now = Date.now, statSync = fsSync.statSync }) {
  /** @type {Map<string, {at: number, stamp: {mtimeMs: number, size: number}|null}>} */
  const writes = new Map()

  /** Record that Tulip just wrote `key` (vault-relative, forward slashes).
   *  @param {string} key
   *  @param {{mtimeMs: number, size: number}|null} [stamp] */
  function note (key, stamp = null) {
    const at = now()
    for (const [other, entry] of writes) if (at - entry.at > SELF_WRITE_MS) writes.delete(other)
    writes.set(key, { at, stamp: stamp && typeof stamp.mtimeMs === 'number' ? stamp : null })
  }

  /** Whether a watcher event for `key` is one of ours. */
  function isOurs (key) {
    const entry = writes.get(key)
    if (!entry) return false
    if (now() - entry.at > SELF_WRITE_MS) return false
    if (!entry.stamp) return true
    const root = rootFor()
    if (!root) return true
    let stat
    try { stat = statSync(path.join(root, key)) } catch {
      /* Not there: the rename is in flight, or the file was removed — the
         removal is its own event under its own name, so this one is ours. */
      return true
    }
    if (stat.mtimeMs === entry.stamp.mtimeMs && stat.size === entry.stamp.size) return true
    /* Somebody else has written it since. Forget ours, so nothing later in
       the window is mistaken for it either. */
    writes.delete(key)
    return false
  }

  return { note, isOurs, clear: () => writes.clear() }
}

module.exports = { makeSelfWrites, SELF_WRITE_MS }
