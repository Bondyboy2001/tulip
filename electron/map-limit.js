'use strict'

/* The bounded parallel map the vault walk, the index and the run-page sweep
   all share. Its own module so that anything lifted out of `main.js` can keep
   using it rather than growing a second copy — see electron/run-pages.js. */

/**
 * `fn` over every item, at most `limit` of them in flight, answered in the
 * order the items came in however the work happens to finish.
 *
 * Bounded rather than a bare `Promise.all`: every use of this is a `readdir`,
 * a `stat`, or a `read`, and a large vault asking the OS for one descriptor per
 * note at the same moment is how a walk turns into EMFILE.
 *
 * The order is not a nicety. The vault scan feeds the attachment list, which is
 * turned into a key and compared against the last one to decide whether
 * anything moved — an order that varied run to run would report a change on
 * every tick and undo the very guard it feeds.
 */
const WALK_LIMIT = 32

async function mapLimit (items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next++
      out[at] = await fn(items[at], at)
    }
  })
  await Promise.all(workers)
  return out
}

module.exports = { mapLimit, WALK_LIMIT }
