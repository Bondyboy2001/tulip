'use strict'

const fsSync = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { makeCoalescedWriter, writeAtomicSync } = require('./atomic-store')

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
   so a restore can itself be undone, the copy an autosave leaves of the note
   it replaced, and the two bulk rewrites — replace-across-the-vault and the
   link chase a rename sets off. Those last two edit notes the user never
   opened, which is exactly the kind of edit there has to be a way back from.
   Applied on load as well, so a store written by an older build sheds anything
   else the first time it is opened. */
const KEPT = new Set(['copilot', 'restore', 'save', 'replace', 'rename'])
const emptyData = () => ({ operations: [], created: {} })

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
    this.inVault = false
    this.data = emptyData()
    this.timer = null
    this.writer = makeCoalescedWriter()
  }

  /* Two homes: beside the rest of the app's state (the default, digest-named),
     or the vault's own `.tulip/` folder, for the vault where the history
     should travel with the folder's sync the way the review schedule does.
     `inVault` is the user's setting, not this store's choice. */
  fileFor (vault, inVault) {
    return inVault && vault
      ? path.join(vault, '.tulip', 'history.json')
      : path.join(this.base, 'trust', `${digest(vault)}.json`)
  }

  file () {
    return this.fileFor(this.vault, this.inVault)
  }

  setVault (vault, inVault = false) {
    this.flushSync()
    const previousFile = this.vault ? this.file() : null
    this.vault = vault || ''
    this.inVault = !!inVault
    this.data = emptyData()
    if (!this.vault) return

    let parsed = null
    try { parsed = JSON.parse(fsSync.readFileSync(this.file(), 'utf8')) } catch {}
    /* A location that has never been written to inherits what the other one
       holds, so flipping the setting migrates the history rather than starting
       it over. The old copy stays put: deleting it is nobody's emergency, and
       flipping back finds it intact. */
    if (!parsed && previousFile && previousFile !== this.file()) {
      try { parsed = JSON.parse(fsSync.readFileSync(previousFile, 'utf8')) } catch {}
    }
    if (parsed && Array.isArray(parsed.operations)) {
      this.data.operations = parsed.operations.filter((row) => KEPT.has(row.source))
      if (parsed.created && typeof parsed.created === 'object' && !Array.isArray(parsed.created)) {
        for (const [note, at] of Object.entries(parsed.created)) {
          if (Number.isFinite(at) && at > 0) this.data.created[String(note)] = at
        }
      }
    }
  }

  schedule () {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush().catch((err) => {
      console.error('note history write failed', err)
    }), 250)
  }

  async flush () {
    clearTimeout(this.timer)
    this.timer = null
    if (!this.vault) return
    const file = this.file()
    const data = this.data
    await this.writer.flush(file, () => this.serialized(data))
  }

  flushSync () {
    if (!this.vault) return
    clearTimeout(this.timer)
    this.timer = null
    try {
      writeAtomicSync(this.file(), this.serialized(this.data))
    } catch (err) {
      console.error('note history final write failed', err)
    }
  }

  /* The store as text, pruned to the byte budget. Pruning here rather than in
     `record` keeps the hot save path free of a full stringify per autosave —
     a save during a session only ever appends, and the bill is paid when the
     store is next written out. */
  serialized (data = this.data) {
    while (data.operations.length) {
      let size = 0
      try { size = Buffer.byteLength(JSON.stringify(data)) } catch { break }
      if (size <= MAX_BYTES) break
      let drop = -1
      for (let i = data.operations.length - 1; i >= 0; i--) {
        if (data.operations[i].source === 'save') { drop = i; break }
      }
      if (drop === -1) break
      data.operations.splice(drop, 1)
    }
    return JSON.stringify(data)
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

  /**
   * The earliest trustworthy moment at which a file existed.
   *
   * Atomic note saves replace the destination inode, which makes APFS birthtime
   * say "created at the last save". Remember the birthtime before that can
   * happen. For vaults already affected, the oldest History operation touching
   * the path proves the note existed by then and repairs the date once.
   */
  creationTime (notePath, filesystemTime = 0) {
    const key = String(notePath || '')
    if (!key) return Number(filesystemTime) || 0
    const stored = this.data.created[key]
    if (Number.isFinite(stored) && stored > 0) return stored

    const candidates = [Number(filesystemTime)]
      .filter((at) => Number.isFinite(at) && at > 0)
    for (const operation of this.data.operations) {
      if (operation.changes.some((change) => change.path === key)) candidates.push(operation.at)
    }
    const created = candidates.length ? Math.min(...candidates) : 0
    if (created) {
      this.data.created[key] = created
      this.schedule()
    }
    return created
  }

  /** Creation metadata follows note and folder moves just as the file does. */
  relocateCreations (moves) {
    let changed = false
    for (const { from, to } of moves || []) {
      if (!Object.prototype.hasOwnProperty.call(this.data.created, from)) continue
      const at = this.data.created[from]
      delete this.data.created[from]
      this.data.created[to] = Math.min(this.data.created[to] ?? Infinity, at)
      changed = true
    }
    if (changed) this.schedule()
  }

  /** A newly created file at the same path must not inherit a deleted note's age. */
  forgetCreations (notePath) {
    const key = String(notePath || '')
    if (!key) return
    const prefix = key.endsWith('/') ? key : `${key}/`
    let changed = false
    for (const stored of Object.keys(this.data.created)) {
      if (stored !== key && !stored.startsWith(prefix)) continue
      delete this.data.created[stored]
      changed = true
    }
    if (changed) this.schedule()
  }
}

module.exports = { TrustStore }
