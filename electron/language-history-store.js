// @ts-check
'use strict'

/* ================================================= language row history
   When a vocabulary item first became complete, and when it last changed.

   The dates are deliberately not columns in the Markdown table. They are app
   state, like the review schedule, and live once per vault under `.tulip/` so
   the note stays clean and portable. Rows carry stable ids here rather than in
   the Markdown: inserting or sorting a table must not give one word another
   word's dates.
   ================================================================== */

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { makeCoalescedWriter } = require('./atomic-store')
/* The same splitter the row editor uses, and deliberately the one copy: this
   file decides which rows exist and that one decides what a new row looks like,
   so a disagreement about where a cell ends would have a word's dates attached
   to the wrong word. */
const { cells, delimiter } = require('./language-row')

const STATE_DIR = '.tulip'
const STATE_FILE = 'language-history.json'

/** Complete body rows in the first Markdown table, with their visible index. */
function languageRows (markdown) {
  const lines = String(markdown || '').split(/\r?\n/)
  for (let at = 0; at < lines.length - 1; at++) {
    if (!lines[at].includes('|') || !delimiter(lines[at + 1])) continue
    const rows = []
    for (let line = at + 2; line < lines.length; line++) {
      if (!lines[line].includes('|') || !lines[line].trim()) break
      const values = cells(lines[line])
      /* A row becomes an item when its prompt and answer both exist. A half-
         typed scaffold is not something the reader has learned yet. */
      if (values[0]?.trim() && values[1]?.trim()) {
        rows.push({ row: line - at - 2, cells: values })
      }
    }
    return rows
  }
  return []
}

const sameCells = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || [])

/** Match visible rows to their previous records without rescanning the whole
 *  history for every row. Buckets keep indices in source order, and `take`
 *  skips an index already claimed by a stronger match, preserving the former
 *  exact -> prompt -> answer -> ordered-fallback semantics for duplicates. */
function matchRows (current, previous) {
  const used = new Set()
  const matched = new Array(current.length).fill(null)

  const bucket = (keyOf) => {
    const rows = new Map()
    previous.forEach((record, index) => {
      const key = keyOf(record)
      const list = rows.get(key) || []
      list.push(index)
      rows.set(key, list)
    })
    return { rows, cursors: new Map() }
  }

  const exact = bucket((record) => JSON.stringify(record.cells || []))
  const prompt = bucket((record) => record.cells?.[0])
  const answer = bucket((record) => record.cells?.[1])

  const take = (index, key) => {
    const list = index.rows.get(key)
    if (!list) return -1
    let at = index.cursors.get(key) || 0
    while (at < list.length && used.has(list[at])) at++
    index.cursors.set(key, at + 1)
    return at < list.length ? list[at] : -1
  }

  const claim = (index, keyOf) => {
    current.forEach((row, at) => {
      if (matched[at]) return
      const found = take(index, keyOf(row))
      if (found < 0) return
      used.add(found)
      matched[at] = previous[found]
    })
  }

  claim(exact, (row) => JSON.stringify(row.cells || []))
  claim(prompt, (row) => row.cells[0])
  claim(answer, (row) => row.cells[1])

  const looseCurrent = current.map((_, index) => index).filter((index) => !matched[index])
  const loosePrevious = previous.map((_, index) => index).filter((index) => !used.has(index))
  if (looseCurrent.length === loosePrevious.length) {
    looseCurrent.forEach((at, index) => {
      matched[at] = previous[loosePrevious[index]]
    })
  }
  return matched
}

