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

/**
 * Rows of fields, from separated text.
 *
 * RFC 4180 with the leniencies every real file needs: either line ending, a
 * final newline or not, and a doubled `""` inside a quoted field standing for
 * one quote. A quote appearing in the middle of an unquoted field is data —
 * spreadsheets write that and refusing it would mean refusing the file.
 *
 * Written as one pass over the characters rather than a split-and-repair,
 * because a delimiter or a newline *inside* quotes is the ordinary case in
 * exported data, and splitting on either first is what gets that wrong.
 */
export function parseSeparated (text, delimiter = ',') {
  // A byte-order mark is not part of the first heading.
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let started = false

  const endField = () => { row.push(field); field = ''; started = true }
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

    if (ch === '"' && field === '') { quoted = true; started = true; continue }
    if (ch === delimiter) { endField(); continue }
    if (ch === '\r') {
      // Swallow the LF of a CRLF; a bare CR is still a line ending.
      if (source[i + 1] === '\n') i++
      endRow()
      continue
    }
    if (ch === '\n') { endRow(); continue }
    field += ch
    started = true
  }

  /* Whatever is left is a final row without a line ending. A file that *did*
     end with one leaves nothing behind, and must not gain a blank row for it —
     which is the difference between a table of 100 rows and one of 101 whose
     last is empty. */
  if (started || field !== '' || row.length) endRow()

  return rows
}

/** Whether a field has to be quoted to survive the round trip. Leading and
 *  trailing spaces are included: readers differ on whether they keep them, and
 *  quoting is the only way to say the space is data. */
const needsQuotes = (value, delimiter) =>
  value.includes(delimiter) || value.includes('"') ||
  value.includes('\n') || value.includes('\r') ||
  value !== value.trim()

const quoteField = (value, delimiter) =>
  needsQuotes(value, delimiter) ? `"${value.replace(/"/g, '""')}"` : value

/**
 * Separated text, from rows of fields. The inverse of `parseSeparated` for
 * every file it can read.
 *
 * `newline` is the file's own, detected on open and handed back: a file
 * written with CRLF that came back LF is a diff against every line of it, from
 * an edit to one cell.
 */
