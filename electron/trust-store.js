'use strict'

const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const MAX_OPERATIONS = 300

/* Whole notes, twice over, bounded by bytes rather than by count alone: a
   vault of long notes should keep fewer versions than one of short ones, so
   the two budgets work together. Save entries are the first to go — they are
   the recoverable kind; a copilot turn or a restore point is kept against
   something a machine rewrote. */
const MAX_BYTES = 4 * 1024 * 1024

/* A typing burst is one history entry, not forty. When a save arrives within
   this window of the last recorded save of the same note, the entry is
   extended rather than added to — its `before` stays where the burst started
   and its `after` becomes the newest text — so the panel lists one "saved"
   row for a paragraph of typing instead of one per pause. */
const COALESCE_MS = 120000

/* What gets kept: the copilot's turns, the snapshot a restore leaves behind
   so a restore can itself be undone, and the copy an autosave leaves of the
   note it replaced. Applied on load as well, so a store written by an older
   build sheds anything else the first time it is opened. */
const KEPT = new Set(['copilot', 'restore', 'save'])

const digest = (value) =>
  crypto.createHash('sha1').update(String(value || '')).digest('hex')

const lines = (text) => String(text ?? '').split('\n').length

/**
 * Snapshots of notes as they stood before something rewrote them: the copilot's
 * turns, a restore so it can be undone, and — since the store is the vault's
 * one memory of what it typed — every autosave. One JSON file per vault,
 * holding whole before/after texts; a note is small enough that honesty beats
 * deltas. Everything the renderer lists comes through `publicOperation`, which
 * carries counts rather than contents; the texts themselves travel only when
 * one diff is asked for.
 */
class TrustStore {
  constructor (base) {
    this.base = base
    this.vault = ''
    this.data = { operations: [] }
    this.timer = null
  }

  setVault (vault) {
    this.flushSync()
    this.vault = vault || ''
    this.data = { operations: [] }
    if (!this.vault) return
    try {
      const parsed = JSON.parse(fsSync.readFileSync(this.file(), 'utf8'))
      if (Array.isArray(parsed.operations)) {
        this.data.operations = parsed.operations.filter((row) => KEPT.has(row.source))
      }
    } catch {}
  }

  file () {
    return path.join(this.base, 'trust', `${digest(this.vault)}.json`)
  }

  schedule () {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush().catch(() => {}), 250)
  }

  async flush () {
    clearTimeout(this.timer)
    this.timer = null
    if (!this.vault) return
    const file = this.file()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await fs.writeFile(temp, this.serialized(), 'utf8')
    await fs.rename(temp, file)
  }

  flushSync () {
    if (!this.timer || !this.vault) return
    clearTimeout(this.timer)
    this.timer = null
    try {
      const file = this.file()
      fsSync.mkdirSync(path.dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      fsSync.writeFileSync(temp, this.serialized(), 'utf8')
      fsSync.renameSync(temp, file)
    } catch {}
  }

  /* The store as text, pruned to the byte budget. Pruning here rather than in
     `record` keeps the hot save path free of a full stringify per autosave —
     a save during a session only ever appends, and the bill is paid when the
     store is next written out. */
  serialized () {
    while (this.data.operations.length) {
      let size = 0
      try { size = Buffer.byteLength(JSON.stringify(this.data)) } catch { break }
      if (size <= MAX_BYTES) break
      let drop = -1
      for (let i = this.data.operations.length - 1; i >= 0; i--) {
        if (this.data.operations[i].source === 'save') { drop = i; break }
      }
      if (drop === -1) break
      this.data.operations.splice(drop, 1)
    }
    return JSON.stringify(this.data)
  }

  record ({ source, changes }) {
    if (!KEPT.has(source)) return null
    const useful = (changes || []).filter((change) => change.before !== change.after)
    if (!useful.length) return null
    const now = Date.now()
    const mapped = useful.map((change) => ({
      path: String(change.path),
      before: change.before == null ? null : String(change.before),
      after: change.after == null ? null : String(change.after),
      added: change.after == null ? 0 : lines(change.after),
      removed: change.before == null ? 0 : lines(change.before)
    }))

    /* A save that lands inside the last save's window of the same note extends
       that entry rather than opening another: its `before` (the state the burst
       began from) is what the panel must show as the recoverable point. The
       newest entry touching the note decides — a copilot turn or a restore
       point for the note in between ends the burst, and a save of some other
       note does not. */
    if (source === 'save' && mapped.length === 1) {
      const change = mapped[0]
      for (let i = 0; i < this.data.operations.length; i++) {
        const prior = this.data.operations[i]
        const match = prior.changes.find((one) => one.path === change.path)
        if (!match) continue
        if (prior.source === 'save' && prior.at >= now - COALESCE_MS) {
          match.after = change.after
          match.added = change.added
          this.schedule()
          return this.publicOperation(prior)
        }
        break
      }
    }

    const operation = {
      id: `h-${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      at: now,
      source,
      changes: mapped
    }
    this.data.operations.unshift(operation)
    this.data.operations = this.data.operations.slice(0, MAX_OPERATIONS)
    this.schedule()
    return this.publicOperation(operation)
  }

  publicOperation (operation) {
    if (!operation) return null
    return {
      id: operation.id,
      at: operation.at,
      source: operation.source,
      changes: operation.changes.map(({ path, added, removed }) => ({
        path,
        added,
        removed
      }))
    }
  }

  list () {
    return this.data.operations.map((row) => this.publicOperation(row))
  }

  operation (id) {
    return this.data.operations.find((row) => row.id === id) || null
  }
}

module.exports = { TrustStore }
