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
  formatSeparated,
  numericValue,
  compareCells,
  sortedOrder,
  filterOrder,
  selectionStats,
  normalRect,
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

/* ---------------------------------------------------------- the selection */

ok('the selection totals only what is a number', () => {
  const stats = selectionStats(['1', '2', 'n/a', '', '$3'])
  assert.equal(stats.count, 5)
  assert.equal(stats.empty, 1)
  assert.equal(stats.numbers, 3)
  assert.equal(stats.sum, 6)
  assert.equal(stats.average, 2)
  assert.equal(stats.min, 1)
  assert.equal(stats.max, 3)
})

ok('a selection with no numbers in it claims none', () => {
  const stats = selectionStats(['a', ''])
  assert.equal(stats.numbers, 0)
  assert.equal(stats.sum, 0)
  assert.equal(stats.average, 0)
})

ok('two corners make the rectangle between them', () => {
  assert.deepEqual(normalRect({ r: 4, c: 1 }, { r: 2, c: 3 }), { r0: 2, r1: 4, c0: 1, c1: 3 })
  // The heading is row -1, which is what makes a whole-column selection
  // include the column's name.
  assert.deepEqual(normalRect({ r: -1, c: 2 }, { r: 9, c: 2 }), { r0: -1, r1: 9, c0: 2, c1: 2 })
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
