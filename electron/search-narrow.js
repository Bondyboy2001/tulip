'use strict'

/* ============================================================ search-narrow
   The one question the incremental search rests on: are the notes that
   answered the last query all the notes that can answer this one?

   Typing a search is a run of queries each narrower than the last, and a note
   that does not hold `phys` cannot hold `physi`. When that holds, the previous
   answer can be rescanned in place of the whole vault — the index is read once
   at the first keystroke and every keystroke after it reads only what is still
   in the running.

   Its own module, and pure, because the cost of being wrong is invisible: a
   false yes does not throw or slow anything down, it silently drops notes from
   a result list that still looks perfectly plausible. That is a thing to have
   tests for (scripts/test-search-narrow.cjs), and electron/main.js cannot be
   imported without Electron.

   CommonJS to match its neighbours here — see the note at the top of
   frontmatter.cjs for why the electron/ modules are written this way.
   ================================================================== */

/**
 * Whether `previous` covers `next`, so its result set may be rescanned instead
 * of the index.
 *
 * Conservative by construction: every clause below is a reason to say no, and
 * anything unrecognised falls through to no. Saying no costs one full scan;
 * saying yes wrongly costs the reader a note they were looking for.
 *
 * @param previous  the last answer — { generation, words, filters, opts, keys }
 * @param next      the query now being run — { words, filters }
 * @param opts      the search switches now in force
 * @param generation which state of the index `next` is being run against
 */
function narrowsFrom (previous, next, opts, generation) {
  if (!previous) return false

  /* The held answer describes the notes as they were. One edit anywhere in the
     vault — the reader's own autosave included — and "the notes that matched"
     is no longer a set it is safe to look inside. */
  if (previous.generation !== generation) return false

  /* Plain substring queries only. In regex mode a longer pattern is not a
     narrower one — `fo` to `fo|x` widens it — and under whole-word matching a
     longer word is not narrower either: a note holding `foo` never held the
     word `fo`, so the previous answer would not have it to give back. */
  if (opts.regex || opts.word) return false
  if (previous.opts.regex !== !!opts.regex) return false
  if (previous.opts.word !== !!opts.word) return false
  if (previous.opts.caseSensitive !== !!opts.caseSensitive) return false

  /* The same filters. Adding one narrows too, but whether a *changed* filter
     narrows is a separate question per kind — `path:` is a substring test and
     would, `tag:` names a branch of the tag tree and might not — and sameness
     is both the part worth having and the part that cannot be got wrong. */
  if (!sameFilters(previous.filters, next.filters)) return false

  /* Every word of the old query has to survive inside a word of the new one,
     so that a note matching all of the new words necessarily matched all of
     the old. Substring rather than prefix, so `foo` to `a foo b` narrows as
     well: what matters is implication, not how the text was typed. */
  const fold = (w) => (opts.caseSensitive ? w : w.toLowerCase())
  return previous.words.every((was) => next.words.some((now) => fold(now).includes(fold(was))))
}

function sameFilters (before, now) {
  for (const kind of ['tag', 'path', 'file']) {
    const a = before[kind] || []
    const b = now[kind] || []
    if (a.length !== b.length) return false
    if (a.some((value, i) => value !== b[i])) return false
  }
  const a = before.prop || []
  const b = now.prop || []
  if (a.length !== b.length) return false
  return !a.some((p, i) => p.key !== b[i].key || p.value !== b[i].value)
}

module.exports = { narrowsFrom }
