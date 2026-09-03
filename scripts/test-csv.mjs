/* What a separated-values file means, and what the vault calls a source file.
 *
 * The parser is the only thing between a spreadsheet export and the grid, and
 * every case here is one that a naive `split(',')` gets wrong — a comma inside
 * quotes, a newline inside a field, a doubled quote standing for one. The
 * round trips matter as much as the parses: this reader is also the writer,
 * and a file that comes back different from how it went in is an edit to one
 * cell showing up as a diff against every line.
 */

import assert from 'node:assert/strict'
import {
  parseSeparated,
  readSeparated,
  formatSeparated,
  detectNewline,
  multiSortedOrder,
  columnDateOrder,
  makeMatcher,
  gridToTsv,
  gridToJson,
  gridToMarkdown,
  numberedHeader,
  restoredSorts,
  restoredFilters,
  numericValue,
  resolutionValue,
  compareCells,
  sortedOrder,
  filterOrder,
  columnValues,
  filteredOrder,
  normalRect,
  sniffDelimiter,
  delimiterName,
  selectionStats,
  formatStat,
  gridToClipboard,
  parseClipboardGrid
} from '../src/csv.js'
import VAULT_CONTRACT from '../electron/vault-contract.json'
import { isCodePath, isDataPath, codeToken, dataDelimiter } from '../src/vault-paths.js'
import { languageId, SOURCE_CHOICES } from '../src/languages.js'

let passed = 0
function ok (what, fn) {
  fn()
  passed++
  console.log(`ok - ${what}`)
}

/* ------------------------------------------------------------- the parser */

ok('plain rows split on the delimiter', () => {
  assert.deepEqual(parseSeparated('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']])
})

ok('a quoted field keeps its delimiter', () => {
  assert.deepEqual(parseSeparated('name,note\nAda,"Lovelace, Countess"'),
    [['name', 'note'], ['Ada', 'Lovelace, Countess']])
})

ok('a quoted field keeps its newline', () => {
  assert.deepEqual(parseSeparated('a,b\n"one\ntwo",three'),
    [['a', 'b'], ['one\ntwo', 'three']])
})

ok('a doubled quote is one quote', () => {
  assert.deepEqual(parseSeparated('a\n"she said ""no"""'),
    [['a'], ['she said "no"']])
})

ok('a quote inside an unquoted field is data', () => {
  // Spreadsheets emit this; refusing it would mean refusing the file.
  assert.deepEqual(parseSeparated('a,b\n5" pipe,x'), [['a', 'b'], ['5" pipe', 'x']])
})

ok('CRLF and a bare CR both end a row', () => {
  assert.deepEqual(parseSeparated('a,b\r\n1,2\r3,4'),
    [['a', 'b'], ['1', '2'], ['3', '4']])
})

