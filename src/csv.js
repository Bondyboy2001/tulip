/* ================================================================== csv
   Separated values, shown as the table they are.

   A `.csv` is the one thing the vault holds that is text on disk but not a
   document: opening it in the editor shows the quoting rather than the data,
   and quoting is exactly what nobody wants to read. So it gets a viewer of its
   own, in the same shape as the whiteboard's — `open`, `save`, `close`,
   `focus`, `place`, `dirty` — and the renderer treats it as one more kind of
   tab.

   Three things drive the design:

   - The file is the model. Edits go into the parsed rows and the rows are
     serialized back on save; nothing is kept about a cell that the file cannot
     say. A spreadsheet's worth of state — formats, formulas, merged cells —
     has nowhere to live in a CSV, so there is none here.

   - A data file is routinely enormous. A 200k-row export is a normal thing to
     be handed and a hopeless thing to put in the DOM, so only the rows in view
     are built. Everything below assumes a fixed row height, which is what
     makes the mapping from scroll position to row index exact rather than
     measured.

   - Sorting is a way of *looking* at the file, not an edit to it. It lives in
     `order`, a list of source row indices, and every read and write goes
     through it. Sorting a hundred-thousand-row export and saving must not
     rewrite all hundred thousand lines because you wanted to see the largest
     first — so it doesn't, and the one case where you did mean it (the
     heading menu's "Write this order into the file") says so and can be undone.

   What the grid can do, beyond showing the file:

     sorting       click a heading; asc → desc → off, blanks last either way
     finding       one box that highlights every cell holding what you typed
     filtering     per column, by ticking the values to keep — and the find box
                   can hide what it does not match, for the times the question
                   is about the whole row rather than one column
     selection     rectangles — drag, shift-click, shift-arrows, whole rows
                   and columns, several at once and not necessarily touching
                   (⌘-click), and the sum/average of whatever is in them
     clipboard     copy, cut and paste a rectangle as TSV, which is what a
                   spreadsheet puts on the clipboard and expects back
     structure     insert and delete rows and columns, rename headings, resize
                   and auto-fit columns, fill down
     undo          every edit above, as patches rather than snapshots of a file
                   that may be a hundred megabytes
   ================================================================== */

import { dataDelimiter } from './vault-paths.js'
import { isMac, keyLabel } from './platform.js'
import { dropdown } from './dropdown.js'

/* Fixed, and in one place, because the virtual window's arithmetic depends on
   it: scroll position divided by this is the first row to build. A row that
   could grow to fit its content would make that division a lie, which is why
   cells clip rather than wrap. */
const ROW_HEIGHT = 28

/* Rows built above and below the viewport, so a fast scroll has something
   already there instead of a band of blank. */
const OVERSCAN = 8

/* The same courtesy sideways, and far less of it: a column is wide, so two
   either side already covers more ground than eight rows do, and every one of
   them is paid for on every row in the band. */
const OVERSCAN_COLS = 2

/* The alignments a column can be pointed at by hand. Anything else in a saved
   sidecar — an older Tulip's spelling, a hand-edited file — reads as "nobody
   asked", which is the same as never having been set. */
const ALIGNMENTS = ['left', 'center', 'right']

const MIN_COL = 72
/* How wide a column is allowed to get on its own, when the table is first
   measured. A cap belongs there: one cell holding a paragraph would otherwise
   open the file with a single column and the rest of the table off the screen.
   It does *not* belong on a fit that was asked for — see `fitCeiling`. */
const MAX_COL = 420
/* The frozen strip of row numbers down the left. Part of the row's width, so
   the canvas is wide enough for it, and `position: sticky` inside the row is
   what keeps it against the left edge while the rest scrolls under it. */
const GUTTER = 58
/* Columns are sized from the widest cell in a sample rather than in the whole
   file: measuring a million cells to pick a width is time spent before the
   first row is on screen, and the first few hundred rows are what the width
   has to suit anyway. */
const WIDTH_SAMPLE = 250
/* Asking for a fit is asking to see what is in the column, so it reads far
   more of the file than the opening measure does — and stops there rather than
   walking a million rows for a width, saying so when it did. */
const FIT_SCAN = 20000
/* How wide a fit may make a column, in characters of the grid's own face.

   It used to be the width of the pane, on the reasoning that a column wider
   than the window shows no more of itself. That is true of a page and false of
   this: the grid scrolls sideways, so past the pane's edge the rest of the
   value is a scroll away — and a fit that stopped at the edge left the cell cut
   off, which is the one thing it was asked to prevent.

   A ceiling is still needed, because one cell holding a chapter would otherwise
   make a column nothing else on the row could be reached past. Five hundred
   characters is far more than any heading, identifier or joined list, and still
   a column you can scroll to the end of; a value longer than that is read by
   opening the cell, which wraps. */
const FIT_CHARS = 500
/* The fallback advance, used only until the real one has been measured. */
const CHAR_WIDTH = 7.4
const CELL_PADDING = 18

/* The size past which a file is opened as a preview of its first rows rather
   than in full.
 *
 * Thirty-two megabytes, which is roughly a quarter of a million rows of a
 * dozen ordinary columns — comfortably above the two-hundred-thousand-row
 * export this viewer was built for, and comfortably below the point where the
 * window stops answering. Everything about opening a table is linear in its
 * size and none of it is interruptible: the text crosses the IPC boundary as
 * one string, the parser walks it a character at a time, and the column
 * measure reads a sample of what comes out. A five-hundred-megabyte export
 * put through that is not slow, it is a frozen window with no way to say what
 * it is doing — so past this it is not attempted, and what is offered instead
 * is the top of the file, read-only, with the whole of it one click away for
 * a reader who knows what they are asking for.

   Read-only matters more than the speed does. A preview holding the first
   fifty thousand rows of a million-row file that could be *saved* would write
   those fifty thousand over the million, which is the worst thing this file
   could possibly do. */
const PREVIEW_ABOVE = 32 * 1024 * 1024
/* How much of the text a preview parses, and how many rows it keeps. The
   character budget is what stops the parse itself from being the freeze; the
   row cap is what the reader is told they are looking at. Four megabytes is
   tens of thousands of rows of anything ordinary. */
const PREVIEW_CHARS = 4 * 1024 * 1024
const PREVIEW_ROWS = 50000

/* Undo depth. Cell edits are patches and cost nothing to keep; the structural
   ones carry a shallow copy of the row list, which on a large file is real
   memory, so far fewer of those are kept. */
const HISTORY_LIMIT = 250
const SNAPSHOT_LIMIT = 30

/* Where the platform is a Mac, because one gesture depends on it: Ctrl-click
   *is* the right-click here, so taking Ctrl as "and this one too" would add a
   block to the selection every time somebody opened a context menu. ⌘ is what
   a Mac presses for that anyway; everywhere else there is no ⌘ to press and
   Ctrl is what every list in the system uses. */
/** Does this click mean "add to what is already selected" rather than
 *  "select this instead"? Delegated to platform.js so the same `process.platform`
 *  source the menu and the shortcut labels use decides it — rather than a second
 *  UA sniff saying a different thing in a test. */
const addsToSelection = (event) => event.metaKey || (event.ctrlKey && !isMac())

/* ------------------------------------------------------------- the format */

/** Does the quoted field opening at `at` close cleanly on its own line?
 *
 *  Only asked under a tab delimiter, and only to decide whether the quote is
 *  data — see the note in `readSeparated`. A field is genuinely quoted when a
 *  lone quote (doubled quotes being one quote's worth of data) turns up before
 *  the line ends and is followed by the delimiter, a line ending or the end of
 *  the file. The line is the boundary on purpose: a closing quote found three
 *  rows later is almost never this field's close — it is the next unit in a
 *  column of them — and taking it as one is exactly how `"5 inch` used to
 *  swallow the rest of the file into a single cell. The price is the quoted
 *  multi-line TSV field, which honest TSV writers do not produce at all. */
const closesQuoted = (source, at, delimiter) => {
  for (let i = at + 1; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\n' || ch === '\r') return false
    if (ch !== '"') continue
    if (source[i + 1] === '"') { i++; continue }
    const after = source[i + 1]
    return after === undefined || after === delimiter || after === '\n' || after === '\r'
  }
  return false
}

/**
 * Rows of fields, and the shape of the text they came out of.
 *
 * RFC 4180 with the leniencies every real file needs: either line ending, a
 * final newline or not, and a doubled `""` inside a quoted field standing for
 * one quote. A quote appearing in the middle of an unquoted field is data —
 * spreadsheets write that and refusing it would mean refusing the file.
 *
 * Written as one pass over the characters rather than a split-and-repair,
 * because a delimiter or a newline *inside* quotes is the ordinary case in
 * exported data, and splitting on either first is what gets that wrong.
 *
 * The shape is gathered in the same pass rather than by scanning the text
 * again: three of its four members are answered by characters this loop is
 * already looking at, and the fourth — who quoted what — is only knowable here.
 *
 * @returns {{rows: string[][], shape: {
 *   newline: string, finalNewline: boolean, quoteAll: boolean,
 *   quoteColumns: boolean[], bom: boolean
 * }}}
 */
export function readSeparated (text, delimiter = ',', { strictQuotes = false } = {}) {
  const raw = String(text ?? '')
  // A byte-order mark is not part of the first heading — but it is a fact
  // about the file, and one that has to go back on when it is written.
  const bom = raw.startsWith('\uFEFF')
  const source = bom ? raw.slice(1) : raw
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let started = false
  /* Whether *this* field was written quoted, which is not the same as whether
     it needs to be. See `quoteColumns` below. */
  let wasQuoted = false
  let newline = ''

  /* Who quoted what, tallied per column rather than per cell.
   *
   * Per cell would be the exact answer and is not affordable: a two-hundred
   * thousand row export of twenty columns is four million facts to carry
   * beside four million strings, kept alive for as long as the tab is open.
   * Per column is both cheap and the more useful answer anyway — a writer that
   * quotes decides by column, and a cell *typed* into a column that Excel
   * quotes wants quoting too, which a per-cell record could never say because
   * the cell did not exist when the file was read. */
  const quotedCol = []
  const bareCol = []
  let sawQuote = false

  const endField = () => {
    const c = row.length
    if (wasQuoted) { quotedCol[c] = true; sawQuote = true } else if (field !== '') bareCol[c] = true
    row.push(field)
    field = ''
    wasQuoted = false
    started = true
  }
  const endRow = () => { endField(); rows.push(row); row = []; started = false }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]

    if (quoted) {
      if (ch !== '"') { field += ch; continue }
      // `""` is one quote; a lone quote ends the quoted run.
      if (source[i + 1] === '"') { field += '"'; i++; continue }
      quoted = false
      continue
    }

    if (ch === '"' && field === '' && !wasQuoted) {
      /* Under a comma, a semicolon or a pipe, a leading quote is a quoted
         field and nothing else: those are the delimiters whose writers all
         follow RFC 4180.

         A tab file is the exception, and an expensive one. Almost nothing that
         writes TSV quotes anything — the format's whole claim is that a tab
         cannot appear in a value — so a leading quote there is far more likely
         to be a unit than a syntax: `"5 inch` in a column of pipe sizes used to
         open a quoted field that ran to the end of the file, and a
         forty-thousand-row export arrived as one cell. Looking ahead for a
         clean close costs a scan of one field in the ordinary case and settles
         it honestly. */
      if (strictQuotes || delimiter !== '\t' || closesQuoted(source, i, delimiter)) {
        quoted = true
        wasQuoted = true
        started = true
        continue
      }
    }
    if (ch === delimiter) { endField(); continue }
    if (ch === '\r') {
      // Swallow the LF of a CRLF; a bare CR is still a line ending.
      if (source[i + 1] === '\n') { i++; if (!newline) newline = '\r\n' } else if (!newline) newline = '\r'
      endRow()
      continue
    }
    if (ch === '\n') { if (!newline) newline = '\n'; endRow(); continue }
    field += ch
    started = true
  }

  /* Whatever is left is a final row without a line ending. A file that *did*
     end with one leaves nothing behind, and must not gain a blank row for it —
     which is the difference between a table of 100 rows and one of 101 whose
     last is empty. That same emptiness is how the writer knows to put the
     final newline back, and only back, where there was one. */
  const finalNewline = !(started || field !== '' || row.length)
  if (!finalNewline) endRow()

  /* A column is "a quoted column" when every value in it that could have been
     written bare was written quoted instead. One bare value settles it the
     other way: a writer that quotes by column does not sometimes forget. */
  const width = rows.reduce((most, r) => Math.max(most, r.length), 0)
  const quoteColumns = []
  for (let c = 0; c < width; c++) quoteColumns[c] = !!quotedCol[c] && !bareCol[c]

  return {
    rows,
    shape: {
      newline: newline || '\n',
      finalNewline: source.length ? finalNewline : true,
      bom,
      /* Every column quoted, which is what Excel and a great many database
         exports emit and what a diff notices the loss of first. */
      quoteAll: sawQuote && width > 0 && quoteColumns.every(Boolean),
      quoteColumns
    }
  }
}

/**
 * Rows of fields, from separated text.
 *
 * The shape-less half of `readSeparated`, kept because most callers — the
 * delimiter sniffer, the clipboard — want the table and have no file to be
 * faithful to.
 */
export function parseSeparated (text, delimiter = ',', options = {}) {
  return readSeparated(text, delimiter, options).rows
}

/** Whether a field has to be quoted to survive the round trip. Leading and
 *  trailing spaces are included: readers differ on whether they keep them, and
 *  quoting is the only way to say the space is data.
 *
 *  `wasQuoted` is the fifth reason, and the one that is not about the value at
 *  all: a field the file quoted is written quoted whether or not it needs to
 *  be, because the alternative is a diff against every line of a file whose
 *  writer quotes everything. */
const needsQuotes = (value, delimiter, wasQuoted = false) =>
  wasQuoted || value.includes(delimiter) || value.includes('"') ||
  value.includes('\n') || value.includes('\r') ||
  value !== value.trim()

const quoteField = (value, delimiter, wasQuoted = false) =>
  needsQuotes(value, delimiter, wasQuoted) ? `"${value.replace(/"/g, '""')}"` : value

/**
 * Separated text, from rows of fields. The inverse of `readSeparated` for
 * every file it can read.
 *
 * `shape` is the file's own, handed back by the reader: the line ending, the
 * final newline or its absence, and which columns were written quoted. A file
 * written with CRLF that came back LF is a diff against every line of it, from
 * an edit to one cell — and so is one whose forty quoted columns came back
 * bare.
 *
 * The byte-order mark is deliberately *not* put on here. It is a property of
 * the bytes rather than of the text, and `api.file.write` is what turns text
 * into bytes; emitting it here would put a literal U+FEFF into a UTF-16 file
 * that then got a real mark in front of it as well.
 *
 * @param {{ quoteAll?: boolean, quoteColumns?: boolean[], finalNewline?: boolean } | null} [shape]
 */
export function formatSeparated (rows, delimiter = ',', newline = '\n', shape = null) {
  const quoteAll = !!shape?.quoteAll
  const quoteColumns = shape?.quoteColumns ?? []
  const finalNewline = shape ? shape.finalNewline !== false : true
  const body = rows
    .map((row) => row
      .map((cell, c) => quoteField(String(cell ?? ''), delimiter, quoteAll || !!quoteColumns[c]))
      .join(delimiter))
    .join(newline)
  if (!rows.length) return ''
  return finalNewline ? body + newline : body
}

/* ---------------------------------------------------------- the delimiter

   What actually separates the values, which the extension only claims to know.

   `.csv` names a comma and a great many files called `.csv` are not separated
   by one: a spreadsheet saved anywhere that writes decimals with a comma emits
   semicolons, and database and log exports lean on pipes and tabs. Read with
   the wrong one, such a file is a single column of unsplit lines — every row
   intact, entirely unusable, and with nothing on screen saying why.

   So the extension's delimiter becomes a starting guess that the file itself
   can overrule. */

/* Tried in this order, except that the extension's own goes first — see
   `sniffDelimiter`, where that ordering is what settles a tie. */
const DELIMITER_CANDIDATES = [',', ';', '\t', '|']

/* How much of the file the guess is made from. A delimiter that holds for the
   first few dozen rows holds for the file; reading more of it to be surer
   would be time spent before anything is on screen. */
const SNIFF_BYTES = 64 * 1024
const SNIFF_ROWS = 50

/** The name a delimiter goes by in the picker and in what the grid says. */
export const delimiterName = (delimiter) => ({
  ',': 'Comma', ';': 'Semicolon', '\t': 'Tab', '|': 'Pipe'
}[delimiter] || 'Comma')

/**
 * The delimiter a file is actually written with.
 *
 * A table is a rectangle, so the right delimiter is the one that makes the
 * rows come out the same length as each other. Each candidate is tried over
 * the first rows, and scored on how much of the file agrees about how many
 * fields there are; a candidate that splits nothing — every row one field — is
 * not a delimiter for this file and is not in the running at all.
 *
 * `fallback` is the extension's own, and it goes first so that it wins any
 * tie. That matters more than it sounds: a two-column comma file could be read
 * as a two-column anything if the other candidates happen not to appear in it,
 * and when the evidence does not distinguish them the file's declared shape is
 * the better answer.
 */
export function sniffDelimiter (text, fallback = ',') {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  if (!source.trim()) return fallback

  /* A prefix cut at a line ending, so the sample never stops in the middle of
     a quoted field and turns the rest of it into a delimiter storm. */
  let head = source
  if (source.length > SNIFF_BYTES) {
    const cut = source.lastIndexOf('\n', SNIFF_BYTES)
    head = source.slice(0, cut > 0 ? cut + 1 : SNIFF_BYTES)
  }

  const order = [fallback, ...DELIMITER_CANDIDATES.filter((d) => d !== fallback)]
  /** @type {{ delimiter: string, score: number, fields: number } | null} */
  let best = null
  for (const candidate of order) {
    const rows = parseSeparated(head, candidate).slice(0, SNIFF_ROWS)
    if (!rows.length) continue
    /* The field count most of the rows agree on, and how many of them do. The
       mode rather than the mean: one ragged row in an export should not drag
       the answer to a width no row actually has. */
    const tally = new Map()
    for (const row of rows) tally.set(row.length, (tally.get(row.length) || 0) + 1)
    let fields = 1
    let agree = 0
    for (const [count, n] of tally) {
      if (n > agree || (n === agree && count > fields)) { fields = count; agree = n }
    }
    // One field per row is a file this candidate does not separate at all.
    if (fields < 2) continue
    const score = agree / rows.length
    // Strictly better, so the fallback's place at the head of the order holds.
    if (!best || score > best.score || (score === best.score && fields > best.fields)) {
      best = { delimiter: candidate, score, fields }
    }
  }
  return best ? best.delimiter : fallback
}

/**
 * The line ending the file already uses, so writing it back does not rewrite
 * every line. Decided by the first ending in the file: a mixed file has to be
 * normalised to something, and the one it opens with is the better guess.
 *
 * All three endings, not two. The old reading looked only for an LF and called
 * anything else Unix — which is right for CRLF and wrong for the third case: a
 * bare-CR file (classic Mac, and what a surprising number of instruments and
 * lab exports still emit) has no LF anywhere in it, so every one of them was
 * silently rewritten to LF the first time a cell was touched. That is a
 * one-cell edit arriving as a diff against the entire file, which is the exact
 * failure this function exists to prevent.
 *
 * `readSeparated` works the same thing out in the pass it is already making
 * over the characters, and is what the grid uses. This is kept for the callers
 * that have only the text.
 */
export const detectNewline = (text) => {
  const source = String(text ?? '')
  const lf = source.indexOf('\n')
  const cr = source.indexOf('\r')
  if (cr < 0) return '\n'
  if (cr + 1 === lf) return '\r\n'
  return lf < 0 || cr < lf ? '\r' : '\n'
}

/* ------------------------------------------------------------ the reading

   What a cell *means*, which is not in the file: a CSV says `1,200` and
   `$1,200` and `(1,200)` and every one of them is the same number to the
   person who exported it. Sorting a column of prices alphabetically, or
   refusing to total a column because of its currency sign, is the failure this
   section exists to avoid. */

/* What is left once the punctuation a number wears has been taken off it: an
   unsigned decimal, in scientific notation or not. The sign is pulled off
   before this is tried rather than allowed for here, which is also what stops
   `--5` reading as five. */
const BARE_NUMBER = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/* A separator only groups digits if it groups them in threes.
 *
 * This is the discipline of the three patterns below, and it is the thing a
 * blanket `.replace(/,/g, '')` could not say: a comma that is not part of a
 * well-formed group is not a thousands separator, and treating it as one read
 * `1,2,3` as a hundred and twenty-three. What matches none of them is left to
 * be text, which is the honest answer for a cell nobody can read as a single
 * number. */

/* `1 234 567,89` — the space family, and the apostrophes Swiss and Italian
   writers group with. Whatever tail follows is left to the two below. */
const SPACE_GROUPED = /^\d{1,3}(?:[\s\u00A0’'`]\d{3})+(?:[.,]\d+)?$/
/* `1,234,567.89` — commas group, and a dot is the decimal mark. */
const COMMA_GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/
/* `1.234,56` and `1234,56` — a comma is the decimal mark. Tried only after the
   pattern above, so the one genuinely ambiguous spelling, `1,500`, reads as
   fifteen hundred rather than as one and a half. That is the reading that
   keeps more real files right: this grid's own files are comma-delimited, and
   a comma decimal cannot appear unquoted in one at all. */
const DECIMAL_COMMA = /^(?:\d{1,3}(?:\.\d{3})+|\d+),\d+$/

/**
 * A cell as a number, or NaN if it is not one.
 *
 * Thousands separators, a leading currency symbol, a trailing percent and
 * accounting's parenthesised negatives all read as the number they denote. A
 * percentage reads as what is written — `50%` is 50, not 0.5 — because the
 * column it is summed against is written the same way.
 *
 * A separator has to be well-formed to count as one; the patterns above say
 * what that means and which way the ambiguous spelling is decided.
 */
export function numericValue (text) {
  let value = String(text ?? '').trim()
  if (!value) return NaN
  let sign = 1
  if (/^\(.*\)$/.test(value)) { sign = -1; value = value.slice(1, -1).trim() }
  value = value
    .replace(/^[+-]?[$£€¥₹]\s*/, (m) => (m.trim().startsWith('-') ? '-' : ''))
    .replace(/%$/, '')
    .trim()
  /* The sign comes off before the grouping is checked: the patterns describe
     digits and their separators, and threading an optional sign through each
     of them would be the same rule written three more times. */
  if (value[0] === '+' || value[0] === '-') {
    if (value[0] === '-') sign = -sign
    value = value.slice(1).trim()
  }
  if (SPACE_GROUPED.test(value)) value = value.replace(/[\s\u00A0’'`]/g, '')
  if (COMMA_GROUPED.test(value)) value = value.replace(/,/g, '')
  else if (DECIMAL_COMMA.test(value)) value = value.replace(/\./g, '').replace(',', '.')
  if (!BARE_NUMBER.test(value)) return NaN
  return sign * Number(value)
}

/* The `k` resolutions, which are named for their width and ordered by their
   height — the one place the two conventions in this column disagree. Written
   out rather than derived, because `4k` is 2160 lines and `2k` is 1080: a
   column holding both has to sort 4K above 1440p and 2K below it, and no
   arithmetic on the digit does that. A closed list is also what keeps a column
   of `4k` meaning four thousand sales from being read as a screen — only these
   five spellings are resolutions, and `20k` is not one of them. */
const K_RESOLUTIONS = { 2: 1080, 4: 2160, 5: 2880, 6: 3384, 8: 4320 }

/* The named ones, in the spelling a spec sheet uses. */
const NAMED_RESOLUTIONS = {
  sd: 480, hd: 720, 'hd+': 900, fhd: 1080, qhd: 1440, wqhd: 1440, uhd: 2160, fuhd: 4320
}

/**
 * A cell as a screen resolution, in lines, or null.
 *
 * `1080p` is not a number — it has a letter on the end — so a column of them
 * used to be sorted as text, and text collation puts `4K` at the wrong end of
 * it: `4` reads as four, which is less than seven hundred and twenty. What the
 * column means is a height in pixels, so that is what it is compared as, and
 * `4K → 1440p → 1080p → 720p` comes out as the descending sort it looks like.
 *
 * Narrow on purpose, the same way `dateValue` is. Only the four shapes a
 * resolution is actually written in are read as one; anything else is left to
 * be a number or a word, because a column of product codes that happened to
 * end in `p` is not a column of screens.
 */
export function resolutionValue (text) {
  const value = String(text ?? '').trim().toLowerCase()
  if (!value) return null

  // 720p, 1080i, 2160P — scan lines, which is the number itself.
  const scan = /^(\d{3,5})\s*[pi]$/.exec(value)
  if (scan) return Number(scan[1])

  // 4k, 8K, 4 K — named for the width, so the table above says what it is.
  const k = /^(\d{1,2})\s*k$/.exec(value)
  if (k) return K_RESOLUTIONS[Number(k[1])] ?? null

  /* 1920x1080 — the height, with the width as a tiebreak far below it, so two
     screens of the same height sort by how wide they are and an ultrawide is
     not silently equal to a 16:9 panel. */
  const pair = /^(\d{3,5})\s*[x×*]\s*(\d{3,5})$/.exec(value)
  if (pair) return Number(pair[2]) + Number(pair[1]) / 1e6

  return NAMED_RESOLUTIONS[value] ?? null
}

/** A cell as a quantity: a resolution if it reads as one, otherwise a plain
 *  number. One function so that `1080p` and a bare `1080` in the same column
 *  land next to each other rather than in two blocks. */
const quantityValue = (text) => {
  const lines = resolutionValue(text)
  if (lines !== null) return lines
  const number = numericValue(text)
  return Number.isNaN(number) ? null : number
}

/* The slashed date, taken apart rather than handed to `Date.parse`.
 *
 * `Date.parse` reads `05/01/2024` as the fifth of January because the ECMAScript
 * specification says a non-ISO string is parsed however the implementation
 * pleases, and every implementation pleases to read it American-first. In a
 * British or European export that is the first of May, and — far worse — the
 * *thirteenth* of January comes back NaN, so `13/01/2024` was not a date at
 * all: it fell through to being a word, and `compareKeys` then compared a
 * moment against a string. That is how a column of 2023 and 2024 dates sorted
 * with January above the previous December and nothing on screen saying why.
 *
 * So the reading is decided per column, once, by `columnDateOrder`, and every
 * value in that column is then read the same way. */
const SLASHED = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})([T ].*)?$/

/** The order the app's own locale writes a slashed date in — the answer when
 *  the column's own values cannot settle it, which is every column whose days
 *  all happen to fall in the first twelve of the month.
 *
 *  Asked once. `formatToParts` builds a formatter, and a comparison sort would
 *  otherwise ask this question a few million times for one click. */
/** @type {string | null} */
let localeOrder = null
const localeDateOrder = () => {
  if (localeOrder) return localeOrder
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      day: '2-digit', month: '2-digit', year: 'numeric'
    }).formatToParts(new Date(Date.UTC(2000, 0, 2)))
    const day = parts.findIndex((part) => part.type === 'day')
    const month = parts.findIndex((part) => part.type === 'month')
    localeOrder = day >= 0 && month >= 0 && day < month ? 'dmy' : 'mdy'
  } catch {
    localeOrder = 'mdy'
  }
  return localeOrder
}

