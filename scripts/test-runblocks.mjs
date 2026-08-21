/* ====================================================== run all / clear all
   The two note-wide commands over src/runcode.js: running every block in a
   note one at a time, and throwing away what they printed.

   Both are about *ordering and shared state* rather than about a process, so
   the main process is a stub here: what is asserted is that the second block
   is not started until the first has reported back, that the sweep survives a
   block that fails and stops for one that was stopped by hand, and that a
   cleared panel is empty rather than merely re-labelled.
   ================================================================== */

import assert from 'node:assert/strict'

/* A DOM small enough to read and large enough for an output panel: the class
   list, the two attributes drawOutput sets, and the one selector
   incrementalOutput looks itself up with. */
class FakeNode {
  constructor (tag = '') {
    this.tag = tag
    this.children = []
    this._class = new Set()
    this.dataset = {}
    this.hidden = false
    this.isConnected = true
    this.attributes = {}
    this._text = ''
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

  set textContent (text) { this._text = String(text); this.children = [] }
  get textContent () {
    return this._text + this.children.map((child) => child.textContent).join('')
  }

  setAttribute (name, value) { this.attributes[name] = String(value) }
  append (...nodes) { this.children.push(...nodes) }
  replaceChildren (...nodes) { this.children = nodes }
  insertBefore (node, before) {
    const at = before ? this.children.indexOf(before) : -1
    if (at === -1) this.children.push(node); else this.children.splice(at, 0, node)
    return node
  }

  /* Only the two forms this code asks for: a class, and a class with one
     `:not(.other)` after it. Anything else is a selector the test has not been
     taught, and saying so beats answering it wrongly. */
  querySelectorAll (selector) {
    const match = /^\.([\w-]+)(?::not\(\.([\w-]+)\))?$/.exec(selector)
    assert.ok(match, `the fake DOM was asked for an unknown selector: ${selector}`)
    const [, wanted, excluded] = match
    const found = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child._class?.has(wanted) && !(excluded && child._class.has(excluded))) {
          found.push(child)
        }
        walk(child)
      }
    }
    walk(this)
    return found
  }
}

globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => Object.assign(new FakeNode('#text'), { textContent: text })
}
globalThis.Element = FakeNode
globalThis.requestAnimationFrame = (callback) => { callback(); return 1 }

/* The main process, as far as the renderer can tell: every start is answered,
   and nothing finishes until this test says so. */
const started = []
const listeners = new Map()
let nextId = 1

const startRun = (lang, code) => {
  const id = nextId++
  started.push({ id, lang, code })
  return Promise.resolve({ id })
}

const tulip = {
  on: (channel, handler) => listeners.set(channel, handler),
  run: {
    start: startRun,
    kill: () => Promise.resolve(),
    warm: () => Promise.resolve()
  }
}

globalThis.window = { tulip }

const emit = (channel, payload) => listeners.get(channel)(payload)
const settle = (id, done = {}) => emit('run:done', { id, code: 0, ms: 5, ...done })
/* One turn of the microtask queue: the sweep awaits its own promises between
   the reply and the next start, and this is how the test gets to look in
   between. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const { clearBlockOutputs, isRunnable, runBlocksInOrder, runPanelUI } =
  await import('../src/runcode.js')

assert.equal(isRunnable('py'), true)
assert.equal(isRunnable('PYTHON'), true)
assert.equal(isRunnable('mermaid'), false)

/* ------------------------------------------------- one block at a time */

const three = [
  { lang: 'py', code: 'print(1)' },
  { lang: 'py', code: 'print(2)' },
  { lang: 'py', code: 'print(3)' }
]

const sweep = runBlocksInOrder(three)
await tick()
assert.equal(started.length, 1, 'the sweep starts one block and waits')

settle(1)
await tick()
assert.equal(started.length, 2, 'the next block starts when the first is done')
assert.equal(started[1].code, 'print(2)')

settle(2)
await tick()
settle(3)
assert.deepEqual(await sweep, { ran: 3, failed: 0, stopped: false })

/* -------------------------------------------- a failure is not the end */

const failing = [
  { lang: 'py', code: 'raise SystemExit(1)' },
  { lang: 'py', code: 'print("after")' }
]
const afterFailure = runBlocksInOrder(failing)
await tick()
settle(4, { code: 1 })
await tick()
assert.equal(started.length, 5, 'a block that exits non-zero does not end the sweep')
settle(5)
assert.deepEqual(await afterFailure, { ran: 2, failed: 1, stopped: false })

/* --------------------------------------- but a block stopped by hand is */

const stopping = [
  { lang: 'py', code: 'while True: pass' },
  { lang: 'py', code: 'print("never")' }
]
const stopped = runBlocksInOrder(stopping)
await tick()
settle(6, { code: null, signal: 'SIGTERM' })
assert.deepEqual(await stopped, { ran: 1, failed: 0, stopped: true })
await tick()
assert.equal(started.length, 6, 'nothing was started after the stop')

/* ------------------------------- a refused start settles like any other */

const refuse = { lang: 'py', code: 'print("refused")' }
tulip.run.start = () => Promise.reject(new Error("Error: python isn't installed"))
assert.deepEqual(await runBlocksInOrder([refuse]), { ran: 1, failed: 1, stopped: false })
tulip.run.start = startRun

/* ------------------------------------------------------------ clearing */

/* A panel over the first block, drawing from the same state the sweep ran —
   which is the whole point of the key: the run and the panel find each other
   through it. */
const panel = runPanelUI('py', 'print(1)', 'tk-run')
emit('run:out', { id: 1, stream: 'stdout', text: 'hello\n' })
assert.equal(panel.hidden, false)
assert.ok(panel.textContent.includes('exit 0'))

assert.deepEqual(clearBlockOutputs([{ lang: 'py', code: 'print(1)' }]), { cleared: 1, running: 0 })
assert.equal(panel.hidden, true, 'a cleared panel is closed, not relabelled')
assert.equal(panel.textContent, '', 'and holds nothing the last run printed')

// Idle already: nothing to clear, and nothing said about it.
assert.deepEqual(clearBlockOutputs([{ lang: 'py', code: 'print(1)' }]), { cleared: 0, running: 0 })
// A block nobody has ever run has no state at all, which is the same answer.
assert.deepEqual(clearBlockOutputs([{ lang: 'py', code: 'print("new")' }]), { cleared: 0, running: 0 })

/* A running block keeps its panel: it is about to fill again, and the caller
   is told so rather than the output disappearing from under a live run. */
const busy = [{ lang: 'py', code: 'print("slow")' }]
const going = runBlocksInOrder(busy)
await tick()
assert.deepEqual(clearBlockOutputs(busy), { cleared: 0, running: 1 })
settle(started[started.length - 1].id)
await going
assert.deepEqual(clearBlockOutputs(busy), { cleared: 1, running: 0 })

/* ---------------------------- a cleared block still runs, into its panel */

const stale = { lang: 'py', code: 'print(1)' }
const again = runBlocksInOrder([stale])
await tick()
const rerun = started[started.length - 1]
assert.equal(rerun.code, 'print(1)', 'clearing did not lose the block')
settle(rerun.id)
assert.deepEqual(await again, { ran: 1, failed: 0, stopped: false })
assert.equal(panel.hidden, false, 'the old panel is drawing the new run')

console.log('runblocks: ok')
