/* Tests for the `.website` file format — src/site.js.
 *
 * The file is the whole feature: one address, and now a `#` line naming the
 * page so that search can find a bookmark by what it is rather than by what
 * the file happens to be called. Both halves are read by three different
 * things — the viewer, the search index in main, and whoever opens the file in
 * an editor — so the round trip is worth pinning down.
 *
 * The reading half is also where a long-standing disagreement lived: the
 * address bar accepted `threejs.org` and filled the scheme in, while the file
 * reader demanded `https://`, so a hand-edited file saying the same thing the
 * bar would have accepted opened as "No address yet".
 */

import assert from 'node:assert/strict'
import { readAddress, writeAddress, normaliseAddress } from '../src/site.js'

let passed = 0
let failed = 0
const check = (what, run) => {
  try { run(); console.log(`ok - ${what}`); passed++ } catch (error) {
    console.log(`not ok - ${what}\n  ${error.message}`); failed++
  }
}

/* ------------------------------------------------------------ addresses */

check('a bare host is the address it obviously means', () => {
  assert.equal(normaliseAddress('threejs.org'), 'https://threejs.org/')
  assert.equal(normaliseAddress('  example.com/path  '), 'https://example.com/path')
})

check('a scheme that is not the web is refused rather than mangled', () => {
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x']) {
    assert.equal(normaliseAddress(bad), '', bad)
  }
})

check('a word with no dot in it is a typo, except localhost', () => {
  assert.equal(normaliseAddress('notahost'), '')
  /* And a port is a port, not a scheme: `localhost:8000` is what someone with
     a dev server running types, and it used to be read as the scheme
     `localhost` and refused. http, because plain http is allowed on loopback
     and nowhere else — see `allowedGuestUrl` in electron/main.js. */
  assert.equal(normaliseAddress('localhost:8000'), 'http://localhost:8000/')
  assert.equal(normaliseAddress('127.0.0.1:5173/app'), 'http://127.0.0.1:5173/app')
  // A real scheme is still a scheme.
  assert.equal(normaliseAddress('https://example.com:8443/'), 'https://example.com:8443/')
})

/* ----------------------------------------------------------- reading it */

check('a file holding one address reads as that address', () => {
  assert.deepEqual(readAddress('https://example.com/\n'), {
    url: 'https://example.com/', title: '', notes: []
  })
})

check('a hand-written address with no scheme is still an address', () => {
  /* The whole of the bug: this file used to open as "No address yet", while
     typing the same text into the bar worked. */
  assert.equal(readAddress('example.com\n').url, 'https://example.com/')
})

check('the first comment line is the page’s name', () => {
  const said = readAddress('# Example Domain\nhttps://example.com/\n')
  assert.equal(said.title, 'Example Domain')
  assert.equal(said.url, 'https://example.com/')
})

check('the reader’s own comments are kept apart from the name', () => {
  const said = readAddress('# Example Domain\nhttps://example.com/\n# read this later\n')
  assert.equal(said.title, 'Example Domain')
  assert.deepEqual(said.notes, ['read this later'])
})

check('a file with nothing in it names nothing', () => {
  assert.deepEqual(readAddress(''), { url: '', title: '', notes: [] })
  assert.deepEqual(readAddress('\n\n  \n'), { url: '', title: '', notes: [] })
})

/* ----------------------------------------------------------- writing it */

check('what is written reads back as what was meant', () => {
  const written = writeAddress({
    url: 'https://example.com/', title: 'Example Domain', notes: ['kept']
  })
  assert.deepEqual(readAddress(written), {
    url: 'https://example.com/', title: 'Example Domain', notes: ['kept']
  })
})

check('the address is always on a line of its own', () => {
  const written = writeAddress({ url: 'https://example.com/', title: 'Example Domain' })
  assert.equal(written, '# Example Domain\nhttps://example.com/\n')
})

check('a title with newlines in it cannot break the file in two', () => {
  /* A page may call itself anything at all, including something with a line
     break in it — which, written straight out, would turn the rest of the
     title into a second line the reader would then be asked to parse. */
  const written = writeAddress({ url: 'https://example.com/', title: 'One\nTwo   Three' })
  assert.equal(written.split('\n').length, 3)
  assert.equal(readAddress(written).title, 'One Two Three')
  assert.equal(readAddress(written).url, 'https://example.com/')
})

check('a file with no title is one line, as it always was', () => {
  assert.equal(writeAddress({ url: 'https://example.com/' }), 'https://example.com/\n')
})

console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ''}`)
if (failed) process.exit(1)
