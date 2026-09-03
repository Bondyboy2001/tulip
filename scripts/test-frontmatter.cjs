'use strict'

/* Tests for electron/frontmatter.cjs's writer.
 *
 * The writer's promise is that it disturbs nothing it did not understand: a
 * verbatim line, a blank line, an unrelated property all come back where they
 * were. The failure worth guarding is silent — a head reformatted on every
 * alias edit reads as churn in whatever syncs the vault, and a dropped
 * verbatim line is data loss with no error anywhere.
 */

const assert = require('node:assert/strict')
const {
  writeListProp, writeScalarProp, renameProp, parseFrontmatter, frontmatterTags
} = require('../electron/frontmatter.cjs')

let passed = 0
let failed = 0
const check = (what, run) => {
  try { run(); console.log(`ok - ${what}`); passed++ } catch (error) {
    console.log(`not ok - ${what}\n  ${error.message}`); failed++
  }
}

check('a note with no head gains one holding just the list', () => {
  assert.equal(
    writeListProp('Body text.\n', 'aliases', ['Other name']),
    '---\naliases: [Other name]\n---\nBody text.\n')
})

check('a note with no head and no values is untouched', () => {
  assert.equal(writeListProp('Body.\n', 'aliases', []), 'Body.\n')
})

check('an existing list is replaced in place', () => {
  const note = '---\ntitle: One\naliases: [a]\ntags: [x]\n---\nBody.\n'
  assert.equal(
    writeListProp(note, 'aliases', ['b', 'c']),
    '---\ntitle: One\naliases: [b, c]\ntags: [x]\n---\nBody.\n')
})

check('the key matches case-insensitively and keeps its position', () => {
  const note = '---\nAliases: [a]\nkeep: yes\n---\nBody.\n'
  assert.equal(
    writeListProp(note, 'aliases', ['b']),
    '---\naliases: [b]\nkeep: yes\n---\nBody.\n')
})

check('a block list is replaced by the flow form', () => {
  const note = '---\naliases:\n  - one\n  - two\n---\nBody.\n'
  assert.equal(
    writeListProp(note, 'aliases', ['three']),
    '---\naliases: [three]\n---\nBody.\n')
})

check('emptying the list removes the property', () => {
  const note = '---\naliases: [a]\nkeep: yes\n---\nBody.\n'
  assert.equal(writeListProp(note, 'aliases', []), '---\nkeep: yes\n---\nBody.\n')
})

check('removing the last property removes the fences too', () => {
  const note = '---\naliases: [a]\n---\nBody.\n'
  assert.equal(writeListProp(note, 'aliases', []), 'Body.\n')
})

check('a round trip through gain and loss is byte-identical', () => {
  const note = 'Just prose.\n'
  const grown = writeListProp(note, 'aliases', ['x'])
  assert.equal(writeListProp(grown, 'aliases', []), note)
})

check('verbatim lines the grammar has no answer for are carried', () => {
  const note = '---\nnested:\n  deep: value\naliases: [a]\n\n# a comment\n---\nBody.\n'
  const out = writeListProp(note, 'aliases', ['b'])
  assert.ok(out.includes('nested:'))
  assert.ok(out.includes('  deep: value'))
  assert.ok(out.includes('# a comment'))
  assert.ok(out.includes('aliases: [b]'))
})

check('a value that needs quoting gets it and reads back', () => {
  const out = writeListProp('Body.\n', 'aliases', ['with, comma', 'plain'])
  const parsed = parseFrontmatter(out)
  const prop = parsed.entries.find((e) => e.key === 'aliases')
  assert.deepEqual(prop.value, ['with, comma', 'plain'])
})

check('a missing key lands at the end of the head', () => {
  const note = '---\ntitle: One\n---\nBody.\n'
  assert.equal(
    writeListProp(note, 'aliases', ['a']),
    '---\ntitle: One\naliases: [a]\n---\nBody.\n')
})

check('duplicate keys collapse to one', () => {
  const note = '---\naliases: [a]\nalias-count: 1\naliases: [b]\n---\nBody.\n'
  const out = writeListProp(note, 'aliases', ['c'])
  assert.equal(out.match(/aliases:/g).length, 1)
  assert.ok(out.includes('alias-count: 1'))
})

/* The tag reader. A vault that arrives from another app spells its tags three
   ways and Tulip has to answer the same for all of them, because the search
   filter and the Info pane both read through here — and a note whose tags the
   pane shows but the search cannot find is worse than no reader at all. */

check('a flow list is read as tags', () => {
  assert.deepEqual(frontmatterTags('---\ntags: [book, read/2026]\n---\nBody.\n'),
    ['book', 'read/2026'])
})

