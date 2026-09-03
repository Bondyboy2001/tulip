'use strict'

/* ========================================================== language rows
   Reading one row of a language table, as text.

   A vocabulary note is Markdown, and the review history reads its rows back
   out of the source rather than through a table model — the same reading of
   an escaped pipe the editor makes, so a word with a `|` in it is one word
   in both places. The one caller is electron/language-history-store.js; the
   quick-add and enrichment paths that once wrote rows through here are gone,
   and the writing half went with them. Pure functions on a string, so that
   `scripts/test-language-row.cjs` can exercise them without a vault.
   ================================================================== */

/** Split one GFM table row, preserving escaped pipes as cell content. */
function cells (line) {
  const out = []
  let cell = ''
  let escaped = false

  for (const char of String(line || '')) {
    if (escaped) {
      cell += char
      escaped = false
    } else if (char === '\\') {
      cell += char
      escaped = true
    } else if (char === '|') {
      out.push(cell)
      cell = ''
    } else {
      cell += char
    }
  }
  out.push(cell)

  if (!out[0]?.trim()) out.shift()
  if (!out[out.length - 1]?.trim()) out.pop()
  return out.map((value) => value.trim().replace(/\\\|/g, '|'))
}

/** Whether a line is the `| --- | --- |` under a table's header. */
const delimiter = (line) => {
  const row = cells(line)
  return row.length > 1 && row.every((value) => /^:?-{1,}:?$/.test(value))
}

module.exports = { cells, delimiter }
