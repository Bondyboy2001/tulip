import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

/* The two modules are browser code. This deliberately small DOM is enough to
   exercise their real token and streaming paths after esbuild bundles them for
   Node; no duplicate implementation is benchmarked. */
class FakeNode {
  constructor (tag = '') {
    this.tag = tag
    this.children = []
    this.className = ''
    this._text = ''
    this.isConnected = true
  }
  append (...nodes) { this.children.push(...nodes) }
  replaceChildren (...nodes) { this.children = nodes }
  set textContent (text) { this._text = String(text); this.children = [] }
  get textContent () {
    return this._text + this.children.map((child) => child.textContent).join('')
  }
}

globalThis.document = {
  documentElement: { style: {} },
  createDocumentFragment: () => new FakeNode('fragment'),
  createTextNode: (text) => Object.assign(new FakeNode('#text'), { textContent: text }),
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag)
}
globalThis.window = { tulip: { on () {}, run: { start () {}, kill () {}, warm () {} } } }
globalThis.requestAnimationFrame = (callback) => { callback(); return 1 }
globalThis.Element = FakeNode

const {
  clearHighlightCache, highlightCacheStats, highlightInto
} = await import('../src/highlight.js')
const { stripAnsiChunk } = await import('../src/runcode.js')

const decoder = { mode: 'text', pending: '' }
const split = [
  'plain \x1b[3', '1mred', '\x1b[0', 'm done ',
  '\x1b]0;window title', '\x1b', '\\tail'
]
const stripped = split.map((chunk) => stripAnsiChunk(decoder, chunk)).join('') +
  stripAnsiChunk(decoder, '', true)
assert.equal(stripped, 'plain red done tail')

const source = Array.from({ length: 1800 }, (_, index) =>
  `const value${index} = ${index} * 2 // highlighted line ${index}`
).join('\n')
assert.ok(source.length < 120_000)

/* Load the JavaScript language pack before timing so the benchmark measures
   parsing/token production, not module I/O. */
assert.equal(await highlightInto(new FakeNode('code'), 'const warm = true', 'js'), true)
clearHighlightCache()

const fresh = new FakeNode('code')
assert.equal(await highlightInto(fresh, source, 'js'), true)
assert.equal(fresh.textContent, source)
assert.equal(highlightCacheStats().entries, 1)
const cached = new FakeNode('code')
assert.equal(await highlightInto(cached, source, 'js'), true)
assert.equal(cached.textContent, source)
assert.equal(highlightCacheStats().entries, 1)

const time = async (work, runs) => {
  const values = []
  for (let index = 0; index < runs; index++) {
    const started = performance.now()
    await work()
    values.push(performance.now() - started)
  }
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)]
}

const uncachedMs = await time(async () => {
  clearHighlightCache()
  await highlightInto(new FakeNode('code'), source, 'js')
}, 9)
clearHighlightCache()
await highlightInto(new FakeNode('code'), source, 'js')
const cachedMs = await time(
  () => highlightInto(new FakeNode('code'), source, 'js'),
  9
)

 
// The same terminal escapes src/runcode.js strips, reproduced here so the
// benchmark measures the real pattern.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-9;?]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g
const chunks = Array.from({ length: 1024 }, (_, index) =>
  `\x1b[3${index % 8}m${String(index).padStart(4, '0')} ${'output '.repeat(4)}\x1b[0m\n`
)

const oldPass = () => {
  const started = performance.now()
  let raw = ''
  let visible = ''
  let domCharacters = 0
  for (const chunk of chunks) {
    raw += chunk
    visible = raw.replace(ANSI, '')
    domCharacters += visible.length
  }
  return { ms: performance.now() - started, visible, domCharacters }
}

const newPass = () => {
  const started = performance.now()
  const stream = { mode: 'text', pending: '' }
  let visible = ''
  let domCharacters = 0
  for (const chunk of chunks) {
    const suffix = stripAnsiChunk(stream, chunk)
    visible += suffix
    domCharacters += suffix.length
  }
  visible += stripAnsiChunk(stream, '', true)
  return { ms: performance.now() - started, visible, domCharacters }
}

const medianPass = (pass) => {
  const runs = Array.from({ length: 9 }, pass).sort((a, b) => a.ms - b.ms)
  return runs[Math.floor(runs.length / 2)]
}

const oldOutput = medianPass(oldPass)
const newOutput = medianPass(newPass)
const oldOutputMs = oldOutput.ms
const newOutputMs = newOutput.ms
const oldVisible = oldOutput.visible
const newVisible = newOutput.visible
const oldDomCharacters = oldOutput.domCharacters
const newDomCharacters = newOutput.domCharacters
assert.equal(newVisible, oldVisible)
assert.equal(newDomCharacters, newVisible.length)

const result = {
  highlight: {
    sourceCharacters: source.length,
    uncachedMedianMs: Number(uncachedMs.toFixed(2)),
    cachedMedianMs: Number(cachedMs.toFixed(2)),
    speedup: Number((uncachedMs / cachedMs).toFixed(1))
  },
  streamingOutput: {
    chunks: chunks.length,
    visibleCharacters: newVisible.length,
    oldMedianStyleMs: Number(oldOutputMs.toFixed(2)),
    incrementalMs: Number(newOutputMs.toFixed(2)),
    cpuSpeedup: Number((oldOutputMs / newOutputMs).toFixed(1)),
    oldDomCharacters,
    incrementalDomCharacters: newDomCharacters,
    domWorkReduction: Number((oldDomCharacters / newDomCharacters).toFixed(1))
  }
}

assert.ok(result.highlight.speedup > 1.5)
assert.ok(result.streamingOutput.domWorkReduction > 100)

/* The speedup must stay bounded: revisiting many different large blocks may
   evict old token runs, but may not turn the cache into a second vault. */
clearHighlightCache()
for (let index = 0; index < 8; index++) {
  await highlightInto(new FakeNode('code'), `${source}\n// variant ${index}`, 'js')
}
assert.ok(highlightCacheStats().bytes <= 2 * 1024 * 1024)
assert.ok(highlightCacheStats().entries < 8)
console.log(JSON.stringify(result, null, 2))
