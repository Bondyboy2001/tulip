'use strict'

/* ------------------------------------------------------ spell + dictionary

   Chromium underlines misspellings in the editor and tells no one which words
   they were: there is no API for reading them back, and the panel in the
   sidebar needs a list. So the app keeps a Hunspell dictionary of its own (see
   src/spellcheck.js) and asks it here — the same side as the custom
   dictionary, which only exists in this process.

   Lifted out of main.js with all of its state: the checker, the memo of
   verdicts, and the generation counter that keeps a mid-pass dictionary
   change from writing stale answers into a fresh memo. What the app knows
   that is not about spelling — broadcasting, the app's own assets, the
   config's language list — arrives through the context object.

   Nothing is loaded until the first question. The dictionaries are a megabyte
   of word list to parse, and most sessions never open the pane.
   ================================================================== */

const { app, ipcMain, session } = require('electron')
const fs = require('node:fs/promises')
const { promisify } = require('node:util')
const gunzipAsync = promisify(require('node:zlib').gunzip)

/**
 * @param {{
 *   broadcast: (channel: string, payload?: unknown) => void,
 *   appAsset: (relPath: string) => string,
 *   readConfig: () => { spellLanguages?: unknown }
 * }} ctx
 */
function makeSpellDomain (ctx) {
  const { broadcast, appAsset, readConfig } = ctx

  /* The checker comes out of spellcheck.cjs at runtime, past tsc's sight —
     so its type is the honest `any`, and the gate holds the rest of this
     module instead. */
  /** @type {any} */
  let speller = null
  /** @type {Promise<any> | null} */
  let spellerLoading = null

  /* The words the spellchecker has been told to leave alone. They usually go in
     from the context menu over a red underline (see the context-menu handler in
     main.js); Settings is where the list can be read, added to by hand, and
     pruned — removing a word puts it back under the checker's eye. */

  /**
   * Teach the checkers a word, wherever the asking came from — the handler
   * below, or the native context menu over an underlined word.
   *
   * Both checkers, or the note keeps its underline under a word the app has been
   * told to accept: Chromium's list is the one Settings shows and the one that
   * survives a restart, and the Hunspell copy is the one the underlines and the
   * pane are actually drawn from.
   */
  function teachWord (word) {
    const w = String(word ?? '').trim()
    if (!w) return false
    speller?.add(w)
    forgetSpellVerdicts()
    const done = session.defaultSession.addWordToSpellCheckerDictionary(w)
    // The renderer is holding a pass that is now out of date by one word.
    broadcast('dictionary:changed')
    return done
  }

  /* One extra language's Hunspell pair, from the gzipped files the build put in
     dist/dict (see build.mjs). The id has been through the config's validator
     and appAsset refuses to leave dist, but the shape check keeps a stray value
     to a missing-file miss rather than a path error. A pair that is not there —
     an id from a newer config under an older build — returns null, and the
     checker simply goes without that language.

     Read with `fs/promises` and gunzipped off the synchronous path: the old
     form did both reads and both inflates with blocking calls on the first
     spell check of the session. The promise is cached per language, so two
     first-checks arriving together share one load rather than reading and
     inflating the same pair twice.

     `createSpeller` (see src/spellcheck.js) asks for its dictionaries
     synchronously at construction, so the warmer below awaits every configured
     language *before* the checker is built, and the getter handed over reads
     the settled cache. A language that failed to load resolves to null, which
     is the same answer the old form gave by returning it. */
  const spellDictionaries = new Map() // id -> Promise<{ aff, dic } | null>

  function loadSpellDictionaryAsync (id) {
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(String(id || ''))) return Promise.resolve(null)
    if (!spellDictionaries.has(id)) {
      spellDictionaries.set(id, (async () => {
        try {
          const [affGz, dicGz] = await Promise.all([
            fs.readFile(appAsset(`dict/${id}.aff.gz`)),
            fs.readFile(appAsset(`dict/${id}.dic.gz`))
          ])
          const [aff, dic] = await Promise.all([gunzipAsync(affGz), gunzipAsync(dicGz)])
          return { aff, dic }
        } catch {
          return null
        }
      })())
    }
    return spellDictionaries.get(id)
  }

  /* The settled answer for a warmed language, or null where there is none —
     the synchronous shape `createSpeller` asks for. Pending means "not warmed",
     which only happens for a language nobody configured at build time; it is
     answered as missing rather than waited on, because the construction asking
     cannot wait. */
  const spellDictionaryStore = new Map() // id -> { aff, dic } | null
  function loadSpellDictionary (id) {
    return spellDictionaryStore.has(id) ? spellDictionaryStore.get(id) : null
  }

  /* Which of the optional dictionaries this build actually carries.
   *
   * `build.mjs` ships all of them unless it was told otherwise — see
   * TULIP_SPELL_LANGUAGES there — so this is usually the whole list. It is asked
   * because a trimmed build must not offer a language in Settings that would then
   * do nothing: `loadSpellDictionary` is right to go quietly without a dictionary
   * that is not there, and quiet is exactly the wrong thing for the checkbox that
   * turns it on.
   *
   * Read once. The folder is inside the app bundle and cannot change while it is
   * running. */
  /** @type {string[] | null} */
  let spellInstalled = null
  /** @type {Promise<string[]> | null} */
  let spellInstalledLoading = null

  /* Which of the optional dictionaries this build actually carries, read with
     one async `readdir` instead of the blocking one this used to do on the
     Settings path — and read once, because the folder is inside the app
     bundle and cannot change while it is running. The promise is shared, so
     two opens of Settings together pay for one listing. */
  function spellInstalledNow () {
    if (spellInstalled) return Promise.resolve(spellInstalled)
    if (spellInstalledLoading) return spellInstalledLoading
    spellInstalledLoading = (async () => {
      let names = []
      try { names = await fs.readdir(appAsset('dict')) } catch { names = [] }
      const held = new Set(names)
      /* Both halves or neither: nspell needs the affix rules and the word list, and
         half a pair is a language that would fail at the moment it was used. */
      spellInstalled = [...held]
        .filter((name) => name.endsWith('.dic.gz'))
        .map((name) => name.slice(0, -'.dic.gz'.length))
        .filter((id) => held.has(`${id}.aff.gz`))
        .sort()
      return spellInstalled
    })()
    spellInstalledLoading.catch(() => {}).finally(() => { spellInstalledLoading = null })
    return spellInstalledLoading
  }

  function spellerNow () {
    if (speller) return Promise.resolve(speller)
    if (spellerLoading) return spellerLoading
    spellerLoading = (async () => {
      const { createSpeller, variantForLocale } = require(appAsset('spellcheck.cjs'))
      /* The words taught from the context menu are the app's answer for "this is
         not a mistake", and the panel has to honour it the same way the
         underlines do. */
      const taught = await session.defaultSession.listWordsInSpellCheckerDictionary().catch(() => [])
      const languages = readConfig().spellLanguages
      const ids = Array.isArray(languages) ? languages : []
      /* Warmed before construction, because the construction asks synchronously
         and the disk does not answer synchronously any more. */
      await Promise.all(ids.map(async (id) => {
        spellDictionaryStore.set(id, await loadSpellDictionaryAsync(id))
      }))
      speller = createSpeller(variantForLocale(app.getLocale()), taught, {
        languages: ids,
        loadDictionary: loadSpellDictionary
      })
      return speller
    })()
    spellerLoading.finally(() => { spellerLoading = null })
    return spellerLoading
  }

  /* A ceiling on one question. A note is a few thousand distinct words at the
     very outside; a number far past that is a bug or a paste of something that
     is not prose, and neither is worth blocking this process over. */
  const MAX_SPELL_WORDS = 8000

  /* One verdict per word, kept between passes.
     The panel asks again on every pause in typing, and it asks about the whole
     note each time — so a three-thousand-word note was three thousand Hunspell
     lookups every half second, on the event loop that also serves file reads and
     the app's own assets. A word's spelling does not change; only the dictionary
     can change the answer, and both the ways it can do that clear this map (they
     are the two places `dictionary:changed` is announced).

     Bounded, and cleared whole rather than evicted one at a time: this only ever
     saves repeated work, so the rare session that overflows it pays for one cold
     pass rather than growing without end. */
  const spellVerdicts = new Map()
  const MAX_SPELL_MEMO = 40000
  /* Moved by a dictionary change and by nothing else — not by the memo simply
     filling up, which is this process tidying after itself rather than the
     answers changing. A pass in flight compares it against what it captured to
     find out whether the checker it is holding has been superseded. */
  let spellGeneration = 0
  function forgetSpellVerdicts () { spellVerdicts.clear(); spellGeneration++ }

  /* The checker itself set aside, for the one change that is not a word: a
     spell language turned on or off in config makes the held checker a
     dictionary nobody chose. Rebuilt on the next question. */
  function forgetChecker () {
    speller = null
    forgetSpellVerdicts()
  }

  /* How many unknown words are looked up before yielding. The very first pass
     over a long note has nothing memoised and is the one that can block; broken
     up, an IPC call that arrives in the middle of it waits for a chunk instead of
     the note. */
  const SPELL_CHUNK = 500

  /* One walk of the unknown words, into a map of this pass's own.
   *
   * Kept out of the memo until the walk is over because of what the yields
   * between chunks let in: a word removed from the dictionary mid-pass sets
   * `speller` aside and clears the memo, and the loop — holding the checker it
   * captured before its first await — used to resume and write that discarded
   * checker's verdicts into the freshly cleared map. The removed word was
   * recorded as correctly spelt and stayed that way until the next dictionary
   * change. `stable` is how the caller learns its answers are of the dictionary
   * that is still in force.
   */
  async function spellPass (fresh) {
    const mine = spellGeneration
    const checker = await spellerNow()
    const out = new Map()
    for (let i = 0; i < fresh.length; i += SPELL_CHUNK) {
      const chunk = fresh.slice(i, i + SPELL_CHUNK)
      const bad = new Set(checker.check(chunk))
      for (const word of chunk) out.set(word, bad.has(word))
      if (i + SPELL_CHUNK < fresh.length) await new Promise((done) => setImmediate(done))
    }
    return { out, stable: spellGeneration === mine }
  }

  function register () {
    ipcMain.handle('dictionary:words', async () => {
      const words = await session.defaultSession.listWordsInSpellCheckerDictionary()
      return words.sort((a, b) => a.localeCompare(b))
    })
    ipcMain.handle('dictionary:add', (_e, word) => teachWord(word))

    ipcMain.handle('dictionary:remove', (_e, word) => {
      const w = String(word ?? '').trim()
      if (!w) return false
      // nspell has no way to take a word back out, so the checker is thrown away
      // and rebuilt without it on the next question.
      speller = null
      forgetSpellVerdicts()
      const done = session.defaultSession.removeWordFromSpellCheckerDictionary(w)
      broadcast('dictionary:changed')
      return done
    })

    ipcMain.handle('spell:installed', () => spellInstalledNow())

    ipcMain.handle('spell:check', async (_e, words) => {
      if (!Array.isArray(words) || !words.length) return []
      const asked = words.slice(0, MAX_SPELL_WORDS).map((word) => String(word || '')).filter(Boolean)

      const fresh = [...new Set(asked.filter((word) => !spellVerdicts.has(word)))]
      if (!fresh.length) return asked.filter((word) => spellVerdicts.get(word))

      /* A dictionary change during the walk means the answers are of a dictionary
         nobody is using any more, so it is walked again against the new one. Twice
         over is a bound rather than a belief: the pane re-asks on
         `dictionary:changed` anyway, so a reader holding down Remove costs one
         stale-looking pass and not an unbounded run of retries. */
      let answer = await spellPass(fresh)
      for (let tries = 0; !answer.stable && tries < 2; tries++) answer = await spellPass(fresh)

      if (answer.stable) {
        // The memo's own cap, which is not a change of answer — hence the plain
        // clear rather than `forgetSpellVerdicts`.
        if (spellVerdicts.size + fresh.length > MAX_SPELL_MEMO) spellVerdicts.clear()
        for (const [word, bad] of answer.out) spellVerdicts.set(word, bad)
      }

      // This pass's own answers first: a clear may have emptied the memo under it.
      return asked.filter((word) => answer.out.get(word) ?? spellVerdicts.get(word))
    })

    ipcMain.handle('spell:suggest', async (_e, word) => {
      const w = String(word ?? '').trim()
      if (!w) return []
      return (await spellerNow()).suggest(w)
    })
  }

  return { register, teachWord, forgetChecker }
}

module.exports = { makeSpellDomain }
