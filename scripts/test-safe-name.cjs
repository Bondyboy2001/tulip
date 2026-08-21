'use strict'

/* What a note may be called. Every case here has cost something: a name that
   turned into `.md` and vanished from the tree, a colon that a synced vault
   could not carry to Windows, a trailing dot that Win32 stored under a
   different name than the app believed it had written.
*/

const assert = require('node:assert/strict')
const { safeFileName } = require('../electron/safe-name')

const NOTE_EXT = /\.md$/i

let passed = 0
function ok (what, fn) {
  fn()
  passed++
  console.log(`ok - ${what}`)
}

const name = (typed, options) => safeFileName(typed, options)
const accepted = (typed, options) => {
  const result = name(typed, options)
  assert.ok(result.ok, `expected "${typed}" to be accepted, got: ${result.error}`)
  return result.name
}
const refused = (typed, options) => {
  const result = name(typed, options)
  assert.ok(!result.ok, `expected "${typed}" to be refused, got: ${result.name}`)
  return result.error
}

/* ------------------------------------------------------- the disappearances */

ok('an empty name is refused', () => {
  refused('')
  refused('   ')
  refused(null)
  refused(undefined)
})

ok('a dot-leading name is refused — it would be hidden and unreachable', () => {
  refused('.md')
  refused('.hidden')
  refused('..')
})

ok('a name that is only forbidden characters is refused, not silently emptied', () => {
  refused('???')
  refused('<>|')
})

/* ------------------------------------------------------------- Windows rules */

ok('device names are refused with or without an extension', () => {
  for (const device of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'lpt9']) {
    refused(device)
  }
  // The extension is stripped before the check, so `CON.md` is the same name.
  refused('CON.md', { strip: [NOTE_EXT] })
})

ok('a name that merely contains a device word is fine', () => {
  assert.equal(accepted('Console'), 'Console')
  assert.equal(accepted('Auxiliary notes'), 'Auxiliary notes')
  assert.equal(accepted('COM10'), 'COM10')
})

ok('characters Windows forbids are dropped', () => {
  assert.equal(accepted('Notes: Monday'), 'Notes Monday')
  assert.equal(accepted('What? Why!'), 'What Why!')
  assert.equal(accepted('a"b|c*d<e>f'), 'abcdef')
})

ok('trailing dots and spaces are removed — Win32 eats them silently', () => {
  assert.equal(accepted('report.'), 'report')
  assert.equal(accepted('report...  '), 'report')
  assert.equal(accepted('  report  '), 'report')
})

ok('control characters are stripped', () => {
  assert.equal(accepted(`a${String.fromCharCode(0)}b`), 'ab')
  assert.equal(accepted(`a${String.fromCharCode(9)}b`), 'ab')
  assert.equal(accepted(`a${String.fromCharCode(127)}b`), 'ab')
})

/* -------------------------------------------------------------- separators */

ok('a path separator becomes a dash rather than a move', () => {
  assert.equal(accepted('a/b'), 'a-b')
  assert.equal(accepted('a\\b'), 'a-b')
  assert.equal(accepted('notes/2026/august'), 'notes-2026-august')
})

ok('a traversal is refused, not merely defused', () => {
  /* The separators become dashes, which leaves `..-..-etc-passwd` — a dot-
     leading name, and so refused by the rule above. Worth asserting directly:
     the two rules only add up to safety in this order. */
  refused('../secret')
  refused('../../etc/passwd')
  refused('..\\..\\windows\\system32')
})

/* ------------------------------------------------------------- extensions */

ok('a typed extension is stripped so it is not doubled', () => {
  assert.equal(accepted('Note.md', { strip: [NOTE_EXT] }), 'Note')
  assert.equal(accepted('Note', { strip: [NOTE_EXT] }), 'Note')
  // Only the trailing one: a note really called `Note.md notes` keeps its name.
  assert.equal(accepted('Note.md notes', { strip: [NOTE_EXT] }), 'Note.md notes')
})

/* ------------------------------------------------------------------ length */

ok('an over-long name is refused rather than truncated on disk', () => {
  refused('x'.repeat(241))
  assert.equal(accepted('x'.repeat(240)).length, 240)
})

ok('length counts bytes, because the filesystem does', () => {
  // Four bytes each, so 61 of them is 244 bytes.
  refused('🌷'.repeat(61))
  assert.equal(accepted('🌷'.repeat(60)), '🌷'.repeat(60))
})

/* ------------------------------------------------------------ ordinary use */

ok('normal names pass through unchanged', () => {
  for (const good of [
    'Untitled', 'Reading list', 'Chapter 3 — notes', 'ünïcodé', '日本語',
    'a.b.c', "Someone's notes", '2026-08-06', 'C++ notes', '#hashtag'
  ]) {
    assert.equal(accepted(good), good)
  }
})

console.log(`\nsafe names: ${passed}/${passed}`)
