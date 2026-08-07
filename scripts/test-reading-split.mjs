/* `safeCut` decides where an enormous note stops being rendered. It is pure
   and it is the only thing standing between a reader and a half-open code
   fence, so it is worth more than the four lines it takes to check. */

import assert from 'node:assert/strict'
import { safeCut } from '../src/reading-split.js'

let passed = 0
const ok = (what) => { passed++; console.log(`ok - ${what}`) }

/* ------------------------------------------------------- the ordinary cases */

{
  const text = 'short enough'
  assert.equal(safeCut(text, 1000), text.length)
  ok('a note under the limit is not cut at all')
}

{
  const text = 'para one\n\npara two\n\npara three\n'
  const at = safeCut(text, 12)
  assert.equal(text.slice(0, at), 'para one\n')
  ok('cuts at the blank line at or before the limit')
}

{
  const text = 'a\n\nb\n\nc\n'
  assert.ok(safeCut(text, 4) <= 4, 'the prefix must come in under budget')
  ok('never overshoots the budget')
}

/* -------------------------------------------------------------- code fences */

{
  /* The blank line inside the fence is the tempting one — it sits right at the
     limit — and cutting there would leave ``` open and render Rust as prose. */
  const text = 'intro\n\n```rust\nlet a = 1;\n\nlet b = 2;\n```\n\ntail\n'
  const at = safeCut(text, text.indexOf('let b'))
  assert.equal(text.slice(0, at), 'intro\n')
  ok('will not cut inside a fenced code block')
}

{
  const text = 'intro\n\n~~~\nx\n\ny\n~~~\n\ntail\n'
  const at = safeCut(text, text.indexOf('y'))
  assert.equal(text.slice(0, at), 'intro\n')
  ok('tilde fences count too')
}

{
  /* A shorter run inside a longer fence is content, not the close. Treating it
     as a close would put the cut back inside the block. */
  const text = 'intro\n\n````\n```\n\n```\n````\n\ntail\n'
  /* The limit lands just past the blank line *inside* the ```` block. Read the
     inner ``` as a close and that blank line looks safe, and the cut lands in
     the middle of a fence. */
  const at = safeCut(text, text.indexOf('\n```\n````') + 1)
  assert.equal(text.slice(0, at), 'intro\n')
  ok('a shorter fence inside a longer one does not close it')
}

{
  const text = 'intro\n\n```\ncode\n```\n\nafter\n\nmore\n'
  const at = safeCut(text, text.indexOf('more'))
  assert.equal(text.slice(0, at), 'intro\n\n```\ncode\n```\n\nafter\n')
  ok('cuts after a fence that closed')
}

/* ------------------------------------------------------------ display maths */

{
  const text = 'intro\n\n$$\na = 1\n\nb = 2\n$$\n\ntail\n'
  const at = safeCut(text, text.indexOf('b = 2'))
  assert.equal(text.slice(0, at), 'intro\n')
  ok('will not cut inside a $$ block')
}

/* ------------------------------------------------------------- no safe place */

{
  /* One block, no blank lines: there is nowhere to stop. Whole, then — a slow
     note beats a broken one. */
  const text = 'x'.repeat(500)
  assert.equal(safeCut(text, 100), text.length)
  ok('a note with no blank line is shown whole')
}

{
  const text = '```\n' + 'x\n'.repeat(500) + '```\n'
  assert.equal(safeCut(text, 100), text.length)
  ok('a note that is one enormous fence is shown whole')
}

/* ------------------------------------------------------------------ nothing */

assert.equal(safeCut('', 10), 0)
assert.equal(safeCut(null, 10), 0)
ok('empty and absent text are answered without throwing')

console.log(`\nreading-split: ${passed}/${passed} passed`)
