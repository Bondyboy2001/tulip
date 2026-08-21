/* ========================================================== spellcheck
   The dictionary, and the one question asked of it: is this a word?

   This runs in the main process, not the renderer — the same side as the
   custom dictionary, which is Chromium's and can only be read there. Keeping
   both on one side is what stops the panel from flagging a word you have
   already taught the app to accept.

   The dictionary is Hunspell's: an affix file of rules and a word list they
   apply to, so "walked" and "walking" are known from "walk" rather than listed.
   Both are inlined into this bundle at build time (see build.mjs) because no
   node_modules travel with the packaged app — a `require` of the dictionary
   package would work in the checkout and fail in /Applications, which is the
   worst of the two.

   British and American spellings are different dictionaries, not one with a
   tolerant mood: "colour" is wrong in one and right in the other. Both are
   carried and the app's locale picks, so a note written in English English is
   not underlined into American English.
   ================================================================== */

import nspell from 'nspell'
import gbAff from '../node_modules/dictionary-en-gb/index.aff'
import gbDic from '../node_modules/dictionary-en-gb/index.dic'
import usAff from '../node_modules/dictionary-en/index.aff'
import usDic from '../node_modules/dictionary-en/index.dic'

const DICTIONARIES = {
  gb: () => ({ aff: gbAff, dic: gbDic }),
  us: () => ({ aff: usAff, dic: usDic })
}

/* Which English a locale means. Only the ones that actually differ are listed:
   everything else — en-US, en, or no locale at all — is the American list,
   which is also what Chromium falls back to. */
const BRITISH = /^en-(GB|AU|NZ|IE|ZA|IN)$/i

export function variantForLocale (locale) {
  return BRITISH.test(String(locale || '')) ? 'gb' : 'us'
}

/**
 * A checker over one or several dictionaries, plus whatever words the app has
 * been taught.
 *
 * Building it parses half a megabyte of word list per language, which takes a
 * moment and is why nothing here happens until the first word is actually
 * checked.
 *
 * English is always the first dictionary; the rest come from `languages`, an
 * array of ids from src/spell-languages.js, each loaded through the caller's
 * `loadDictionary` — this module cannot know where the shipped `.aff`/`.dic`
 * pairs live (that is dist layout, the main process's business). A language
 * whose pair cannot be loaded is skipped rather than fatal: the checker that
 * knows fewer languages underlines more, never less, and the note is still
 * being checked.
 *
 * A word is correct if ANY dictionary knows it — the only reading of "this
 * vault is written in English and German" under which prose in either
 * language comes out clean.
 *
 * @param {string} [variant]
 * @param {string[]} [extraWords]
 * @param {{ languages?: string[],
 *           loadDictionary?: (id: string) => { aff: string|Buffer, dic: string|Buffer } | null }} [options]
 */
export function createSpeller (variant = 'us', extraWords = [], { languages = [], loadDictionary } = {}) {
  const load = DICTIONARIES[variant] || DICTIONARIES.us
  const spellers = [nspell(load())]
  for (const id of languages || []) {
    const pair = loadDictionary?.(id)
    if (pair && pair.aff && pair.dic) spellers.push(nspell(pair))
  }

  /* The taught words are the app's own list, not any dictionary's, so they
     are held apart rather than pushed into nspell: one set answers for every
     language, and matching case-insensitively means a name taught from its
     capitalised use is not re-flagged where it opens a sentence. */
  const taught = new Set()
  const teach = (word) => { if (word) taught.add(String(word).toLowerCase()) }
  for (const word of extraWords) teach(word)

  const known = (word) => {
    if (taught.has(word.toLowerCase())) return true
    const lower = word.toLowerCase()
    for (const speller of spellers) {
      if (speller.correct(word)) return true
      /* Tried as written and again in lower case, so a word that opens a
         sentence is not reported for its capital letter. The other direction
         is deliberately not tried: `english` really is a misspelling of
         `English`, and folding it away would hide a whole class of them. */
      if (lower !== word && speller.correct(lower)) return true
    }
    return false
  }

  return {
    variant,

    /** Teach it a word for the rest of this session. */
    add: teach,

    /** The subset of `words` no dictionary here knows. */
    check (words) {
      const bad = []
      for (const raw of words || []) {
        const word = String(raw || '')
        if (!word) continue
        if (!known(word)) bad.push(word)
      }
      return bad
    },

    /**
     * What it might have been. Bounded, because suggesting is a search over the
     * whole dictionary and a panel showing five alternatives to every word
     * would spend longer guessing than the note took to write. Every language
     * is asked and the answers interleaved — for a word mistyped in German,
     * the German guesses are the point, and English-first ordering would push
     * them off the end of the list.
     */
    suggest (word, limit = 4) {
      const asked = String(word || '')
      const rounds = spellers.map((speller) => speller.suggest(asked))
      const out = []
      for (let i = 0; out.length < limit; i++) {
        let offered = false
        for (const round of rounds) {
          if (i >= round.length) continue
          offered = true
          if (!out.includes(round[i])) out.push(round[i])
          if (out.length >= limit) break
        }
        if (!offered) break
      }
      return out
    }
  }
}