ok('a trailing newline does not make a blank row', () => {
  assert.deepEqual(parseSeparated('a,b\n1,2\n'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parseSeparated('a,b\n1,2'), [['a', 'b'], ['1', '2']])
})

ok('an empty field between delimiters survives', () => {
  assert.deepEqual(parseSeparated('a,,c'), [['a', '', 'c']])
  assert.deepEqual(parseSeparated('a,b,'), [['a', 'b', '']])
})

ok('a byte-order mark is not part of the first heading', () => {
  assert.deepEqual(parseSeparated('﻿id,name'), [['id', 'name']])
})

ok('empty text is no rows at all', () => {
  assert.deepEqual(parseSeparated(''), [])
  assert.deepEqual(parseSeparated(null), [])
})

ok('a tab file splits on tabs and keeps its commas', () => {
  assert.deepEqual(parseSeparated('a\tb\n1,5\t2', '\t'), [['a', 'b'], ['1,5', '2']])
})

/* ------------------------------------------------------------- the writer */

ok('only the fields that need quoting get it', () => {
  assert.equal(formatSeparated([['a', 'b,c', 'd"e', 'f']]), 'a,"b,c","d""e",f\n')
})

ok('a field with edge whitespace is quoted', () => {
  // The only way to say the space is data rather than the reader's slack.
  assert.equal(formatSeparated([[' a', 'b ']]), '" a","b "\n')
})

ok('the file\'s own line ending is what comes back', () => {
  assert.equal(formatSeparated([['a'], ['b']], ',', '\r\n'), 'a\r\nb\r\n')
})

ok('no rows is an empty file, not a lone newline', () => {
  assert.equal(formatSeparated([]), '')
})

/* ------------------------------------------------------- the round trips */

const roundTrip = (text, delimiter = ',', newline = '\n') =>
  formatSeparated(parseSeparated(text, delimiter), delimiter, newline)

for (const [what, text] of [
  ['a plain table', 'id,name\n1,Ada\n2,Grace\n'],
  ['embedded delimiters', 'a,b\n"x,y",z\n'],
  ['embedded newlines', 'a,b\n"one\ntwo",z\n'],
  ['embedded quotes', 'a\n"say ""hi"""\n'],
  ['empty fields', 'a,b,c\n,,\n1,,3\n'],
  ['edge whitespace', 'a,b\n" x ",y\n']
]) {
  ok(`${what} survives a round trip`, () => assert.equal(roundTrip(text), text))
}

ok('a CRLF file stays CRLF', () => {
  assert.equal(roundTrip('a,b\r\n1,2\r\n', ',', '\r\n'), 'a,b\r\n1,2\r\n')
})

/* --------------------------------------------------------- the reading

   What a cell means, which is what sorting and totalling are built on. Every
   case here is one an exported file actually contains. */

ok('a number reads through its punctuation', () => {
  assert.equal(numericValue('1,200'), 1200)
  assert.equal(numericValue('$1,200.50'), 1200.5)
  assert.equal(numericValue('-$40'), -40)
  assert.equal(numericValue('(1,200)'), -1200)   // accounting's negative
  assert.equal(numericValue('12%'), 12)          // as written, not as a ratio
  assert.equal(numericValue('  7 '), 7)
  assert.equal(numericValue('1.5e3'), 1500)
})

ok('what is not a number is not one', () => {
  for (const text of ['', '  ', 'n/a', '5" pipe', '2026-01-02', 'v1.2.3', '12,3,4.5.6']) {
    assert.ok(Number.isNaN(numericValue(text)), `${text} should not read as a number`)
  }
})

ok('a separator only groups digits if it groups them in threes', () => {
  /* The failure this exists to prevent: every comma stripped wherever it fell,
     which read a list as one long number. */
  assert.ok(Number.isNaN(numericValue('1,2,3')), 'a list is not a number')
  assert.ok(Number.isNaN(numericValue('1.234.567')), 'dots that group nothing here')
  assert.equal(numericValue('1,234,567'), 1234567)
  assert.equal(numericValue('1 234 567'), 1234567)   // the space family groups too
  assert.ok(Number.isNaN(numericValue('--5')), 'one sign, not two')
})

ok('a comma reads as a decimal mark where it cannot be a separator', () => {
  // `1,23` has too few digits after the comma to be a thousands group.
  assert.equal(numericValue('1,23'), 1.23)
  assert.equal(numericValue('1.234,56'), 1234.56)    // the European spelling
  assert.equal(numericValue('1234,56'), 1234.56)
  assert.equal(numericValue('1 234,56'), 1234.56)
})

ok('the ambiguous spelling reads as thousands', () => {
  /* `1,500` is fifteen hundred to one reader and one and a half to another,
     and nothing in the cell settles it. Thousands is the reading that keeps
     more real files right — a comma decimal cannot appear unquoted in a
     comma-delimited file at all. */
  assert.equal(numericValue('1,500'), 1500)
  assert.equal(numericValue('$1,200'), 1200)
})

ok('numbers compare as quantities, not as spellings', () => {
  // The failure this exists to prevent: 10 sorting between 1 and 2.
  assert.ok(compareCells('2', '10') < 0)
  assert.ok(compareCells('$1,000', '$900') > 0)
})

ok('dates compare as moments', () => {
  assert.ok(compareCells('2026-01-02', '2026-01-10') < 0)
  assert.ok(compareCells('2025-12-31', '2026-01-01') < 0)
})

ok('text compares with its digit runs read as numbers', () => {
  assert.ok(compareCells('item2', 'item10') < 0)
  assert.ok(compareCells('Ada', 'Grace') < 0)
})

ok('a column of both puts the numbers first', () => {
  assert.ok(compareCells('5', 'apples') < 0)
  assert.ok(compareCells('apples', '5') > 0)
})

/* ------------------------------------------------------------ the sorting */

const COLUMN = [['b'], ['a'], [''], ['c'], ['a']]
const base = COLUMN.map((_, i) => i)

ok('sorting ascends and descends', () => {
  assert.deepEqual(sortedOrder(COLUMN, base, 0, 'asc').map((i) => COLUMN[i][0]),
    ['a', 'a', 'b', 'c', ''])
  assert.deepEqual(sortedOrder(COLUMN, base, 0, 'desc').map((i) => COLUMN[i][0]),
    ['c', 'b', 'a', 'a', ''])
})

ok('blanks go last in both directions', () => {
  // A descending sort that opened with a screen of empty cells would be
  // answering a question nobody asked.
  assert.equal(sortedOrder(COLUMN, base, 0, 'asc').at(-1), 2)
  assert.equal(sortedOrder(COLUMN, base, 0, 'desc').at(-1), 2)
})

ok('ties keep the order they came in', () => {
  // Which is what makes sorting by one column and then another leave the
  // first sort standing as the tiebreak.
  const rows = [['a', '2'], ['a', '1'], ['b', '9']]
  const byB = sortedOrder(rows, [0, 1, 2], 1, 'asc')
  assert.deepEqual(sortedOrder(rows, byB, 0, 'asc'), [1, 0, 2])
})

ok('sorting reads the numbers in a numeric column', () => {
  const rows = [['9'], ['10'], ['1']]
  assert.deepEqual(sortedOrder(rows, [0, 1, 2], 0, 'asc'), [2, 0, 1])
})

/* ------------------------------------------------------- the resolutions */

ok('a resolution reads as the lines it means', () => {
  assert.equal(resolutionValue('1080p'), 1080)
  assert.equal(resolutionValue('720P'), 720)
  assert.equal(resolutionValue('1080i'), 1080)
  // Named for the width, ordered by the height: 4K is 2160 lines and 2K 1080.
  assert.equal(resolutionValue('4K'), 2160)
  assert.equal(resolutionValue('8k'), 4320)
  assert.equal(resolutionValue('2k'), 1080)
  assert.equal(resolutionValue('QHD'), 1440)
  assert.equal(Math.round(resolutionValue('1920x1080')), 1080)
})

ok('and everything else is left to be a number or a word', () => {
  assert.equal(resolutionValue('20k'), null, 'twenty thousand is not a screen')
  assert.equal(resolutionValue('1080'), null)
  assert.equal(resolutionValue('sku-4p'), null)
  assert.equal(resolutionValue(''), null)
  // The stats line still refuses to add resolutions up, because they are not
  // numbers however they sort.
  assert.ok(Number.isNaN(numericValue('1080p')))
})

ok('a resolution column sorts by resolution, not by spelling', () => {
  const rows = [['1080p'], ['4K'], ['720p'], ['1440p']]
  // Descending is the way this column is read: the best screen first.
  assert.deepEqual(sortedOrder(rows, [0, 1, 2, 3], 0, 'desc').map((i) => rows[i][0]),
    ['4K', '1440p', '1080p', '720p'])
  assert.deepEqual(sortedOrder(rows, [0, 1, 2, 3], 0, 'asc').map((i) => rows[i][0]),
    ['720p', '1080p', '1440p', '4K'])
})

ok('a bare number sits with the resolution it equals', () => {
  const rows = [['4K'], ['1080'], ['720p']]
  assert.deepEqual(sortedOrder(rows, [0, 1, 2], 0, 'asc').map((i) => rows[i][0]),
    ['720p', '1080', '4K'])
})

ok('two screens of a height sort by how wide they are', () => {
  const rows = [['2560x1080'], ['1920x1080'], ['3840x2160']]
  assert.deepEqual(sortedOrder(rows, [0, 1, 2], 0, 'desc').map((i) => rows[i][0]),
    ['3840x2160', '2560x1080', '1920x1080'])
})

ok('a sort is a permutation of what it was given, no more', () => {
  const some = [3, 1, 4]
  assert.deepEqual(sortedOrder(COLUMN, some, 0, 'asc').slice().sort(), [1, 3, 4])
})

/* ----------------------------------------------------------- the filtering */

const TABLE = [['Ada', 'maths'], ['Grace', 'compilers'], ['Alan', 'MATHS']]

ok('the filter matches any cell, in either case', () => {
  assert.deepEqual(filterOrder(TABLE, [0, 1, 2], 'maths'), [0, 2])
  assert.deepEqual(filterOrder(TABLE, [0, 1, 2], 'gra'), [1])
})

ok('an empty query is not a filter', () => {
  assert.deepEqual(filterOrder(TABLE, [0, 1, 2], ''), [0, 1, 2])
  assert.deepEqual(filterOrder(TABLE, [0, 1, 2], '   '), [0, 1, 2])
})

ok('the filter narrows what it is given rather than the whole file', () => {
  assert.deepEqual(filterOrder(TABLE, [2], 'maths'), [2])
})

/* ------------------------------------------------------ the column filter */

/* The question this is for: a column of categories, and one of them wanted.
   Blanks are a category too — the rows the export left empty. */
const CATALOGUE = [
  ['Arrival', 'Movie', '2016'],
  ['Severance', 'TV Show', '2022'],
  ['Dune', 'Movie', '2021'],
  ['Andor', 'TV Show', '2022'],
  ['Unknown', '', '']
]
const every = [0, 1, 2, 3, 4]

ok('a column reports its values with how many rows hold each', () => {
  assert.deepEqual(columnValues(CATALOGUE, every, 1), [
    { value: 'Movie', count: 2 },
    { value: 'TV Show', count: 2 },
    { value: '', count: 1 }
  ])
})

ok('values come out in the order the column sorts, blanks last', () => {
  // Numbers as numbers, so 2016 is not filed between 20 and 21 by its digits.
  assert.deepEqual(columnValues(CATALOGUE, every, 2).map((v) => v.value),
    ['2016', '2021', '2022', ''])
})

ok('a filter hides the values it names and keeps the rest', () => {
  const only = new Map([[1, new Set(['Movie', ''])]])
  assert.deepEqual(filteredOrder(CATALOGUE, every, only).map((i) => CATALOGUE[i][0]),
    ['Severance', 'Andor'])
})

ok('blanks are hidden by naming the empty value, not by anything special', () => {
  const noBlanks = new Map([[1, new Set([''])]])
  assert.deepEqual(filteredOrder(CATALOGUE, every, noBlanks), [0, 1, 2, 3])
})

ok('filters on two columns are both applied', () => {
  const both = new Map([[1, new Set(['Movie'])], [2, new Set(['2022'])]])
  assert.deepEqual(filteredOrder(CATALOGUE, every, both), [4])
})

ok('an empty hidden set is no filter at all', () => {
  assert.deepEqual(filteredOrder(CATALOGUE, every, new Map([[1, new Set()]])), every)
  assert.deepEqual(filteredOrder(CATALOGUE, every, new Map()), every)
})

ok('the filter narrows what it is given, and can be sorted after', () => {
  const only = new Map([[1, new Set(['Movie'])]])
  const kept = filteredOrder(CATALOGUE, [0, 1, 2], only)
  assert.deepEqual(kept, [1])
  assert.deepEqual(sortedOrder(CATALOGUE, filteredOrder(CATALOGUE, every, only), 0, 'asc')
    .map((i) => CATALOGUE[i][0]), ['Andor', 'Severance', 'Unknown'])
})

ok('a value that appears after the filter was set is shown, not hidden', () => {
  /* The reason the filter is a set of hidden values rather than kept ones: a
     row typed in later cannot be in a list made before it existed. */
  const only = new Map([[1, new Set(['Movie'])]])
  const grown = [...CATALOGUE, ['Fallout', 'Series', '2024']]
  assert.deepEqual(filteredOrder(grown, [...every, 5], only).at(-1), 5)
})

/* ---------------------------------------------------------- the selection */

ok('two corners make the rectangle between them', () => {
  assert.deepEqual(normalRect({ r: 4, c: 1 }, { r: 2, c: 3 }), { r0: 2, r1: 4, c0: 1, c1: 3 })
  // The heading is row -1, which is what makes a whole-column selection
  // include the column's name.
  assert.deepEqual(normalRect({ r: -1, c: 2 }, { r: 9, c: 2 }), { r0: -1, r1: 9, c0: 2, c1: 2 })
})

/* ----------------------------------------------------------- the shape

   The four facts about a file the rows alone cannot say, and the reason they
   are worth a section of their own: forget any one of them and an edit to one
   cell arrives in git as a rewrite of every line. */

ok('a byte-order mark is reported, and is not part of the first heading', () => {
  const { rows, shape } = readSeparated('﻿a,b\n1,2\n')
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']])
  assert.equal(shape.bom, true)
  assert.equal(readSeparated('a,b\n').shape.bom, false)
})

ok('the line ending is the file’s own, all three of them', () => {
  assert.equal(readSeparated('a,b\r\n1,2\r\n').shape.newline, '\r\n')
  assert.equal(readSeparated('a,b\n1,2\n').shape.newline, '\n')
  // The bare-CR file: classic Mac, and still what some instruments emit. It
  // has no LF anywhere, so the old LF-or-CRLF reading rewrote every line.
  assert.equal(readSeparated('a,b\r1,2\r').shape.newline, '\r')
  assert.equal(detectNewline('a,b\r1,2\r'), '\r')
  assert.equal(detectNewline('a,b\r\n1,2'), '\r\n')
  assert.equal(detectNewline('a,b\n1,2'), '\n')
})

ok('a missing final newline is remembered, and not invented back', () => {
  const ended = readSeparated('a,b\n1,2\n')
  const bare = readSeparated('a,b\n1,2')
  assert.equal(ended.shape.finalNewline, true)
  assert.equal(bare.shape.finalNewline, false)
  assert.equal(formatSeparated(bare.rows, ',', '\n', bare.shape), 'a,b\n1,2')
  assert.equal(formatSeparated(ended.rows, ',', '\n', ended.shape), 'a,b\n1,2\n')
})

ok('a writer that quotes everything gets its quotes back', () => {
  const text = '"a","b"\n"1","2"\n'
  const { rows, shape } = readSeparated(text)
  assert.equal(shape.quoteAll, true)
  assert.equal(formatSeparated(rows, ',', '\n', shape), text)
})

ok('a column the writer quotes stays quoted, and its neighbours stay bare', () => {
  const text = 'id,"name"\n1,"Ada"\n2,"Grace"\n'
  const { rows, shape } = readSeparated(text)
  assert.deepEqual(shape.quoteColumns, [false, true])
  assert.equal(formatSeparated(rows, ',', '\n', shape), text)
})

ok('one bare value settles a column as unquoted', () => {
  // A writer that quotes by column does not sometimes forget: the quotes on
  // the other rows were about their content, not the column.
  const { shape } = readSeparated('a\n"x, y"\nplain\n')
  assert.deepEqual(shape.quoteColumns, [false])
})

ok('every file the reader can read comes back byte for byte', () => {
  for (const text of [
    'a,b\n1,2\n',
    'a,b\r\n1,2\r\n',
    'a,b\r1,2\r',
    'a,b\n1,2',
    '"a","b"\r\n"1, one","2"\r\n',
    'x;"y ""q"""\n1;2',
    'a,b\n"one\ntwo",three\n'
  ]) {
    const delimiter = text.includes(';') ? ';' : ','
    const { rows, shape } = readSeparated(text, delimiter)
    assert.equal(formatSeparated(rows, delimiter, shape.newline, shape),
      text, JSON.stringify(text))
  }
})

ok('a field that gains a newline quotes itself on the way out', () => {
  // Which is what lets ⇧⏎ put a line break inside a cell.
  assert.equal(formatSeparated([['a'], ['one\ntwo']], ',', '\n'), 'a\n"one\ntwo"\n')
})

/* -------------------------------------------------------------- TSV quotes */

ok('a lone leading quote in a TSV is data, not syntax', () => {
  // Almost nothing that writes TSV quotes anything, so `"5 inch` is a unit —
  // and reading it as an opening quote swallowed the rest of the file into
  // one cell.
  assert.deepEqual(parseSeparated('size\tname\n"5 inch\tpipe\n6"\televen\n', '\t'),
    [['size', 'name'], ['"5 inch', 'pipe'], ['6"', 'eleven']])
})

ok('a genuinely quoted TSV field still reads as one', () => {
  assert.deepEqual(parseSeparated('a\tb\n"one\ttab"\ttwo\n', '\t'),
    [['a', 'b'], ['one\ttab', 'two']])
})

/* --------------------------------------------------------------- the dates

   The slashed date is ambiguous per value and settled per column: one day
   above twelve proves the column day-first, one month above twelve proves it
   month-first, and every value in the column is then read the same way. */

ok('a day above twelve proves a column day-first', () => {
  const rows = [['05/01/2024'], ['13/01/2024']]
  assert.equal(columnDateOrder(rows, [0, 1], 0), 'dmy')
})

ok('a second field above twelve proves it month-first', () => {
  const rows = [['01/13/2024'], ['05/01/2024']]
  assert.equal(columnDateOrder(rows, [0, 1], 0), 'mdy')
})

ok('a UK date column sorts as the calendar, not as Date.parse reads it', () => {
  /* The failure this exists to prevent: `05/01/2024` read US-style as 1 May
     while `13/01/2024` failed to parse and stayed a word, so January 2024
     sorted above December 2023. */
  const rows = [['05/01/2024'], ['13/01/2024'], ['31/12/2023'], ['01/02/2024']]
  const sorted = sortedOrder(rows, [0, 1, 2, 3], 0, 'asc').map((i) => rows[i][0])
  assert.deepEqual(sorted, ['31/12/2023', '05/01/2024', '13/01/2024', '01/02/2024'])
})

ok('a US date column sorts month-first the same way throughout', () => {
  const rows = [['01/13/2024'], ['12/31/2023'], ['02/01/2024']]
  const sorted = sortedOrder(rows, [0, 1, 2], 0, 'asc').map((i) => rows[i][0])
  assert.deepEqual(sorted, ['12/31/2023', '01/13/2024', '02/01/2024'])
})

ok('a date is never compared against a word as a moment', () => {
  // Mixed prose is not a calendar: the stray label collates as text.
  const rows = [['13/01/2024'], ['pending'], ['05/01/2024']]
  const sorted = sortedOrder(rows, [0, 1, 2], 0, 'asc').map((i) => rows[i][0])
  assert.deepEqual(sorted, ['05/01/2024', '13/01/2024', 'pending'])
})

ok('two-digit years land in the century a spreadsheet means', () => {
  const rows = [['05/01/99'], ['05/01/01']]
  assert.deepEqual(sortedOrder(rows, [0, 1], 0, 'asc'), [0, 1])
})

/* --------------------------------------------------------- the multi-sort */

ok('two keys are one ordering, not two sorts', () => {
  const rows = [['b', '2'], ['a', '2'], ['b', '1'], ['a', '1']]
  const order = multiSortedOrder(rows, [0, 1, 2, 3],
    [{ col: 0, dir: 'asc' }, { col: 1, dir: 'desc' }])
  assert.deepEqual(order.map((i) => rows[i].join('')), ['a2', 'a1', 'b2', 'b1'])
})

ok('blanks go last per key, and ties keep their order', () => {
  const rows = [['', 'x'], ['a', 'y'], ['a', 'y']]
  const order = multiSortedOrder(rows, [0, 1, 2],
    [{ col: 0, dir: 'asc' }, { col: 1, dir: 'asc' }])
  assert.deepEqual(order, [1, 2, 0])
})

ok('no keys is the order that came in', () => {
  assert.deepEqual(multiSortedOrder([['b'], ['a']], [0, 1], []), [0, 1])
})

/* ------------------------------------------------------------ the matcher */

ok('the plain matcher is a case-insensitive substring', () => {
  const m = makeMatcher('ada')
  assert.ok(m.test('Ada Lovelace'))
  assert.ok(!m.test('Grace'))
  assert.equal(m.replace('Ada and ADA', 'X'), 'X and X')
})

ok('whole-cell matching finds 12 and not 120', () => {
  const m = makeMatcher('12', { whole: true })
  assert.ok(m.test('12'))
  assert.ok(!m.test('120'))
  assert.equal(m.replace('12', 'X'), 'X')
  assert.equal(m.replace('120', 'X'), '120')
})

ok('a regular expression matches and replaces with its groups', () => {
  const m = makeMatcher('(\\d{2})/(\\d{2})/(\\d{4})', { regex: true })
  assert.ok(m.test('05/01/2024'))
  assert.equal(m.replace('05/01/2024', '$3-$2-$1'), '2024-01-05')
})

ok('a half-typed pattern is "no matcher yet", not an error', () => {
  assert.equal(makeMatcher('(\\d+', { regex: true }), null)
  assert.equal(makeMatcher('   '), null)
})

ok('filterOrder takes the same options the box offers', () => {
  const rows = [['item12'], ['12'], ['other']]
  assert.deepEqual(filterOrder(rows, [0, 1, 2], '12', { whole: true }), [1])
  assert.deepEqual(filterOrder(rows, [0, 1, 2], '^item', { regex: true }), [0])
})

/* ------------------------------------------------------------ the exports */

ok('TSV escapes rather than quotes, which is what its readers expect', () => {
  assert.equal(gridToTsv([['a', 'b\tc'], ['x\ny', 'z\\w']]),
    'a\tb\\tc\nx\\ny\tz\\\\w\n')
})

ok('JSON keys off the headings, and invents names only where it must', () => {
  const json = JSON.parse(gridToJson(['name', '', 'name'], [['Ada', '1', '2']]))
  assert.deepEqual(json, [{ name: 'Ada', 'column 2': '1', 'name (2)': '2' }])
})

ok('JSON keeps values as the strings they are', () => {
  const json = JSON.parse(gridToJson(['id'], [['007']]))
  assert.equal(json[0].id, '007')
})

ok('a Markdown table escapes its pipes and breaks its lines', () => {
  assert.equal(gridToMarkdown([['a', 'b|c'], ['1', 'x\ny']]),
    '| a | b\\|c |\n| --- | --- |\n| 1 | x<br>y |\n')
})

/* ------------------------------------------------------- the restored view */

ok('a reload puts back only the view that still fits the file', () => {
  const sorts = restoredSorts({ sorts: [
    { col: 1, dir: 'asc' }, { col: 9, dir: 'desc' },
    { col: 1, dir: 'desc' }, { col: 0, dir: 'sideways' }
  ] }, 3)
  assert.deepEqual(sorts, [{ col: 1, dir: 'asc' }])
  const filters = restoredFilters({ filters: [[2, ['x', 'y']], [0, []], ['junk']] })
  assert.deepEqual([...filters.get(2)], ['x', 'y'])
  assert.equal(filters.size, 1)
})

ok('a headerless file is shown under the spreadsheet alphabet', () => {
  assert.deepEqual(numberedHeader(3), ['A', 'B', 'C'])
  assert.equal(numberedHeader(27)[26], 'AA')
  assert.equal(numberedHeader(28)[27], 'AB')
})

/* --------------------------------------------------------- the delimiter */

ok('a comma file is read with commas', () => {
  assert.equal(sniffDelimiter('id,name,city\n1,Ada,London\n2,Grace,Baltimore\n'), ',')
})

ok('a semicolon file is not read as one long column', () => {
  /* The failure this exists to prevent. Everywhere that writes decimals with a
     comma exports `.csv` separated by semicolons, and read with a comma the
     whole file is one column of unsplit lines — every row intact, entirely
     unusable, and nothing on screen saying why. */
  const text = 'id;name;price\n1;Ada;1,50\n2;Grace;2,75\n'
  assert.equal(sniffDelimiter(text), ';')
  assert.deepEqual(parseSeparated(text, sniffDelimiter(text))[1], ['1', 'Ada', '1,50'])
})

ok('tabs and pipes are read as what they are', () => {
  assert.equal(sniffDelimiter('a\tb\tc\n1\t2\t3\n'), '\t')
  assert.equal(sniffDelimiter('a|b|c\n1|2|3\n'), '|')
})

ok('the extension wins where the file does not settle it', () => {
  /* A two-column file could be read as two columns of several things when the
     other candidates simply do not appear in it. The extension's delimiter is
     the file's declared shape, so it takes the tie. */
  assert.equal(sniffDelimiter('a,b\n1,2\n', ','), ',')
  assert.equal(sniffDelimiter('a\tb\n1\t2\n', '\t'), '\t')
  // And a file with no delimiter in it at all is left as it was declared.
  assert.equal(sniffDelimiter('alpha\nbeta\ngamma\n', ','), ',')
  assert.equal(sniffDelimiter('', ';'), ';')
})

ok('a delimiter inside quotes does not win the file', () => {
  /* Semicolons appear on every line here, but only inside a quoted field, so
     splitting on them gives rows that disagree about their own width. The
     comma gives a rectangle, and a rectangle is what a table is. */
  const text = 'id,tags\n1,"a;b;c"\n2,"d;e;f"\n3,"g;h;i"\n'
  assert.equal(sniffDelimiter(text), ',')
})

ok('the rows have to agree, not merely split', () => {
  // Commas split this into a consistent three; semicolons into a ragged mess.
  assert.equal(sniffDelimiter('a,b,c\n1,2,3\n4;5,6,7\n8,9,10\n'), ',')
})

ok('a delimiter has a name to show', () => {
  assert.equal(delimiterName(';'), 'Semicolon')
  assert.equal(delimiterName('\t'), 'Tab')
  assert.equal(delimiterName('|'), 'Pipe')
  assert.equal(delimiterName(','), 'Comma')
})

/* --------------------------------------------------------- the arithmetic */

ok('a selection adds up', () => {
  const stats = selectionStats(['1', '2', '3', '4'])
  assert.equal(stats.sum, 10)
  assert.equal(stats.average, 2.5)
  assert.equal(stats.min, 1)
  assert.equal(stats.max, 4)
  assert.equal(stats.cells, 4)
})

ok('the punctuation an export wears adds up as the number it means', () => {
  const stats = selectionStats(['$1,200', '(300)', '50%'])
  assert.equal(stats.sum, 950)
  assert.equal(stats.numbers, 3)
})

ok('what is not a number is skipped rather than counted as zero', () => {
  /* The case that decides it: one `n/a` in a column of prices must not drag
     the average down, and a blank caught in the drag must not either. */
  const stats = selectionStats(['10', 'n/a', '', '  ', '20'])
  assert.equal(stats.cells, 5)
  assert.equal(stats.filled, 3, 'the two blanks are not filled cells')
  assert.equal(stats.numbers, 2)
  assert.equal(stats.sum, 30)
  assert.equal(stats.average, 15, 'the average is over the numbers, not the selection')
})

ok('nothing numeric is a selection with no total', () => {
  const stats = selectionStats(['Ada', 'Grace'])
  assert.equal(stats.numbers, 0)
  assert.equal(stats.sum, 0)
  assert.equal(stats.average, 0)
})

ok('a column of screens has no sum', () => {
  // They sort as heights because that is what the column means, but adding
  // two resolutions together would be inventing a quantity.
  const stats = selectionStats(['1080p', '4K', '720p'])
  assert.equal(stats.numbers, 0)
})

ok('a column of prices totals to the price it should', () => {
  /* Summed naively in binary floating point this comes to 0.9999999999999999,
     and a total ending in a run of nines reads as a bug in the file. */
  const stats = selectionStats(['0.1', '0.2', '0.3', '0.4'])
  assert.equal(stats.sum, 1)
  assert.equal(formatStat(stats.sum), '1')
})

ok('a total is written the way a person reads one', () => {
  assert.equal(formatStat(1234567), '1,234,567')
  assert.equal(formatStat(1234.5), '1,234.5')
  assert.equal(formatStat(0), '0')
  assert.equal(formatStat(-40.25), '-40.25')
  // Past what grouping helps with, and below what four places can show.
  assert.equal(formatStat(1e16), '1.0000e+16')
  assert.equal(formatStat(0.000001), '1.0000e-6')
  assert.equal(formatStat(Infinity), '—')
})

ok('the selection walks an iterable rather than needing an array', () => {
  // Which is what lets the grid total a rectangle without collecting it first.
  function * cells () { yield '5'; yield '7' }
  assert.equal(selectionStats(cells()).sum, 12)
})

/* --------------------------------------------------------- the clipboard */

ok('a selection goes on the clipboard as a spreadsheet writes one', () => {
  assert.equal(gridToClipboard([['a', 'b'], ['1', '2']]), 'a\tb\n1\t2')
})

ok('a cell holding a tab or a newline is quoted', () => {
  assert.equal(gridToClipboard([['one\ttwo', 'three\nfour']]), '"one\ttwo"\t"three\nfour"')
})

ok('what a spreadsheet pastes comes back as the grid it was', () => {
  assert.deepEqual(parseClipboardGrid('a\tb\n1\t2'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parseClipboardGrid('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parseClipboardGrid('a\tb\r\n1\t2'), [['a', 'b'], ['1', '2']])
})

ok('commas are a delimiter only where there are no tabs', () => {
  assert.deepEqual(parseClipboardGrid('a,b\n1,2'), [['a', 'b'], ['1', '2']])
  // A tabbed paste keeps its commas as data — this is the case that decides
  // the rule, because a spreadsheet's own copy is tab-separated.
  assert.deepEqual(parseClipboardGrid('1,5\t2'), [['1,5', '2']])
})

ok('one plain cell pastes as one cell', () => {
  assert.deepEqual(parseClipboardGrid('hello'), [['hello']])
  assert.deepEqual(parseClipboardGrid(''), [['']])
})

ok('a copied rectangle survives the round trip through the clipboard', () => {
  const grid = [['a', 'b,c'], ['line\none', 'say "hi"']]
  assert.deepEqual(parseClipboardGrid(gridToClipboard(grid)), grid)
})

/* ------------------------------------------------- the vault's own lists */

ok('the two processes agree on which files are data', () => {
  for (const ext of Object.keys(VAULT_CONTRACT.dataExtensions)) {
    assert.ok(isDataPath(`Exports/table${ext}`), `${ext} should be a data file`)
    assert.ok(!isCodePath(`Exports/table${ext}`), `${ext} should not also be source`)
  }
  assert.equal(dataDelimiter('a.tsv'), '\t')
  assert.equal(dataDelimiter('a.csv'), ',')
})

ok('every source extension is recognised as one', () => {
  for (const ext of VAULT_CONTRACT.codeExtensions) {
    assert.ok(isCodePath(`Scripts/solve${ext}`), `${ext} should be a source file`)
    assert.equal(codeToken(`Scripts/solve${ext}`), ext.slice(1))
  }
})

ok('a note is not mistaken for source', () => {
  for (const ext of VAULT_CONTRACT.noteExtensions) {
    assert.ok(!isCodePath(`Notes/thoughts${ext}`), `${ext} is a note`)
  }
  assert.ok(!isCodePath('Papers/thesis.pdf'))
  assert.ok(!isCodePath('Papers/thesis.tex'))
})

/* The extension list and the language table are two files, and the whole
   arrangement is that the second explains the first. An extension neither
   names a language nor is deliberately plain would open uncoloured with
   nothing saying why — which is the failure this catches. */
ok('every source extension names a language the app knows', () => {
  const unknown = VAULT_CONTRACT.codeExtensions
    .map((ext) => ext.slice(1))
    .filter((token) => languageId(token) === '')
  assert.deepEqual(unknown, [],
    `these extensions resolve to no language in src/languages.js: ${unknown.join(', ')}`)
})

/* ------------------------------------------------- the new-file choices */

ok('the language picker offers each language once', () => {
  const ids = SOURCE_CHOICES.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length,
    'a language appearing twice is the same language under two extensions')
})

ok('every offered language creates a file the app will open', () => {
  for (const choice of SOURCE_CHOICES) {
    assert.ok(isCodePath(`New${choice.ext}`), `${choice.ext} would not open`)
    assert.equal(languageId(choice.ext.slice(1)), choice.id)
    assert.ok(choice.label, `${choice.ext} has no name to show`)
  }
})

ok('the picker uses the first extension the contract lists', () => {
  // `.cpp` and not `.cc`; `.c` and not `.h`. Otherwise the row for C++ would
  // make a header file, which is not what "new C++ file" means.
  const byId = new Map(SOURCE_CHOICES.map((c) => [c.id, c.ext]))
  assert.equal(byId.get('cpp'), '.cpp')
  assert.equal(byId.get('c'), '.c')
  assert.equal(byId.get('python'), '.py')
  assert.equal(byId.get('julia'), '.jl')
})

ok('the picker offers no data files — those have their own command', () => {
  for (const choice of SOURCE_CHOICES) {
    assert.ok(!isDataPath(`New${choice.ext}`), `${choice.ext} is a data file`)
  }
})

console.log(`\n${passed} checks passed`)
