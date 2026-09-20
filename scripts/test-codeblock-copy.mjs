/* ================================================ copying a fenced block

   The copy control on a code block is what carries a block out of the app, so
   what it puts on the clipboard is the block as it was written: the fence, the
   language, then the code. Pasted into a note, a chat or an issue it arrives
   as a code block again — with the language to highlight it by — rather than
   as a wall of code.

   Asserted by reading the clipboard back with the same markdown parser the
   reading view renders with: one fence, the right language, the code
   unchanged. That is the property, and it is the one that has to survive a
   block that holds a fence of its own.

   ================================================================== */

import assert from 'node:assert/strict'
import MarkdownIt from 'markdown-it'

/* The browser these modules expect: enough for a button, its icon, and a
   click. Nothing here is the code under test. */
class FakeNode {
  constructor (tag = '') {
    this.tag = tag
    this.children = []
    this._class = new Set()
    this.attributes = {}
    this.handlers = {}
    const node = this
    this.classList = {
      add: (...names) => names.forEach((name) => node._class.add(name)),
      remove: (...names) => names.forEach((name) => node._class.delete(name)),
      contains: (name) => node._class.has(name),
      toggle: (name, on) => {
        const wanted = on == null ? !node._class.has(name) : Boolean(on)
        if (wanted) node._class.add(name); else node._class.delete(name)
      }
    }
  }

  get className () { return [...this._class].join(' ') }
  set className (value) { this._class = new Set(String(value).split(/\s+/).filter(Boolean)) }

  setAttribute (name, value) { this.attributes[name] = String(value) }
  append (...nodes) { this.children.push(...nodes) }
  replaceChildren (...nodes) { this.children = nodes }
  addEventListener (type, handler) { (this.handlers[type] ||= []).push(handler) }

  /* Icons are stamped from a cached template, so a clone has to carry what the
     template was given — see svgIcon in src/dom.js. */
  cloneNode () {
    const copy = new FakeNode(this.tag)
    copy._class = new Set(this._class)
    copy.attributes = { ...this.attributes }
    copy.children = this.children.map((child) => child.cloneNode())
    return copy
  }

  click () { for (const handler of this.handlers.click || []) handler() }
}

globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag)
}

const copied = []
globalThis.window = { tulip: { copy: (text) => copied.push(text) } }

const { codeCopyButton } = await import('../src/blocks.js')

const md = new MarkdownIt()

/** The clipboard after the copy control of one block has been pressed. */
const copyOf = (lang, code) => {
  copied.length = 0
  codeCopyButton(lang, code).click()
  assert.equal(copied.length, 1, 'one press puts one thing on the clipboard')
  return copied[0]
}

/** What markdown makes of it: the fence, its language, and the code inside. */
const asMarkdown = (lang, code) => {
  const tokens = md.parse(copyOf(lang, code), {})
  assert.equal(tokens.length, 1, `the clipboard holds ${tokens.length} blocks, not one`)
  assert.equal(tokens[0].type, 'fence', 'the clipboard holds a fenced block')
  return {
    lang: tokens[0].info.trim(),
    code: tokens[0].content.replace(/\n$/, '')
  }
}

/* The shape itself, once, so the format is written down where it can be read. */
assert.equal(copyOf('rust', 'fn main () {}'), '```rust\nfn main () {}\n```')

/* A block in a language, from either view: the code arrives whole and the
   language arrives with it. */
const rust = ['fn main () {', '    let mut v = String::from("hello,");', '}'].join('\n')
assert.deepEqual(asMarkdown('rust', rust), { lang: 'rust', code: rust })

/* A block that never named one still gets the fence, and no info string. */
assert.deepEqual(asMarkdown('', 'plain words, no language'),
  { lang: '', code: 'plain words, no language' })

/* A block holding a fence, which is what the fence's length is for: copied as
   three backticks the block would end at the first inner one, and what was in
   the note would arrive as two blocks with the example's code among them. The
   indented run counts too — up to three spaces of indentation still closes a
   fence. */
const nested = [
  '```js',
  'const answer = 42',
  '```',
  '',
  '   ````',
  'four backticks, three spaces in'
].join('\n')
assert.deepEqual(asMarkdown('markdown', nested), { lang: 'markdown', code: nested })

console.log('codeblock copy: ok')
