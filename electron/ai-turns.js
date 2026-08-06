'use strict'

/**
 * Turn-scoped snapshots for Copilot.
 *
 * Main can hear more than one terminal event for the same subprocess (for
 * example a provider's `turn.failed`, followed by the process exit). Snapshot
 * completion is asynchronous, so the baseline cannot be one mutable global:
 * a queued turn may begin while the previous snapshot is still being compared.
 * This ledger keeps those two pieces of work separate and coalesces duplicate
 * finish requests for the same turn.
 */
class TurnLedger {
  constructor ({ snapshot, complete }) {
    this.snapshot = snapshot
    this.complete = complete
    this.baselines = new Map()
    this.finishing = new Map()
  }

  async begin (id) {
    const key = turnId(id)
    if (!key) throw new Error('A Copilot turn needs an id.')
    const before = await this.snapshot()
    this.baselines.set(key, before)
    return key
  }

  /** Whether this turn took a baseline — which is the same question as whether
   *  finishing it can produce anything. A read-only turn never begins one, and
   *  the caches main drops on the way into `finish` are only worth dropping for
   *  a turn that is going to look at them. */
  has (id) {
    const key = turnId(id)
    return !!key && (this.baselines.has(key) || this.finishing.has(key))
  }

  finish (id) {
    const key = turnId(id)
    if (!key) return Promise.resolve(null)
    const running = this.finishing.get(key)
    if (running) return running
    if (!this.baselines.has(key)) return Promise.resolve(null)

    const before = this.baselines.get(key)
    this.baselines.delete(key)
    const finishing = Promise.resolve(this.snapshot())
      .then((after) => this.complete(before, after))
      .finally(() => this.finishing.delete(key))
    this.finishing.set(key, finishing)
    return finishing
  }

  discard (id) {
    const key = turnId(id)
    if (key) this.baselines.delete(key)
  }
}

/** IPC-facing ids stay small, printable strings. */
function turnId (value) {
  const id = String(value || '').trim()
  return id && id.length <= 120 ? id : ''
}

module.exports = { TurnLedger, turnId }
