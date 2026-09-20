'use strict'

/* ------------------------------------------------------------- review sink

   The bookkeeping a study session owes the vault: answers are batched rather
   than written one at a time — a reviewer answers faster than a durable write
   settles, and the store collapses a burst into one pass anyway — and the
   batch is flushed as the session goes, because a crash mid-review used to
   lose every answer since it began.

   Extracted from mountLanguageStudy's pending/undone/flush/settle so the
   flashcard queue owes the same discipline without copying it. */

/**
 * @param {object} deps
 * @param {(entries: object[]) => Promise<any>} deps.record   `api.review.record`
 * @param {(entry: object) => Promise<any>} [deps.unrecord]   `api.review.unrecord`
 * @param {number} [deps.delay]  the coalescing pause — 400ms matches the
 *   language session's
 */
export function makeReviewSink ({ record, unrecord, delay = 400 }) {
  /** Entries answered since the last write. */
  const pending = []
  /** Entries taken back — undo can land while a batch is still in flight. */
  const undone = new Set()
  /** @type {Promise<any> | null} */
  let flushing = null
  /** @type {any} */
  let timer = null

  async function flush () {
    // An entry undone while it waited — or while an earlier failed write held
    // it — is not owed to anyone.
    const batch = pending.filter((one) => !undone.has(one))
    pending.length = 0
    if (!batch.length) return
    try {
      await record(batch)
    } catch (err) {
      // Put them back, so the next flush — or the one at close — tries again
      // rather than the answers being lost for having been picked up.
      pending.unshift(...batch)
      console.error('recording the review failed', err)
    }
  }

  /* A write is never in flight twice: `flush` empties `pending` before it
     awaits, and a second pass entered meanwhile would hand the store a batch
     the first one is still writing. Chained instead, so an answer given during
     a write is carried by the pass after it. */
  function queueFlush () {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      flushing = (flushing || Promise.resolve()).then(flush, flush)
    }, delay)
  }

  return {
    /** A graded answer: its log row joins the batch and the clock starts. */
    offer (entry) {
      pending.push(entry)
      queueFlush()
    },
    /* Take an answer back wherever it is: still waiting, mid-write, or
       already recorded. Marking covers all three — `flush` skips marked
       entries wherever it finds them, and the store is told to put the card's
       state back in case the write already happened. */
    retract (entry, restore) {
      undone.add(entry)
      const held = pending.indexOf(entry)
      if (held !== -1) pending.splice(held, 1)
      else if (restore) unrecord?.(restore).catch(() => {})
    },
    /** What a last-chance write would carry — for `beforeunload`, which
        cannot await the flush it starts. */
    owed () {
      return pending.filter((one) => !undone.has(one))
    },
    /** Everything owed to the vault, written before this settles. */
    async settle () {
      clearTimeout(timer)
      timer = null
      flushing = (flushing || Promise.resolve()).then(flush, flush)
      await flushing
      // An answer given while that pass was writing leaves a batch behind it.
      if (pending.length) await flush()
    },
    get size () { return pending.length }
  }
}
