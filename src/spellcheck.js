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
 * A checker over one dictionary, plus whatever words the app has been taught.
 *
 * Building it parses half a megabyte of word list, which takes a moment and is
 * why nothing here happens until the first word is actually checked.
 */
export function createSpeller (variant = 'us', extraWords = []) {
  const load = DICTIONARIES[variant] || DICTIONARIES.us
  const speller = nspell(load())
  for (const word of extraWords) if (word) speller.add(String(word))

  return {
    variant,

    /** Teach it a word for the rest of this session. */
    add (word) { if (word) speller.add(String(word)) },

    /**
     * The subset of `words` this dictionary does not know.
     *
     * A word is tried as it was written and again in lower case, so a word
     * that opens a sentence is not reported for its capital letter. The other
     * direction is deliberately not tried: `english` really is a misspelling
     * of `English`, and folding it away would hide a whole class of them.
     */
    check (words) {
      const bad = []
      for (const raw of words || []) {
        const word = String(raw || '')
        if (!word) continue
        if (speller.correct(word)) continue
        const lower = word.toLowerCase()
        if (lower !== word && speller.correct(lower)) continue
        bad.push(word)
      }
      return bad
    },

    /**
     * What it might have been. Bounded, because suggesting is a search over the
     * whole dictionary and a panel showing five alternatives to every word
     * would spend longer guessing than the note took to write.
     */
    suggest (word, limit = 4) {
      return speller.suggest(String(word || '')).slice(0, limit)
    }
  }
}