/**
 * Which way round a column writes its slashed dates.
 *
 * The file cannot say, so the column is asked. A first field above twelve can
 * only be a day, and a second field above twelve can only be a month's
 * neighbour — that is, the file is month-first. Both are proof; either one
 * settles the whole column, because a column mixing the two conventions is not
 * a thing any exporter produces and guessing per value is exactly the mixture
 * this fix exists to end.
 *
 * Where neither appears — twelve months of the first of the month, a column of
 * three rows — nothing in the data can decide it and the app's locale is the
 * best remaining guess.
 */
export function columnDateOrder (rows, base, col) {
  for (const index of base) {
    const parts = SLASHED.exec(String(rows[index]?.[col] ?? '').trim())
    if (!parts) continue
    if (Number(parts[1]) > 12) return 'dmy'
    if (Number(parts[2]) > 12) return 'mdy'
  }
  return localeDateOrder()
}

/** A two-digit year as the century a spreadsheet means by it: the POSIX split,
 *  which every one of them uses. */
const fullYear = (digits) => {
  const year = Number(digits)
  if (digits.length > 2) return year
  return year < 69 ? 2000 + year : 1900 + year
}

/**
 * A cell as a moment in time, or null.
 *
 * Deliberately narrow: only the two shapes that are unambiguously dates — ISO,
 * and the slashed form — get read, because handing everything to `Date.parse`
 * turns a product code into a year and sorts a column into nonsense.
 *
 * Built with `Date.UTC` rather than parsed. A local-time constructor puts a
 * column of dates an hour apart across a daylight-saving boundary, which is
 * invisible in the grid and real in the sort; UTC has no such seam and the
 * numbers are only ever compared against each other.
 *
 * @param order 'dmy' or 'mdy' — how this *column* writes a slashed date, from
 *              `columnDateOrder`. Nothing decides it per value: that is the
 *              bug, not the feature.
 */
const dateValue = (text, order = 'mdy') => {
  const value = String(text ?? '').trim()
  const iso = ISO_DATE.exec(value)
  if (iso) {
    const at = Date.parse(value)
    return Number.isNaN(at) ? null : at
  }
  const parts = SLASHED.exec(value)
  if (!parts) return null
  const day = Number(order === 'dmy' ? parts[1] : parts[2])
  const month = Number(order === 'dmy' ? parts[2] : parts[1])
  if (!day || day > 31 || !month || month > 12) return null
  const at = Date.UTC(fullYear(parts[3]), month - 1, day)
  return Number.isNaN(at) ? null : at
}

/* One collator, made once.
 *
 * `String.prototype.localeCompare` with options builds a collator on every
 * call, and a sort calls its comparator n log n times — which on a
 * two-hundred-thousand-row column is three and a half million collators for
 * one click on a heading, and two and a half seconds of frozen window. The
 * same comparisons through one reused collator take a seventh of a second and
 * come out in exactly the same order. */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'variant' })

/* What a cell is, worked out once rather than on every comparison it takes
   part in.
 *
 * The classification is the expensive half of comparing two cells — half a
 * dozen regular expressions per cell, to decide whether it is a quantity, a
 * date or a word — and a comparison sort asks the same question about the same
 * cell log n times over. So `sortedOrder` asks once per cell and compares the
 * answers; `compareCells` is the same thing for a single pair.

   The three ranks are an ordering in themselves: a quantity sorts before
   anything that is not one, which is what puts the data together and leaves a
   stray label at the end rather than interleaved by its spelling. Dates and
   words share a rank because a date is only compared as a moment when the
   *other* cell is one too — against a word it is a word, and sorting it
   anywhere else would be deciding that a column of mixed prose is really a
   calendar. */
const QUANTITY = 0
const MOMENT = 1
const WORD = 2

const cellKey = (text, order = 'mdy') => {
  const quantity = quantityValue(text)
  if (quantity !== null) return { rank: QUANTITY, value: quantity, text }
  const at = dateValue(text, order)
  if (at !== null) return { rank: MOMENT, value: at, text }
  return { rank: WORD, value: 0, text }
}

/** One cell classifier per column, with the column's date reading baked in and
 *  its answers remembered.
 *
 *  Many columns hold the same ten or twenty strings repeated two hundred
 *  thousand times, and `cellKey` runs half a dozen regular expressions per
 *  distinct value — so the duplicates pay once. */
const columnClassifier = (order) => {
  const cache = new Map()
  return (text) => {
    let hit = cache.get(text)
    if (hit === undefined) {
      hit = cellKey(text, order)
      cache.set(text, hit)
    }
    return hit
  }
}

/** The order two classified cells belong in. */
const compareKeys = (p, q) => {
  if (p.rank === QUANTITY || q.rank === QUANTITY) {
    if (p.rank !== QUANTITY) return 1
    if (q.rank !== QUANTITY) return -1
    return p.value === q.value ? 0 : (p.value < q.value ? -1 : 1)
  }
  if (p.rank === MOMENT && q.rank === MOMENT) {
    return p.value === q.value ? 0 : (p.value < q.value ? -1 : 1)
  }
  if (p.text === q.text) return 0
  /* The tiebreak is what keeps the sort total: the collator calls two spellings
     equal that are not the same string, and a comparator that returns 0 for
     them would leave their order to whatever the sort happened to do. */
  return COLLATOR.compare(p.text, q.text) || (p.text < q.text ? -1 : 1)
}

/**
 * The order two cells belong in: numbers as numbers, resolutions as the number
 * of lines they mean, dates as dates, and everything else by the locale's own
 * collation with digit runs compared as quantities — so `item2` comes before
 * `item10`.
 *
 * Numbers sort before text when a column holds both, which is the only stable
 * answer: it puts the data together and the stray label at one end, rather
 * than interleaving them by their spelling.
 */
export function compareCells (a, b, order = 'mdy') {
  const x = String(a ?? '')
  const y = String(b ?? '')
  if (x === y) return 0
  return compareKeys(cellKey(x, order), cellKey(y, order))
}

/**
 * `base` reordered by one column — `multiSortedOrder` with a single key.
 *
 * @param rows  every row of the file, in file order
 * @param base  the view's current row indices — filtered or not
 * @param col   which column to sort on
 * @param dir   'asc' or 'desc', or nothing for the file's own order
 */
export function sortedOrder (rows, base, col, dir) {
  return multiSortedOrder(rows, base, dir ? [{ col, dir }] : [])
}

/**
 * `base` reordered by several columns at once, the first being the strongest.
 *
 * Not the same thing as sorting twice. Sorting by surname and then by first
 * name gives a list ordered by first name, because the second sort is free to
 * move a row anywhere — the stability of the first only survives an exact tie
 * on the second key. What a person asking for "by department, then by name"
 * wants is one ordering with two keys, and that is what this is: the keys are
 * compared in turn and the first that disagrees settles the row.
 *
 * Each cell is classified once per column, before the sort starts, and the
 * comparator only ever looks at the answers — see `cellKey`. The comparator is
 * the one piece of code here that runs a few million times on a large file, so
 * anything it can be told in advance, it is.
 *
 * @param rows  every row of the file, in file order
 * @param base  the view's current row indices — filtered or not
 * @param sorts [{ col, dir }] — strongest key first; `dir` is 'asc' or 'desc'
 */
export function multiSortedOrder (rows, base, sorts) {
  const keys = (sorts ?? []).filter((key) => key && key.dir)
  if (!keys.length) return base.slice()

  /* One reading of a slashed date per column, decided from that column's own
     values — the whole of item four's fix. Worked out here rather than inside
     the comparator because it is a question about the column, and asking it
     per value is what let `05/01` and `13/01` be read two different ways in
     the same sort. */
  const plans = keys.map(({ col, dir }) => ({
    col,
    sign: dir === 'desc' ? -1 : 1,
    classify: columnClassifier(columnDateOrder(rows, base, col))
  }))

  const keyed = base.map((index, at) => {
    const row = rows[index] || []
    const cells = plans.map((plan) => {
      const text = String(row[plan.col] ?? '')
      // A blank is decided before anything else and never compared, so it is
      // not worth classifying one.
      return text.trim() === '' ? null : plan.classify(text)
    })
    return { index, at, cells }
  })

  keyed.sort((p, q) => {
    for (let i = 0; i < plans.length; i++) {
      const a = p.cells[i]
      const b = q.cells[i]
      /* Blanks go last in both directions — a descending sort that opened with
         a screen of empty cells would be answering a question nobody asked. */
      if (!a || !b) {
        if (a === b) continue
        return a ? -1 : 1
      }
      const verdict = plans[i].sign * compareKeys(a, b)
      if (verdict) return verdict
    }
    // Ties keep the order they came in, so the view stays where the reader is.
    return p.at - q.at
  })
  return keyed.map((k) => k.index)
}

/* ------------------------------------------------------------- the finding

   What "matching" means, in one place, because four things ask it and they must
   never disagree: the highlight on the cells, the count on the bar, ⌘G, and
   "Only matches" hiding the rows that do not.

   Three readings, and the reason there is more than one:

     substring   the default, and what a person means nine times out of ten
     whole cell  `12` finding the cell that says twelve and not the one that
                 says 120 — the only way to find an id or a code in a column
                 full of longer ones
     regular     the reading a replace-all needs to be worth having, since
     expression  `^\s+` and `(\d{4})-(\d{2})` are what a column of scraped
                 data has to be cleaned with

   A matcher is made once per keystroke and asked a few hundred thousand times,
   so it is an object with the decisions already taken rather than a function
   that re-reads the flags on every cell. */

/**
 * How to recognise `query` in a cell, and how to replace it there.
 *
 * @param {string} query what was typed into the find box
 * @param {{regex?: boolean, whole?: boolean}} [options] both off is a
 *   case-insensitive substring
 * @returns {{
 *   regex: boolean, whole: boolean, query: string,
 *   test: (text: string) => boolean,
 *   replace: (text: string, replacement: string) => string
 * }|null} null when there is nothing to look for, or when `regex` is on and
 *          what was typed is not yet a regular expression. A half-typed
 *          `(\d+` is the ordinary state of a box being typed into, so it is
 *          "no matcher yet" rather than an error to shout about.
 */
export function makeMatcher (query, { regex = false, whole = false } = {}) {
  const source = String(query ?? '')
  if (!source.trim()) return null

  if (regex) {
    let pattern
    try {
      pattern = new RegExp(whole ? `^(?:${source})$` : source, 'giu')
    } catch {
      try {
        // Without `u`, so the many patterns that are valid only in the older
        // grammar — a bare `\p`, an unescaped `{` — still work.
        pattern = new RegExp(whole ? `^(?:${source})$` : source, 'gi')
      } catch {
        return null
      }
    }
    return {
      regex: true,
      whole,
      query: source,
      test (text) {
        pattern.lastIndex = 0
        return pattern.test(String(text ?? ''))
      },
      replace (text, replacement) {
        pattern.lastIndex = 0
        /* `$1` and friends are what a regular-expression replace is for, so
           the replacement is handed to the engine rather than escaped. */
        return String(text ?? '').replace(pattern, replacement)
      }
    }
  }

  const needle = source.toLowerCase()
  return {
    regex: false,
    whole,
    query: source,
    test (text) {
      const value = String(text ?? '').toLowerCase()
      return whole ? value === needle : value.includes(needle)
    },
    replace (text, replacement) {
      const value = String(text ?? '')
      if (whole) return value.toLowerCase() === needle ? replacement : value
      /* Case-insensitively, and without a regular expression: escaping the
         needle to build one would be a second place for the two readings to
         drift apart. */
      let out = ''
      let at = 0
      const lower = value.toLowerCase()
      for (;;) {
        const found = lower.indexOf(needle, at)
        if (found < 0) break
        out += value.slice(at, found) + replacement
        at = found + needle.length
      }
      return out + value.slice(at)
    }
  }
}

/** The rows of `base` holding `query` anywhere in them. An empty query is
 *  every row: the filter box being empty is not a filter.
 *
 *  @param options the find box's own — see `makeMatcher`. A matcher may be
 *                 passed straight in, which is what the grid does so that a
 *                 pattern is compiled once rather than once per call. */
export function filterOrder (rows, base, query, options = {}) {
  const matcher = query && typeof query === 'object' && typeof query.test === 'function'
    ? query
    : makeMatcher(query, options)
  if (!matcher) return base.slice()
  return base.filter((index) => {
    const row = rows[index] || []
    for (const cell of row) {
      if (matcher.test(cell)) return true
    }
    return false
  })
}

/* ------------------------------------------------------ the column filter

   Finding highlights; filtering takes rows away. They answer different
   questions — "where does it say TV Show" against "show me only the TV shows"
   — and the second one is the question a column of categories is usually being
   asked, so it gets a control of its own rather than a mode on the find box.

   A filter is per column and is a set of *hidden* values, not kept ones. That
   way round for two reasons: a value typed into the column after the filter
   was set is shown rather than silently swallowed by a list that could not
   have known about it, and unticking one category out of forty is one entry
   rather than thirty-nine. Filters on different columns are all applied — type
   is TV Show *and* year is not blank — which is what picking in two columns
   reads as. */

/**
 * Every distinct value in one column, with how many of `base`'s rows hold it.
 *
 * Ordered the way sorting that column orders it — numbers as numbers, blanks
 * last — because this list is read by scanning it for the one you want, and
 * `10` filed between `1` and `2` is a list you cannot scan. Blank is a value
 * like any other here: rows with nothing in the column are a group a person
 * means to keep or drop, and no other control in the grid can name them.
 *
 * @returns [{ value, count }] — `value` is the cell's text, blanks as ''
 */
