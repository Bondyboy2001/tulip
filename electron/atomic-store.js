// @ts-check
'use strict'

/* Durable, atomic state writes shared by the small JSON stores.

   Callers hand the coalescer a target and a lazy serializer. Synchronous bursts
   collapse into one write, while a change that arrives during an in-flight
   write is guaranteed a second pass. Unique temporary names keep independent
   flushes from racing each other's rename. */

const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')

let serial = 0
const temporary = (target) => path.join(
  path.dirname(target),
  `.${path.basename(target)}.${process.pid}.${++serial}.tmp`
)

async function syncDirectory (dir) {
  let handle
  try {
    handle = await fs.open(dir, 'r')
    await handle.sync()
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function writeAtomic (target, body, { durable = true } = {}) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = temporary(target)
  let handle
  try {
    handle = await fs.open(tmp, 'wx')
    await handle.writeFile(body, 'utf8')
    if (durable) await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(tmp, target)
    if (durable) await syncDirectory(path.dirname(target)).catch(() => {})
  } catch (err) {
    await handle?.close().catch(() => {})
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

function writeAtomicSync (target, body, { durable = true } = {}) {
  fsSync.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = temporary(target)
  let fd = null
  try {
    fd = fsSync.openSync(tmp, 'wx')
    fsSync.writeFileSync(fd, body, 'utf8')
    if (durable) fsSync.fsyncSync(fd)
    fsSync.closeSync(fd)
    fd = null
    fsSync.renameSync(tmp, target)
    if (durable) {
      let dir = null
      try {
        dir = fsSync.openSync(path.dirname(target), 'r')
        fsSync.fsyncSync(dir)
      } catch { /* not every filesystem permits directory fsync */ } finally {
        if (dir !== null) fsSync.closeSync(dir)
      }
    }
  } catch (err) {
    if (fd !== null) {
      try { fsSync.closeSync(fd) } catch {}
    }
    try { fsSync.unlinkSync(tmp) } catch {}
    throw err
  }
}

/** One lane per store. Every returned promise settles with the write that
 *  includes the state visible when that caller requested a flush. */
function makeCoalescedWriter () {
  const lanes = new Map()

  const laneFor = (target) => {
    if (lanes.has(target)) return lanes.get(target)
    let requested = 0
    let pending = null
    let draining = null
    const waiters = []

    const settle = (through, error = null) => {
      for (let at = waiters.length - 1; at >= 0; at--) {
        if (waiters[at].ticket > through) continue
        const waiter = waiters.splice(at, 1)[0]
        if (error) waiter.reject(error)
        else waiter.resolve()
      }
    }

    const drain = async () => {
      // Let a synchronous burst become one snapshot and one durable rename.
      await Promise.resolve()
      while (pending) {
        const job = pending
        pending = null
        const through = requested
        try {
          await writeAtomic(target, job.serialize(), job.options)
          settle(through)
        } catch (err) {
          settle(through, err)
        }
        // A request made while the file was being written replaced `pending`
        // and is picked up by the next turn rather than being incorrectly
        // resolved by the older snapshot.
      }
    }

    const start = () => {
      if (draining) return
      draining = drain().finally(() => {
        draining = null
        // A request can land between the loop observing no work and this
        // finally running. Start a fresh drain instead of stranding it.
        if (pending) start()
      })
    }

    const lane = {
      flush (serialize, options) {
        const ticket = ++requested
        pending = { serialize, options }
        const answer = new Promise((resolve, reject) => {
          waiters.push({ ticket, resolve, reject })
        })
        start()
        return answer
      }
    }
    lanes.set(target, lane)
    return lane
  }

  return {
    flush (target, serialize, options) {
      return laneFor(target).flush(serialize, options)
    }
  }
}

module.exports = { makeCoalescedWriter, writeAtomicSync }
