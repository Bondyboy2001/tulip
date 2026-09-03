/**
 * Reading a row of a language table without a table model.
 *
 * The review history reads rows straight out of the note's source, so the
 * splitting has to agree with the editor's about the one thing that can go
 * wrong in a cell: an escaped pipe.
 *
 *   node scripts/test-language-row.cjs
 */
const { cells, delimiter } = require('../electron/language-row')

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) return
  failures++
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

check('cells: outer pipes are optional',
  JSON.stringify(cells('| a | b |')) === JSON.stringify(cells('a | b')))
check('cells: an escaped pipe stays in the cell',
  JSON.stringify(cells('| a \\| b | c |')) === JSON.stringify(['a | b', 'c']))
check('cells: values are trimmed',
  JSON.stringify(cells('|  ναι  | yes|')) === JSON.stringify(['ναι', 'yes']))
check('cells: an empty cell is kept as one',
  JSON.stringify(cells('| a |  | c |')) === JSON.stringify(['a', '', 'c']))

check('delimiter: the rule under a header', delimiter('| --- | :---: | ---: |'))
check('delimiter: needs more than one column', !delimiter('| --- |'))
check('delimiter: a body row is not one', !delimiter('| ναι | yes |'))

if (failures) {
  console.error(`language row: ${failures} failure${failures === 1 ? '' : 's'}`)
  process.exit(1)
}
console.log('language row: all checks passed')