export function columnValues (rows, base, col) {
  const counts = new Map()
  for (const index of base) {
    const text = String(rows[index]?.[col] ?? '')
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  /* The same reading of a slashed date the sort uses, for the same reason: a
     panel that listed the column's dates in one order while the heading sorted
     them in another would be two answers to one question. */
  const order = columnDateOrder(rows, base, col)
  /* Classified once per value rather than on every comparison — the same
     economy `multiSortedOrder` makes, and for the same reason: `cellKey` is
     half a dozen regular expressions, and a sort asks n log n times. */
  const classify = columnClassifier(order)
  const list = [...counts].map(([value, count]) =>
    ({ value, count, key: value.trim() === '' ? null : classify(value) }))
  list.sort((p, q) => {
    if (!p.key || !q.key) return !p.key && !q.key ? 0 : (!p.key ? 1 : -1)
    return compareKeys(p.key, q.key)
  })
  return list.map(({ value, count }) => ({ value, count }))
}

/**
 * The rows of `base` that every column filter lets through.
 *
 * @param filters a Map from column index to the Set of values hidden in it. An
 *                empty set is no filter at all, so clearing one by unticking
 *                its last box does not have to remember to delete the entry.
 */
export function filteredOrder (rows, base, filters) {
  const live = [...(filters ?? new Map())].filter(([, hidden]) => hidden?.size)
  if (!live.length) return base.slice()
  return base.filter((index) => {
    const row = rows[index] || []
    for (const [col, hidden] of live) {
      if (hidden.has(String(row[col] ?? ''))) return false
    }
    return true
  })
}

/** Two corners as the rectangle between them. */
export function normalRect (a, b) {
  return {
    r0: Math.min(a.r, b.r),
    r1: Math.max(a.r, b.r),
    c0: Math.min(a.c, b.c),
    c1: Math.max(a.c, b.c)
  }
}

/* -------------------------------------------------------- the arithmetic

   What a selection adds up to. The question a person selects a column of
   numbers in order to ask, and the reason every spreadsheet keeps a corner of
   its window for the answer. */

/**
 * The totals for a run of cells.
 *
 * `numericValue` decides what counts, which means the punctuation an export
 * wears — currency signs, thousands separators, accounting's parentheses —
 * adds up as the number it denotes, and a stray `n/a` in a column of prices is
 * skipped rather than poisoning the total. A resolution is deliberately not a
 * number here: `1080p` sorts as a height because that is what the column
 * means, but a column of screens has no sum, and offering one would be
 * inventing a quantity.
 *
 * The average is over the cells that *were* numbers, not over the selection —
 * which is what a spreadsheet reports, and the only figure that does not
 * change when a blank row is caught in the drag.
 *
 * @param values  an iterable, so a large rectangle can be walked rather than
 *                collected into an array first
 */
export function selectionStats (values) {
  let cells = 0
  let filled = 0
  let numbers = 0
  let sum = 0
  let min = Infinity
  let max = -Infinity
  /* Kahan's running compensation. A column of two-decimal prices summed left
     to right in binary floating point drifts, and the drift surfaces as a
     total ending in `.00000000004` — which reads as a bug in the file rather
     than in the arithmetic. This costs one subtraction per cell and removes
     the whole class of it. */
  let carry = 0

  for (const value of values) {
    cells++
    const text = String(value ?? '')
    if (!text.trim()) continue
    filled++
    const n = numericValue(text)
    if (Number.isNaN(n)) continue
    numbers++
    const adjusted = n - carry
    const total = sum + adjusted
    carry = (total - sum) - adjusted
    sum = total
    if (n < min) min = n
    if (n > max) max = n
  }

  return {
    cells,
    filled,
    numbers,
    sum: numbers ? sum : 0,
    average: numbers ? sum / numbers : 0,
    min: numbers ? min : 0,
    max: numbers ? max : 0
  }
}

/** A total as a person reads one: grouped, and with a fraction only where
 *  there is one. Four places is where a sum of money or a percentage stops
 *  being informative and starts being the float's own noise. */
export function formatStat (value) {
  if (!Number.isFinite(value)) return '—'
  const size = Math.abs(value)
  // Past what grouping can help with, and below what four places can show.
  if (size >= 1e15 || (size > 0 && size < 1e-4)) return value.toExponential(4)
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

/* --------------------------------------------------------- the clipboard

   Tab-separated, because that is what every spreadsheet puts on the clipboard
   and the only thing all of them read back. A cell holding a tab or a newline
   is quoted the same way the file quotes one, which is what Excel and Numbers
   and Sheets all do with theirs. */

export function gridToClipboard (grid) {
  return grid
    .map((row) => row
      .map((cell) => {
        const value = String(cell ?? '')
        return /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
      })
      .join('\t'))
    .join('\n')
}

/**
 * Clipboard text as a grid. Tabs win where there are any — that is a
 * spreadsheet's copy — and commas are read as a delimiter only in their
 * absence, which is what makes pasting a snippet of CSV work.
 */
export function parseClipboardGrid (text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (!source) return [['']]
  const delimiter = source.includes('\t') ? '\t' : (source.includes(',') ? ',' : '\t')
  /* Strictly quoted even under tabs: this text came off a clipboard, and a
     spreadsheet's copy *does* quote a multi-line cell — the leniency that
     saves `"5 inch` in a file would tear that cell in half here. */
  const grid = parseSeparated(source, delimiter, { strictQuotes: true })
  return grid.length ? grid : [['']]
}

/* ----------------------------------------------------------- the exports

   The same table, said in three other languages. A CSV is the lowest common
   denominator and that is exactly its problem: the thing you were going to do
   with it next wants a TSV because it is going into a shell pipeline, or JSON
   because it is going into a script, or a Markdown table because it is going
   into a note in this very vault. All three are two lines of code and none of
   them is two lines of code the reader should have to write.

   Kept beside the parser rather than in the grid because they are the same
   kind of thing it is — a table in, text out, and nothing about the screen. */

/** The table as tab-separated values. Not `formatSeparated` with a tab: the
 *  point of a TSV is that a field never needs quoting, so a tab or a newline
 *  inside a value is spelled the way the format's readers expect — escaped,
 *  the way `\t` is in every other tab-separated thing. */
export function gridToTsv (rows, newline = '\n') {
  return rows
    .map((row) => row
      .map((cell) => String(cell ?? '').replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r?\n/g, '\\n'))
      .join('\t'))
    .join(newline) + (rows.length ? newline : '')
}

/**
 * The table as JSON: an array of objects, keyed by the headings.
 *
 * Objects rather than arrays of arrays, because a script reading this wants
 * `row.price` and not `row[7]` — and a heading is the one thing a CSV does
 * carry that says which is which. A blank or duplicated heading would make two
 * keys collide silently, so those become `column 8` and `price (2)`: a name
 * nobody wrote is better than a field nobody can see has been overwritten.
 *
 * Values stay strings. A CSV holds text, and deciding here that `007` is seven
 * or that `1-2` is a date is the guess that has cost every other CSV-to-JSON
 * tool its reputation.
 */
export function gridToJson (header, rows) {
  const keys = []
  const taken = new Map()
  header.forEach((name, c) => {
    const base = String(name ?? '').trim() || `column ${c + 1}`
    const seen = taken.get(base) ?? 0
    taken.set(base, seen + 1)
    keys.push(seen ? `${base} (${seen + 1})` : base)
  })
  return JSON.stringify(rows.map((row) => {
    const out = {}
    keys.forEach((key, c) => { out[key] = String(row[c] ?? '') })
    return out
  }), null, 2) + '\n'
}

/**
 * The table as a Markdown table, for pasting into a note.
 *
 * A pipe inside a value ends the cell, so it is escaped; a newline inside one
 * cannot be written at all in this dialect, so it becomes a `<br>` — which is
 * what every Markdown renderer in the vault already draws as a line break, and
 * is far better than a table that silently loses half a value.
 *
 * The columns are not padded to a common width. A padded table is pleasant to
 * read in the source and turns a table of a thousand rows into a wall whose
 * every line changes when one cell grows; the renderer does not care either
 * way, and the reader can always run a formatter over it.
 */
export function gridToMarkdown (grid) {
  if (!grid.length) return ''
  const escape = (cell) => String(cell ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
  const line = (cells) => `| ${cells.join(' | ')} |`
  const width = grid.reduce((most, row) => Math.max(most, row.length), 0)
  const at = (row, c) => escape(row[c] ?? '')
  const body = grid.slice(1).map((row) =>
    line(Array.from({ length: width }, (_, c) => at(row, c))))
  return [
    line(Array.from({ length: width }, (_, c) => at(grid[0], c))),
    line(Array.from({ length: width }, () => '---')),
    ...body
  ].join('\n') + '\n'
}

/* ------------------------------------------------------- the header choice

   Whether a file's first row is its headings, remembered for the session.

   Per path and at module level rather than on the grid instance, because the
   choice outlives the instance: closing the tab and reopening the file goes
   through a fresh `open`, and a reader who has said "this file has no header
   row" has said it about the file, not about the tab. The sidecar store's
   `clean` pass strips keys it does not know, so this cannot live there without
   a main-process change; the session is what can be kept from here. */
const headerChoice = new Map()

/** The headings a headerless file is shown under: the spreadsheet alphabet,
 *  because `A, B, C … AA, AB` is what every reader of a table already knows
 *  the anonymous columns are called. */
export function numberedHeader (count) {
  const names = []
  for (let c = 0; c < Math.max(1, count); c++) {
    let name = ''
    for (let n = c; n >= 0; n = Math.floor(n / 26) - 1) {
      name = String.fromCharCode(65 + (n % 26)) + name
    }
    names.push(name)
  }
  return names
}

/* -------------------------------------------------------- the restored view

   What `place` may carry back into `open`, checked rather than trusted.

   `place()` is round-tripped through the renderer on every reload an external
   change forces, and the file may have changed shape on the way: a column the
   sort named may be gone, a filter may key a column that no longer exists.
   Each piece is validated against the file as it is *now*, and whatever no
   longer fits is dropped silently — a sort on a vanished column is not worth a
   dialog, it is worth the file's own order. */

/** The sort keys `place` carried, kept only where they still name a column. */
export function restoredSorts (place, width) {
  const asked = Array.isArray(place?.sorts) ? place.sorts : []
  const seen = new Set()
  const kept = []
  for (const key of asked) {
    const col = Number(key?.col)
    if (!Number.isInteger(col) || col < 0 || col >= width || seen.has(col)) continue
    if (key.dir !== 'asc' && key.dir !== 'desc') continue
    seen.add(col)
    kept.push({ col, dir: key.dir })
  }
  return kept
}

/** The column filters `place` carried, as the Map of hidden-value Sets the
 *  grid keeps them in. */
export function restoredFilters (place) {
  const filters = new Map()
  const asked = Array.isArray(place?.filters) ? place.filters : []
  for (const entry of asked) {
    if (!Array.isArray(entry)) continue
    const col = Number(entry[0])
    if (!Number.isInteger(col) || col < 0) continue
    const hidden = new Set((Array.isArray(entry[1]) ? entry[1] : []).map((v) => String(v)))
    if (hidden.size) filters.set(col, hidden)
  }
  return filters
}

/* --------------------------------------------------------------- the grid */

/**
 * Mount the grid into `host`. One instance for the life of the window; `open`
 * points it at a file and `close` lets go of one.
 *
 * @param {object} args         what the grid is mounted into and talks to
 * @param {any} args.host      the element the grid is mounted into
 * @param {any} args.file      the renderer's `api.file` — `read` and `write`
 * @param {any} [args.layout]  where column widths are kept, since the file cannot keep
 *                   them itself — `api.tableWidths`, or nothing, in which case
 *                   the columns are measured afresh every time as they were
 * @param {(dirty: boolean) => void} args.onDirty    told whenever the unsaved state changes
 * @param {() => void} args.onSaved    told when a save lands clean
 * @param {(message: string) => void} args.onStatus   told when something worth a line of status happened
 * @param {() => void} args.onSelection told when the selection settles on something new, so the
 *                   status line can ask what it adds up to
 */
export function mountCsv ({
  host, file, layout = null, onDirty, onSaved,
  onStatus = () => {}, onSelection = () => {}
}) {
  const frame = document.createElement('div')
  frame.className = 'csv-frame'

  /* ------------------------------------------------------------- the bar */

  const bar = document.createElement('div')
  bar.className = 'csv-bar'

  const search = document.createElement('input')
  search.className = 'csv-search'
  search.type = 'search'
  search.placeholder = 'Find in table'
  search.spellcheck = false

  const found = document.createElement('span')
  found.className = 'csv-found'

  /* The find box, promoted to a filter. Hidden until something is typed,
     because a toggle for a box with nothing in it is a control that cannot do
     anything. See `setOnlyMatches`. */
  const onlyBtn = button('Only matches', 'only-matches',
    'Hide the rows that do not match what you typed')

  /* The column filter's way in from the keyboard and from a bar that can be
     read, since the funnel in a heading only shows on hover. It acts on the
     column the cursor is in — see `openFilter`. */
  const filterBtn = button('Filter…', 'filter', keyLabel('Filter this column by its values (⇧⌘F)'))
  const clearFilters = button('Clear filters', 'clear-filters',
    'Show every row again')

  /* What the file is separated by, shown only when that is worth saying —
     see `paintBar`. Reading a file with the wrong delimiter is the one failure
     that leaves the grid looking like it works, so the answer is on the bar
     rather than in a menu, and it is a control rather than a label because a
     guess that went wrong has to be correctable by the person who can see it
     went wrong. */
  const delimiterPick = dropdown(/** @type {any} */ ({
    label: 'Delimiter',
    className: 'csv-delimiter',
    options: DELIMITER_CANDIDATES.map((candidate) => ({
      value: candidate, label: delimiterName(candidate)
    })),
    onChange: (candidate) => { useDelimiter(candidate) }
  }))
  delimiterPick.root.title = 'What separates the values in this file'
  delimiterPick.root.hidden = true

  /* A way of looking rather than an edit, so it sits with the sort chips and
     stays on the bar in Reading view. */
  const fitAll = button('Fit columns', 'fit', keyLabel('Fit every column to its content (⌥⌘F)'))

  /* A horizontal scrollbar is an overlay on macOS and disappears when the
     pointer is still. When Copilot narrows the table that made the columns to
     the right look absent rather than merely off-screen. These two compact
     controls stay on the bar only while there is somewhere to move. */
  const scrollBack = button('‹', 'scroll-left', 'Show earlier columns')
  const scrollForward = button('›', 'scroll-right', 'Show later columns')
  for (const [control, label] of /** @type {[HTMLButtonElement, string][]} */ ([
    [scrollBack, 'Scroll to earlier columns'],
    [scrollForward, 'Scroll to later columns']
  ])) {
    control.classList.add('is-column-scroll')
    control.setAttribute('aria-label', label)
  }

  const undoBtn = button('↶', 'undo', keyLabel('Undo (⌘Z)'))
  const redoBtn = button('↷', 'redo', keyLabel('Redo (⇧⌘Z)'))
  const addRow = button('+ Row', 'add-row', keyLabel('Add a row below the cursor (⌘⏎)'))
  const addCol = button('+ Column', 'add-col', 'Add a column after this one')

  const gap = document.createElement('span')
  gap.className = 'csv-bar-gap'

  /* ⌘F opens the complete find-and-replace strip. It stays folded away until
     then so the ordinary table bar does not carry search modes or a second
     text field that are irrelevant while the table is being read. */
  const replaceBox = document.createElement('input')
  replaceBox.className = 'csv-replace'
  replaceBox.type = 'text'
  replaceBox.placeholder = 'Replace with'
  replaceBox.spellcheck = false
  replaceBox.hidden = true
  const replaceOneBtn = button('Replace', 'replace-one', 'Replace this cell’s match and find the next')
  const replaceAllBtn = button('Replace all', 'replace-all',
    'Replace every match in the rows on screen')
  replaceOneBtn.hidden = true
  replaceAllBtn.hidden = true

  bar.append(search, replaceBox, replaceOneBtn, replaceAllBtn, onlyBtn, found, gap,
    delimiterPick.root, filterBtn, clearFilters, fitAll, scrollBack, scrollForward,
    undoBtn, redoBtn, addRow, addCol)

  function button (label, act, title) {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'csv-btn'
    element.dataset.act = act
    element.textContent = label
    element.title = title
    return element
  }

  /* ------------------------------------------------------------ the grid */

  const headRow = document.createElement('div')
  headRow.className = 'csv-head'
  headRow.setAttribute('role', 'row')
  // The header is row one; the body starts at two. See `buildRow`.
  headRow.setAttribute('aria-rowindex', '1')

  const scroller = document.createElement('div')
  scroller.className = 'csv-scroller'
  /* In the tab order, because it is the grid: the keys that move the cursor
     are handled here, and a table only a mouse can reach is not one. */
  scroller.tabIndex = 0

  /* The full height of the table, whether or not those rows exist in the DOM —
     this is what gives the scrollbar its true size. The rows in view are
     positioned inside it. */
  const canvas = document.createElement('div')
  canvas.className = 'csv-canvas'
  const window_ = document.createElement('div')
  window_.className = 'csv-window'
  canvas.append(window_)
  scroller.append(canvas)

  const menu = document.createElement('div')
  menu.className = 'csv-menu'
  menu.hidden = true

  /* The column filter's panel. A sibling of the menu and positioned the same
     way, but it is not a menu: it stays open while boxes are ticked, because
     picking three categories out of a column is three decisions and a menu
     that closed after each of them would be three trips back to the heading. */
  const filterPanel = document.createElement('div')
  filterPanel.className = 'csv-filter'
  filterPanel.hidden = true

  /* The grid, to anything reading the page rather than looking at it.
   *
   * All of this was bare `div`s, which is to say a screen reader was told
   * there was a table here by nothing at all: no shape, no headings, no sense
   * of which cell the cursor was in. The roles below are the same structure
   * the eye already gets from the layout.
   *
   * It has to wrap the headings *and* the body, which is why there is an
   * element here at all: those are two separately-scrolled strips — see
   * `syncHeadScroll` — and a `role="grid"` on either one alone would describe
   * a table with no headings, or headings belonging to no table. The find box
   * and the buttons stay outside it, because a toolbar is not a row.
   *
   * `aria-rowcount` and `aria-colcount` are the whole file, while only the
   * band in view exists to be walked. That is exactly what those attributes
   * are for: they let a virtual grid say how big it really is, so "row 4 of
   * 200,000" is what gets announced rather than "row 4 of 56". */
  const table = document.createElement('div')
  table.className = 'csv-table'
  table.setAttribute('role', 'grid')
  /* More than one cell can be selected at a time, and — since ⌘-click — more
     than one block of them. `aria-selected` on the cells says which. */
  table.setAttribute('aria-multiselectable', 'true')
  table.append(headRow, scroller)

  /* One line under the bar for the things the grid has to say *about the
     file* rather than about what was just done.
   *
     The status line is the wrong place for these. It is transient, it is
     shared with every other document in the window, and what belongs here is
     neither: "this file could not be decoded and is open read-only" and "you
     are looking at the first fifty thousand rows of a million" are conditions
     that hold for as long as the file is open, and each of them comes with
     something the reader may want to do about it. So they sit against the
     table they are about, with their own buttons, and they do not go away on
     their own. */
  const notice = document.createElement('div')
  notice.className = 'csv-notice'
  notice.hidden = true
  notice.setAttribute('role', 'status')
  const noticeText = document.createElement('span')
  noticeText.className = 'csv-notice-text'
  const noticeActions = document.createElement('span')
  noticeActions.className = 'csv-notice-actions'
  notice.append(noticeText, noticeActions)

  frame.append(bar, notice, table, menu, filterPanel)
  host.replaceChildren(frame)

  /** @type {any} */
  /* Everything about the file that is not its rows: where it is, how it is
     separated, how its bytes spell its characters, the shape it was written in
     and the stamp it had when it was read. All of it goes back on when it is
     written — see `saveFile`. */
  let current = null          // { path, delimiter, newline, shape, encoding, bom, stamp }
  let rows = []               // the body: every row after the header
  let header = []
  let widths = []
  let numeric = []            // per column: does it read as numbers?
  /* Per column: the alignment somebody asked for, or null for the one the
     content implies. A view of the file rather than a fact in it — a CSV has
     nowhere to say which way a column reads — so it is kept beside the widths
     and never written into the data. */
  let aligns = []
  /* The view. Every display position is an index into this, and every index in
     it is a row of `rows` — which stays in the file's own order throughout. */
  let order = []
  /* The sort, as a list of keys rather than one.
   *
   * "By department, then by name" is one ordering with two keys and not two
   * sorts: sorting twice gives a list ordered by the *second* column, because
   * the second sort is free to move any row that is not an exact tie on its own
   * key. So the keys are kept and compared in turn — see `multiSortedOrder` —
   * and `sorts[0]` is the strongest. An empty list is the file's own order. */
  let sorts = []              // [{ col, dir }], strongest first
  let query = ''
  /* Column index → the Set of values hidden in that column. A way of looking,
     like the sort: it lives in `order` and never touches `rows`, so filtering
     a two-hundred-thousand-row export and saving writes the file it opened. */
  let filters = new Map()
  /* Whether the find box hides what it does not match, rather than only
     marking it. Off by default: finding is the more common thing to want from
     a box you can type into without meaning to lose your place. */
  let onlyMatches = false
  /* Compiled once per keystroke rather than once per cell. */
  /** @type {any} */
  let matcher = null
  let replacing = false
  /* Whether the file's first row is its headings. True for very nearly every
     file, and wrong often enough to be worth a switch: a headerless export
     opened as though it had one loses its first row of data to the column
     heads, where it cannot be sorted, filtered, totalled or even seen
     properly. */
  let hasHeader = true
  let dirty = false
  /** @type {Promise<any> | null} */
  let saving = null
  let flushRequested = false
  /* Counts edits rather than describing them. A write is not instant and a
     hundred-thousand-row file takes a real fraction of a second to format and
     put on disk; anything typed during one belongs to a version of the file
     that is not the version being written. See `saveFile`. */
  let revision = 0
  let cursor = { r: 0, c: 0 } // view coordinates; -1 row means the header
  let anchor = { r: 0, c: 0 }
  /* The blocks a ⌘-click added, which the anchor and the cursor cannot hold
     because they describe one rectangle. See "the selection". */
  let extras = []
  /* Whether the cursor is being *shown*. Escape puts it away, which is what
     "deselect" means in a grid — but the coordinates stay, so an arrow key
     picks up where the selection was rather than jumping back to A1. Anything
     that puts the cursor somewhere shows it again; see `showCursor`. */
  let shown = true
  /** @type {any} */
  let editing = null          // { r, c, input } while a cell is open
  let firstBuilt = -1
  let lastBuilt = -1
  let firstColBuilt = -1
  let lastColBuilt = -1
  /** @type {string | null} */
  let dragging = null         // 'cells' | 'rows' while a drag-select is on
  let history = []
  let future = []
  /* What the sort was before the click that may turn out to be a double one —
     see the heading's `dblclick`, which has to put back the sort its own first
     click performed. */
  /** @type {any} */
  let sortBeforeClick = null

  /** The key on one column, or nothing. Most of the grid only ever asks about
   *  one column at a time — the heading it is painting, the column that was
   *  just edited — and this is that question. */
  const sortOn = (col) => sorts.find((key) => key.col === col) || null
  /** Where a column sits in the ordering, one-based, when there is more than
   *  one key. Zero means it is not a key, or is the only one. */
  const sortRank = (col) => {
    if (sorts.length < 2) return 0
    const at = sorts.findIndex((key) => key.col === col)
    return at < 0 ? 0 : at + 1
  }

  /* What the selection adds up to, and the rectangle it was worked out for.
     Held rather than computed on demand because the status line asks for it on
     every repaint, and a whole-column selection is a hundred thousand cells. */
  /** @type {any} */
  let stats = null
  /* The rectangle the totals were worked out for: a key while they hold, and
     null when there is no answer yet — which is both "nothing has been
     selected" and "what was selected has been edited under us". */
  /** @type {string | null} */
  let statsFor = null
  /** @type {any} */
  let statsTimer = null

  /* Reading or Editing — the same two views a note has, for the one document
     whose editor is this grid rather than the text one.

     Reading is the same grid. A file of half a million rows has no second way
     to be put on screen, and a "reading view" that could only show the first
     thousand of them would be a worse view of the file rather than a calmer
     one. What it takes out is the editing: no cell opens, no structure
     changes, and the bar keeps only the controls that are ways of *looking* —
     find, fit, sort. Sorting stays for the reason it is `order` and not an
     edit at all; writing that order into the file goes, because it is the one
     that writes. Copy stays, cut and paste do not: reading a table and taking
     a column out of it is reading. */
  let readonly = false

  /* Reading view is a preference; this is a *fact about the file* that makes
     writing it destructive — it could not be decoded, or only part of it was
     read. Kept apart from `readonly` because the two are cleared by entirely
     different things and because this one has to survive the view switch: a
     ⌘2 into Editing view must not hand somebody an editable preview of the
     first fifty thousand rows of a file with a million in it. */
  /** @type {{ why: string } | null} */
  let lock = null             // { why } or null

  /** The one guard, on every path that would change the file. It says why
   *  rather than doing nothing, so a double-click on a cell in Reading view
   *  explains itself instead of feeling broken. */
  const editable = () => {
    if (lock) { onStatus(lock.why); return false }
    if (!readonly) return true
    onStatus(keyLabel('Reading view — press ⌘2 to edit this table'))
    return false
  }

  /* --------------------------------------------------------- the notice */

  const hideNotice = () => {
    notice.hidden = true
    noticeText.textContent = ''
    noticeActions.replaceChildren()
  }

  /**
   * Say something about the file, with the things that can be done about it.
   *
   * Deliberately not dismissable by pressing Escape or clicking away. The two
   * things this says — the file could not be decoded, and only part of it was
   * read — are both cases where the reader is one keystroke from destroying
   * data, and a warning that a stray Escape takes away is a warning that will
   * be gone by the time it mattered. It goes when the condition does.
   */
  const showNotice = (text, actions = []) => {
    noticeText.textContent = text
    notice.className = 'csv-notice'
    const frag = document.createDocumentFragment()
    for (const action of actions) {
      const item = button(action.label, 'notice', action.title || action.label)
      item.classList.add('csv-notice-btn')
      item.addEventListener('click', () => { action.run() })
      frag.append(item)
    }
    noticeActions.replaceChildren(frag)
    notice.hidden = false
  }

  /* One command, two ways in.

     Cut, copy, paste, undo and redo can each arrive twice: once as the
     keystroke this file handles, and once as the window menu's item firing a
     DOM clipboard event or calling back through the renderer. Which of the two
     turns up depends on the platform's menu, so both are wired — and the
     second one is dropped. Without this, one ⌘V pastes twice.

     The suppression is one-directional on purpose. A keystroke always runs;
     it is the *other* path that stands down if a key just did the same thing.
     A guard that dropped any repeat inside the window would have swallowed
     every keystroke after the first of a held-down ⌘Z, which repeats every
     thirtieth of a second. */
  let lastKeyCommand = { name: '', at: 0 }
  const fromKey = (name, run) => {
    lastKeyCommand = { name, at: Date.now() }
    run()
  }
  const unlessKey = (name, run) => {
    if (lastKeyCommand.name === name && Date.now() - lastKeyCommand.at < 150) return
    run()
  }

  /* A cell's own name in the document. Unique per grid instance, because two
     tables open in two tabs would otherwise both claim `csv-cell-0-0` and
     `aria-activedescendant` would resolve to whichever came first. */
  const gridId = `csv-${Math.random().toString(36).slice(2, 8)}`
  const cellId = (r, c) => `${gridId}-${r}-${c}`

  const columns = () => widths.length
  const viewRows = () => order.length
  const bodyWidth = () => widths.reduce((sum, w) => sum + w, GUTTER)
  const sourceOf = (r) => (r === -1 ? -1 : order[r] ?? -1)
  /** Is anything hiding rows? The find box counts only while it is a filter. */
  const filtering = () =>
    [...filters.values()].some((hidden) => hidden.size) || (onlyMatches && !!query.trim())
  /* True when `order` is the file's own order, front to back — which is what
     lets an insert splice `rows` and rebuild rather than patch. A filter makes
     it false for the same reason a sort does: a rebuild would drop the blank
     row that was just asked for, since a blank matches nothing. */
  const plainOrder = () => !sorts.length && !filtering()

  const setDirty = (next) => {
    if (next) revision++
    if (dirty === next) return
    dirty = next
    onDirty(next)
  }

  /* ------------------------------------------------------------ measuring */

  /* The width of one character, measured rather than assumed. The grid is
     monospace, so a single advance describes every cell in it — and a guess
     that is a fraction of a pixel short is a fit that clips the last letter of
     the longest row, which is the one row the fit was asked for. Taken from
     the scroller's own computed font, so a theme with another mono face is
     measured in that face; re-measured whenever a file is opened, which is
     also when a webfont that arrived late gets picked up. */
  let charWidth = 0
  const charAdvance = () => {
    if (charWidth) return charWidth
    try {
      const style = getComputedStyle(scroller)
      const probe = /** @type {CanvasRenderingContext2D} */ (document.createElement('canvas').getContext('2d'))
      probe.font = `${style.fontSize} ${style.fontFamily}`
      // Over a run, so the result is an advance and not one glyph's bearings.
      charWidth = probe.measureText('0'.repeat(40)).width / 40
    } catch { /* no canvas in this window — the constant still stands */ }
    if (!charWidth || !Number.isFinite(charWidth)) charWidth = CHAR_WIDTH
    return charWidth
  }

  /** How wide a cell holding `text` needs to be. */
  const textWidth = (text) => text.length * charAdvance() + CELL_PADDING

  /**
   * The widths this file was left at, written down.
   *
   * A CSV has nowhere inside it to say how wide a column should be — the file
   * is the data and nothing else — so a fit or a drag used to last exactly as
   * long as the tab did. It is filed against the path instead, beside the
   * file's tags; see electron/path-store.js, which is also what carries it
   * through a rename.
   *
   * Not awaited by anything: the layout is already on screen, and a write that
   * fails leaves the columns where they are and the next open measuring them
   * as it always did.
   */
  const rememberWidths = () => {
    if (!current || !layout) return
    /* The delimiter travels with the widths because it is the same kind of
       fact: something true of this file that the file has no way to state.
       Written together so that one sidecar entry describes how the table is
       read as well as how it is laid out. */
    layout.set(current.path, {
      widths: widths.slice(),
      /* Null for every column that was never asked about, so what comes back
         is one entry per column and lines up with the widths beside it. */
      aligns: aligns.slice(),
      delimiter: current.delimiter
    }).catch(() => {})
  }

  /* Whether a saved layout is about this file *as it is now*. A column added
     or removed since — by a hand, or by whatever wrote the file while Tulip
     was closed — makes a list of the old length a description of a table that
     no longer exists, and applying it would shift every column's width onto
     its neighbour. Measuring afresh is the honest answer to that. */
  const layoutFits = (saved) => Array.isArray(saved) && saved.length === widths.length

  /* How wide a fit is allowed to make a column. The opening measure caps at
     MAX_COL so one long cell cannot open the file with the rest of the table
     off screen; a fit is a request to *see* the column and answers a different
     question, so it goes by FIT_CHARS instead — see the note there. */
  const fitCeiling = () => Math.max(MAX_COL, FIT_CHARS * charAdvance() + CELL_PADDING)

  /**
   * How many columns the file has: the longest row in it, header included.
   *
   * Every row, not a sample of them. How *wide* a column should be is a
   * question a sample answers well — the first few hundred rows are what the
   * width has to suit — but how *many* there are is not that kind of question.
   * A file whose four-hundredth row is the first to carry a fifth field has
   * five columns, and taking the count from the first two hundred and fifty
   * rows meant that field was never shown, never selected and never edited,
   * while `formatSeparated` went on writing it back out. Worse, a column
   * inserted or deleted splices at an index below it, so the hidden field
   * quietly changed which column it belonged to.
   *
   * The cost of being right is a pass that reads `.length` and nothing else —
   * no string work, no allocation — which on a million rows is a few
   * milliseconds against the parse that just built them.
   */
  const columnCount = () => {
    let count = Math.max(header.length, 1)
    for (const row of rows) if (row.length > count) count = row.length
    return count
  }

  const measure = () => {
    const count = columnCount()
    widths = new Array(count).fill(MIN_COL)
    numeric = new Array(count).fill(false)
    aligns = new Array(count).fill(null)
    const seen = new Array(count).fill(0)
    const numbers = new Array(count).fill(0)
    const consider = (row, body) => {
      for (let c = 0; c < count; c++) {
        const text = String(row[c] ?? '')
        const wanted = Math.min(MAX_COL, Math.max(MIN_COL, textWidth(text)))
        if (wanted > widths[c]) widths[c] = Math.round(wanted)
        if (!body || !text.trim()) continue
        seen[c]++
        if (!Number.isNaN(numericValue(text))) numbers[c]++
      }
    }
    consider(header, false)
    for (let i = 0; i < Math.min(rows.length, WIDTH_SAMPLE); i++) consider(rows[i], true)
    /* A column is a number column when nearly all of it is numbers — "nearly"
       because one `n/a` in a column of prices does not make it prose, and
       right-aligning the other nine hundred is what makes them readable. */
    for (let c = 0; c < count; c++) numeric[c] = seen[c] > 0 && numbers[c] / seen[c] >= 0.8
  }

  /** The width one column wants: its widest cell, and never narrower than the
   *  heading, which carries the sort mark, the funnel and the grip beside its
   *  label. */
  /* Whether the last fit wanted more room than it was allowed — read by
     `sayIfClipped` and set by nothing else. */
  let fitClipped = false

  const fittedWidth = (c) => {
    // +34 for the sort mark, the funnel and the grip, which sit beside the
    // heading's text.
    let wanted = textWidth(String(header[c] ?? '')) + 34
    const limit = Math.min(order.length, FIT_SCAN)
    for (let i = 0; i < limit; i++) {
      wanted = Math.max(wanted, textWidth(String(rows[order[i]]?.[c] ?? '')))
    }
    const ceiling = fitCeiling()
    if (wanted > ceiling) fitClipped = true
    return Math.round(Math.min(ceiling, Math.max(MIN_COL, wanted)))
  }

  /* A fit that read part of the file says so. Silence would read as "this is
     as wide as anything in the column", which past twenty thousand rows is a
     claim rather than a measurement. */
  const sayIfSampled = () => {
    if (order.length <= FIT_SCAN) return
    onStatus(`Fitted to the first ${FIT_SCAN.toLocaleString()} rows`)
  }

  /* And a fit that could not finish the job says that instead, along with what
     to do about it. A column left at the ceiling still ends in a clipped cell,
     and without a word here that reads as the fit having failed rather than as
     the value being longer than any column may be. */
  const sayIfClipped = () => {
    if (!fitClipped) return false
    onStatus('Some cells are longer than a column may be — press Enter on one to read it whole')
    return true
  }

  /** One column, as wide as its content. Double-clicking the divider asks for
   *  this; so does the heading's menu. */
  const fitColumn = (c) => {
    fitClipped = false
    widths[c] = fittedWidth(c)
    paint()
    rememberWidths()
    if (!sayIfClipped()) sayIfSampled()
  }

  /** Every column at once — one pass and one repaint, rather than the column's
   *  own fit run n times and the table relaid out after each of them.
   *
   *  A way of *looking* at the file and not an edit to it — the file itself is
   *  untouched and this is offered in Reading view too. It is remembered all
   *  the same, beside the file rather than in it: fitting the columns of a
   *  wide export and finding them back at their measured widths tomorrow is
   *  the same work done twice. */
  const fitAllColumns = () => {
    const count = columns()
    if (!count) return false
    fitClipped = false
    let changed = false
    for (let c = 0; c < count; c++) {
      const wanted = fittedWidth(c)
      if (wanted === widths[c]) continue
      widths[c] = wanted
      changed = true
    }
    if (!changed) return false
    paint()
    revealCursor()
    rememberWidths()
    if (!sayIfClipped()) sayIfSampled()
    /* The columns visibly move, which is the whole of the feedback the button
       and the menu need. What the caller does with the answer is the command
       palette's problem — it ran from a list and has nothing on screen to
       show for it. */
    return true
  }

  /* ------------------------------------------------------------- the view */

  /** Recompute `order` from the filters and the sort. Everything structural
   *  ends here, because both are functions of the rows.
   *
   *  Filtering first and sorting what is left, rather than the other way
   *  round: the sort is the expensive half and there is no reason to order
   *  rows that are about to be dropped. */
  const rebuildOrder = ({ keepSource = null } = {}) => {
    let next = rows.map((_, i) => i)
    next = filteredOrder(rows, next, filters)
    if (onlyMatches && query.trim()) {
      const flags = matchFlags()
      next = next.filter((i) => flags[i])
    }
    const keys = sorts.filter((key) => key.col < columns())
    if (keys.length) next = multiSortedOrder(rows, next, keys)
    order = next
    if (keepSource !== null) {
      const at = order.indexOf(keepSource)
      if (at >= 0) cursor = { ...cursor, r: at }
    }
    clampCursor()
  }

  const clampCursor = () => {
    const lastRow = viewRows() - 1
    const lastCol = Math.max(0, columns() - 1)
    cursor = {
      r: Math.max(-1, Math.min(lastRow, cursor.r)),
      c: Math.max(0, Math.min(lastCol, cursor.c))
    }
    anchor = {
      r: Math.max(-1, Math.min(lastRow, anchor.r)),
      c: Math.max(0, Math.min(lastCol, anchor.c))
    }
    /* The extra blocks are view coordinates too, and a shorter table leaves one
       hanging over the end. Most things that change the shape of the table
       collapse the selection outright — see `collapse` — so this is the belt to
       that braces: undo is the one path that puts a whole view back. */
    if (extras.length) {
      extras = extras.map((box) => ({
        r0: Math.max(-1, Math.min(lastRow, box.r0)),
        r1: Math.max(-1, Math.min(lastRow, box.r1)),
        c0: Math.max(0, Math.min(lastCol, box.c0)),
        c1: Math.max(0, Math.min(lastCol, box.c1))
      }))
    }
  }

  /* ------------------------------------------------------------- painting */

  /* The class that says it on a cell. A number column left alone keeps
     `csv-num`, which lines the digits up as well as pushing them right; a
     column pointed right by hand is only pushed right, because "align these
     names right" is not a claim that they are quantities. */
  const alignClass = (c) => {
    const asked = aligns[c]
    if (!asked) return numeric[c] ? 'csv-num' : ''
    return `csv-${asked}`
  }

  const cellStyle = (element, c) => {
    element.style.width = `${widths[c]}px`
    element.style.minWidth = `${widths[c]}px`
  }

  const gutterCell = (label, r) => {
    const cell = document.createElement('div')
    cell.className = 'csv-gutter'
    cell.dataset.row = String(r)
    // The line number names its row the way a heading names its column.
    cell.setAttribute('role', 'rowheader')
    cell.textContent = label
    return cell
  }

  /* ----------------------------------------------- where the columns are

     The same arithmetic the rows have always had, for the other axis. A row's
     height is a constant, so the row at a scroll offset is a division; a
     column's width is not, so the offsets are added up once and searched.

     Kept as a running total rather than recomputed per cell: laying out a row
     used to be a sum over every column to its left, which on a wide file is
     the quadratic version of a job that is linear. */
  let colLeft = [0]

  const layoutColumns = () => {
    const count = columns()
    colLeft = new Array(count + 1)
    colLeft[0] = 0
    for (let c = 0; c < count; c++) colLeft[c + 1] = colLeft[c] + widths[c]
  }

  /**
   * The columns that should exist right now.
   *
   * Rows were virtual from the beginning and columns were not, on the
   * reasonable assumption that a table is tall rather than wide. Exports are
   * both: a two-hundred-column file built two hundred cells for every row in
   * the band, forty thousand elements thrown away and remade on every scroll
   * tick, for the fifteen columns anybody could see.
   *
   * The gutter is frozen over the left edge, so the first column genuinely in
   * view starts a gutter's width into the scroll.
   */
  const visibleColumns = () => {
    const count = columns()
    if (!count) return { firstCol: 0, lastCol: 0 }
    const from = Math.max(0, scroller.scrollLeft - GUTTER)
    const to = from + (scroller.clientWidth || 800)
    /* `colLeft` is a running total, so both edges are binary searches rather
       than walks: on a two-hundred-column export the walks ran the whole
       offset array twice per scroll tick. `colLeft[0]` is zero, which is never
       past `from`, so the first search always has an answer. */
    let lo = 0
    let hi = count - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (colLeft[mid] <= from) lo = mid
      else hi = mid - 1
    }
    const firstCol = lo
    /* The first offset at or past `to`, or `count` when the row runs out
       first — which is exactly where the walk below used to stop, since it
       never looked at `colLeft[count]`. */
    lo = firstCol
    hi = count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (mid < count && colLeft[mid] < to) lo = mid + 1
      else hi = mid
    }
    return {
      firstCol: Math.max(0, firstCol - OVERSCAN_COLS),
      lastCol: Math.min(count, lo + OVERSCAN_COLS)
    }
  }

  /* The width the built cells are standing in for, on each side. A spacer
     rather than a margin so that the row is the same total width whichever
     columns happen to exist inside it — which is what keeps the horizontal
     scrollbar still while the table scrolls under it. */
  const spacer = (width) => {
    const pad = document.createElement('div')
    pad.className = 'csv-pad'
    // Width standing in for columns that are not here. There is nothing in it
    // to read, and a reader walking the row must not be stopped by it.
    pad.setAttribute('aria-hidden', 'true')
    pad.style.width = `${width}px`
    pad.style.minWidth = `${width}px`
    return pad
  }

  const paintHead = () => {
    layoutColumns()
    const { firstCol, lastCol } = visibleColumns()
    const frag = document.createDocumentFragment()
    const corner = gutterCell('', -2)
    corner.classList.add('csv-corner')
    corner.title = keyLabel('Select the whole table (⌘A)')
    frag.append(corner)
    frag.append(spacer(colLeft[firstCol]))
    for (let c = firstCol; c < lastCol; c++) {
      const cell = document.createElement('div')
      cell.className = 'csv-cell csv-th'
      const align = alignClass(c)
      if (align) cell.classList.add(align)
      cell.dataset.col = String(c)
      cell.dataset.row = '-1'
      cell.id = cellId(-1, c)
      cell.setAttribute('role', 'columnheader')
      cell.setAttribute('aria-colindex', String(c + 1))
      /* Which way this column is pointed, said rather than drawn — the mark
         beside the label is a triangle, and a triangle reads as nothing. */
      const key = sortOn(c)
      cell.setAttribute('aria-sort', key
        ? (key.dir === 'asc' ? 'ascending' : 'descending')
        : 'none')
      cell.title = readonly
        ? keyLabel('Click to sort · ⌘-click to select the column')
        : keyLabel('Click to sort · ⌘-click to select the column · double-click to rename')
      const hiding = filters.get(c)?.size ?? 0
      cell.classList.toggle('is-filtered', hiding > 0)

      const label = document.createElement('span')
      label.className = 'csv-th-label'
      label.textContent = header[c] ?? ''
      const mark = document.createElement('span')
      mark.className = 'csv-sort'
      /* The arrow, and — only when the ordering has more than one key — which
         key this column is. Without the number a table sorted by three columns
         shows three identical arrows and says nothing about which one wins. */
      const rank = sortRank(c)
      mark.textContent = key ? `${key.dir === 'asc' ? '▲' : '▼'}${rank || ''}` : ''
      /* Faint until the heading is hovered, and lit for good once the column
         is filtered — a funnel on every heading of a thirty-column export is
         thirty pieces of furniture, and a column that is hiding rows has to
         say so whether or not anything is under the pointer. */
      const funnel = document.createElement('span')
      funnel.className = 'csv-funnel'
      funnel.dataset.funnel = String(c)
      funnel.textContent = '⌄'
      funnel.setAttribute('aria-hidden', 'true')
      funnel.title = hiding
        ? `Filtered — hiding ${hiding.toLocaleString()} ${hiding === 1 ? 'value' : 'values'}`
        : 'Filter this column by its values'
      const grip = document.createElement('span')
      grip.className = 'csv-grip'
      grip.dataset.grip = String(c)
      grip.title = 'Drag to resize · double-click to fit'

      cell.append(label, mark, funnel, grip)
      cellStyle(cell, c)
      frag.append(cell)
    }
    frag.append(spacer(colLeft[columns()] - colLeft[lastCol]))
    headRow.replaceChildren(frag)
  }

  /* The heading strip cannot be `position: sticky` over a body whose rows do
     not all exist, so it is a second clipped strip kept level with the body by
     hand. Its own width is the pane's; the cells inside overflow it and are
     clipped, which is what makes this scroll rather than stretch. */
  const syncHeadScroll = () => { headRow.scrollLeft = scroller.scrollLeft }

  const paintColumnScroll = () => {
    const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
    const useful = max > 1
    scrollBack.hidden = !useful
    scrollForward.hidden = !useful
    scrollBack.disabled = !useful || scroller.scrollLeft <= 1
    scrollForward.disabled = !useful || scroller.scrollLeft >= max - 1
  }

  /** The rows that should exist right now, given where the scroller is. */
  const visibleRange = () => {
    const top = scroller.scrollTop
    const height = scroller.clientHeight || 400
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN)
    const last = Math.min(viewRows(), Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN)
    return { first, last }
  }

  const buildRow = (r, firstCol, lastCol) => {
    const line = document.createElement('div')
    /* Striped from the row's own index rather than from its position among the
       elements that happen to exist: with only the visible band built, a
       `:nth-child(even)` rule would make the stripes swap places every time
       the window scrolled past a row. */
    line.className = `csv-row${r % 2 ? ' is-odd' : ''}`
    line.dataset.row = String(r)
    line.setAttribute('role', 'row')
    /* Counted from one with the header as row one, and against the whole file
       rather than the band — which is what `aria-rowcount` on the grid is
       promising. */
    line.setAttribute('aria-rowindex', String(r + 2))
    line.style.top = `${r * ROW_HEIGHT}px`
    /* The file's own line number, not the view's: with a sort or a filter on,
       "row 4" has to keep meaning the fourth line of the file, or the number
       is decoration. */
    line.append(gutterCell(String(sourceOf(r) + 2), r))
    line.append(spacer(colLeft[firstCol]))
    const source = rows[sourceOf(r)] || []
    for (let c = firstCol; c < lastCol; c++) {
      const cell = document.createElement('div')
      cell.className = 'csv-cell'
      const align = alignClass(c)
      if (align) cell.classList.add(align)
      cell.dataset.row = String(r)
      cell.dataset.col = String(c)
      cell.id = cellId(r, c)
      cell.setAttribute('role', 'gridcell')
      cell.setAttribute('aria-colindex', String(c + 1))
      cell.textContent = source[c] ?? ''
      cellStyle(cell, c)
      line.append(cell)
    }
    line.append(spacer(colLeft[columns()] - colLeft[lastCol]))
    return line
  }

  /* The rows that exist, by their index in the view. Kept so that a scroll can
     add the row that came into view and drop the one that left, rather than
     rebuilding the whole band around them — which on a wide table was several
     thousand elements discarded and remade to move by one line. */
  const liveRows = new Map()

  const paintRows = ({ force = false } = {}) => {
    layoutColumns()
    const { first, last } = visibleRange()
    const { firstCol, lastCol } = visibleColumns()
    /* A column range that has moved changes the contents of every row, so
       there is nothing to keep; a row range that has moved changes which rows
       there are, and the ones still in view are the same rows they were. */
    const sameColumns = firstCol === firstColBuilt && lastCol === lastColBuilt
    if (!force && sameColumns && first === firstBuilt && last === lastBuilt) return
    /* An open editor is a live element inside the band about to be replaced.
       Commit it first: rebuilding the DOM around a focused input drops both
       the focus and, on a scroll that outran the keystroke, the edit. */
    if (editing) commitEdit()
    /* The headings are virtual on the same axis and have to move with the
       cells under them — a scroll sideways that rebuilt the body and left the
       strip above it alone would label every column with its neighbour's
       name. Only when the range moved: a scroll straight down leaves the
       headings exactly where they were. */
    if (!sameColumns) paintHead()

    /* Start from nothing when the cells themselves have to change, and from
       what is already there when only the range has moved. Either way what
       follows is the same: build the rows that are missing. */
    if (force || !sameColumns) {
      liveRows.clear()
      window_.replaceChildren()
    } else {
      for (const [r, line] of liveRows) {
        if (r < first || r >= last) { line.remove(); liveRows.delete(r) }
      }
    }

    const frag = document.createDocumentFragment()
    for (let r = first; r < last; r++) {
      if (liveRows.has(r)) continue
      const line = buildRow(r, firstCol, lastCol)
      liveRows.set(r, line)
      frag.append(line)
    }
    /* Appended rather than inserted in order: every row is positioned
       absolutely at its own offset, so where it sits among its siblings says
       nothing about where it appears. */
    if (frag.childNodes.length) window_.append(frag)

    firstBuilt = first
    lastBuilt = last
    firstColBuilt = firstCol
    lastColBuilt = lastCol
    window_.style.width = `${bodyWidth()}px`
    decorate()
  }

  const paint = () => {
    canvas.style.height = `${Math.max(viewRows() * ROW_HEIGHT, 1)}px`
    canvas.style.width = `${bodyWidth()}px`
    /* The size of the whole file, not of the band that exists. The header is
       counted as a row, which is what makes the body's indices start at two. */
    table.setAttribute('aria-rowcount', String(viewRows() + 1))
    table.setAttribute('aria-colcount', String(columns()))
    /* Forget which columns are built, so `paintRows` repaints the headings
       along with the body. A full paint is what a sort or a rename asks for,
       and the sort mark and the label live up there. */
    firstColBuilt = -1
    paintRows({ force: true })
    paintBar()
  }

  /** Repaint one cell in place — what an edit needs, instead of rebuilding the
   *  band around it. */
  const repaintCell = (r, c) => {
    const selector = `.csv-cell[data-row="${r}"][data-col="${c}"]`
    const cell = r === -1 ? headRow.querySelector(selector) : window_.querySelector(selector)
    if (!cell || cell.querySelector('.csv-input')) return
    if (r === -1) {
      const label = cell.querySelector('.csv-th-label')
      if (label) label.textContent = header[c] ?? ''
      return
    }
    cell.textContent = rows[sourceOf(r)]?.[c] ?? ''
  }

  /* ---------------------------------------------------------- the selection

     A list of rectangles. Nearly always one — from an anchor to the cursor,
     grown by a drag or a shift-click. A whole column is that rectangle with the
     heading at one corner and the last row at the other, which is why `-1` is a
     row here rather than a special case.

     ⌘-click is what makes it a list: a second column, a fourth row, a block
     somewhere else entirely. The question a person asks by picking three
     columns out of thirty is the same one they ask by dragging across two — how
     much, on average, and give me those — so a picked-apart selection totals
     and copies exactly as a dragged one does.

     The live rectangle is `anchor`→`cursor` and is always the last of them, so
     a drag or a shift-arrow goes on growing whichever block was started most
     recently. `extras` holds the ones already finished, in view coordinates —
     which is why anything that moves rows out from under them (a sort, a
     delete, a paste that grows the table) collapses the selection back to one
     rather than leaving blocks pointing at rows that have moved. */

  const rect = () => normalRect(anchor, cursor)
  /** Every block, the live one last. */
  const ranges = () => (extras.length ? [...extras, rect()] : [rect()])
  const singleCell = () =>
    !extras.length && anchor.r === cursor.r && anchor.c === cursor.c

  const holds = (box, r, c) => r >= box.r0 && r <= box.r1 && c >= box.c0 && c <= box.c1
  const sameBox = (a, b) => a.r0 === b.r0 && a.r1 === b.r1 && a.c0 === b.c0 && a.c1 === b.c1

  /** Is this cell selected by any of the blocks? The list is passed in where
   *  the caller is walking every visible cell, so it is built once. */
  const inSelection = (r, c, boxes = ranges()) => {
    for (const box of boxes) if (holds(box, r, c)) return true
    return false
  }

  /** Back to one rectangle, at the cursor. What every structural change ends
   *  with, because the blocks name view positions and the change moved them. */
  const collapse = () => { anchor = { ...cursor }; extras = [] }

  /** The positions a set of blocks covers along one axis, ascending and without
   *  repeats — the rows a selection or the clipboard grid has, or the columns. */
  const axisOf = (boxes, from, to) => {
    const seen = new Set()
    for (const box of boxes) for (let i = box[from]; i <= box[to]; i++) seen.add(i)
    return [...seen].sort((a, b) => a - b)
  }

  /**
   * The view rows the selection touches, ascending and without repeats — what
   * "delete the selected rows" means when the selection is in pieces. The
   * header is not one of them: it is a row on screen but not a row of the file.
   */
  const selectedRows = () => axisOf(ranges(), 'r0', 'r1').filter((r) => r >= 0)

  /**
   * The columns the selection touches, ascending and without repeats.
   *
   * What "align these" means when three headings have been ⌘-clicked. A
   * right-click inside the selection is about the selection; one outside it is
   * about the column under the pointer, the same way the row menu behaves.
   */
  const selectedColumns = () => axisOf(ranges(), 'c0', 'c1').filter((c) => c >= 0)

  /** The columns an alignment item should act on: the selected ones when the
   *  clicked column is among them, and otherwise just the one clicked. */
  const alignTargets = (c) => {
    const picked = shown ? selectedColumns() : []
    return picked.includes(c) && picked.length > 1 ? picked : [c]
  }

  /**
   * Point some columns left, centre or right — or, with null, back at whatever
   * their content implies.
   *
   * Not an edit: nothing in the file changes and nothing is queued to be
   * saved, so this is offered in Reading view too and never marks a tab dirty.
   * It is remembered beside the file the way the widths are, because a column
   * of codes pointed left is a decision about this file that would otherwise
   * have to be made again tomorrow.
   */
  const alignColumns = (cols, how) => {
    let changed = false
    for (const c of cols) {
      if (c < 0 || c >= columns() || aligns[c] === how) continue
      aligns[c] = how
      changed = true
    }
    if (!changed) return
    paint()
    requestDecorate()
    rememberWidths()
  }

  /** Selection, cursor and search-match classes, coalesced across a frame.
   *
   *  Every cursor move repaints the band, and a held arrow or a drag sends
   *  several moves per frame — each of which used to walk every built cell for
   *  a paint only the last one could show. The first touch in a frame still
   *  paints at once, so a single step answers synchronously exactly as before;
   *  the rest collapse into one trailing paint. The trailer is a timed task
   *  rather than a frame callback on purpose: a frame can land after whatever
   *  is waiting on the paint, while tasks run first-in first-out. */
  let decorateQueued = false
  let decorateSynced = false
  let decorateSyncArmed = 0
  const requestDecorate = () => {
    if (decorateQueued) return
    if (!decorateSynced) {
      decorateSynced = true
      decorate()
      if (!decorateSyncArmed) {
        decorateSyncArmed = requestAnimationFrame(() => {
          decorateSyncArmed = 0
          decorateSynced = false
        })
      }
      return
    }
    decorateQueued = true
    setTimeout(() => {
      decorateQueued = false
      decorate()
    }, 0)
  }

  /** Selection, cursor and search-match classes over whatever is built. Cheap
   *  because only the visible band exists to walk. */
  function decorate () {
    const boxes = ranges()
    const picked = (r, c) => shown && inSelection(r, c, boxes)
    for (const cell of /** @type {NodeListOf<HTMLElement>} */ (frame.querySelectorAll('.csv-cell'))) {
      const r = Number(cell.dataset.row)
      const c = Number(cell.dataset.col)
      const inside = picked(r, c)
      const isCursor = shown && r === cursor.r && c === cursor.c
      cell.classList.toggle('is-sel', inside && !isCursor)
      cell.classList.toggle('is-cursor', isCursor)
      // The same fact the highlight carries, for a reader who cannot see it.
      cell.setAttribute('aria-selected', String(inside))
      /* The four sides of the selection, drawn on the cells that sit against
         them. A range reads as one block with a line round it, the way every
         other grid draws one — a wash with no edge leaves the reader counting
         cells to find where the selection stops, and says nothing at all about
         where it ends off the bottom of the window. The band is the cell's own
         box-shadow, so nothing is positioned over the grid and a row scrolling
         into view brings its share of the outline with it.

         An edge is where the selection *stops*, rather than the side of any one
         block: two columns ⌘-clicked that happen to be neighbours are one shape
         to the eye, and drawing the seam between them would say they were two
         things when the only thing that made them two is how they were picked. */
      cell.classList.toggle('is-edge-t', inside && !picked(r - 1, c))
      cell.classList.toggle('is-edge-b', inside && !picked(r + 1, c))
      cell.classList.toggle('is-edge-l', inside && !picked(r, c - 1))
      cell.classList.toggle('is-edge-r', inside && !picked(r, c + 1))
      cell.classList.toggle('is-match', !!matcher && matcher.test(cell.textContent))
    }
    /* The heading and the line number light up to say which column and which
       row the selection is in — so with nothing selected there is nothing for
       them to say either. */
    for (const cell of /** @type {NodeListOf<HTMLElement>} */ (frame.querySelectorAll('.csv-gutter'))) {
      const r = Number(cell.dataset.row)
      cell.classList.toggle('is-active',
        shown && boxes.some((box) => r >= box.r0 && r <= box.r1))
    }
    for (const cell of /** @type {NodeListOf<HTMLElement>} */ (headRow.querySelectorAll('.csv-th'))) {
      const c = Number(cell.dataset.col)
      cell.classList.toggle('is-active',
        shown && boxes.some((box) => c >= box.c0 && c <= box.c1))
    }
    /* Which cell the keyboard is on. The focus never leaves the scroller — it
       is the thing that scrolls, and moving focus cell to cell would fight it
       — so the cursor is announced this way instead, which is how a grid whose
       cells come and go is meant to say it. */
    if (shown && current) scroller.setAttribute('aria-activedescendant', cellId(cursor.r, cursor.c))
    else scroller.removeAttribute('aria-activedescendant')
    noteSelection()
  }

  /* --------------------------------------------------------- the totals */

  /* How many cells a selection may cover before it is reported by its shape
     alone. Selecting the whole of a wide export is a gesture — ⌘A, usually on
     the way to a copy — rather than a question about a total, and reading four
     million cells to answer a question nobody asked is time the window spends
     not responding. */
  const STATS_CELL_LIMIT = 1000000

  /**
   * Where the selection's cells are, walked rather than collected: at the limit
   * above the array alone would be a million pairs.
   *
   * A cell already covered by an earlier block is skipped, so two blocks that
   * cross do not count — or total, or clear — the cells they share twice. The
   * check costs nothing in the ordinary case, where there is one block and
   * nothing earlier to compare against.
   */
  function * selectionCoords () {
    const boxes = ranges()
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]
      for (let r = box.r0; r <= box.r1; r++) {
        for (let c = box.c0; c <= box.c1; c++) {
          let already = false
          for (let j = 0; j < i && !already; j++) already = holds(boxes[j], r, c)
          if (!already) yield [r, c]
        }
      }
    }
  }

  function * selectionCells () {
    for (const [r, c] of selectionCoords()) yield valueAt(r, c)
  }

  /** How much is selected, before it is walked — an overlap counted twice, so
   *  it can only overstate, which is what a cap wants. */
  const selectionArea = () => ranges().reduce(
    (sum, box) => sum + (box.r1 - box.r0 + 1) * (box.c1 - box.c0 + 1), 0)

  const computeStats = () => {
    const blocks = ranges().length
    const cells = selectionArea()
    stats = cells > STATS_CELL_LIMIT
      ? { cells, filled: 0, numbers: 0, sum: 0, average: 0, min: 0, max: 0, capped: true, blocks }
      : { ...selectionStats(selectionCells()), blocks }
    onSelection()
  }

  /**
   * Notice that the selection has moved, and work out what it comes to.
   *
   * Two things keep this off the hot path. It is keyed on the rectangle, so the
   * `decorate` that follows every scroll tick — which does not move the
   * selection — recognises the same box and does nothing. And the sum itself
   * waits for the drag to stop: a selection swept down a long column would
   * otherwise be totalled afresh on every row it passed, each pass longer than
   * the last.
   */
  const noteSelection = () => {
    const key = shown && !singleCell()
      ? ranges().map((box) => `${box.r0}:${box.r1}:${box.c0}:${box.c1}`).join('|')
      : ''
    if (key === statsFor) return
    statsFor = key
    stats = null
    clearTimeout(statsTimer)
    // A single cell has no arithmetic to report, so the line simply goes.
    if (!key) { onSelection(); return }
    /* Said twice on purpose: the shape of the selection is known now and the
       reader is told now, and the total follows a moment later rather than
       holding the rest of the line back. */
    onSelection()
    statsTimer = setTimeout(computeStats, 80)
  }

  /** Edits move the numbers without moving the selection, so the key alone
   *  would not notice. Called wherever the data under a rectangle changes. */
  const forgetStats = () => { statsFor = null; stats = null }

  /** What the status line says about the selection, or nothing. */
  const statsSummary = () => {
    if (!stats) return ''
    /* How many blocks, when there is more than one. A selection in pieces is
       mostly off screen — three columns picked out of thirty, on a file of a
       hundred thousand rows — and the count is how the reader checks that what
       is being totalled is what they meant to pick. */
    const shape = stats.blocks > 1
      ? `${stats.cells.toLocaleString()} selected in ${stats.blocks} blocks`
      : `${stats.cells.toLocaleString()} selected`
    if (stats.capped) return shape
    if (!stats.numbers) return shape
    const parts = [shape, `sum ${formatStat(stats.sum)}`, `avg ${formatStat(stats.average)}`]
    /* How many of them were numbers, but only when that is not all of them:
       "12 selected · 12 numbers" is a column of prices saying twice over that
       it is a column of prices. */
    if (stats.numbers !== stats.filled) parts.push(`${stats.numbers.toLocaleString()} numeric`)
    return parts.join(' · ')
  }

  /**
   * Every value in the selection, row by row. The header counts as a row when
   * the selection reaches it, so copying a column copies its name.
   *
   * Several blocks come out as one rectangle: every row any of them touches, by
   * every column any of them touches, with a blank wherever nothing was picked.
   * For the two shapes a ⌘-click is nearly always making — a few whole columns,
   * or a few whole rows — that is exactly those columns side by side or those
   * rows stacked, which is what a spreadsheet puts on the clipboard for the same
   * gesture and the whole reason for picking them. For a ragged pick it is the
   * honest reading: the shape is kept, and the cells nobody chose are empty
   * rather than quietly filled in with the ones between them.
   */
  const selectionValues = () => {
    const boxes = ranges()
    if (boxes.length === 1) {
      const box = boxes[0]
      const grid = []
      for (let r = box.r0; r <= box.r1; r++) {
        const line = []
        for (let c = box.c0; c <= box.c1; c++) line.push(valueAt(r, c))
        grid.push(line)
      }
      return grid
    }
    const wantRows = axisOf(boxes, 'r0', 'r1')
    const wantCols = axisOf(boxes, 'c0', 'c1')
    return wantRows.map((r) =>
      wantCols.map((c) => (inSelection(r, c, boxes) ? valueAt(r, c) : '')))
  }

  const paintBar = () => {
    const active = !!query.trim()
    /* Shown when the file is not separated by what its extension says it is —
       which is the case the reader needs told — and when the table came out a
       single column, which is what a guess that went wrong looks like. A
       `.csv` that really is comma-separated says nothing, because there is
       nothing to say. */
    if (current) {
      delimiterPick.root.hidden = current.delimiter === current.declared && columns() > 1
      delimiterPick.set(null, current.delimiter)
    } else {
      delimiterPick.root.hidden = true
    }
    /* Replace changes the file, so the whole strip of it goes where the other
       writing controls go: away, in Reading view and on a locked file. */
    const canWrite = !readonly && !lock
    replaceBox.hidden = !replacing || !canWrite
    replaceOneBtn.hidden = !replacing || !canWrite
    replaceAllBtn.hidden = !replacing || !canWrite
    replaceOneBtn.disabled = !matcher
    replaceAllBtn.disabled = !matcher
    for (const element of [undoBtn, redoBtn, addRow, addCol]) element.hidden = readonly || !!lock
    undoBtn.disabled = !history.length
    redoBtn.disabled = !future.length
    /* Filtering is a way of looking, so both of its controls stay in Reading
       view — see the note on `readonly`. */
    onlyBtn.hidden = !active
    onlyBtn.classList.toggle('is-on', onlyMatches)
    onlyBtn.setAttribute('aria-pressed', String(onlyMatches))
    const columnFilters = [...filters.values()].filter((hidden) => hidden.size).length
    filterBtn.classList.toggle('is-on', columnFilters > 0)
    clearFilters.hidden = !filtering()
    /* One line, saying whichever of the two is the answer to what was just
       done. How many rows are left comes first when rows are being hidden,
       because that is the number a filter is read for; the match count is what
       a find that only highlights has to offer instead. */
    if (filtering()) {
      const left = viewRows()
      const parts = []
      if (columnFilters) {
        parts.push(`${columnFilters} column ${columnFilters === 1 ? 'filter' : 'filters'}`)
      }
      parts.push(`${left.toLocaleString()} of ${rows.length.toLocaleString()} rows`)
      found.textContent = parts.join(' · ')
      found.classList.toggle('is-empty', !left)
    } else if (!active) {
      found.textContent = ''
      found.classList.remove('is-empty')
    } else {
      const hits = countMatches()
      found.textContent = hits.capped
        ? `${MATCH_COUNT_LIMIT.toLocaleString()}+ matching rows`
        : hits.count
          ? `${hits.count.toLocaleString()} matching ${hits.count === 1 ? 'row' : 'rows'}`
          : 'no matches'
      found.classList.toggle('is-empty', !hits.count)
    }
  }

  /* Which source rows the find box matches, remembered from one keystroke to
     the next. The count in the bar and the "only matches" filter both asked
     `filterOrder` over the whole file on every character typed — half a
     million rows, twenty cells each, `toLowerCase` on every one. A plain
     needle can only lose rows as it grows: a row holding "revenue" held
     "revenu", so the rows to look at are the ones the shorter needle kept.
     A pattern grown by typing narrows the same way, as long as it only gained
     a suffix: any match of the longer pattern begins with a match of the
     shorter one, so a row the shorter one missed cannot match. An end anchor
     breaks that — `$` can succeed mid-pattern before a newline — as does a
     whole-cell match, so those are done from scratch.
     Keyed on the rows and the revision, both of which every edit moves.

     A scan also remembers how far it got. The count in the bar stops early —
     see `countMatches` — and the rows it never reached are unknown rather
     than clear, so the next scan tests those while still skipping the ones
     the shorter needle ruled out. */
  /* Past this many matches the bar says "5000+" instead of counting the file:
     the number is a shape, not an answer, and the rows past it cost a full
     scan to name. */
  const MATCH_COUNT_LIMIT = 5000
  /** @type {any} */
  let finding = null
  /* Whether the rows `prev` ruled out can be skipped for `query`: the previous
     scan's needle, grown rather than changed. */
  const narrows = (prev) => {
    if (!prev || prev.query === query) return true
    if (prev.regex !== matcher.regex || prev.whole !== matcher.whole || matcher.whole) return false
    if (matcher.regex) {
      return query.length > prev.query.length &&
        query.startsWith(prev.query) &&
        !prev.query.includes('$')
    }
    return query.toLowerCase().includes(prev.query.toLowerCase())
  }
  const freshFinding = () => (finding && finding.rows === rows && finding.revision === revision &&
    finding.regex === matcher?.regex && finding.whole === matcher?.whole)
    ? finding
    : null
  const matchFlags = () => {
    if (!matcher) return new Uint8Array(rows.length)
    const prev = freshFinding()
    if (prev && prev.query === query && prev.tested >= rows.length) return prev.flags
    const reuse = !!prev && narrows(prev)
    const flags = reuse ? prev.flags : new Uint8Array(rows.length)
    const tested = reuse ? prev.tested : 0
    for (let i = 0; i < rows.length; i++) {
      /* Rows the previous scan tested keep their answer when the query did
         not change; when it only grew, the ones it cleared stay clear. A row
         tested again gets its answer written either way — a longer needle can
         unmatch what the shorter one kept. */
      if (i < tested && (prev.query === query || !flags[i])) continue
      const row = rows[i] || []
      let hit = 0
      for (const cell of row) {
        if (matcher.test(cell)) { hit = 1; break }
      }
      flags[i] = hit
    }
    finding = { rows, revision, query, regex: matcher.regex, whole: matcher.whole, flags, tested: rows.length }
    return flags
  }
  /* How many rows match, stopping once the answer is "more than the bar
     says". Shares the scan above — including its narrowing — and leaves what
     it tested behind for the "only matches" filter to resume, so capping the
     count never costs a second full scan. */
  const countMatches = (limit = MATCH_COUNT_LIMIT) => {
    if (!matcher) return { count: 0, capped: false }
    const prev = freshFinding()
    if (prev && prev.query === query && prev.tested >= rows.length) {
      let n = 0
      for (const flag of prev.flags) {
        n += flag
        if (n > limit) return { count: n, capped: true }
      }
      return { count: n, capped: false }
    }
    const reuse = !!prev && narrows(prev)
    const flags = reuse ? prev.flags : new Uint8Array(rows.length)
    const tested = reuse ? prev.tested : 0
    let n = 0
    let i = 0
    for (; i < rows.length; i++) {
      if (i < tested && (prev.query === query || !flags[i])) n += flags[i]
      else {
        const row = rows[i] || []
        let hit = 0
        for (const cell of row) {
          if (matcher.test(cell)) { hit = 1; break }
        }
        flags[i] = hit
        n += hit
      }
      if (n > limit) { i++; break }
    }
    finding = { rows, revision, query, regex: matcher.regex, whole: matcher.whole, flags, tested: Math.max(tested, i) }
    return { count: n, capped: i < rows.length }
  }

  /* Bring the cursor into view, vertically by row arithmetic and horizontally
     by the column offsets — neither needs the cell to exist in the DOM, which
     is what lets ⌘↓ jump to row 400,000. */
  const revealCursor = () => {
    if (cursor.r >= 0) {
      const top = cursor.r * ROW_HEIGHT
      const height = scroller.clientHeight
      if (top < scroller.scrollTop) scroller.scrollTop = top
      else if (top + ROW_HEIGHT > scroller.scrollTop + height) {
        scroller.scrollTop = top + ROW_HEIGHT - height
      }
    }
    /* From the running totals rather than by adding the columns up again —
       the same array the visible column range is searched in, so a cursor on
       column four hundred costs a lookup rather than four hundred additions on
       every keystroke that moves it. */
    layoutColumns()
    const left = GUTTER + (colLeft[cursor.c] ?? 0)
    const width = widths[cursor.c] || MIN_COL
    // The frozen gutter covers the left edge, so "in view" starts after it.
    if (left - GUTTER < scroller.scrollLeft) scroller.scrollLeft = left - GUTTER
    else if (left + width > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = left + width - scroller.clientWidth
    }
  }

  /**
   * Put the cursor somewhere.
   *
   * @param extend  keep the anchor where it is — a shift-click or shift-arrow,
   *                which is what turns a cursor into a rectangle
   * @param add     keep the whole selection and start another block here — a
   *                ⌘-click, which is what turns a rectangle into a list of them
   */
  const moveTo = (r, c, { extend = false, add = false } = {}) => {
    if (editing) commitEdit()
    shown = true
    if (add) extras = [...extras, rect()]
    else if (!extend) extras = []
    cursor = {
      r: Math.max(-1, Math.min(viewRows() - 1, r)),
      c: Math.max(0, Math.min(columns() - 1, c))
    }
    if (!extend) anchor = { ...cursor }
    revealCursor()
    paintRows()
    requestDecorate()
  }

  const selectAll = () => {
    shown = true
    extras = []
    anchor = { r: -1, c: 0 }
    cursor = { r: viewRows() - 1, c: Math.max(0, columns() - 1) }
    paintRows()
    requestDecorate()
  }

  const selectColumn = (c, { add = false } = {}) => {
    shown = true
    extras = add ? [...extras, rect()] : []
    anchor = { r: -1, c }
    cursor = { r: Math.max(-1, viewRows() - 1), c }
    revealCursor()
    paintRows()
    requestDecorate()
  }

  const selectRow = (r, { add = false } = {}) => {
    shown = true
    extras = add ? [...extras, rect()] : []
    anchor = { r, c: 0 }
    cursor = { r, c: Math.max(0, columns() - 1) }
    revealCursor()
    paintRows()
    requestDecorate()
  }

  /**
   * Take a block back out of the selection.
   *
   * A ⌘-click on a heading that is already a column of its own means "not that
   * one after all" — the same click that added it, taking it away, which is how
   * every list of things that can be picked apart behaves. Only an exact match
   * counts: a column ⌘-clicked while it happens to sit inside a drag is a
   * column being added, not the drag being unpicked.
   *
   * The last block standing stays. A click that emptied the selection would
   * leave nothing selected and no sign of why; Escape already says that, and
   * says it about the whole selection at once.
   *
   * @return whether the click was answered by taking something away
   */
  const dropRange = (want) => {
    const boxes = ranges()
    const at = boxes.findIndex((box) => sameBox(box, want))
    if (at < 0) return false
    if (boxes.length === 1) return true
    const kept = boxes.filter((_, i) => i !== at)
    /* Whichever is left last becomes the live one, so a shift-arrow after this
       carries on from a block that is still there. */
    const live = kept[kept.length - 1]
    extras = kept.slice(0, -1)
    anchor = { r: live.r0, c: live.c0 }
    cursor = { r: live.r1, c: live.c1 }
    paintRows()
    requestDecorate()
    return true
  }

  /** ⌘-click on a heading. Answers whether a *new* block was made, because only
   *  then does the drag that may follow have one to grow. */
  const toggleColumn = (c) => {
    if (dropRange({ r0: -1, r1: Math.max(-1, viewRows() - 1), c0: c, c1: c })) return false
    selectColumn(c, { add: true })
    return true
  }

  /** ⌘-click on a line number, the same way round. */
  const toggleRow = (r) => {
    if (dropRange({ r0: r, r1: r, c0: 0, c1: Math.max(0, columns() - 1) })) return false
    selectRow(r, { add: true })
    return true
  }

  /* ------------------------------------------------------------- the file */

  const valueAt = (r, c) => (r === -1 ? header[c] : rows[sourceOf(r)]?.[c]) ?? ''

  /**
   * Write one cell, by *source* row — which is what every patch and every
   * undo entry is in terms of, because the view can be sorted out from under
   * one between an edit and its undo.
   *
   * Copy-on-write: the row is replaced rather than mutated, so a snapshot
   * taken before this still describes what the file looked like then. That is
   * the whole reason undo can afford to keep snapshots at all.
   */
  const writeSource = (src, c, value) => {
    if (src === -1) {
      if ((header[c] ?? '') === value && c < header.length) return false
      const next = header.slice()
      while (next.length <= c) next.push('')
      next[c] = value
      header = next
      return true
    }
    const row = rows[src]
    if (!row) return false
    if ((row[c] ?? '') === value && c < row.length) return false
    const next = row.slice()
    // Short rows are legal in these files; fill so the column lands in place.
    while (next.length <= c) next.push('')
    next[c] = value
    rows[src] = next
    return true
  }

  /* ------------------------------------------------------------- the undo

     Two kinds of entry. A cell patch is a list of before-and-afters and costs
     a few words; a snapshot is a shallow copy of the row list and costs one
     pointer per row, which on a large file is worth keeping few of. Structural
     changes — a column inserted, a thousand rows deleted — are the only ones
     that take a snapshot. */

  const snapshot = () => ({
    kind: 'snapshot',
    header: header.slice(),
    rows: rows.slice(),
    widths: widths.slice(),
    numeric: numeric.slice(),
    aligns: aligns.slice(),
    sorts: sorts.map((key) => ({ ...key })),
    cursor: { ...cursor },
    anchor: { ...anchor },
    extras: extras.map((box) => ({ ...box }))
  })

  const record = (patch) => {
    // The rectangle has not moved but what is under it has.
    forgetStats()
    history.push(patch)
    future.length = 0
    if (history.length > HISTORY_LIMIT) history.shift()
    let snapshots = history.reduce((n, p) => n + (p.kind === 'snapshot' ? 1 : 0), 0)
    while (snapshots > SNAPSHOT_LIMIT) {
      const at = history.findIndex((p) => p.kind === 'snapshot')
      history.splice(at, 1)
      snapshots--
    }
    paintBar()
  }

  /** Apply a patch and hand back the one that undoes it. */
  const applyPatch = (patch) => {
    if (patch.kind === 'cells') {
      const inverse = {
        kind: 'cells',
        edits: patch.edits.map((e) => ({ src: e.src, c: e.c, before: e.after, after: e.before }))
      }
      for (const edit of patch.edits) writeSource(edit.src, edit.c, edit.before)
      rebuildOrder()
      paint()
      return inverse
    }
    const inverse = snapshot()
    header = patch.header.slice()
    rows = patch.rows.slice()
    widths = patch.widths.slice()
    numeric = patch.numeric.slice()
    aligns = (patch.aligns || new Array(patch.widths.length).fill(null)).slice()
    sorts = (patch.sorts || []).map((key) => ({ ...key }))
    cursor = { ...patch.cursor }
    anchor = { ...patch.anchor }
    extras = (patch.extras || []).map((box) => ({ ...box }))
    rebuildOrder()
    paint()
    return inverse
  }

  const stepHistory = (redo) => {
    if (!editable()) return false
    if (editing) commitEdit()
    const stack = redo ? future : history
    const patch = stack.pop()
    if (!patch) { onStatus(`Nothing to ${redo ? 'redo' : 'undo'}`); return false }
    const inverse = applyPatch(patch)
    ;(redo ? history : future).push(inverse)
    setDirty(true)
    queueSave()
    revealCursor()
    paintBar()
    return true
  }

  /* ------------------------------------------------------------- editing */

  /* How far an open cell may grow downwards, in rows. A field the height of the
     table would hide the thing being edited *for*: the rest of the column. Past
     this it scrolls, which is what a value of a few thousand characters was
     always going to do. */
  const EDIT_LINES = 8

  /**
   * The open cell, sized to what is in it.
   *
   * A cell is as wide as its column, and a value longer than that used to be
   * edited through a slot: the field kept the column's width and scrolled, so
   * the text on screen began and ended mid-word and there was no way to see the
   * whole of what you were changing. Every spreadsheet answers this the same
   * way — the open cell leaves the column and takes the room it needs — and
   * that is what this does: out to the right edge of the grid, then down over
   * the rows below, wrapping.
   *
   * The heading strip is the exception. It is 30px of `overflow: hidden` with
   * the body underneath it, so a heading's field grows sideways and no further;
   * a heading long enough to need two lines would be drawn under the table.
   */
  function fitEditor () {
    if (!editing) return
    const { input, cell, r } = editing
    const strip = r === -1 ? headRow : scroller
    /* From the cell's own left edge to the grid's, less a hair: the field is
       allowed to cover its neighbours to the right, not the scrollbar. */
    const room = strip.getBoundingClientRect().right - cell.getBoundingClientRect().left - 6
    const wanted = textWidth(input.value) + CELL_PADDING
    input.style.width = `${Math.round(Math.max(cell.offsetWidth, Math.min(wanted, room)))}px`
    if (r === -1) return
    /* Measured, not computed: how many lines the value wraps onto is the
       browser's business once the width is settled. `auto` first, or a field
       that has just been emptied keeps the height of what it held. */
    input.style.height = 'auto'
    /* `scrollHeight` is the content and its padding; the border is not in it,
       and this box is sized border to border — without the difference the field
       is two pixels short of what it holds and scrolls by that much. */
    const edges = input.offsetHeight - input.clientHeight
    input.style.height = `${Math.min(input.scrollHeight + edges, ROW_HEIGHT * EDIT_LINES)}px`
  }

  /** @param {string | null} [seed] */
  function beginEdit (seed = null) {
    if (!editable()) return
    if (editing) commitEdit()
    // Typing into a cell is selecting it, whatever Escape did a moment ago.
    shown = true
    if (cursor.r >= 0 && !rows[sourceOf(cursor.r)]) return
    const selector = `.csv-cell[data-row="${cursor.r}"][data-col="${cursor.c}"]`
    const cell = cursor.r === -1 ? headRow.querySelector(selector) : window_.querySelector(selector)
    if (!cell) return
    /* A textarea rather than an input, for two reasons: it can wrap, and it
       can hold a line break. Plain Enter, Tab and Escape are the grid's, taken
       before the field ever sees them; ⇧⏎ and ⌥⏎ are left to the field, which
       is how a newline gets into a value. */
    const input = document.createElement('textarea')
    input.className = 'csv-input'
    input.rows = 1
    input.spellcheck = false
    input.value = seed === null ? valueAt(cursor.r, cursor.c) : seed
    cell.classList.add('is-editing')
    cell.replaceChildren(input)
    editing = { r: cursor.r, c: cursor.c, input, cell }
    fitEditor()
    input.addEventListener('input', fitEditor)
    input.focus()
    if (seed === null) input.select()
    else input.setSelectionRange(input.value.length, input.value.length)
  }

  /** Take what is in the open editor, if anything is open. Safe to call at any
   *  time — closing, scrolling and moving all do. */
  function commitEdit ({ cancel = false } = {}) {
    if (!editing) return
    const { r, c, input, cell } = editing
    // The cell goes back to being a cell: clipped, and in its own column.
    cell.classList.remove('is-editing')
    const value = input.value
    const src = sourceOf(r)
    editing = null
    /* The field goes before the cell is repainted, not after. `repaintCell`
       refuses to write over a cell with an editor in it — which is right for
       every other cell, and exactly wrong for this one: leaving it in place
       made the guard fire on the cell being committed, so an edited cell
       showed blank until something else rebuilt the row. */
    input.remove()
    if (!cancel) {
      const before = valueAt(r, c)
      if (writeSource(src, c, value)) {
        record({ kind: 'cells', edits: [{ src, c, before, after: value }] })
        setDirty(true)
        /* A sorted column whose cell just changed has moved that row. Rebuild
           the view and follow the row rather than the position: the cursor
           belongs to the thing that was edited. Any other blocks are positions
           and the rows under them have just moved, so they go. */
        if (sortOn(c)) { extras = []; rebuildOrder({ keepSource: src }); paint() }
      }
    }
    /* A heading's cell holds its label, its sort mark and its resize grip, and
       the editor replaced all three. Rebuilding the strip is cheaper than
       reassembling one cell by hand, and there are only ever a few columns. */
    if (r === -1) paintHead()
    else repaintCell(r, c)
    requestDecorate()
    if (!cancel) queueSave()
  }

  /* --------------------------------------------------------------- saving */

  /** @type {any} */
  let saveTimer = null
  const queueSave = () => {
    /* Nothing to queue on a locked file: `editable` already refused the edit
       that would have called this, and an armed timer on a preview would be a
       write waiting for a bug to let it through. */
    if (lock) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveFile().catch(() => {}) }, 900)
  }

  const saveFile = async ({ flush = false, force = false } = {}) => {
    if (flush) flushRequested = true
    if (saving) return saving
    saving = (async () => {
      do {
        if (editing) commitEdit()
        if (!current || !dirty) break
        /* The lock is why nothing here can have been edited — see `editable` —
           but the guard stands on its own: a preview or an undecodable file
           must never be written, whatever state the flags got into. */
        if (lock) break
        clearTimeout(saveTimer)
        /* What is about to be written, named. Formatting and writing a large
           file is not instant, and a cell typed during one belongs to a
           version that is not on disk. Calling the grid clean regardless marks
           that edit as saved: the save it queued for itself then finds
           `!dirty` here and writes nothing, and the edit lives only in memory
           until the tab is closed and it goes. */
        const writingRevision = revision
        /* `rows` and not the view: a sort is a way of looking at the file, and
           saving one must not rewrite every line of it. The header only goes
           back on when it came off the file; a numbered one is the grid's own
           furniture and writing it would add a row the file never had. And the
           whole of the file's shape goes with the text — its own line ending,
           its final newline or the lack of one, its quoting — because a save
           that only changed one cell must only change one line. */
        const table = hasHeader ? [header, ...rows] : rows
        const text = formatSeparated(table, current.delimiter, current.newline, current.shape)
        /* Written back as the bytes it arrived in: the encoding and the mark
           are the file's, not the app's. `expect` is the stamp the text was
           read at, so a version somebody else wrote in the meantime is refused
           rather than overwritten — the 900 ms autosave is exactly the write
           that can land inside a sync client's window. */
        const outcome = await file.write(current.path, text, {
          encoding: current.encoding,
          bom: current.bom,
          ...(current.stamp && !force ? { expect: current.stamp } : {}),
          ...(force ? { force: true } : {})
        })
        /* The test harness's file object returns nothing; the real one answers
           `{ ok, stamp }` or a refusal. Nothing back is the old success. */
        if (outcome && outcome.ok === false) {
          if (outcome.stale) {
            /* Somebody else's version is on disk. The choice is the reader's,
               and until they make it the grid stays dirty and stops trying:
               re-queuing the same losing write every 900 ms would be asking
               the same question forever. */
            showNotice(
              'This file has changed on disk since it was opened — saving now would overwrite that change.',
              [{
                label: 'Keep mine',
                title: 'Write this table over the version on disk',
                run: () => {
                  hideNotice()
                  saveFile({ flush: true, force: true }).catch(() => {})
                }
              }, {
                label: 'Take theirs',
                title: 'Reload the file from disk — unsaved edits here are lost',
                run: () => {
                  hideNotice()
                  setDirty(false)
                  grid.open(current.path, grid.place()).catch(() => {})
                }
              }]
            )
            break
          }
          if (outcome.unencodable) {
            /* A character was typed that the file's own encoding cannot spell —
               an emoji into a windows-1252 export, say. Substituting for it is
               the corruption this whole path exists to prevent, so the write
               was refused; the honest way out is the one the reader can say
               yes to. */
            showNotice(
              `“${outcome.character || 'A character'}” cannot be written in this file’s encoding (${outcome.encoding || current.encoding}).`,
              [{
                label: 'Save as UTF-8',
                title: 'Convert the file to UTF-8, which can spell everything',
                run: () => {
                  current.encoding = 'utf8'
                  current.bom = false
                  hideNotice()
                  saveFile({ flush: true }).catch(() => {})
                }
              }]
            )
            break
          }
          throw new Error(outcome.error || 'The write failed.')
        }
        /* The stamp the bytes landed with is what the next write's `expect`
           must name — without this every second autosave would refuse itself
           as stale. */
        if (outcome?.stamp) current.stamp = outcome.stamp
        const clean = revision === writingRevision
        if (clean) setDirty(false)
        /* Only a clean write is a saved file. Saying otherwise puts the status
           line and the tab's dot at odds with what is on disk — and the host
           reads `onSaved` as permission to stop tracking the buffer. */
        if (clean) onSaved()
        /* Still dirty means something arrived mid-write. Its own `queueSave`
           is already pending — armed after the `clearTimeout` above, because
           it happened after it — so the debounced path picks it up. A flush
           has no later to wait for and goes round again here. */
      } while (flushRequested && dirty)
      flushRequested = false
      return true
    })()
    try { return await saving } finally { saving = null }
  }

  /* --------------------------------------------------------- the structure */

  const blankRow = () => new Array(Math.max(1, columns())).fill('')

  /** Move every filter at or after `from` by `by` columns, which is what an
   *  insert or a delete does to the indices they are keyed by. */
  const shiftFilters = (from, by) => {
    if (!filters.size) return
    const next = new Map()
    for (const [col, hidden] of filters) next.set(col >= from ? col + by : col, hidden)
    filters = next
  }

  const insertRows = (atView, count = 1) => {
    if (!editable()) return
    record(snapshot())
    const made = Array.from({ length: count }, blankRow)
    if (plainOrder()) {
      const at = Math.max(0, Math.min(rows.length, atView))
      rows.splice(at, 0, ...made)
      rebuildOrder()
      cursor = { r: at, c: cursor.c }
    } else {
      /* Sorted, a new row still belongs in the file beside the row it was
         asked for — the gutter shows the file's own line number, and a row
         inserted below line 2 that came back numbered 1,345 is that number
         made meaningless. So it goes into `rows` after the row above it on
         screen, every later source index shifts up to match, and `order` is
         patched rather than rebuilt: re-sorting would send a blank row
         straight to the bottom, away from where it was asked for. It stays
         put until the next re-sort. */
      const where = Math.max(0, Math.min(order.length, atView))
      const at = where > 0 ? order[where - 1] + 1 : (order[0] ?? rows.length)
      rows.splice(at, 0, ...made)
      order = order.map((i) => (i >= at ? i + count : i))
      order.splice(where, 0, ...made.map((_, i) => at + i))
      cursor = { r: where, c: cursor.c }
    }
    collapse()
    setDirty(true)
    paint()
    revealCursor()
    queueSave()
  }

  /** The view rows of a list, in order, with the ones that are not rows of the
   *  file left out — what every row operation takes now that a selection can be
   *  a handful of rows picked out of a long file rather than a span of them. */
  const rowList = (wanted) => [...new Set(wanted)]
    .filter((r) => r >= 0 && r < viewRows())
    .sort((a, b) => a - b)

  const deleteRows = (wanted) => {
    if (!editable()) return
    const list = rowList(wanted)
    if (!list.length) return
    record(snapshot())
    const kill = new Set(list.map((r) => order[r]))
    rows = rows.filter((_, i) => !kill.has(i))
    rebuildOrder()
    cursor = { r: Math.min(list[0], viewRows() - 1), c: cursor.c }
    collapse()
    clampCursor()
    setDirty(true)
    paint()
    revealCursor()
    queueSave()
    onStatus(`Deleted ${kill.size.toLocaleString()} ${kill.size === 1 ? 'row' : 'rows'}`)
  }

  const insertColumn = (at) => {
    if (!editable()) return
    record(snapshot())
    const where = Math.max(0, Math.min(columns(), at))
    header = header.slice()
    while (header.length < where) header.push('')
    header.splice(where, 0, '')
    rows = rows.map((row) => {
      const next = row.slice()
      while (next.length < where) next.push('')
      next.splice(where, 0, '')
      return next
    })
    widths.splice(where, 0, MIN_COL)
    numeric.splice(where, 0, false)
    aligns.splice(where, 0, null)
    /* A filter is keyed by column index, and a column inserted to the left of
       a filtered one moves it. Without this, filtering "type" and then adding
       a column before it leaves the grid hiding rows by the wrong column. */
    shiftFilters(where, 1)
    cursor = { r: cursor.r, c: where }
    collapse()
    setDirty(true)
    paint()
    revealCursor()
    /* The saved layout is one width per column, so a column added or removed
       has to be recorded with it — a stale list of the old length is one the
       next open discards, taking every deliberate width with it. */
    rememberWidths()
    queueSave()
  }

  /**
   * Move one column to another position — the drop half of dragging a heading.
   *
   * An edit, unlike everything else a heading does: the cells change which
   * field of each line they are, so every row is rewritten. Structural, so it
   * snapshots like an insert or a delete does.
   */
  const moveColumn = (from, to) => {
    if (!editable() || !current) return
    if (from === to || from < 0 || to < 0 || from >= columns() || to >= columns()) return
    record(snapshot())

    /* One mapping for everything that names columns by index, so the widths,
       the sort keys and the filters all keep describing the columns they were
       about. */
    const mapCol = (c) => {
      if (c === from) return to
      if (from < to && c > from && c <= to) return c - 1
      if (to < from && c >= to && c < from) return c + 1
      return c
    }
    /* Padded to the table's width before the move so the splice lands where
       the column actually is, then trimmed back: the padding is scaffolding,
       and leaving it would give every short row a tail of empty fields — a
       diff on lines the edit never touched. */
    const lift = (list, width) => {
      const next = list.slice()
      while (next.length < width) next.push('')
      const [value] = next.splice(from, 1)
      next.splice(to, 0, value)
      return next
    }
    const width = columns()
    header = lift(header, width)
    rows = rows.map((row) => {
      const wide = Math.max(row.length, from + 1, to + 1)
      const next = lift(row, wide)
      while (next.length > row.length && next[next.length - 1] === '') next.pop()
      return next
    })
    widths = lift(widths, width)
    numeric = lift(numeric, width)
    aligns = lift(aligns.map((a) => a ?? null), width).map((a) => (a === '' ? null : a))
    sorts = sorts.map((key) => ({ ...key, col: mapCol(key.col) }))
    const nextFilters = new Map()
    for (const [col, hidden] of filters) nextFilters.set(mapCol(col), hidden)
    filters = nextFilters
    cursor = { ...cursor, c: mapCol(cursor.c) }
    anchor = { ...anchor, c: mapCol(anchor.c) }
    extras = []
    setDirty(true)
    rebuildOrder()
    paint()
    rememberWidths()
    queueSave()
    onStatus(`Moved “${header[to] || `column ${to + 1}`}” to column ${to + 1}`)
  }

  const deleteColumn = (at) => {
    if (!editable()) return
    if (columns() <= 1) { onStatus('A table keeps at least one column'); return }
    record(snapshot())
    header = header.slice()
    header.splice(at, 1)
    rows = rows.map((row) => {
      if (at >= row.length) return row
      const next = row.slice()
      next.splice(at, 1)
      return next
    })
    widths.splice(at, 1)
    numeric.splice(at, 1)
    aligns.splice(at, 1)
    // The deleted column's filter goes with it; the ones after it move up.
    filters.delete(at)
    shiftFilters(at, -1)
    /* The deleted column's own key goes; the keys to its right slide left with
       the columns they name. */
    sorts = sorts.filter((key) => key.col !== at)
      .map((key) => (key.col > at ? { ...key, col: key.col - 1 } : key))
    clampCursor()
    collapse()
    rebuildOrder()
    setDirty(true)
    paint()
    rememberWidths()
    queueSave()
  }

  const duplicateRows = (wanted) => {
    if (!editable()) return
    const list = rowList(wanted)
    if (!list.length) return
    record(snapshot())
    /* The copies land together, below the last of the rows they came from, in
       the order they were picked up. Rows chosen apart from each other are
       being copied as a set — putting each copy back beside its original would
       be interleaving the file with itself. */
    const last = list[list.length - 1]
    const copies = list.map((r) => (rows[order[r]] || []).slice())
    if (plainOrder()) {
      rows.splice(order[last] + 1, 0, ...copies)
      rebuildOrder()
    } else {
      const start = rows.length
      rows.push(...copies)
      order.splice(last + 1, 0, ...copies.map((_, i) => start + i))
    }
    cursor = { r: last + 1, c: cursor.c }
    collapse()
    setDirty(true)
    paint()
    revealCursor()
    queueSave()
  }

  /* ---------------------------------------------------------- the sorting */

  /**
   * Sort, without moving the reader.
   *
   * A sort used to carry the cursor's row with it — the selected row kept its
   * data and took its new position, and the view was scrolled to wherever that
   * turned out to be. On a long export that is a click on a heading answered by
   * being thrown four thousand rows down the file, which is not what "show me
   * this in order" asks for.
   *
   * So the cursor keeps its *position* rather than its row, and nothing
   * scrolls: sorting is a way of looking at the file, and where you were
   * looking is the one thing a way of looking should not change. The row count
   * cannot change here either — a sort reorders `order`, it does not filter it
   * — so the scroll offset the reader is at stays valid.
   *
   * The other way round is still right where the cursor belongs to a *thing*
   * rather than to a place: editing a cell in the sorted column follows its row
   * (see `commitEdit`), and so does hiding the rows that do not match a search,
   * where positions mean nothing because rows have gone.
   */
  const sortBy = (col, dir) => {
    sorts = dir ? [{ col, dir }] : []
    rebuildOrder()
    collapse()
    paint()
  }

  /**
   * Add a column to the ordering rather than replacing it — ⇧-click on a
   * heading, and the heading menu's "Then by".
   *
   * A column already in the list keeps its place and changes direction, which
   * is the only reading of ⇧-clicking it a second time: moving it to the end
   * would silently demote the key the reader had just been adjusting.
   */
  const addSort = (col, dir) => {
    const at = sorts.findIndex((key) => key.col === col)
    if (!dir) sorts = sorts.filter((key) => key.col !== col)
    else if (at >= 0) sorts = sorts.map((key) => (key.col === col ? { col, dir } : key))
    else sorts = [...sorts, { col, dir }]
    rebuildOrder()
    collapse()
    paint()
  }

  /** ⇧-click's own cycle, on a column that may already be a key: ascending,
   *  descending, then out of the ordering altogether. */
  const cycleAddSort = (col) => {
    const key = sortOn(col)
    if (!key) return addSort(col, 'asc')
    return addSort(col, key.dir === 'asc' ? 'desc' : null)
  }

  /** The next state of a heading that was clicked: ascending, then descending,
   *  then back to the file's own order. */
  const cycleSort = (col) => {
    const key = sorts.length === 1 ? sortOn(col) : null
    if (!key) return sortBy(col, 'asc')
    if (key.dir === 'asc') return sortBy(col, 'desc')
    return sortBy(col, null)
  }

  /**
   * Whether the first row is the headings — the switch, not the reading.
   *
   * Not an edit: the file holds the same rows either way, and saving writes
   * the same bytes, because `saveFile` only puts the header row back when it
   * came off the file. What changes is where row one is shown — in the column
   * heads, or as the first row of data where it can be sorted, filtered and
   * totalled with the rest.
   *
   * The undo history goes with the toggle. Every entry in it names rows by
   * their index, and moving row one in or out of the data renumbers every row
   * behind it — replaying an old patch against the new numbering would edit
   * the wrong rows, which is far worse than a history that starts here.
   */
  const setHasHeader = (flag) => {
    const next = !!flag
    if (next === hasHeader || !current) return
    if (editing) commitEdit()
    if (next) {
      header = rows.length ? rows[0] : ['']
      rows = rows.slice(1)
    } else {
      rows = [header, ...rows]
      header = numberedHeader(columns())
    }
    hasHeader = next
    headerChoice.set(current.path, next)
    history = []
    future = []
    extras = []
    cursor = { r: rows.length ? 0 : -1, c: Math.min(cursor.c, Math.max(0, columns() - 1)) }
    anchor = { ...cursor }
    forgetStats()
    rebuildOrder()
    paint()
    onStatus(next ? 'First row shown as the headings' : 'First row shown as data')
  }

  /** Make the sort real: write the rows in the order they are being shown in.
   *  The one destructive thing sorting can do, so it is a button and an undo
   *  entry rather than a side effect of looking. */
  const applySort = () => {
    if (!sorts.length || !editable()) return
    record(snapshot())
    // Over every row, not just the filtered ones: applying a sort must not
    // silently drop what the filter is hiding.
    const full = multiSortedOrder(rows, rows.map((_, i) => i), sorts)
    const keep = sourceOf(cursor.r)
    const moved = new Map(full.map((src, at) => [src, at]))
    rows = full.map((i) => rows[i])
    sorts = []
    if (keep >= 0 && moved.has(keep)) cursor = { ...cursor, r: moved.get(keep) }
    collapse()
    rebuildOrder()
    setDirty(true)
    paint()
    revealCursor()
    queueSave()
    onStatus('Sort written into the file')
  }

  /* ------------------------------------------------------- the find box */

  /* The find box highlights; it never changes which rows are on screen, so
     `order` is untouched and only the marks are repainted — unless "Only
     matches" is on, which makes it a filter and puts it in `order` with the
     column ones. */
  /** One matcher per keystroke, not one per cell. */
  const refreshMatcher = () => { matcher = makeMatcher(query) }

  const setQuery = (text) => {
    query = text
    refreshMatcher()
    if (onlyMatches) {
      const keep = sourceOf(cursor.r)
      rebuildOrder({ keepSource: keep })
      collapse()
      paint()
      return
    }
    paintBar()
    requestDecorate()
  }

  const openFindReplace = () => {
    replacing = true
    paintBar()
    search.focus()
    search.select()
  }

  const setOnlyMatches = (flag) => {
    const next = !!flag
    if (next === onlyMatches) return
    onlyMatches = next
    const keep = sourceOf(cursor.r)
    rebuildOrder({ keepSource: keep })
    collapse()
    paint()
    /* Said out loud because the grid is about to lose most of its rows and the
       one control that did it is a button the reader may not have been looking
       at. The count is of rows, not cells: a row is what went. */
    if (query.trim()) {
      onStatus(next
        ? `Showing ${viewRows().toLocaleString()} of ${rows.length.toLocaleString()} rows`
        : 'Showing every row')
    }
  }

  /** The next cell holding the query, wrapping once. Enter in the find box,
   *  and ⌘G is the same thing from the grid. */
  const findNext = (back = false) => {
    if (!matcher || !viewRows()) return false
    const total = viewRows() * columns()
    const at = Math.max(0, cursor.r) * columns() + cursor.c
    for (let step = 1; step <= total; step++) {
      const index = ((at + (back ? -step : step)) % total + total) % total
      const r = Math.floor(index / columns())
      const c = index % columns()
      if (matcher.test(valueAt(r, c))) {
        moveTo(r, c)
        scroller.focus({ preventScroll: true })
        return true
      }
    }
    onStatus('No match')
    return false
  }

  /* ---------------------------------------------------------- the replace */

  /**
   * Replace the match in the cell under the cursor and step to the next one —
   * or, when the cursor is not on a match, only step: the first press finds,
   * the second press changes, which is how every editor's Replace button
   * behaves and the only rhythm that lets the reader see each change before it
   * is made.
   */
  const replaceOne = () => {
    if (!matcher || !editable()) return
    const replacement = replaceBox.value
    const value = String(valueAt(cursor.r, cursor.c))
    if (cursor.r >= 0 && matcher.test(value)) {
      const after = matcher.replace(value, replacement)
      if (after !== value) {
        const src = sourceOf(cursor.r)
        writeSource(src, cursor.c, after)
        record({ kind: 'cells', edits: [{ src, c: cursor.c, before: value, after }] })
        setDirty(true)
        if (sortOn(cursor.c)) rebuildOrder({ keepSource: src })
        paint()
        queueSave()
      }
    }
    findNext()
  }

  /**
   * Replace every match in the rows on screen — the filtered view, not the
   * file, because a filter narrowed to "TV Show" followed by Replace All is a
   * sentence about those rows and silently rewriting the hidden ones would be
   * the grid deciding it knew better. With no filter on, the view *is* the
   * file. One undo entry for the lot.
   */
  const replaceAll = () => {
    if (!matcher || !editable()) return
    const replacement = replaceBox.value
    const edits = []
    for (const viewRow of order) {
      const row = rows[viewRow] || []
      for (let c = 0; c < Math.max(row.length, columns()); c++) {
        const before = String(row[c] ?? '')
        if (!before || !matcher.test(before)) continue
        const after = matcher.replace(before, replacement)
        if (after === before) continue
        edits.push({ src: viewRow, c, before, after })
      }
    }
    if (!edits.length) { onStatus('No match'); return }
    for (const edit of edits) writeSource(edit.src, edit.c, edit.after)
    record({ kind: 'cells', edits })
    setDirty(true)
    rebuildOrder()
    paint()
    queueSave()
    onStatus(`Replaced in ${edits.length.toLocaleString()} ${edits.length === 1 ? 'cell' : 'cells'}`)
  }

  /* ---------------------------------------------------- the column filter */

  /* How many value rows the panel puts in the document. A column of free text
     has as many distinct values as it has rows, and a panel that tried to list
     two hundred thousand tick boxes would be a window that stopped responding
     on the way to a list nobody could read anyway. The rest are reachable by
     typing into the panel's own box, which is what a list that long is
     searched rather than scanned. */
  const FILTER_ROWS = 400

  const closeFilter = () => {
    filterPanel.hidden = true
    filterPanel.replaceChildren()
  }

  /** Hide `hidden` in column `c`, or clear the column's filter if that set is
   *  empty. The one way `filters` is written to. */
  const setColumnFilter = (c, hidden) => {
    if (hidden && hidden.size) filters.set(c, new Set(hidden))
    else filters.delete(c)
    /* The cursor keeps its *row* rather than its position, which is the
       opposite of what a sort does and for the reason given at `sortBy`: rows
       have gone, so a position means something different than it did. */
    const keep = sourceOf(cursor.r)
    rebuildOrder({ keepSource: keep })
    collapse()
    paint()
  }

  const clearAllFilters = () => {
    if (!filtering()) return
    const keep = sourceOf(cursor.r)
    filters = new Map()
    onlyMatches = false
    rebuildOrder({ keepSource: keep })
    collapse()
    paint()
    onStatus(`Showing all ${rows.length.toLocaleString()} rows`)
  }

  /**
   * The panel for one column: every value it holds, ticked or not.
   *
   * Ticks apply as they are made rather than on a Done button. A filter is a
   * way of looking and the table behind the panel is the answer — untick
   * "Movie" and the shows are there to see, which is the whole gesture. There
   * is nothing to commit and so nothing to cancel; Escape closes the panel and
   * leaves the view as the ticks left it.
   *
   * The values are counted over the whole file rather than over what the other
   * columns' filters leave, so the list does not change under the reader as
   * they work across columns — and a value that is ticked but currently shows
   * nothing is still the truth about the column.
   */
  const openFilter = (x, y, c) => {
    closeMenu()
    if (!current || c < 0 || c >= columns()) return
    const every = rows.map((_, i) => i)
    const values = columnValues(rows, every, c)
    const hidden = new Set(filters.get(c) ?? [])
    let needle = ''

    const panelHead = document.createElement('div')
    panelHead.className = 'csv-filter-head'
    panelHead.textContent = header[c] || `Column ${c + 1}`

    const box = document.createElement('input')
    box.className = 'csv-filter-search'
    box.type = 'search'
    box.placeholder = 'Find a value'
    box.spellcheck = false

    const picks = document.createElement('div')
    picks.className = 'csv-filter-picks'
    const allBtn = button('All', 'filter-all', 'Tick everything listed')
    const noneBtn = button('None', 'filter-none', 'Untick everything listed')
    const kept = document.createElement('span')
    kept.className = 'csv-filter-kept'
    picks.append(allBtn, noneBtn, kept)

    const list = document.createElement('div')
    list.className = 'csv-filter-list'
    list.setAttribute('role', 'group')
    list.setAttribute('aria-label', `Values in ${header[c] || `column ${c + 1}`}`)

    const note = document.createElement('div')
    note.className = 'csv-filter-note'

    /** The values the panel's own box leaves, which is what All and None act
     *  on: narrowing to `TV` and pressing None means "not those", and having
     *  it mean "not anything" would be a different sentence. */
    const listed = () => (needle
      ? values.filter((v) => v.value.toLowerCase().includes(needle))
      : values)

    const apply = () => {
      setColumnFilter(c, hidden)
      drawFoot()
    }

    const drawFoot = () => {
      const showing = values.length - hidden.size
      kept.textContent = `${showing.toLocaleString()} of ${values.length.toLocaleString()} kept`
    }

    const drawList = () => {
      const shown = listed()
      const frag = document.createDocumentFragment()
      for (const { value, count } of shown.slice(0, FILTER_ROWS)) {
        const row = document.createElement('label')
        row.className = 'csv-filter-row'
        const tick = document.createElement('input')
        tick.type = 'checkbox'
        tick.checked = !hidden.has(value)
        tick.addEventListener('change', () => {
          if (tick.checked) hidden.delete(value)
          else hidden.add(value)
          apply()
        })
        const name = document.createElement('span')
        name.className = 'csv-filter-value'
        /* A blank cell is a value a person filters on — the rows where nothing
           was exported — and it needs a name to be tickable at all. Marked as
           a label rather than shown as emptiness, which would read as a
           rendering fault. */
        if (value.trim() === '') {
          name.textContent = '(blank)'
          name.classList.add('is-blank')
        } else {
          name.textContent = value
        }
        const many = document.createElement('span')
        many.className = 'csv-filter-count'
        many.textContent = count.toLocaleString()
        row.append(tick, name, many)
        frag.append(row)
      }
      list.replaceChildren(frag)
      list.scrollTop = 0
      const over = shown.length - FILTER_ROWS
      if (!shown.length) note.textContent = 'Nothing here matches that'
      else if (over > 0) note.textContent = `${over.toLocaleString()} more — type to narrow the list`
      else note.textContent = ''
      note.hidden = !note.textContent
    }

    box.addEventListener('input', () => {
      needle = box.value.trim().toLowerCase()
      drawList()
    })
    allBtn.addEventListener('click', () => {
      for (const { value } of listed()) hidden.delete(value)
      apply()
      drawList()
    })
    noneBtn.addEventListener('click', () => {
      for (const { value } of listed()) hidden.add(value)
      apply()
      drawList()
    })

    drawList()
    drawFoot()
    filterPanel.replaceChildren(panelHead, box, picks, list, note)
    filterPanel.hidden = false

    const bounds = frame.getBoundingClientRect()
    const width = filterPanel.offsetWidth || 240
    const height = filterPanel.offsetHeight || 300
    filterPanel.style.left = `${Math.max(4, Math.min(x - bounds.left, bounds.width - width - 8))}px`
    filterPanel.style.top = `${Math.max(4, Math.min(y - bounds.top, bounds.height - height - 8))}px`
    box.focus()
  }

  /** The funnel in a heading, the bar's button and ⇧⌘F all end here. Anchored
   *  under the heading when there is one on screen, so the panel opens beside
   *  the column it is about rather than wherever the pointer last was. */
  const filterColumn = (c) => {
    const cell = headRow.querySelector(`.csv-th[data-col="${c}"]`)
    const at = (cell || headRow).getBoundingClientRect()
    openFilter(at.left, at.bottom + 2, c)
  }

  /* ------------------------------------------------------- the clipboard */

  const copySelection = async ({ cut = false } = {}) => {
    const grid = selectionValues()
    const text = gridToClipboard(grid)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* No clipboard permission is the one failure worth saying out loud: the
         alternative is a ⌘C that silently does nothing. */
      onStatus('Could not reach the clipboard')
      return
    }
    if (cut) clearSelection()  // a no-op with a reason in Reading view
    else onStatus(`Copied ${grid.length.toLocaleString()} × ${grid[0]?.length || 0}`)
  }

  const clearSelection = () => {
    if (!editable()) return
    const edits = []
    for (const [r, c] of selectionCoords()) {
      const before = valueAt(r, c)
      if (before === '') continue
      edits.push({ src: sourceOf(r), c, before, after: '' })
    }
    if (!edits.length) return
    for (const edit of edits) writeSource(edit.src, edit.c, '')
    record({ kind: 'cells', edits })
    setDirty(true)
    if (sorts.length) { rebuildOrder(); paint() } else paintRows({ force: true })
    requestDecorate()
    queueSave()
  }

  /**
   * Paste a grid at the cursor, growing the table if it does not fit — which
   * is what a spreadsheet does and what makes pasting a fresh export into an
   * empty file work at all.
   */
  const pasteGrid = (grid) => {
    if (!grid.length || !editable()) return
    const wide = Math.max(...grid.map((row) => row.length))
    const startRow = cursor.r
    const needRows = startRow === -1 ? grid.length - 1 : startRow + grid.length
    const needCols = cursor.c + wide
    const grows = needCols > columns() || needRows > viewRows()

    if (grows) record(snapshot())

    if (needCols > columns()) {
      while (header.length < needCols) header.push('')
      while (widths.length < needCols) {
        widths.push(MIN_COL)
        numeric.push(false)
        aligns.push(null)
      }
    }
    if (needRows > viewRows()) {
      const extra = needRows - viewRows()
      const start = rows.length
      for (let i = 0; i < extra; i++) rows.push(blankRow())
      for (let i = 0; i < extra; i++) order.push(start + i)
    }

    const edits = []
    for (let i = 0; i < grid.length; i++) {
      const r = startRow + i
      if (r >= viewRows()) break
      const src = sourceOf(r)
      for (let c = 0; c < grid[i].length; c++) {
        const col = cursor.c + c
        if (col >= columns()) break
        const before = valueAt(r, col)
        const after = String(grid[i][c] ?? '')
        if (before === after) continue
        edits.push({ src, c: col, before, after })
        writeSource(src, col, after)
      }
    }
    if (!grows && edits.length) record({ kind: 'cells', edits })
    if (edits.length || grows) setDirty(true)
    // What was pasted is what is selected, and only that.
    extras = []
    anchor = { r: startRow, c: cursor.c }
    cursor = {
      r: Math.min(viewRows() - 1, startRow + grid.length - 1),
      c: Math.min(columns() - 1, cursor.c + wide - 1)
    }
    if (sorts.length) rebuildOrder()
    paint()
    revealCursor()
    queueSave()
  }

  const pasteFromClipboard = async () => {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      onStatus('Could not read the clipboard')
      return
    }
    if (!text) return
    pasteGrid(parseClipboardGrid(text))
  }

  /** ⌘D: the top row of the selection, copied over the rest of it — of each
   *  block of it, since each has a top row of its own. */
  const fillDown = () => {
    if (!editable()) return
    const edits = []
    /* One edit per cell, whatever the blocks do. Two that overlap would
       otherwise record the shared cell twice, and undo replays a patch
       forwards: the second entry's "before" is what the first one wrote, so
       putting them both back leaves the cell holding the filled value. */
    const written = new Set()
    for (const box of ranges()) {
      if (box.r1 <= box.r0) continue
      for (let c = box.c0; c <= box.c1; c++) {
        const value = valueAt(box.r0, c)
        for (let r = box.r0 + 1; r <= box.r1; r++) {
          if (written.has(`${r}:${c}`)) continue
          written.add(`${r}:${c}`)
          const src = sourceOf(r)
          const before = valueAt(r, c)
          if (before === value) continue
          edits.push({ src, c, before, after: value })
          writeSource(src, c, value)
        }
      }
    }
    if (!edits.length) return
    record({ kind: 'cells', edits })
    setDirty(true)
    if (sorts.length) rebuildOrder()
    paint()
    queueSave()
  }

  /* ---------------------------------------------------------- the exports */

  /**
   * Write the table out as another format, beside the file it came from.
   *
   * A sibling with the new extension, and never over one that already exists:
   * an export is a copy, and a copy that destroyed `data.tsv` on the grounds
   * that you asked for a TSV would be an unpleasant surprise. Plain UTF-8,
   * because the point of exporting is the file's next reader and UTF-8 is the
   * one thing all of them take.
   */
  const exportAs = async (kind) => {
    if (!current) return
    const base = current.path.replace(/\.[^./\\]+$/, '')
    const ext = kind === 'json' ? '.json' : '.tsv'
    let target = `${base}${ext}`
    if (typeof file.probe === 'function') {
      for (let n = 0; target === current.path ||
          (await file.probe(target).then((r) => r && r.ok !== false).catch(() => false)); n++) {
        target = `${base} export${n ? ` ${n + 1}` : ''}${ext}`
        if (n > 20) break
      }
    } else if (target === current.path) {
      target = `${base} export${ext}`
    }
    const table = hasHeader ? [header, ...rows] : rows
    const text = kind === 'json'
      ? gridToJson(header, rows)
      : gridToTsv(table)
    try {
      await file.write(target, text)
      onStatus(`Exported to ${target.split('/').pop()}`)
    } catch {
      onStatus('The export could not be written')
    }
  }

  /** The selection as a Markdown table on the clipboard, headed by the
   *  columns' own headings — a table pasted into a note without them would be
   *  data with the names stripped off. */
  const copyMarkdown = async () => {
    const values = selectionValues()
    const cols = axisOf(ranges(), 'c0', 'c1')
    const head = cols.map((c) => header[c] ?? '')
    try {
      await navigator.clipboard.writeText(gridToMarkdown([head, ...values]))
      onStatus(`Copied ${values.length.toLocaleString()} ${values.length === 1 ? 'row' : 'rows'} as a Markdown table`)
    } catch {
      onStatus('Could not reach the clipboard')
    }
  }

  /* ------------------------------------------------------- the right-click */

  const closeMenu = () => { menu.hidden = true; menu.replaceChildren() }

  const openMenu = (x, y, items) => {
    const frag = document.createDocumentFragment()
    for (const item of items) {
      if (item === '-') {
        const rule = document.createElement('div')
        rule.className = 'csv-menu-rule'
        frag.append(rule)
        continue
      }
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'csv-menu-item'
      row.textContent = item.label
      row.disabled = !!item.disabled
      row.addEventListener('click', () => { closeMenu(); item.run() })
      frag.append(row)
    }
    menu.replaceChildren(frag)
    menu.hidden = false
    const box = frame.getBoundingClientRect()
    const width = menu.offsetWidth || 200
    const height = menu.offsetHeight || 220
    menu.style.left = `${Math.min(x - box.left, box.width - width - 8)}px`
    menu.style.top = `${Math.min(y - box.top, box.height - height - 8)}px`
  }

  /**
   * The alignment items, worded and ordered the same in every menu that shows
   * them.
   *
   * A tick against the one in force rather than three items that look alike:
   * the question "which way is this column pointed" is one the menu can answer
   * just by being open, and over several columns at once it answers honestly —
   * no tick when they disagree.
   */
  const alignItems = (c) => {
    const cols = alignTargets(c)
    const many = cols.length > 1
    const suffix = many ? ` (${cols.length} columns)` : ''
    const agreed = cols.every((col) => aligns[col] === aligns[cols[0]]) ? aligns[cols[0]] : undefined
    const item = (how, label) => ({
      label: `${agreed === how ? '✓ ' : ''}${label}${suffix}`,
      run: () => alignColumns(cols, how)
    })
    return [
      item('left', 'Align left'),
      item('center', 'Align centre'),
      item('right', 'Align right'),
      {
        label: `${agreed === null ? '✓ ' : ''}Align automatically${suffix}`,
        run: () => alignColumns(cols, null)
      }
    ]
  }

  const cellMenu = (event, r, c) => {
    /* Worked out once, here, rather than inside each item: the list is what the
       labels count and what the items act on, so a menu that says "Delete 3
       rows" deletes those three and no others. */
    const picked = selectedRows()
    const many = picked.length > 1
    const first = picked[0] ?? Math.max(0, r)
    const last = picked[picked.length - 1] ?? Math.max(0, r)
    /* Reading view's menu is the reading half of the editing one, rather than
       the same list with two thirds of it greyed out: a menu of disabled items
       is a menu that has to be read to learn it does nothing. */
    if (readonly) {
      openMenu(event.clientX, event.clientY, [
        { label: 'Copy', run: () => copySelection() },
        { label: 'Copy as Markdown table', run: () => copyMarkdown() },
        '-',
        { label: 'Select column', run: () => selectColumn(c) },
        { label: 'Select row', disabled: r < 0, run: () => selectRow(r) },
        '-',
        ...alignItems(c)
      ])
      return
    }
    openMenu(event.clientX, event.clientY, [
      { label: 'Copy', run: () => copySelection() },
      { label: 'Copy as Markdown table', run: () => copyMarkdown() },
      { label: 'Cut', run: () => copySelection({ cut: true }) },
      { label: 'Paste', run: () => pasteFromClipboard() },
      { label: 'Clear contents', run: () => clearSelection() },
      '-',
      { label: 'Insert row above', run: () => insertRows(first) },
      { label: 'Insert row below', run: () => insertRows(last + 1) },
      {
        label: many ? `Duplicate ${picked.length.toLocaleString()} rows` : 'Duplicate row',
        disabled: !picked.length,
        run: () => duplicateRows(picked)
      },
      {
        label: many ? `Delete ${picked.length.toLocaleString()} rows` : 'Delete row',
        disabled: !picked.length,
        run: () => deleteRows(picked)
      },
      '-',
      { label: 'Insert column left', run: () => insertColumn(c) },
      { label: 'Insert column right', run: () => insertColumn(c + 1) },
      { label: 'Delete column', run: () => deleteColumn(c) },
      '-',
      { label: 'Select column', run: () => selectColumn(c) },
      { label: 'Select row', disabled: r < 0, run: () => selectRow(r) },
      { label: 'Fill down', disabled: !many, run: () => fillDown() },
      '-',
      ...alignItems(c)
    ])
  }

  const headMenu = (event, c) => {
    /* Sorting is a way of looking too, so the same four items are in both
       menus. "Then by" only appears once there is something for this column to
       come *after*: on a table in its own order it would be a distinction
       without a difference, and it is the one item here that needs explaining
       to be understood. */
    const sortItems = [
      { label: 'Sort A → Z', run: () => sortBy(c, 'asc') },
      { label: 'Sort Z → A', run: () => sortBy(c, 'desc') },
      ...(sorts.length && !(sorts.length === 1 && sorts[0].col === c)
        ? [
            { label: 'Then by A → Z', run: () => addSort(c, 'asc') },
            { label: 'Then by Z → A', run: () => addSort(c, 'desc') }
          ]
        : []),
      { label: 'Clear sort', disabled: !sorts.length, run: () => sortBy(c, null) }
    ]
    /* Filtering is a way of looking, so it is in both menus and worded the
       same in each. */
    const filterItems = [
      { label: 'Filter this column…', run: () => filterColumn(c) },
      {
        label: 'Clear this column’s filter',
        disabled: !filters.get(c)?.size,
        run: () => setColumnFilter(c, null)
      },
      { label: 'Clear all filters', disabled: !filtering(), run: () => clearAllFilters() }
    ]
    /* Exports are reads, so they are in both menus. The header toggle is a way
       of looking too — the file is the same rows either way — so it stays in
       Reading view as well; only when the table is locked is it left out,
       because it clears the undo history and a locked file has nothing to
       lose it for. */
    const tableItems = [
      {
        label: `${hasHeader ? '✓ ' : ''}First row is the headings`,
        run: () => setHasHeader(!hasHeader)
      },
      '-',
      { label: 'Export as TSV', run: () => { exportAs('tsv') } },
      { label: 'Export as JSON', run: () => { exportAs('json') } }
    ]
    if (readonly) {
      openMenu(event.clientX, event.clientY, [
        ...sortItems,
        '-',
        ...filterItems,
        '-',
        { label: 'Fit column width', run: () => fitColumn(c) },
        { label: 'Fit all columns', run: () => fitAllColumns() },
        { label: 'Select column', run: () => selectColumn(c) },
        '-',
        ...tableItems,
        '-',
        ...alignItems(c)
      ])
      return
    }
    openMenu(event.clientX, event.clientY, [
      ...sortItems,
      { label: 'Write this order into the file', disabled: !sorts.length, run: () => applySort() },
      '-',
      ...filterItems,
      '-',
      { label: 'Rename heading', run: () => { moveTo(-1, c); beginEdit() } },
      { label: 'Fit column width', run: () => fitColumn(c) },
      { label: 'Fit all columns', run: () => fitAllColumns() },
      { label: 'Select column', run: () => selectColumn(c) },
      '-',
      ...tableItems,
      '-',
      ...alignItems(c),
      '-',
      { label: 'Insert column left', run: () => insertColumn(c) },
      { label: 'Insert column right', run: () => insertColumn(c + 1) },
      { label: 'Delete column', run: () => deleteColumn(c) }
    ])
  }

  /* ------------------------------------------------------------ resizing */

  /** @type {{ c: number, x: number, from: number } | null} */
  let resize = null

  const startResize = (event, c) => {
    resize = { c, x: event.clientX, from: widths[c] }
    frame.classList.add('is-resizing')
    event.preventDefault()
  }

  const onResizeMove = (event) => {
    if (!resize) return
    /* A hand dragging a column is the one width nobody has to guess at, so the
       ceiling here is only there to stop a column being dragged off into
       nothing — and it is never below what a fit would have given. */
    const next = Math.round(Math.max(MIN_COL,
      Math.min(Math.max(MAX_COL * 2, fitCeiling()), resize.from + (event.clientX - resize.x))))
    if (next === widths[resize.c]) return
    widths[resize.c] = next
    /* Repainted rather than restyled in place. Widening a column moves every
       column to its right, which moves the spacers standing in for the ones
       off screen and can bring another column into view — none of which a
       pass over the cells that happen to exist could do. Only the visible
       columns are built, so this is a smaller repaint than the one it
       replaces. */
    canvas.style.width = `${bodyWidth()}px`
    paintHead()
    paintRows({ force: true })
  }

  const endResize = () => {
    if (!resize) return
    resize = null
    frame.classList.remove('is-resizing')
    // At the end of the drag, not through it: a width per mouse-move would be
    // a write per pixel.
    rememberWidths()
  }

  /* ------------------------------------------------------------ the wiring */

  scroller.addEventListener('scroll', () => {
    syncHeadScroll()
    paintRows()
    paintColumnScroll()
  }, { passive: true })

  bar.addEventListener('click', (event) => {
    const act = (/** @type {any} */ (event.target)).closest?.('.csv-btn')?.dataset.act
    switch (act) {
      case 'undo': stepHistory(false); break
      case 'redo': stepHistory(true); break
      case 'add-row': insertRows(Math.max(0, cursor.r) + 1); break
      case 'add-col': insertColumn(cursor.c + 1); break
      case 'fit': fitAllColumns(); break
      case 'scroll-left':
        scroller.scrollBy({ left: -Math.max(180, scroller.clientWidth * 0.75), behavior: 'smooth' })
        return
      case 'scroll-right':
        scroller.scrollBy({ left: Math.max(180, scroller.clientWidth * 0.75), behavior: 'smooth' })
        return
      // A toggle keeps the focus it was given: the next thing the reader does
      // is likely to be turning it back off, or typing more into the box.
      case 'only-matches': setOnlyMatches(!onlyMatches); return
      case 'replace-one': replaceOne(); return
      case 'replace-all': replaceAll(); return
      case 'clear-filters': clearAllFilters(); break
      /* The panel takes the focus itself and keeps it while boxes are ticked,
         so this one does not hand it back to the grid. */
      case 'filter': filterColumn(cursor.c); return
      default: return
    }
    scroller.focus({ preventScroll: true })
  })

  /**
   * Read the file again, split a different way.
   *
   * Not a re-split of what is in memory. Quoting is done in terms of the
   * delimiter a file was written with, so re-splitting the rows already parsed
   * would take a field that legitimately contains the *new* delimiter — never
   * quoted, because it never needed to be — and tear it in half. The text on
   * disk is the only thing that can answer this, so anything unsaved goes down
   * first and the file is opened again from scratch.
   *
   * The choice is remembered, so a file whose delimiter had to be corrected by
   * hand opens correctly next time rather than asking again.
   */
  const useDelimiter = async (delimiter) => {
    if (!current || delimiter === current.delimiter) return
    const path = current.path
    const where = { top: scroller.scrollTop, left: scroller.scrollLeft }
    try {
      await saveFile({ flush: true })
      await grid.open(path, where, delimiter)
      rememberWidths()
      onStatus(`Read as ${delimiterName(delimiter).toLowerCase()}-separated`)
    } catch {
      onStatus('Could not read the file that way')
    }
  }

  /* A big file waits for the typing to pause: each character costs a pass
     over the rows the last one kept, and the first character keeps nearly
     all of them. A small one answers at once, as it always did. */
  const FIND_DEBOUNCE_ROWS = 5000
  const FIND_DEBOUNCE_MS = 80
  /** @type {any} */
  let findTimer = null
  search.addEventListener('input', () => {
    clearTimeout(findTimer)
    if (rows.length < FIND_DEBOUNCE_ROWS) { setQuery(search.value); return }
    findTimer = setTimeout(() => setQuery(search.value), FIND_DEBOUNCE_MS)
  })
  /* Enter in the replace box replaces — the box is only on screen because
     replacing is what the reader is doing — and Escape folds the strip away. */
  replaceBox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey || event.metaKey || event.ctrlKey) replaceAll()
      else replaceOne()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      replacing = false
      paintBar()
      scroller.focus({ preventScroll: true })
    }
  })
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); findNext(event.shiftKey) }
    else if (event.key === 'Escape') {
      event.preventDefault()
      search.value = ''
      setQuery('')
      scroller.focus({ preventScroll: true })
    }
  })

  headRow.addEventListener('mousedown', (event) => {
    const grip = (/** @type {any} */ (event.target)).closest?.('.csv-grip')
    if (grip) { startResize(event, Number(grip.dataset.grip)); return }
    /* Before the sort, and swallowing the click: the funnel sits inside the
       heading, and a click on it that also cycled the sort would reorder the
       table every time somebody went to filter it. */
    const funnel = (/** @type {any} */ (event.target)).closest?.('.csv-funnel')
    if (funnel) {
      event.preventDefault()
      filterColumn(Number(funnel.dataset.funnel))
      return
    }
    const cell = (/** @type {any} */ (event.target)).closest?.('.csv-th')
    if (!cell) return
    const c = Number(cell.dataset.col)
    event.preventDefault()
    /* ⌘-click on a heading picks the column out without disturbing the columns
       already picked — and a second one puts it back. Never a sort: the click
       that adds a column to a selection is not a click about order. */
    if (addsToSelection(event)) {
      toggleColumn(c)
      scroller.focus({ preventScroll: true })
      return
    }
    /* ⌥-click adds the column to the ordering instead of replacing it, which
       is what makes "by department, then by name" two clicks. Not ⇧-click,
       which every grid in the world — this one included, two lines up — reads
       as "extend the selection to here"; taking it for a second sort key would
       be one gesture with two meanings on the same element. */
    if (event.altKey) {
      cycleAddSort(c)
      scroller.focus({ preventScroll: true })
      return
    }
    if (event.shiftKey) { moveTo(cursor.r, c, { extend: true }); return }
    if (event.detail > 1) return  // the double-click handler renames it
    sortBeforeClick = sorts.map((key) => ({ ...key }))
    cycleSort(c)
    /* The same press may turn out to be a drag. Armed rather than started:
       nothing happens until the pointer has moved far enough sideways that it
       cannot be a click — see the frame's mousemove — and if it never does,
       the sort this click just performed simply stands. */
    if (!readonly && !lock) headerDrag = { c, x: event.clientX, active: false, to: null }
    scroller.focus({ preventScroll: true })
  })

  /* -------------------------------------------------- dragging a heading */

  /* The press that may become a column drag. `active` flips once the pointer
     has moved past the slop a click can wander, and from then on the sort the
     press performed is owed an undoing — a drag is not a click, and reordering
     the rows on the way to reordering the columns would be doing both halves
     of an ambiguous gesture. */
  /** @type {{ c: number, x: number, active: boolean, to: number | null } | null} */
  let headerDrag = null

  const paintColumnDrop = (to) => {
    for (const cell of /** @type {NodeListOf<HTMLElement>} */ (headRow.querySelectorAll('.csv-th'))) {
      const c = Number(cell.dataset.col)
      cell.classList.toggle('is-col-drop', to !== null && c === to && c !== headerDrag?.c)
      cell.classList.toggle('is-col-lifted', headerDrag?.active === true && c === headerDrag?.c)
    }
  }

  const endHeaderDrag = () => {
    if (!headerDrag) return
    const { c, to, active } = headerDrag
    headerDrag = null
    frame.classList.remove('is-col-dragging')
    paintColumnDrop(null)
    if (!active) return
    /* The mousedown that began this sorted the column on its way here, and a
       drag is not a request to reorder the rows — so the sort goes back to
       whatever it was, exactly as the rename double-click puts it back. */
    sorts = (sortBeforeClick || []).map((key) => ({ ...key }))
    rebuildOrder()
    if (to !== null && to !== c) moveColumn(c, to)
    else paint()
  }

  /**
   * The element of `kind` this event is about.
   *
   * `event.target` first, and the element under the pointer as the fallback:
   * clicking a heading sorts, which rebuilds the whole strip, so by the time
   * the *second* click of a double-click arrives its predecessor is gone from
   * the document and the browser reports the two clicks' common ancestor
   * instead. Without this, double-clicking a heading to rename it silently did
   * nothing on every column that had been clicked once.
   */
  const eventTarget = (event, kind) => {
    const direct = event.target.closest?.(kind)
    if (direct) return direct
    return document.elementFromPoint(event.clientX, event.clientY)?.closest?.(kind) || null
  }

  headRow.addEventListener('dblclick', (event) => {
    const grip = (/** @type {any} */ (event.target)).closest?.('.csv-grip')
    if (grip) { fitColumn(Number(grip.dataset.grip)); return }
    const cell = eventTarget(event, '.csv-th')
    if (!cell) return
    /* Nothing to rename in Reading view, so the double-click is left as the
       two sort clicks it looks like — undoing the first one to say "you cannot
       edit this" would take the sort away as the price of the message. */
    if (readonly) return
    const c = Number(cell.dataset.col)
    /* The first click of this double-click sorted the column on its way here.
       Renaming a heading is not a request to reorder the table, so the sort
       goes back to whatever it was before that click. */
    sorts = (sortBeforeClick || []).map((key) => ({ ...key }))
    rebuildOrder()
    collapse()
    paint()
    moveTo(-1, c)
    beginEdit()
  })

  headRow.addEventListener('contextmenu', (event) => {
    const cell = eventTarget(event, '.csv-th')
    if (!cell) return
    event.preventDefault()
    headMenu(event, Number(cell.dataset.col))
  })

  scroller.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return
    if ((/** @type {any} */ (event.target)).tagName === 'INPUT') return
    const corner = (/** @type {any} */ (event.target)).closest?.('.csv-corner')
    if (corner) { selectAll(); scroller.focus({ preventScroll: true }); return }
    const gutter = (/** @type {any} */ (event.target)).closest?.('.csv-gutter')
    if (gutter) {
      const r = Number(gutter.dataset.row)
      if (addsToSelection(event)) {
        /* A ⌘-click that took a row back out has nothing to drag; one that
           added a row starts a block there, so a drag from it picks up the
           rows below as any other drag on the gutter does. */
        if (!toggleRow(r)) { scroller.focus({ preventScroll: true }); return }
      } else if (event.shiftKey) moveTo(r, columns() - 1, { extend: true })
      else selectRow(r)
      dragging = 'rows'
      scroller.focus({ preventScroll: true })
      return
    }
    const cell = (/** @type {any} */ (event.target)).closest?.('.csv-cell')
    if (!cell) return
    const r = Number(cell.dataset.row)
    const c = Number(cell.dataset.col)
    if (addsToSelection(event)) moveTo(r, c, { add: true })
    else moveTo(r, c, { extend: event.shiftKey })
    dragging = 'cells'
    scroller.focus({ preventScroll: true })
  })

  frame.addEventListener('mousemove', (event) => {
    if (resize) { onResizeMove(event); return }
    if (headerDrag) {
      /* Sideways only: a heading press that drifts down is on its way to the
         body, not to another column. Six pixels is the slop a click wanders. */
      if (!headerDrag.active && Math.abs(event.clientX - headerDrag.x) > 6) {
        headerDrag.active = true
        frame.classList.add('is-col-dragging')
      }
      if (headerDrag.active) {
        const th = eventTarget(event, '.csv-th')
        const to = th ? Number(th.dataset.col) : null
        if (to !== headerDrag.to) {
          headerDrag.to = to
          paintColumnDrop(to)
        }
      }
      return
    }
    if (!dragging) return
    const target = dragging === 'rows'
      ? (/** @type {any} */ (event.target)).closest?.('.csv-gutter, .csv-cell')
      : (/** @type {any} */ (event.target)).closest?.('.csv-cell')
    if (!target) return
    const r = Number(target.dataset.row)
    if (Number.isNaN(r)) return
    const c = dragging === 'rows' ? columns() - 1 : Number(target.dataset.col)
    if (r === cursor.r && c === cursor.c) return
    moveTo(r, Number.isNaN(c) ? cursor.c : c, { extend: true })
  })

  window.addEventListener('mouseup', () => { dragging = null; endResize(); endHeaderDrag() })

  scroller.addEventListener('dblclick', (event) => {
    if ((/** @type {any} */ (event.target)).closest?.('.csv-gutter')) return
    if (eventTarget(event, '.csv-cell')) beginEdit()
  })

  scroller.addEventListener('contextmenu', (event) => {
    const cell = (/** @type {any} */ (event.target)).closest?.('.csv-cell')
    const gutter = (/** @type {any} */ (event.target)).closest?.('.csv-gutter')
    if (gutter) {
      const r = Number(gutter.dataset.row)
      /* Right-clicking outside the selection moves it there first, the way
         every list in the app does — and inside it, whichever block it is in,
         leaves it alone: a menu about three picked rows has to open on all
         three. */
      const boxes = ranges()
      if (!boxes.some((box) => r >= box.r0 && r <= box.r1)) selectRow(r)
      event.preventDefault()
      cellMenu(event, r, cursor.c)
      return
    }
    if (!cell) return
    const r = Number(cell.dataset.row)
    const c = Number(cell.dataset.col)
    if (!inSelection(r, c)) moveTo(r, c)
    event.preventDefault()
    cellMenu(event, r, c)
  })

  frame.addEventListener('mousedown', (event) => {
    if (!menu.hidden && !(/** @type {any} */ (event.target)).closest?.('.csv-menu')) closeMenu()
    /* The panel outlives a click inside itself and a click on the funnel that
       would only reopen it; anything else is the reader going back to the
       table, which is what closes it. */
    if (!filterPanel.hidden && !(/** @type {any} */ (event.target)).closest?.('.csv-filter') &&
        !(/** @type {any} */ (event.target)).closest?.('.csv-funnel')) closeFilter()
  }, true)

  /* Keys on the frame rather than on each cell: the cells come and go with the
     scroll, and a handler per cell would be a handler per row of a file with a
     million of them. */
  frame.addEventListener('keydown', (event) => {
    // The find box is a text field and owns everything typed into it.
    if ((/** @type {any} */ (event.target)).closest?.('.csv-bar')) return

    /* So does the filter panel's box — without this, typing `TV` into it would
       reach the grid below and be taken for typing over a cell. Escape is the
       one key the panel hands back, because closing it is what Escape means
       everywhere else in here too. */
    if ((/** @type {any} */ (event.target)).closest?.('.csv-filter')) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeFilter()
        scroller.focus({ preventScroll: true })
      }
      return
    }

    // While a cell is open, the input owns almost everything typed into it.
    if (editing) {
      if (event.key === 'Enter') {
        /* ⇧⏎ and ⌥⏎ put a line break *inside* the cell, which is the one thing
           a value could never be given by typing before this: plain Enter has
           always meant "done", so the break needs a chord, and these two are
           the chords every spreadsheet already uses for it. Nothing is done
           here — the field is a textarea and inserting a newline is its own
           default — beyond keeping the key from the commit below. The value
           then quotes itself on save, because a newline is one of the things
           `needsQuotes` has always quoted for. Headings stay single-line: the
           strip is one line tall and a broken heading would be drawn under
           the table. */
        if ((event.shiftKey || event.altKey) && editing.r !== -1) return
        event.preventDefault()
        commitEdit()
        moveTo(cursor.r + (event.shiftKey ? -1 : 1), cursor.c)
        scroller.focus({ preventScroll: true })
      } else if (event.key === 'Escape') {
        event.preventDefault()
        commitEdit({ cancel: true })
        scroller.focus({ preventScroll: true })
      } else if (event.key === 'Tab') {
        event.preventDefault()
        commitEdit()
        moveTo(cursor.r, cursor.c + (event.shiftKey ? -1 : 1))
        scroller.focus({ preventScroll: true })
      }
      return
    }

    const mod = event.metaKey || event.ctrlKey
    const extend = event.shiftKey
    const lastRow = viewRows() - 1

    /* ⌥⌘F fits every column; ⌘F alone is still the find box. Read from the
       physical key as well as the character, because Option turns an `f` into
       an `ƒ` on a Mac keyboard — matching on the character alone would make
       this chord work everywhere except the platform it is written for. Alt is
       free to claim: the window's own handler ignores every chord carrying it. */
    if (mod && event.altKey && (event.code === 'KeyF' || event.key.toLowerCase() === 'f' ||
        event.key === 'ƒ')) {
      event.preventDefault()
      fitAllColumns()
      return
    }

    if (mod) {
      const key = event.key.toLowerCase()
      switch (key) {
        case 'a': event.preventDefault(); selectAll(); return
        case 'c': event.preventDefault(); fromKey('copy', () => copySelection()); return
        case 'x': event.preventDefault(); fromKey('cut', () => copySelection({ cut: true })); return
        case 'v': event.preventDefault(); fromKey('paste', () => pasteFromClipboard()); return
        case 'd': event.preventDefault(); fillDown(); return
        /* ⇧⌘F filters the column the cursor is in; ⌘F alone is the find box.
           The two questions a table is asked about what is in it, a shift
           apart. */
        case 'f':
          event.preventDefault()
          if (extend) filterColumn(cursor.c)
          else openFindReplace()
          return
        case 'g': event.preventDefault(); findNext(extend); return
        case 'z': event.preventDefault(); fromKey(extend ? 'redo' : 'undo', () => stepHistory(extend)); return
        case 'y': event.preventDefault(); fromKey('redo', () => stepHistory(true)); return
        default: break
      }
    }

    /* ⌃Space and ⇧Space, which is what a spreadsheet's own keyboard says for
       "this whole column" and "this whole row". */
    if (event.key === ' ' && event.ctrlKey) { event.preventDefault(); selectColumn(cursor.c); return }
    if (event.key === ' ' && extend) { event.preventDefault(); selectRow(cursor.r); return }

    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); moveTo(mod ? lastRow : cursor.r + 1, cursor.c, { extend }); return
      case 'ArrowUp': event.preventDefault(); moveTo(mod ? -1 : cursor.r - 1, cursor.c, { extend }); return
      case 'ArrowLeft': event.preventDefault(); moveTo(cursor.r, mod ? 0 : cursor.c - 1, { extend }); return
      case 'ArrowRight': event.preventDefault(); moveTo(cursor.r, mod ? columns() - 1 : cursor.c + 1, { extend }); return
      case 'PageDown': {
        event.preventDefault()
        moveTo(cursor.r + Math.floor(scroller.clientHeight / ROW_HEIGHT), cursor.c, { extend })
        return
      }
      case 'PageUp': {
        event.preventDefault()
        moveTo(cursor.r - Math.floor(scroller.clientHeight / ROW_HEIGHT), cursor.c, { extend })
        return
      }
      case 'Home': event.preventDefault(); moveTo(mod ? -1 : cursor.r, 0, { extend }); return
      case 'End': event.preventDefault(); moveTo(mod ? lastRow : cursor.r, columns() - 1, { extend }); return
      case 'Tab': event.preventDefault(); moveTo(cursor.r, cursor.c + (event.shiftKey ? -1 : 1)); return
      case 'F2': event.preventDefault(); beginEdit(); return
      case 'Enter': {
        event.preventDefault()
        // ⌘⏎ makes a row rather than editing one — the spreadsheet reflex.
        if (mod) insertRows(Math.max(0, cursor.r) + 1)
        else if (extend) moveTo(cursor.r - 1, cursor.c)
        else beginEdit()
        return
      }
      case 'Backspace':
      case 'Delete': {
        event.preventDefault()
        if (mod) { deleteRows(selectedRows()); return }
        clearSelection()
        return
      }
      case 'Escape': {
        /* Escape peels one layer at a time, transient first: the filter panel,
           then the menu, then a
           rectangle back to the cell it grew from, then the cell itself, then
           the search. Only when there is nothing left to put away does it
           reach the window behind the grid. */
        if (!filterPanel.hidden) { event.preventDefault(); closeFilter(); return }
        if (!menu.hidden) { event.preventDefault(); closeMenu(); return }
        if (!singleCell()) { event.preventDefault(); moveTo(cursor.r, cursor.c); return }
        /* Deselected: the highlight goes and the coordinates stay, so an arrow
           key carries on from the cell that was selected rather than from the
           corner of the table. */
        if (shown) { event.preventDefault(); shown = false; decorate(); return }
        if (query) { event.preventDefault(); search.value = ''; setQuery('') }
        return
      }
      default: break
    }

    /* Typing over a cell replaces it, the way it does in every grid. Only
       single printable characters, so shortcuts on their way to the window
       are not swallowed as text. */
    if (!mod && !event.altKey && event.key.length === 1) {
      event.preventDefault()
      beginEdit(event.key)
    }
  })

  /* The clipboard, the other way round: a ⌘C routed through the window menu
     arrives as an event rather than as a keystroke, so both paths are wired
     and both end in the same place. */
  frame.addEventListener('copy', (event) => {
    if (editing || (/** @type {any} */ (event.target)).closest?.('.csv-bar')) return
    event.preventDefault()
    /* The data goes on the clipboard either way — setting it twice with the
       same text is harmless. The guard is on the *effect*: cut clearing the
       cells twice, or paste landing twice. */
    event.clipboardData?.setData('text/plain', gridToClipboard(selectionValues()))
  })

  frame.addEventListener('cut', (event) => {
    if (editing || (/** @type {any} */ (event.target)).closest?.('.csv-bar')) return
    event.preventDefault()
    event.clipboardData?.setData('text/plain', gridToClipboard(selectionValues()))
    unlessKey('cut', () => clearSelection())
  })

  frame.addEventListener('paste', (event) => {
    if (editing || (/** @type {any} */ (event.target)).closest?.('.csv-bar')) return
    const text = event.clipboardData?.getData('text/plain')
    if (!text) return
    event.preventDefault()
    unlessKey('paste', () => pasteGrid(parseClipboardGrid(text)))
  })

  /* Focus leaving the grid entirely — clicking a tab, opening the copilot —
     has to take the open cell with it, or the edit is lost with the element. */
  frame.addEventListener('focusout', (event) => {
    if (!editing) return
    if (frame.contains(/** @type {any} */ (event.relatedTarget))) return
    commitEdit()
  })

  /* Named, because two things inside the grid drive it through its own public
     surface rather than through its internals: re-reading the file with a
     different delimiter is exactly an `open`, and writing it is exactly a
     `save`. */
  const grid = {
    /**
     * Point the grid at a file.
     *
     * @param path   what to open
     * @param {any} [place]  where the reader was — the scroll offsets, and, since an
     *               external change reopens the file through here, the whole
     *               of how they were looking at it: the sort, the filters, the
     *               find box. A file rewritten under the reader by a sync
     *               client used to come back at the top, unsorted, unfiltered
     *               and with the undo history gone, which is a heavier price
     *               for somebody else's edit than the edit itself.
     * @param forced a delimiter chosen by hand, which outranks the sniff
     * @param whole  read the whole of a file big enough to be previewed — the
     *               notice's own button, and the only way past `PREVIEW_ABOVE`
     */
    async open (path, place = null, forced = null, { whole = false } = {}) {
      hideNotice()
      lock = null

      /* How big it is, asked before a byte of it is read. `file.probe` is the
         cheap question — a stat and a sniff of the head — and it is the only
         thing standing between the reader and a window that stops answering
         while half a gigabyte crosses the IPC boundary as one string. */
      let size = 0
      if (typeof file.probe === 'function') {
        const stat = await file.probe(path).catch(() => null)
        if (Number.isFinite(stat?.size)) size = Number(stat.size)
      }

      /* Read as bytes and decoded by whatever those bytes turn out to be,
         rather than as UTF-8 and hope.

         This is the highest-priority fix in the file and it is invisible until
         it bites: a Latin-1 or cp1252 export — which is what Excel on a
         Windows machine still writes by default in much of the world — decoded
         as UTF-8 puts U+FFFD in place of every accented character, and the
         nine-hundred-millisecond autosave then writes those replacement
         characters back over the reader's data. The damage is silent, total
         for every name with an accent in it, and completely irreversible.

         `readEncoded` hands back what the bytes actually were, and every write
         from here on puts them back the same way. The fallback is for the
         tests' own file object, which has only `read`. */
      const read = typeof file.readEncoded === 'function'
        ? await file.readEncoded(path)
        : {
            ok: true,
            text: await file.read(path),
            encoding: 'utf8',
            bom: false,
            clean: true,
            stamp: null
          }
      if (!read || read.ok === false) {
        throw new Error(read?.error || 'That file could not be read.')
      }

      const source = String(read.text ?? '')
      /* Big enough to be a preview? Either answer may be the one that knows:
         `probe` measures the bytes and is absent in tests, while the decoded
         text is what the parser is actually about to walk. */
      const previewing = !whole && (size > PREVIEW_ABOVE || source.length > PREVIEW_ABOVE)
      /* Cut at a line ending, so the preview never stops in the middle of a
         quoted field and turns the rest of it into a delimiter storm. */
      let text = source
      if (previewing && source.length > PREVIEW_CHARS) {
        const cut = source.lastIndexOf('\n', PREVIEW_CHARS)
        text = source.slice(0, cut > 0 ? cut + 1 : PREVIEW_CHARS)
      }

      /* Everything kept beside this file, read before it is parsed: the
         delimiter decides what the rows even are, so it cannot wait until
         after the columns have been measured the way the widths do. */
      const saved = layout ? await layout.get(path).catch(() => null) : null
      /* What the extension claims, what the file says, and what a person said
         last time — in that order of authority. A remembered choice wins
         because it was made by someone who could see the result; the sniff
         wins over the extension because it read the file. */
      const declared = dataDelimiter(path)
      const remembered = forced || saved?.delimiter
      const delimiter = DELIMITER_CANDIDATES.includes(remembered)
        ? remembered
        : sniffDelimiter(text, declared)
      const { rows: parsedAll, shape } = readSeparated(text, delimiter)
      const parsed = previewing ? parsedAll.slice(0, PREVIEW_ROWS + 1) : parsedAll

      /* Whether the first row is the headings. Remembered per file for the
         session and carried across a reload in `place`; the sidecar cannot
         hold it yet, so a restart forgets. Only ever false because somebody
         said so — the default is the only useful reading of a file that has
         not been asked about. */
      hasHeader = typeof place?.hasHeader === 'boolean'
        ? place.hasHeader
        : (headerChoice.get(path) ?? true)
      if (hasHeader) {
        /* The first row is the header. Not a guess about the file so much as
           the only useful reading of one: a CSV with no header row is a CSV
           whose first row is its own labels, and showing it as the header
           costs nothing but a row that reads oddly. */
        header = parsed.length ? parsed[0] : ['']
        rows = parsed.slice(1)
      } else {
        rows = parsed.slice()
        header = numberedHeader(parsed.reduce((most, r) => Math.max(most, r.length), 1))
      }
      current = {
        path,
        delimiter,
        declared,
        newline: shape.newline,
        shape,
        encoding: read.encoding || 'utf8',
        bom: !!read.bom,
        /* What the file looked like when it was read, so a write can refuse to
           land on top of somebody else's. */
        stamp: read.stamp || null,
        truncated: previewing,
        size: size || source.length
      }

      /* The two conditions that make writing this file destructive, and the
         notice that says so.

         A preview first, because it is the one that would lose the most: fifty
         thousand rows written over a million is not a bad save, it is a
         deletion. */
      if (previewing) {
        lock = { why: `Showing the first ${rows.length.toLocaleString()} rows — this file is too large to edit here` }
        showNotice(
          `This file is ${Math.round(current.size / (1024 * 1024)).toLocaleString()} MB. ` +
          `Showing the first ${rows.length.toLocaleString()} rows, read-only, so that saving cannot write them over the rest.`,
          [{
            label: 'Open the whole file',
            title: 'Read all of it — the window will not respond while it does',
            run: () => {
              onStatus('Reading the whole file…')
              grid.open(path, grid.place(), forced, { whole: true }).catch(() => {
                onStatus('That file could not be opened in full')
              })
            }
          }]
        )
      } else if (read.clean === false) {
        /* Rare, and worth every line of this: it means the file carried a
           byte-order mark and then contradicted it, so the decode substituted
           U+FFFD and a save would burn those replacement characters into the
           reader's data. Read-only until they say otherwise in as many words. */
        lock = { why: 'This file could not be decoded — it is open read-only' }
        showNotice(
          'This file’s bytes do not match the encoding it declares, so some characters could not be read. ' +
          'It is open read-only: saving would write “\uFFFD” over them.',
          [{
            label: 'Save as UTF-8 anyway',
            title: 'Accept the substitutions and write the file back as UTF-8',
            run: () => {
              lock = null
              current.encoding = 'utf8'
              current.bom = false
              hideNotice()
              paintBar()
              onStatus('This table will be saved as UTF-8')
            }
          }]
        )
      }

      cursor = { r: rows.length ? 0 : -1, c: 0 }
      anchor = { ...cursor }
      extras = []
      // A file opens with its first cell selected, whatever Escape had done to
      // the one before it.
      shown = true
      editing = null
      firstBuilt = -1
      lastBuilt = -1
      firstColBuilt = -1
      lastColBuilt = -1
      liveRows.clear()
      /* The view the reader had, when this open is a reload of the file they
         were already looking at, and a clean slate when it is a different
         file. `place` is what tells the two apart: the renderer hands back
         what `place()` gave it, and only for the same document.

         A filter otherwise belongs to the file it was made for: its values are
         that file's values, and carrying it into the next one would open a
         table with rows already missing for a reason nothing on screen
         explains. */
      /* Bounded by the widest row, not the header: a sort on a column only
         the body carries — see `columnCount` — is otherwise dropped on every
         reload the watcher asks for. */
      sorts = restoredSorts(place, columnCount())
      filters = restoredFilters(place)
      onlyMatches = !!place?.onlyMatches
      query = typeof place?.query === 'string' ? place.query : ''
      search.value = query
      replaceBox.value = typeof place?.replacement === 'string' ? place.replacement : ''
      refreshMatcher()
      closeFilter()
      history = []
      future = []
      clearTimeout(statsTimer)
      stats = null
      statsFor = null
      setDirty(false)
      // Measured again for this file: the mono face may have changed with the
      // theme, or simply have finished loading since the last one was opened.
      charWidth = 0
      measure()
      /* The widths this file was last left at, over the measured ones. Applied
         after `measure` so there is something to check the length against, and
         before the first paint so the columns never visibly jump from one set
         to the other. */
      const savedWidths = Array.isArray(saved) ? saved : saved?.widths
      // The file may have been swapped under us while the reads resolved.
      if (current?.path === path && layoutFits(savedWidths)) widths = savedWidths.slice()
      /* Checked against the column count on its own: an older sidecar has
         widths and no alignments, and a file whose shape has changed since is
         one whose remembered alignments describe other columns. */
      if (current?.path === path && layoutFits(saved?.aligns)) {
        aligns = saved.aligns.map((a) => (ALIGNMENTS.includes(a) ? a : null))
      }
      rebuildOrder()
      paint()
      scroller.scrollTop = Number(place?.top) || 0
      scroller.scrollLeft = Number(place?.left) || 0
      syncHeadScroll()
      paintRows({ force: true })
      requestDecorate()
      requestAnimationFrame(paintColumnScroll)
    },

    save: saveFile,

    async close () {
      /* The last save this file will ever get — everything below throws the
         rows away. Letting the error out of here is worse than useless: the
         one caller is `leaveDoc`, which runs outside the try that opening a
         document wraps itself in, so a failed write became an unhandled
         rejection in the middle of a tab switch and the reader saw nothing at
         all. Closing anyway is right; saying so is the part that was missing. */
      await saveFile({ flush: true }).catch((err) => {
        onStatus(`“${current?.path?.split('/').pop() || 'This file'}” could not be saved: ${err?.message || 'the write failed'}`)
        console.error('csv close: save failed for', current?.path, err)
      })
      clearTimeout(saveTimer)
      clearTimeout(statsTimer)
      stats = null
      statsFor = null
      current = null
      rows = []
      header = []
      order = []
      history = []
      future = []
      sorts = []
      filters = new Map()
      onlyMatches = false
      editing = null
      lock = null
      hideNotice()
      replacing = false
      query = ''
      matcher = null
      search.value = ''
      replaceBox.value = ''
      closeMenu()
      closeFilter()
      liveRows.clear()
      window_.replaceChildren()
      headRow.replaceChildren()
    },

    /**
     * Reading or Editing, from the window's own view switch.
     *
     * Called before `open` as well as after it — the view is a preference that
     * outlives any one document — so it must stand on its own with no file
     * loaded. An open cell is committed rather than dropped: leaving Editing
     * is not a reason to lose what was typed into it.
     */
    setReadonly (flag) {
      const next = !!flag
      if (next === readonly) return
      if (next && editing) commitEdit()
      readonly = next
      frame.classList.toggle('is-reading', readonly)
      table.setAttribute('aria-readonly', String(readonly))
      closeMenu()
      closeFilter()
      paintBar()
      // The headings carry a title that names what a double-click does, and in
      // Reading view it does nothing.
      if (current) paintHead()
    },

    focus () { scroller.focus({ preventScroll: true }) },

    /**
     * The file moved — it was renamed, or dragged into another folder.
     *
     * The grid holds the path it writes back to, and nothing else was telling
     * it: renaming a table mid-edit left the next autosave writing to a name
     * that no longer exists, which is a failed write and a lost edit. The
     * column widths are filed against the path too, so they move with it.
     */
    retarget (path) {
      if (!current || !path || path === current.path) return
      current.path = path
      // The widths are filed against the path, so they move with it — a table
      // renamed would otherwise open next time measured from scratch.
      rememberWidths()
    },

    /**
     * How the reader has the file, so a reload can put all of it back.
     *
     * Not only the scroll offsets: an external change reopens the file through
     * `open`, and a reload that kept the reader's place while dropping their
     * sort, their filters and their search was keeping the least of what they
     * had. The undo history is the one thing that cannot come back — its
     * patches name rows of a file that has since changed under it.
     */
    place: () => ({
      top: scroller.scrollTop,
      left: scroller.scrollLeft,
      sorts: sorts.map((key) => ({ ...key })),
      filters: [...filters].map(([col, hidden]) => [col, [...hidden]]),
      onlyMatches,
      query,
      replacement: replaceBox.value,
      hasHeader
    }),
    dirty: () => dirty,

    /** ⌘F, routed here by the renderer while a table is the open document. */
    find () { openFindReplace() },

    /** The command palette's Auto-resize all columns, which a language table
     *  answers the same way. True when anything actually moved. */
    fitColumns: fitAllColumns,

    /** The palette's Filter this column — the same panel the funnel opens, on
     *  the column the cursor is in. */
    filter () { filterColumn(cursor.c) },

    /** …and the way back out of every filter at once. True when there was one
     *  to clear, so the caller can say which of the two just happened. */
    clearFilters () {
      const on = filtering()
      clearAllFilters()
      return on
    },

    /** ⌘Z and ⇧⌘Z, which arrive through the window menu rather than as keys. */
    history (redo) {
      let stepped = false
      unlessKey(redo ? 'redo' : 'undo', () => { stepped = stepHistory(!!redo) })
      return stepped
    },

    /** What the status bar says about the table: its shape, and what is being
     *  done to the view of it. */
    summary () {
      if (!current) return ''
      const r = rows.length
      const c = columns()
      const parts = [
        `${r.toLocaleString()} ${r === 1 ? 'row' : 'rows'} · ${c} ${c === 1 ? 'column' : 'columns'}`
      ]
      /* Said wherever the shape is said: a preview's row count is true of the
         preview and a lie about the file, and this is the correction. */
      if (current.truncated) {
        parts.push(`the first rows of a ${Math.round(current.size / (1024 * 1024)).toLocaleString()} MB file, read-only`)
      }
      if (sorts.length) {
        const named = sorts.map((key) =>
          `${header[key.col] || `column ${key.col + 1}`} ${key.dir === 'asc' ? '↑' : '↓'}`)
        parts.push(`sorted by ${named.join(', then ')}`)
      }
      /* Named rather than counted: "filtered" alone leaves the reader hunting
         for which column is doing it, and the whole point of the line is that
         a table showing 812 of 8,000 rows says why. */
      const by = [...filters].filter(([, hidden]) => hidden.size)
        .map(([col]) => header[col] || `column ${col + 1}`)
      if (onlyMatches && query.trim()) by.push(`“${query.trim()}”`)
      if (by.length) {
        parts.push(`showing ${order.length.toLocaleString()} of ${r.toLocaleString()}, filtered by ${by.join(', ')}`)
      }
      const totals = statsSummary()
      if (totals) parts.push(totals)
      return parts.join(' · ')
    },

    /** The table as text, for the copilot: it cannot see the grid, and the
     *  quoted source is what it would have been handed for any other file.
     *  What it gets is what is on screen — sorted and filtered as the reader
     *  has it — because a question about "the top rows" is about those. */
    context () {
      if (!current) return { text: '', rows: rows.length, columns: columns() }
      const count = 50
      const active = Math.max(0, cursor.r)
      const from = Math.max(0, Math.min(Math.max(0, order.length - count), active - Math.floor(count / 2)))
      const shown = order.slice(from, from + count).map((i) => rows[i])
      const text = formatSeparated([header, ...shown], current.delimiter, '\n')
      const selectedRow = cursor.r >= 0 ? order[cursor.r] : -1
      const column = header[cursor.c] || ''
      const activeText = selectedRow >= 0
        ? formatSeparated([rows[selectedRow]], current.delimiter, '\n')
        : ''
      return {
        text,
        rows: rows.length,
        columns: columns(),
        atRow: selectedRow >= 0 ? selectedRow + 1 : 0,
        atColumn: cursor.c + 1,
        column,
        value: selectedRow >= 0 ? String(rows[selectedRow]?.[cursor.c] || '') : '',
        shownRows: order.length,
        sortedBy: sorts.map(({ col, dir }) => `${header[col] || `column ${col + 1}`} ${dir}`),
        filteredBy: [...filters].filter(([, hidden]) => hidden.size)
          .map(([col]) => header[col] || `column ${col + 1}`),
        focus: activeText ? Math.max(0, text.indexOf(activeText)) : 0
      }
    },

    /** The grid is laid out in pixels against the scroller's width; a pane
     *  opening beside it changes that without a window resize. */
    resize () {
      paintRows({ force: true })
      paintColumnScroll()
    }
  }

  return grid
}
