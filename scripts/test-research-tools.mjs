import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { startSearchServer } from '../electron/copilot-search-server.js'
const scratch = await mkdtemp(path.join(os.tmpdir(), 'tulip-research-'))
try {
  const outfile = path.join(scratch, 'review.mjs')
  await build({ entryPoints: ['src/change-review.js'], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
  /* A Windows path is not a URL: `import('D:\\…')` is refused as an unknown
     scheme, so the bundle is imported by its file: URL on every platform. */
  const { changeSections, combineSections } = await import(pathToFileURL(outfile).href)
  for (const [before, after] of [['', 'hi'], ['hi', ''], ['x\n', 'x'], ['x', 'x\n'], ['a\nb\na', 'b\na\nb'], ['a\nb', 'a\nnew\nb']]) {
    const sections = changeSections(before, after)
    assert.equal(combineSections(before, sections, new Set(sections.map((_, i) => i))), after)
    assert.equal(combineSections(before, sections, new Set()), before)
  }
  const before = 'a\nb\nc\nd'
  const sections = changeSections(before, 'a\nB\nc\nD')
  assert.equal(combineSections(before, sections, new Set([1])), 'a\nb\nc\nD')
  // Repeated lines, empty lines and final newline differences exercise diff boundaries.
  let seed = 12345
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  for (let i = 0; i < 200; i++) {
    const a = Array.from({ length: 30 }, () => ['x', '', 'same', 'z'][Math.floor(random() * 4)]).join('\n')
    const lines = a.split('\n'); lines.splice(Math.floor(random() * 30), Math.floor(random() * 5), 'new', 'replacement')
    const b = lines.join('\n'); const changes = changeSections(a, b)
    assert.equal(combineSections(a, changes, new Set(changes.map((_, at) => at))), b)
  }
  console.log('selective changes: exact reconstruction, mixed choices and 200 repeated-line edits passed')
  const storeFile = path.join(scratch, 'store.mjs')
  await build({ entryPoints: ['src/copilot-store.js'], bundle: true, platform: 'node', format: 'esm', outfile: storeFile, logLevel: 'error' })
  const { createStore } = await import(pathToFileURL(storeFile).href)
  const store = createStore({ persist: async () => {}, keepKey: () => 'A.md', entryBusy: () => false })
  store.ingest({ 'A.md': { convos: [{ id: 'interrupted', interrupted: true, contextOptions: { pins: ['B.md'] }, messages: [{ t: 'you', text: 'Revise this' }, { t: 'bot', text: 'Partial answer', live: true, bookmarked: true }] }] } })
  const recovered = store.entry('A.md').convos.find((convo) => convo.id === 'interrupted')
  assert.equal(recovered.messages.at(-1).resume, true)
  assert.equal(recovered.messages[1].live, false)
  assert.equal(recovered.messages[1].bookmarked, true)
  assert.deepEqual(recovered.contextOptions.pins, ['B.md'])
  console.log('interrupted conversations: resume action, bookmarks and pinned context survive restore')
  const requests = []
  const server = await startSearchServer(async (query) => { requests.push(query); return { results: [{ path: 'Paper.pdf', page: 3 }], truncated: false } })
  try {
    const call = async (method, params = {}) => (await fetch(server.config.url, { method: 'POST', headers: { ...server.config.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
    assert.equal((await fetch(server.config.url, { method: 'POST' })).status, 403)
    assert.equal((await call('initialize')).result.serverInfo.name, 'tulip')
    const list = (await call('tools/list')).result.tools
    assert.deepEqual(list.map((tool) => tool.name), ['search'])
    assert.equal(list[0].annotations.readOnlyHint, true)
    const result = await call('tools/call', { name: 'search', arguments: { query: 'proof type:pdf' } })
    assert.match(result.result.content[0].text, /Paper.pdf/)
    assert.deepEqual(requests, ['proof type:pdf'])
    assert.equal((await call('tools/call', { name: 'write', arguments: {} })).error.code, -32601)
    console.log('read-only search: MCP discovery, authenticated calls, ranked results and unsupported writes passed')
  } finally { server.close() }
} finally { await rm(scratch, { recursive: true, force: true }) }