export function formatSeparated (rows, delimiter = ',', newline = '\n') {
  const body = rows
    .map((row) => row.map((cell) => quoteField(String(cell ?? ''), delimiter)).join(delimiter))
    .join(newline)
  // A trailing newline, which is what every writer of these files emits.
  return rows.length ? body + newline : ''
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

/** The line ending the file already uses, so writing it back does not rewrite
 *  every line. Decided by the first ending in the file: a mixed file has to be
 *  normalised to something, and the one it opens with is the better guess. */
const detectNewline = (text) => {
  const at = String(text ?? '').indexOf('\n')
  return at > 0 && text[at - 1] === '\r' ? '\r\n' : '\n'
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

/** A cell as a moment in time, or null. Deliberately narrow: only the two
 *  shapes that are unambiguously dates — ISO, and the slashed form — get
 *  parsed, because handing everything to `Date.parse` turns a product code
 *  into a year and sorts a column into nonsense. */
const dateValue = (text) => {
  const value = String(text ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value) && !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value)) {
    return null
  }
  const at = Date.parse(value)
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

const cellKey = (text) => {
  const quantity = quantityValue(text)
  if (quantity !== null) return { rank: QUANTITY, value: quantity, text }
  const at = dateValue(text)
  if (at !== null) return { rank: MOMENT, value: at, text }
  return { rank: WORD, value: 0, text }
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
export function compareCells (a, b) {
  const x = String(a ?? '')
  const y = String(b ?? '')
  if (x === y) return 0
  return compareKeys(cellKey(x), cellKey(y))
}

/**
 * `base` reordered by one column.
 *
 * Blanks go last in both directions — a descending sort that opened with a
 * screen of empty cells would be answering a question nobody asked — and ties
 * keep the order they came in, so sorting by one column and then another
 * leaves the first sort as the tiebreak.
 *
 * Each cell is classified once, before the sort starts, and the comparator
 * only ever looks at the answers — see `cellKey`. The comparator is the one
 * piece of code here that runs a few million times on a large file, so
 * anything it can be told in advance, it is.
 *
 * @param rows  every row of the file, in file order
 * @param base  the view's current row indices — filtered or not
 * @param col   which column to sort on
 * @param dir   'asc' or 'desc'
 */
export function sortedOrder (rows, base, col, dir) {
  const sign = dir === 'desc' ? -1 : 1
  // Many columns hold the same 10–20 strings repeated 200k times. `cellKey`
  // runs 6 regexes per distinct value — memoize by exact text so duplicates pay once.
  const keyCache = new Map()
  const cachedKey = (text) => {
    let hit = keyCache.get(text)
    if (hit === undefined) {
      hit = cellKey(text)
      keyCache.set(text, hit)
    }
    return hit
  }
  const keyed = base.map((index, at) => {
    const text = String(rows[index]?.[col] ?? '')
    // A blank is decided before anything else and never compared, so it is not
    // worth classifying one.
    const blank = text.trim() === ''
    return { index, at, blank, key: blank ? null : cachedKey(text) }
  })
  keyed.sort((p, q) => {
    if (p.blank || q.blank) return p.blank && q.blank ? p.at - q.at : (p.blank ? 1 : -1)
    return sign * compareKeys(p.key, q.key) || p.at - q.at
  })
  return keyed.map((k) => k.index)
}

/** The rows of `base` holding `query` anywhere in them, case-insensitively. An
 *  empty query is every row: the filter box being empty is not a filter. */
export function filterOrder (rows, base, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (!needle) return base.slice()
  return base.filter((index) => {
    const row = rows[index] || []
    for (const cell of row) {
      if (String(cell ?? '').toLowerCase().includes(needle)) return true
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
  const list = [...counts].map(([value, count]) => ({ value, count }))
  list.sort((p, q) => {
    const pBlank = p.value.trim() === ''
    const qBlank = q.value.trim() === ''
    if (pBlank || qBlank) return pBlank && qBlank ? 0 : (pBlank ? 1 : -1)
    return compareCells(p.value, q.value)
  })
  return list
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
  const grid = parseSeparated(source, delimiter)
  return grid.length ? grid : [['']]
}

/* --------------------------------------------------------------- the grid */

/**
 * Mount the grid into `host`. One instance for the life of the window; `open`
 * points it at a file and `close` lets go of one.
 *
 * @param file       the renderer's `api.file` — `read` and `write`
 * @param layout     where column widths are kept, since the file cannot keep
 *                   them itself — `api.tableWidths`, or nothing, in which case
 *                   the columns are measured afresh every time as they were
 * @param onDirty    told whenever the unsaved state changes
 * @param onSaved    told when a save lands clean
 * @param onStatus   told when something worth a line of status happened
 * @param onSelection told when the selection settles on something new, so the
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
  const delimiterPick = dropdown({
    label: 'Delimiter',
    className: 'csv-delimiter',
    options: DELIMITER_CANDIDATES.map((candidate) => ({
      value: candidate, label: delimiterName(candidate)
    })),
    onChange: (candidate) => { useDelimiter(candidate) }
  })
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
  for (const [control, label] of [
    [scrollBack, 'Scroll to earlier columns'],
    [scrollForward, 'Scroll to later columns']
  ]) {
    control.classList.add('is-column-scroll')
    control.setAttribute('aria-label', label)
  }

  const undoBtn = button('↶', 'undo', keyLabel('Undo (⌘Z)'))
  const redoBtn = button('↷', 'redo', keyLabel('Redo (⇧⌘Z)'))
  const addRow = button('+ Row', 'add-row', keyLabel('Add a row below the cursor (⌘⏎)'))
  const addCol = button('+ Column', 'add-col', 'Add a column after this one')

  const gap = document.createElement('span')
  gap.className = 'csv-bar-gap'

  bar.append(search, onlyBtn, found, gap,
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

  frame.append(bar, table, menu, filterPanel)
  host.replaceChildren(frame)

  let current = null          // { path, delimiter, newline }
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
  let sort = null             // { col, dir }
  let query = ''
  /* Column index → the Set of values hidden in that column. A way of looking,
     like the sort: it lives in `order` and never touches `rows`, so filtering
     a two-hundred-thousand-row export and saving writes the file it opened. */
  let filters = new Map()
  /* Whether the find box hides what it does not match, rather than only
     marking it. Off by default: finding is the more common thing to want from
     a box you can type into without meaning to lose your place. */
  let onlyMatches = false
  let dirty = false
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
  let editing = null          // { r, c, input } while a cell is open
  let firstBuilt = -1
  let lastBuilt = -1
  let firstColBuilt = -1
  let lastColBuilt = -1
  let dragging = null         // 'cells' | 'rows' while a drag-select is on
  let history = []
  let future = []
  /* What the sort was before the click that may turn out to be a double one —
     see the heading's `dblclick`, which has to put back the sort its own first
     click performed. */
  let sortBeforeClick = null

  /* What the selection adds up to, and the rectangle it was worked out for.
     Held rather than computed on demand because the status line asks for it on
     every repaint, and a whole-column selection is a hundred thousand cells. */
  let stats = null
  /* The rectangle the totals were worked out for: a key while they hold, and
     null when there is no answer yet — which is both "nothing has been
     selected" and "what was selected has been edited under us". */
  let statsFor = null
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

  /** The one guard, on every path that would change the file. It says why
   *  rather than doing nothing, so a double-click on a cell in Reading view
   *  explains itself instead of feeling broken. */
  const editable = () => {
    if (!readonly) return true
    onStatus(keyLabel('Reading view — press ⌘2 to edit this table'))
    return false
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
  const plainOrder = () => !sort && !filtering()

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
      const probe = document.createElement('canvas').getContext('2d')
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
    if (onlyMatches && query.trim()) next = filterOrder(rows, next, query)
    if (sort && sort.col < columns()) next = sortedOrder(rows, next, sort.col, sort.dir)
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
    let firstCol = 0
    while (firstCol < count - 1 && colLeft[firstCol + 1] <= from) firstCol++
    let lastCol = firstCol
    while (lastCol < count && colLeft[lastCol] < to) lastCol++
    return {
      firstCol: Math.max(0, firstCol - OVERSCAN_COLS),
      lastCol: Math.min(count, lastCol + OVERSCAN_COLS)
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
      cell.setAttribute('aria-sort', sort && sort.col === c
        ? (sort.dir === 'asc' ? 'ascending' : 'descending')
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
      mark.textContent = sort && sort.col === c ? (sort.dir === 'asc' ? '▲' : '▼') : ''
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

  /**
   * The view rows the selection touches, ascending and without repeats — what
   * "delete the selected rows" means when the selection is in pieces. The
   * header is not one of them: it is a row on screen but not a row of the file.
   */
  const selectedRows = () => {
    const seen = new Set()
    for (const box of ranges()) {
      for (let r = Math.max(0, box.r0); r <= box.r1; r++) seen.add(r)
    }
    return [...seen].sort((a, b) => a - b)
  }

  /**
   * The columns the selection touches, ascending and without repeats.
   *
   * What "align these" means when three headings have been ⌘-clicked. A
   * right-click inside the selection is about the selection; one outside it is
   * about the column under the pointer, the same way the row menu behaves.
   */
  const selectedColumns = () => {
    const seen = new Set()
    for (const box of ranges()) {
      for (let c = Math.max(0, box.c0); c <= box.c1; c++) seen.add(c)
    }
    return [...seen].sort((a, b) => a - b)
  }

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
    decorate()
    rememberWidths()
  }

  /** Selection, cursor and search-match classes over whatever is built. Cheap
   *  because only the visible band exists to walk. */
  function decorate () {
    const boxes = ranges()
    const picked = (r, c) => shown && inSelection(r, c, boxes)
    const needle = query.trim().toLowerCase()
    for (const cell of frame.querySelectorAll('.csv-cell')) {
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
      cell.classList.toggle('is-match',
        !!needle && cell.textContent.toLowerCase().includes(needle))
    }
    /* The heading and the line number light up to say which column and which
       row the selection is in — so with nothing selected there is nothing for
       them to say either. */
    for (const cell of frame.querySelectorAll('.csv-gutter')) {
      const r = Number(cell.dataset.row)
      cell.classList.toggle('is-active',
        shown && boxes.some((box) => r >= box.r0 && r <= box.r1))
    }
    for (const cell of headRow.querySelectorAll('.csv-th')) {
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

  /** The positions a set of blocks covers along one axis, ascending and without
   *  repeats — the rows the clipboard grid has, or the columns. */
  const axisOf = (boxes, from, to) => {
    const seen = new Set()
    for (const box of boxes) for (let i = box[from]; i <= box[to]; i++) seen.add(i)
    return [...seen].sort((a, b) => a - b)
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
    for (const element of [undoBtn, redoBtn, addRow, addCol]) element.hidden = readonly
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
      found.textContent = hits ? `${hits.toLocaleString()} matching ${hits === 1 ? 'row' : 'rows'}` : 'no matches'
      found.classList.toggle('is-empty', !hits)
    }
  }

  const countMatches = () => filterOrder(rows, rows.map((_, i) => i), query).length

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
    decorate()
  }

  const selectAll = () => {
    shown = true
    extras = []
    anchor = { r: -1, c: 0 }
    cursor = { r: viewRows() - 1, c: Math.max(0, columns() - 1) }
    paintRows()
    decorate()
  }

  const selectColumn = (c, { add = false } = {}) => {
    shown = true
    extras = add ? [...extras, rect()] : []
    anchor = { r: -1, c }
    cursor = { r: Math.max(-1, viewRows() - 1), c }
    revealCursor()
    paintRows()
    decorate()
  }

  const selectRow = (r, { add = false } = {}) => {
    shown = true
    extras = add ? [...extras, rect()] : []
    anchor = { r, c: 0 }
    cursor = { r, c: Math.max(0, columns() - 1) }
    revealCursor()
    paintRows()
    decorate()
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
    decorate()
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
    sort: sort && { ...sort },
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
    sort = patch.sort && { ...patch.sort }
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

  function beginEdit (seed = null) {
    if (!editable()) return
    if (editing) commitEdit()
    // Typing into a cell is selecting it, whatever Escape did a moment ago.
    shown = true
    if (cursor.r >= 0 && !rows[sourceOf(cursor.r)]) return
    const selector = `.csv-cell[data-row="${cursor.r}"][data-col="${cursor.c}"]`
    const cell = cursor.r === -1 ? headRow.querySelector(selector) : window_.querySelector(selector)
    if (!cell) return
    /* A textarea rather than an input, and for one reason: it can wrap. Nothing
       else about it is used — Enter, Tab and Escape are the grid's, taken
       before the field ever sees them, so a value still cannot be given a
       newline by typing one. */
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
        if (sort && sort.col === c) { extras = []; rebuildOrder({ keepSource: src }); paint() }
      }
    }
    /* A heading's cell holds its label, its sort mark and its resize grip, and
       the editor replaced all three. Rebuilding the strip is cheaper than
       reassembling one cell by hand, and there are only ever a few columns. */
    if (r === -1) paintHead()
    else repaintCell(r, c)
    decorate()
    if (!cancel) queueSave()
  }

  /* --------------------------------------------------------------- saving */

  let saveTimer = null
  const queueSave = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveFile().catch(() => {}) }, 900)
  }

  const saveFile = async ({ flush = false } = {}) => {
    if (flush) flushRequested = true
    if (saving) return saving
    saving = (async () => {
      do {
        if (editing) commitEdit()
        if (!current || !dirty) break
        clearTimeout(saveTimer)
        /* What is about to be written, named. Formatting and writing a large
           file is not instant, and a cell typed during one belongs to a
           version that is not on disk. Calling the grid clean regardless marks
           that edit as saved: the save it queued for itself then finds
           `!dirty` here and writes nothing, and the edit lives only in memory
           until the tab is closed and it goes. */
        const writingRevision = revision
        /* `rows` and not the view: a sort is a way of looking at the file, and
           saving one must not rewrite every line of it. */
        const text = formatSeparated([header, ...rows], current.delimiter, current.newline)
        await file.write(current.path, text)
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
    if (sort) {
      if (sort.col === at) sort = null
      else if (sort.col > at) sort = { ...sort, col: sort.col - 1 }
    }
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
    sort = dir ? { col, dir } : null
    rebuildOrder()
    collapse()
    paint()
  }

  /** The next state of a heading that was clicked: ascending, then descending,
   *  then back to the file's own order. */
  const cycleSort = (col) => {
    if (!sort || sort.col !== col) return sortBy(col, 'asc')
    if (sort.dir === 'asc') return sortBy(col, 'desc')
    return sortBy(col, null)
  }

  /** Make the sort real: write the rows in the order they are being shown in.
   *  The one destructive thing sorting can do, so it is a button and an undo
   *  entry rather than a side effect of looking. */
  const applySort = () => {
    if (!sort || !editable()) return
    record(snapshot())
    // Over every row, not just the filtered ones: applying a sort must not
    // silently drop what the filter is hiding.
    const full = sortedOrder(rows, rows.map((_, i) => i), sort.col, sort.dir)
    const keep = sourceOf(cursor.r)
    const moved = new Map(full.map((src, at) => [src, at]))
    rows = full.map((i) => rows[i])
    sort = null
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
  const setQuery = (text) => {
    query = text
    if (onlyMatches) {
      const keep = sourceOf(cursor.r)
      rebuildOrder({ keepSource: keep })
      collapse()
      paint()
      return
    }
    paintBar()
    decorate()
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
    const needle = query.trim().toLowerCase()
    if (!needle || !viewRows()) return
    const total = viewRows() * columns()
    const at = Math.max(0, cursor.r) * columns() + cursor.c
    for (let step = 1; step <= total; step++) {
      const index = ((at + (back ? -step : step)) % total + total) % total
      const r = Math.floor(index / columns())
      const c = index % columns()
      if (String(valueAt(r, c)).toLowerCase().includes(needle)) {
        moveTo(r, c)
        scroller.focus({ preventScroll: true })
        return
      }
    }
    onStatus('No match')
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
    if (sort) { rebuildOrder(); paint() } else paintRows({ force: true })
    decorate()
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
    if (sort) rebuildOrder()
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
    if (sort) rebuildOrder()
    paint()
    queueSave()
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
    if (readonly) {
      openMenu(event.clientX, event.clientY, [
        { label: 'Sort A → Z', run: () => sortBy(c, 'asc') },
        { label: 'Sort Z → A', run: () => sortBy(c, 'desc') },
        { label: 'Clear sort', disabled: !sort, run: () => sortBy(c, null) },
        '-',
        ...filterItems,
        '-',
        { label: 'Fit column width', run: () => fitColumn(c) },
        { label: 'Fit all columns', run: () => fitAllColumns() },
        { label: 'Select column', run: () => selectColumn(c) },
        '-',
        ...alignItems(c)
      ])
      return
    }
    openMenu(event.clientX, event.clientY, [
      { label: 'Sort A → Z', run: () => sortBy(c, 'asc') },
      { label: 'Sort Z → A', run: () => sortBy(c, 'desc') },
      { label: 'Clear sort', disabled: !sort, run: () => sortBy(c, null) },
      { label: 'Write this order into the file', disabled: !sort, run: () => applySort() },
      '-',
      ...filterItems,
      '-',
      { label: 'Rename heading', run: () => { moveTo(-1, c); beginEdit() } },
      { label: 'Fit column width', run: () => fitColumn(c) },
      { label: 'Fit all columns', run: () => fitAllColumns() },
      { label: 'Select column', run: () => selectColumn(c) },
      '-',
      ...alignItems(c),
      '-',
      { label: 'Insert column left', run: () => insertColumn(c) },
      { label: 'Insert column right', run: () => insertColumn(c + 1) },
      { label: 'Delete column', run: () => deleteColumn(c) }
    ])
  }

  /* ------------------------------------------------------------ resizing */

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
    const act = event.target.closest?.('.csv-btn')?.dataset.act
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

  search.addEventListener('input', () => setQuery(search.value))
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
    const grip = event.target.closest?.('.csv-grip')
    if (grip) { startResize(event, Number(grip.dataset.grip)); return }
    /* Before the sort, and swallowing the click: the funnel sits inside the
       heading, and a click on it that also cycled the sort would reorder the
       table every time somebody went to filter it. */
    const funnel = event.target.closest?.('.csv-funnel')
    if (funnel) {
      event.preventDefault()
      filterColumn(Number(funnel.dataset.funnel))
      return
    }
    const cell = event.target.closest?.('.csv-th')
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
    if (event.shiftKey) { moveTo(cursor.r, c, { extend: true }); return }
    if (event.detail > 1) return  // the double-click handler renames it
    sortBeforeClick = sort && { ...sort }
    cycleSort(c)
    scroller.focus({ preventScroll: true })
  })

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
    const grip = event.target.closest?.('.csv-grip')
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
    sortBy(sortBeforeClick ? sortBeforeClick.col : c, sortBeforeClick?.dir ?? null)
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
    if (event.target.tagName === 'INPUT') return
    const corner = event.target.closest?.('.csv-corner')
    if (corner) { selectAll(); scroller.focus({ preventScroll: true }); return }
    const gutter = event.target.closest?.('.csv-gutter')
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
    const cell = event.target.closest?.('.csv-cell')
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
    if (!dragging) return
    const target = dragging === 'rows'
      ? event.target.closest?.('.csv-gutter, .csv-cell')
      : event.target.closest?.('.csv-cell')
    if (!target) return
    const r = Number(target.dataset.row)
    if (Number.isNaN(r)) return
    const c = dragging === 'rows' ? columns() - 1 : Number(target.dataset.col)
    if (r === cursor.r && c === cursor.c) return
    moveTo(r, Number.isNaN(c) ? cursor.c : c, { extend: true })
  })

  window.addEventListener('mouseup', () => { dragging = null; endResize() })

  scroller.addEventListener('dblclick', (event) => {
    if (event.target.closest?.('.csv-gutter')) return
    if (eventTarget(event, '.csv-cell')) beginEdit()
  })

  scroller.addEventListener('contextmenu', (event) => {
    const cell = event.target.closest?.('.csv-cell')
    const gutter = event.target.closest?.('.csv-gutter')
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
    if (!menu.hidden && !event.target.closest?.('.csv-menu')) closeMenu()
    /* The panel outlives a click inside itself and a click on the funnel that
       would only reopen it; anything else is the reader going back to the
       table, which is what closes it. */
    if (!filterPanel.hidden && !event.target.closest?.('.csv-filter') &&
        !event.target.closest?.('.csv-funnel')) closeFilter()
  }, true)

  /* Keys on the frame rather than on each cell: the cells come and go with the
     scroll, and a handler per cell would be a handler per row of a file with a
     million of them. */
  frame.addEventListener('keydown', (event) => {
    // The find box is a text field and owns everything typed into it.
    if (event.target.closest?.('.csv-bar')) return

    /* So does the filter panel's box — without this, typing `TV` into it would
       reach the grid below and be taken for typing over a cell. Escape is the
       one key the panel hands back, because closing it is what Escape means
       everywhere else in here too. */
    if (event.target.closest?.('.csv-filter')) {
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
          else { search.focus(); search.select() }
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
    if (editing || event.target.closest?.('.csv-bar')) return
    event.preventDefault()
    /* The data goes on the clipboard either way — setting it twice with the
       same text is harmless. The guard is on the *effect*: cut clearing the
       cells twice, or paste landing twice. */
    event.clipboardData?.setData('text/plain', gridToClipboard(selectionValues()))
  })

  frame.addEventListener('cut', (event) => {
    if (editing || event.target.closest?.('.csv-bar')) return
    event.preventDefault()
    event.clipboardData?.setData('text/plain', gridToClipboard(selectionValues()))
    unlessKey('cut', () => clearSelection())
  })

  frame.addEventListener('paste', (event) => {
    if (editing || event.target.closest?.('.csv-bar')) return
    const text = event.clipboardData?.getData('text/plain')
    if (!text) return
    event.preventDefault()
    unlessKey('paste', () => pasteGrid(parseClipboardGrid(text)))
  })

  /* Focus leaving the grid entirely — clicking a tab, opening the copilot —
     has to take the open cell with it, or the edit is lost with the element. */
  frame.addEventListener('focusout', (event) => {
    if (!editing) return
    if (frame.contains(event.relatedTarget)) return
    commitEdit()
  })

  /* Named, because two things inside the grid drive it through its own public
     surface rather than through its internals: re-reading the file with a
     different delimiter is exactly an `open`, and writing it is exactly a
     `save`. */
  const grid = {
    async open (path, place = null, forced = null) {
      const text = await file.read(path)
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
      const parsed = parseSeparated(text, delimiter)
      /* The first row is the header. Not a guess about the file so much as the
         only useful reading of one: a CSV with no header row is a CSV whose
         first row is its own labels, and showing it as the header costs
         nothing but a row that reads oddly. */
      header = parsed.length ? parsed[0] : ['']
      rows = parsed.slice(1)
      current = { path, delimiter, declared, newline: detectNewline(text) }
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
      sort = null
      /* A filter belongs to the file it was made for: its values are that
         file's values, and carrying it into the next one would open a table
         with rows already missing for a reason nothing on screen explains. */
      filters = new Map()
      onlyMatches = false
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
      decorate()
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
      sort = null
      filters = new Map()
      onlyMatches = false
      editing = null
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
    place: () => ({ top: scroller.scrollTop, left: scroller.scrollLeft }),
    dirty: () => dirty,

    /** ⌘F, routed here by the renderer while a table is the open document. */
    find () { search.focus(); search.select() },

    /** The command palette's Auto-resize all columns, which a language table
     *  answers the same way. True when anything actually moved. */
    fitColumns: () => fitAllColumns(),

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
      if (sort) parts.push(`sorted by ${header[sort.col] || `column ${sort.col + 1}`} ${sort.dir === 'asc' ? '↑' : '↓'}`)
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
      const shown = order.slice(0, 50).map((i) => rows[i])
      return {
        text: formatSeparated([header, ...shown], current.delimiter, '\n'),
        rows: rows.length,
        columns: columns()
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
