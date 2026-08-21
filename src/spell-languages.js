/* ====================================================== spell languages
   The languages the spellchecker can be asked to keep beside English. The
   list itself is electron/spell-languages.json — JSON because three sides
   that cannot share a module system have to agree on it: the build (ESM run
   by node, which ships each language's Hunspell files as a gzipped pair in
   dist/dict), the settings pane (renderer ESM, which offers the list), and
   the checker (which loads the pairs the config names). This module is the
   renderer's door to it.

   English is deliberately not in the list — it is not optional. The app's
   locale picks between its two spellings in src/spellcheck.js, and these are
   the languages a note might be *in* on top of that.

   Ids are the dictionary packages' own (BCP 47, lower-cased), because the id
   is also the filename in dist/dict and half of the npm package name — one
   spelling for all three or the build and the loader drift apart. */

import SPELL_LANGUAGES from '../electron/spell-languages.json'

export { SPELL_LANGUAGES }

/** The ids, for the callers that validate rather than display. */
export const SPELL_LANGUAGE_IDS = SPELL_LANGUAGES.map((entry) => entry.id)