function makeStore ({ vault, now = Date.now, makeId = randomUUID }) {
  const file = () => path.join(vault(), STATE_DIR, STATE_FILE)
  let state = null
  let loadedFor = null
  const writer = makeCoalescedWriter()

  /* The read in flight, so two callers arriving together share one of them.
     `state` used to be published as an empty vault *before* the file was
     awaited: a `sync()` landing during that window read a history with no notes
     in it, decided every row was new, minted each a fresh id and stamped it
     with today's date — the whole note's Added and Edited dates gone, and gone
     durably, since the next flush wrote the invention back. Nothing sees
     `state` now until it holds what was on disk. */
  let loading = null
  let loadingFor = null

  async function load () {
    const forVault = vault()
    if (state && loadedFor === forVault) return state
    if (loading && loadingFor === forVault) return loading

    /* Resolved once rather than through `file()`, which reads `vault()` afresh:
       the vault can be replaced while this read is in flight, and every path
       this pass touches has to belong to the vault it started in. */
    const target = path.join(forVault, STATE_DIR, STATE_FILE)

    loadingFor = forVault
    loading = (async () => {
      const fresh = { version: 1, notes: {} }
      let raw = null
      try { raw = await fs.readFile(target, 'utf8') } catch {}
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw)
          if (parsed?.notes && typeof parsed.notes === 'object') {
            fresh.notes = parsed.notes
          }
        } catch (err) {
          console.error('language history unreadable', err)
          await fs.rename(target, `${target}.corrupt`).catch(() => {})
        }
      }
      // A vault swapped mid-read makes this answer one about somewhere nobody
      // is looking; it is returned to the caller that asked and not held.
      if (vault() === forVault) {
        state = fresh
        loadedFor = forVault
      }
      return fresh
    })()

    const settled = loading.finally(() => {
      if (loadingFor === forVault) { loading = null; loadingFor = null }
    })
    // Swallowed here only so an unobserved rejection cannot crash the process;
    // the caller still receives it.
    settled.catch(() => {})
    return loading
  }

  async function flush () {
    const target = file()
    const snapshot = state
    await writer.flush(target, () => JSON.stringify(snapshot, null, 1))
  }

  /**
   * Bring one note's metadata in line with its current table.
   *
   * Exact rows are claimed first, so sorting costs no history. An edited row
   * is then recognised by either its prompt or answer; only as a final fallback
   * are equally-sized unmatched sets paired in order, which covers correcting
   * both halves at once without treating an ordinary insertion as an edit.
   */
  async function sync (notePath, markdown, { trackNew = true } = {}) {
    await load()
    const current = languageRows(markdown)
    const previous = Array.isArray(state.notes[notePath]?.rows)
      ? state.notes[notePath].rows
      : []
    const matched = matchRows(current, previous)

    const stamp = now()
    const rows = current.map((row, at) => {
      const record = matched[at]
      if (!record) {
        return {
          id: makeId(), row: row.row, cells: row.cells,
          /* Reading an existing note establishes a baseline; it cannot tell us
             when those rows were added. Only a row first seen on a write gets
             an honest Added date. */
          addedAt: trackNew ? stamp : null,
          editedAt: trackNew ? stamp : null
        }
      }
      return {
        ...record,
        row: row.row,
        cells: row.cells,
        editedAt: sameCells(record.cells, row.cells) ? record.editedAt : stamp
      }
    })

    if (!sameCells(previous, rows)) {
      if (rows.length) state.notes[notePath] = { rows }
      else delete state.notes[notePath]
      await flush()
    }

    return rows.map((record) => ({
      row: record.row,
      id: record.id,
      addedAt: record.addedAt,
      editedAt: record.editedAt
    }))
  }

  async function rows (notePath) {
    await load()
    const records = state.notes[notePath]?.rows || []
    return records.map((record) => ({
      row: record.row, id: record.id, addedAt: record.addedAt, editedAt: record.editedAt
    }))
  }

  async function relocate (from, to) {
    await load()
    const moves = Object.keys(state.notes)
      .filter((key) => key === from || key.startsWith(`${from}/`))
      .map((key) => [key, key === from ? to : `${to}${key.slice(from.length)}`])
    if (!moves.length) return { moved: 0 }
    for (const [source, target] of moves) {
      state.notes[target] = state.notes[source]
      delete state.notes[source]
    }
    await flush()
    return { moved: moves.length }
  }

  async function remove (notePath) {
    await load()
    const keys = Object.keys(state.notes)
      .filter((key) => key === notePath || key.startsWith(`${notePath}/`))
    if (!keys.length) return { dropped: 0 }
    for (const key of keys) delete state.notes[key]
    await flush()
    return { dropped: keys.length }
  }

  return { sync, rows, relocate, remove }
}

module.exports = { makeStore, languageRows, matchRows }