check('a block list is read as tags', () => {
  assert.deepEqual(frontmatterTags('---\ntags:\n  - book\n  - paper\n---\nBody.\n'),
    ['book', 'paper'])
})

check('a bare scalar splits on commas and whitespace', () => {
  assert.deepEqual(frontmatterTags('---\ntags: book, paper draft\n---\nBody.\n'),
    ['book', 'paper', 'draft'])
})

check('the singular key is accepted and a leading # is not part of the name', () => {
  assert.deepEqual(frontmatterTags('---\ntag: "#Book"\n---\nBody.\n'), ['book'])
})

check('a note with no head, and one with no tags, have none', () => {
  assert.deepEqual(frontmatterTags('Body.\n'), [])
  assert.deepEqual(frontmatterTags('---\ntitle: One\n---\nBody.\n'), [])
})

check('the same tag written twice is one tag', () => {
  assert.deepEqual(frontmatterTags('---\ntags: [book, "#BOOK"]\n---\nBody.\n'), ['book'])
})

check('a tag list round-trips through the writer', () => {
  const note = '---\ntitle: One\n---\nBody.\n'
  const out = writeListProp(note, 'tags', ['book', 'read/2026'])
  assert.equal(out, '---\ntitle: One\ntags: [book, read/2026]\n---\nBody.\n')
  assert.deepEqual(frontmatterTags(out), ['book', 'read/2026'])
})

/* The scalar writer and the rename, which the Info pane's properties table
   edits through. The promise is the list writer's: everything the head holds
   that this was not asked about comes back exactly where it was. */

check('a scalar lands in place and keeps its neighbours', () => {
  const note = '---\ntitle: One\nstatus: draft\n---\nBody.\n'
  assert.equal(writeScalarProp(note, 'status', 'reading'),
    '---\ntitle: One\nstatus: reading\n---\nBody.\n')
})

check('a new scalar lands at the end of the head', () => {
  assert.equal(writeScalarProp('---\ntitle: One\n---\nBody.\n', 'rating', 5),
    '---\ntitle: One\nrating: 5\n---\nBody.\n')
})

check('null removes the property, the empty string empties it', () => {
  const note = '---\ntitle: One\nstatus: draft\n---\nBody.\n'
  assert.equal(writeScalarProp(note, 'status', null), '---\ntitle: One\n---\nBody.\n')
  assert.equal(writeScalarProp(note, 'status', ''), '---\ntitle: One\nstatus:\n---\nBody.\n')
})

check('a value YAML would misread comes back quoted, and reads back whole', () => {
  const out = writeScalarProp('Body.\n', 'note', 'a: b #c')
  const prop = parseFrontmatter(out).entries.find((e) => e.key === 'note')
  assert.equal(prop.value, 'a: b #c')
})

check('a rename keeps the value and drops the old name', () => {
  const note = '---\ntitle: One\nstatus: draft\ntags: [x]\n---\nBody.\n'
  const out = renameProp(note, 'status', 'stage')
  assert.ok(out.includes('stage: draft'))
  assert.ok(!out.includes('status:'))
  assert.ok(out.includes('tags: [x]'))
})

check('a rename carries a list, and renaming to the same name changes nothing', () => {
  const note = '---\nkinds:\n  - a\n  - b\n---\nBody.\n'
  assert.equal(renameProp(note, 'kinds', 'sorts'), '---\nsorts: [a, b]\n---\nBody.\n')
  assert.equal(renameProp(note, 'kinds', 'kinds'), note)
  assert.equal(renameProp(note, 'missing', 'other'), note)
})

check('the head of a block mapping is verbatim, not an empty property', () => {
  const parsed = parseFrontmatter('---\nnested:\n  deep: 1\nstatus: draft\n---\nBody.\n')
  assert.deepEqual(parsed.entries.filter((e) => e.key !== undefined).map((e) => e.key),
    ['status'])
  // And still every line, in order, for the writer to carry.
  assert.deepEqual(parsed.entries.map((e) => e.raw),
    ['nested:', '  deep: 1', 'status: draft', ''])
})

check('an empty value is still a property when nothing is indented under it', () => {
  const parsed = parseFrontmatter('---\nstatus:\ntitle: One\n---\nBody.\n')
  const status = parsed.entries.find((e) => e.key === 'status')
  assert.equal(status.value, null)
})

check('a verbatim line survives a scalar write', () => {
  const note = '---\nnested:\n  deep: 1\nstatus: draft\n---\nBody.\n'
  const out = writeScalarProp(note, 'status', 'done')
  assert.ok(out.includes('nested:\n  deep: 1'))
  assert.ok(out.includes('status: done'))
})

console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ''}`)
if (failed) process.exit(1)
