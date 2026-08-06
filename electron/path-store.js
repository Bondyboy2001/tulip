'use strict'

/**
 * A JSON sidecar keyed by path, for what a file cannot hold about itself.
 *
 * Some things belong to a file and have nowhere in it to live. A `.csv` has no
 * syntax for a column width; a note has no field for the tags a reader put on
 * it from outside its text. Both end up in the same shape — one object under
 * `<vault>/.tulip/`, keyed by the path relative to the vault — and both need
 * the same three things done for them that nobody remembers to do twice:
 *
 *   - read once and hold it, because these are asked for on every open;
 *   - follow a rename, or the file loses what was recorded about it the moment
 *     it is given a better name;
 *   - be forgotten on a delete, or the vault accumulates entries for files that
 *     have not existed for a year.
 *
 * A store made here does all three. Adding a new one is a call rather than a
 * fourth copy of this logic — and, more to the point, the rename and delete
 * paths in main.js pick up new stores through the registry below instead of
 * having to be edited in step with each one.
 */

const path = require('node:path')
const fs = require('node:fs/promises')
const { makeCoalescedWriter } = require('./atomic-store')

/* Shared by every store built here: the writer keys its lanes by target file,
   so two stores flushing at once are two lanes and a burst against one of them
   is a single durable write — the same arrangement the review and language
   histories use. */
const writer = makeCoalescedWriter()

/* Every store built here, so `relocateAll` and `forgetAll` cover the ones added
   later without the call sites in main.js being touched again. This is the
   whole reason a registry exists: a store that a rename forgets to carry is a
   silent loss, and it is silent precisely because nothing fails. */
const stores = []

/**
 * @param name    the file under `.tulip/`, without its extension
 * @param vault   a function answering the open vault's absolute path
 * @param clean   what a value must look like to be stored; returns the cleaned
 *                value, or something falsy for "do not keep this"
 * @param onSave  told after a write, for the caches that a change invalidates
 */
function makePathStore ({ name, vault, clean = (v) => v, onSave = () => {} }) {
  let cache = null

  const file = () => path.join(vault(), '.tulip', `${name}.json`)

  async function load () {
    if (cache) return cache
    try {
      const parsed = JSON.parse(await fs.readFile(file(), 'utf8'))
      cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch { cache = {} }
    return cache
  }

  async function save () {
    const target = file()
    await fs.mkdir(path.dirname(target), { recursive: true })
    /* Written whole, atomically, and serialized at flush time rather than now:
       these files are small, and a half-written one read at the next launch
       would lose every entry rather than one. */
    await writer.flush(target, () => JSON.stringify(cache || {}, null, 2) + '\n')
    onSave()
  }

  const store = {
    /** What is recorded for this path, or nothing. */
    async get (key) {
      return (await load())[key]
    },

    /** Every entry, for the sweeps that want the whole map at once — a search
     *  over tags reads all of them and asking per path would be a walk. The
     *  live object, like the rest of this module: nothing here copies a store
     *  it is about to hand back, and nothing outside it writes to one. */
    all () { return load() },

    /** Record it, or — for a value `clean` rejects — stop recording it. A
     *  cleared entry is deleted rather than stored empty, so the file stays the
     *  size of what is actually being remembered. */
    async set (key, value) {
      const next = clean(value)
      const all = await load()
      const had = Object.prototype.hasOwnProperty.call(all, key)
      if (next) all[key] = next
      else if (had) delete all[key]
      else return next
      await save()
      return next
    },

    /** Carry entries from one path to another. A folder carries everything
     *  underneath it, which is what a folder rename is. */
    async relocate (from, to, isDir) {
      const all = await load()
      let changed = false
      if (isDir) {
        const prefix = `${from}/`
        for (const key of Object.keys(all)) {
          if (key !== from && !key.startsWith(prefix)) continue
          all[`${to}${key.slice(from.length)}`] = all[key]
          delete all[key]
          changed = true
        }
      } else if (all[from] !== undefined) {
        all[to] = all[from]
        delete all[from]
        changed = true
      }
      if (changed) await save()
    },

    /** Drop a deleted file's entry, and a deleted folder's whole subtree. */
    async forget (target, isDir) {
      const all = await load()
      const prefix = `${target}/`
      let changed = false
      for (const key of Object.keys(all)) {
        if (key !== target && !(isDir && key.startsWith(prefix))) continue
        delete all[key]
        changed = true
      }
      if (changed) await save()
    },

    /** Said when the vault changes: the next read is of the new vault's file. */
    reset () { cache = null }
  }

  stores.push(store)
  return store
}

/* What the rename, delete and vault-open paths call. One line each, whatever
   is registered. */
const relocateAll = (from, to, isDir) =>
  Promise.all(stores.map((store) => store.relocate(from, to, isDir).catch(() => {})))

const forgetAll = (target, isDir) =>
  Promise.all(stores.map((store) => store.forget(target, isDir).catch(() => {})))

const resetAll = () => { for (const store of stores) store.reset() }

module.exports = { makePathStore, relocateAll, forgetAll, resetAll }
