'use strict'

const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const MAX_OPERATIONS = 120

/* What gets kept: the copilot's turns, and the snapshot a restore leaves
   behind so a restore can itself be undone. Applied on load as well, so a
   store written by an older build sheds anything else the first time it is
   opened. */
const KEPT = new Set(['copilot', 'restore'])

const digest = (value) =>
  crypto.createHash('sha1').update(String(value || '')).digest('hex')

const lines = (text) => String(text ?? '').split('\n').length

/**
 * Snapshots of notes as they stood before the copilot rewrote them.
 *
 * One JSON file per vault, holding whole before/after texts — a note is small
 * enough that honesty beats deltas. Everything the renderer lists comes
 * through `publicOperation`, which carries counts rather than contents; the
 * texts themselves travel only when one diff is asked for.
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
    await fs.writeFile(temp, JSON.stringify(this.data), 'utf8')
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
      fsSync.writeFileSync(temp, JSON.stringify(this.data), 'utf8')
      fsSync.renameSync(temp, file)
    } catch {}
  }

  record ({ source, changes }) {
    if (!KEPT.has(source)) return null
    const useful = (changes || []).filter((change) => change.before !== change.after)
    if (!useful.length) return null
    const now = Date.now()
    const operation = {
      id: `h-${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      at: now,
      source,
      changes: useful.map((change) => ({
        path: String(change.path),
        before: change.before == null ? null : String(change.before),
        after: change.after == null ? null : String(change.after),
        added: change.after == null ? 0 : lines(change.after),
        removed: change.before == null ? 0 : lines(change.before)
      }))
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
