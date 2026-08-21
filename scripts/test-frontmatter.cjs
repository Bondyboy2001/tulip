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
const { writeListProp, parseFrontmatter } = require('../electron/frontmatter.cjs')

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

console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ''}`)
if (failed) process.exit(1)
