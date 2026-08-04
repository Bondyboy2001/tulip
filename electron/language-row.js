'use strict'

/* ========================================================== language rows
   Reading and writing one row of a language table, as text.

   A vocabulary note is Markdown, and adding a word to it has to leave it
   Markdown — the same file, the same table, the same column widths, with one
   more line in it. Which means editing the source rather than parsing it into a
   model and printing the model back out: a round trip through a table
   representation would reformat every row the user had lined up by hand, and
   the note would look rewritten every time a word was added to it.

   The two callers are the quick-add box and the enrichment errand, both in
   electron/main.js. Everything here is a pure function on a string so that
   `scripts/test-language-row.cjs` can exercise it without a vault.
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

/**
 * Where the first table is, and what its columns are called.
 *
 * @returns {{header: string[], at: number, first: number, end: number}|null}
 *   `at` is the header line, `first` the first body line, `end` one past the
 *   last — the half-open range the body occupies.
 */
function tableAt (markdown) {
  const lines = String(markdown || '').split(/\r?\n/)
  for (let at = 0; at < lines.length - 1; at++) {
    if (!lines[at].includes('|') || !delimiter(lines[at + 1])) continue
    let end = at + 2
    while (end < lines.length && lines[end].includes('|') && lines[end].trim()) end++
    return { header: cells(lines[at]), at, first: at + 2, end, lines }
  }
  return null
}

/** A pipe inside a cell would end the cell, so it is escaped; a newline cannot
 *  be escaped at all and becomes a space. */
const escape = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()

/** One row of Markdown from cells, in the style the template writes. */
const rowText = (values) => `| ${values.map(escape).join(' | ')} |`

/**
 * Values keyed by column name, laid out in the table's own column order.
 *
 * Matched case- and space-insensitively, because a header the user renamed
 * `word ` is still the Word column. A key naming no column is dropped rather
 * than appended: a value in a column that does not exist is a value nothing
 * will ever read.
 */
function placed (header, values, existing = []) {
  const at = (name) => header.findIndex(
    (column) => column.trim().toLowerCase() === String(name).trim().toLowerCase()
  )
  const row = header.map((_, index) => existing[index] ?? '')
  for (const [name, value] of Object.entries(values || {})) {
    const index = at(name)
    if (index >= 0) row[index] = value
  }
  return row
}

/** Whether every cell of a row is blank — the template's scaffold row, which is
 *  a place to type rather than a word. */
const isBlank = (row) => row.every((value) => !String(value).trim())

/**
 * A word added to a note's first table.
 *
 * The blank scaffold row a new table is created with is filled rather than
 * pushed down: a table whose first line is empty and whose second is the first
 * word looks like a mistake, and is one.
 *
 * @param {string} markdown the note
 * @param {object} values   column name -> cell text
 * @returns {{text: string, row: number}|null} the new note and which body row
 *   the word landed on, or null if the note has no table to add to
 */
function appendRow (markdown, values) {
  const table = tableAt(markdown)
  if (!table) return null
  const { lines, header, first, end } = table

  const row = placed(header, values)
  if (isBlank(row)) return null

  const last = end - 1
  const replacing = last >= first && isBlank(cells(lines[last]))
  const at = replacing ? last : end

  const next = [...lines]
  next.splice(at, replacing ? 1 : 0, rowText(row))
  return { text: next.join('\n'), row: at - first }
}

/**
 * Fill in the empty cells of the row holding `term`.
 *
 * Only the empty ones: this is what the enrichment errand writes back, and a
 * translation the user typed themselves must survive a model disagreeing with
 * it. Nothing is overwritten, ever, so running it twice on a finished row is a
 * no-op rather than a rewrite.
 *
 * @returns {{text: string, filled: object}|null} the new note and which columns
 *   were actually filled, or null if there is no such row or nothing to do
 */
function fillRow (markdown, term, values) {
  const table = tableAt(markdown)
  if (!table) return null
  const { lines, header, first, end } = table

  const wanted = String(term || '').trim()
  if (!wanted) return null

  for (let at = first; at < end; at++) {
    const row = cells(lines[at])
    if (row[0]?.trim() !== wanted) continue

    const filled = {}
    const next = placed(header, {}, row)
    for (const [name, value] of Object.entries(values || {})) {
      const index = header.findIndex(
        (column) => column.trim().toLowerCase() === String(name).trim().toLowerCase()
      )
      if (index < 0 || next[index]?.trim() || !String(value ?? '').trim()) continue
      next[index] = value
      filled[header[index]] = value
    }
    if (!Object.keys(filled).length) return null

    const text = [...lines]
    text[at] = rowText(next)
    return { text: text.join('\n'), filled }
  }
  return null
}

/** Every row of the first table, as its cells — for the enrichment prompt,
 *  which is better at inventing a sentence when it can see the ones already
 *  there. */
function rows (markdown) {
  const table = tableAt(markdown)
  if (!table) return []
  const out = []
  for (let at = table.first; at < table.end; at++) out.push(cells(table.lines[at]))
  return out
}

module.exports = { cells, delimiter, tableAt, appendRow, fillRow, rows }
