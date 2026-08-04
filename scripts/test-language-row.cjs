/**
 * Adding a word to a table without rewriting the table.
 *
 * A vocabulary note is the user's file, lined up by hand, and quick-add has to
 * leave every row it did not touch exactly as it found it — including the
 * widths comment the editor writes above the table and the spacing inside the
 * cells. Anything that reformats a note on the way past is a feature nobody
 * will use twice.
 *
 *   node scripts/test-language-row.cjs
 */
const { cells, tableAt, appendRow, fillRow, rows } = require('../electron/language-row')

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) return
  failures++
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

const NOTE = `<!-- tk-widths: 148 141 0 84 -->
| Word | English | Example | Notes |
| --- | --- | :---: | --- |
| ναι | yes | |  |
| καρότο | carrot |  |  |
`

/* ------------------------------------------------------------- reading */

check('cells: outer pipes are optional',
  JSON.stringify(cells('| a | b |')) === JSON.stringify(cells('a | b')))
check('cells: an escaped pipe stays in the cell',
  JSON.stringify(cells('| a \\| b | c |')) === JSON.stringify(['a | b', 'c']))

const table = tableAt(NOTE)
check('table: found under its comment', table.at === 1)
check('table: the header is its columns',
  JSON.stringify(table.header) === JSON.stringify(['Word', 'English', 'Example', 'Notes']))
check('table: the body is the rows and nothing else',
  table.end - table.first === 2, `${table.first}..${table.end}`)
check('table: a note with no table has none', tableAt('just prose') === null)
check('rows: every word in the table', rows(NOTE).length === 2)

/* ----------------------------------------------------------- appending */

const added = appendRow(NOTE, { Word: 'νερό', English: 'water' })
check('append: the note gains one line',
  added.text.split('\n').length === NOTE.split('\n').length + 1)
check('append: everything above the new row is untouched',
  added.text.startsWith(NOTE.trimEnd()),
  JSON.stringify(added.text.slice(0, 60)))
check('append: the word lands in its columns',
  added.text.includes('| νερό | water |  |  |'), added.text.split('\n').at(-2))
check('append: the row index is counted from the first word', added.row === 2)

const reordered = appendRow(
  '| English | Word |\n| --- | --- |\n| yes | ναι |\n',
  { Word: 'νερό', English: 'water' }
)
check('append: values follow the table’s column order, not the caller’s',
  reordered.text.includes('| water | νερό |'), reordered.text)

check('append: a column the table does not have is dropped',
  appendRow(NOTE, { Word: 'νερό', Gender: 'neuter' }).text.includes('| νερό |  |  |  |'))
check('append: nothing to add is not an edit', appendRow(NOTE, { Gender: 'n' }) === null)
check('append: a note with no table cannot take a word',
  appendRow('prose', { Word: 'νερό' }) === null)

/* The template's blank row is a place to type, not a word. */
const TEMPLATE = '| Word | English | Example | Notes |\n| --- | --- | --- | --- |\n|  |  |  |  |\n'
const first = appendRow(TEMPLATE, { Word: 'ναι', English: 'yes' })
check('append: the blank scaffold row is filled, not pushed down',
  !first.text.includes('|  |  |  |  |'), first.text)
check('append: and the first word is the first row', first.row === 0)

check('append: a pipe in a word is escaped rather than ending the cell',
  cells(appendRow(NOTE, { Word: 'a|b', English: 'x' }).text.split('\n').at(-2))[0] === 'a|b')
check('append: a newline in a value becomes a space',
  appendRow(NOTE, { Word: 'a\nb', English: 'x' }).text.includes('| a b | x |'))

/* ------------------------------------------------------------ filling */

const filled = fillRow(NOTE, 'ναι', {
  English: 'no — wrong', Example: 'Ναι, ευχαριστώ.', Notes: 'adverb'
})
check('fill: an empty cell is filled', filled.text.includes('Ναι, ευχαριστώ.'))
check('fill: a cell the user wrote is never overwritten',
  filled.text.includes('| ναι | yes |'), filled.text.split('\n')[3])
check('fill: it reports only what it actually changed',
  JSON.stringify(Object.keys(filled.filled).sort()) === JSON.stringify(['Example', 'Notes']))
check('fill: the other rows are untouched', filled.text.includes('| καρότο | carrot |  |  |'))
check('fill: a row with nothing empty is not an edit',
  fillRow(filled.text, 'ναι', { Example: 'something else' }) === null)
check('fill: a word that is not in the table is not an edit',
  fillRow(NOTE, 'ρύζι', { English: 'rice' }) === null)
check('fill: an empty suggestion is not an edit',
  fillRow(NOTE, 'ναι', { Example: '   ' }) === null)
check('fill: no term, no edit', fillRow(NOTE, '', { English: 'x' }) === null)

console.log(failures ? `\n${failures} failed` : 'language rows: all checks passed')
process.exit(failures ? 1 : 0)
