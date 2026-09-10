const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { buildSync } = require('esbuild')
const { readInlineAttachment } = require('../electron/copilot-attachments.js')
const { encodeText } = require('../electron/text-encoding.js')
const { promptFor, nothingSent } = require('../electron/prompt.js')

buildSync({ entryPoints: ['src/copilot-context.js'], bundle: true, platform: 'node', format: 'cjs', outfile: 'node_modules/.cache/copilot-context-test.cjs', logLevel: 'error' })
const { captureSavedContext } = require('../node_modules/.cache/copilot-context-test.cjs')

async function run () {
  const snapshot = { note: 'a.md', selection: 'chosen passage' }
  assert.equal(await captureSavedContext(() => snapshot, async () => true, true), snapshot)
  await assert.rejects(captureSavedContext(() => snapshot, async () => false, true), /Could not save/)
  await assert.rejects(captureSavedContext(() => snapshot, async () => { throw new Error('disk full') }, true), /disk full/)
  assert.equal(await captureSavedContext(() => snapshot, () => { throw new Error('unnecessary save') }, false), snapshot)

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-copilot-context-'))
  try {
    for (const encoding of ['utf8', 'utf16le', 'utf16be', 'windows-1252']) {
      const file = path.join(dir, `${encoding}.csv`)
      const text = 'name,amount\ncafé,€10\n'
      await fs.writeFile(file, encodeText(text, { encoding, bom: encoding !== 'windows-1252' }))
      const got = await readInlineAttachment(file, async (p) => p, 4096)
      assert.equal(got.text, text)
    }
    const oversized = path.join(dir, 'large.txt')
    await fs.writeFile(oversized, 'x'.repeat(4097))
    assert.equal(await readInlineAttachment(oversized, async (p) => p, 4096), null)
    const broken = path.join(dir, 'broken.txt')
    await fs.writeFile(broken, Buffer.from([0xff, 0xfe, 0x61]))
    assert.equal(await readInlineAttachment(broken, async (p) => p, 4096), null)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }

  // Apply the model-facing delta to the old document: its location and both
  // sides must be sufficient even when multiple lines contain identical text.
  for (const [before, after] of [
    ['Task A\nStatus: open\nTask B\nStatus: open\n', 'Task A\nStatus: open\nTask B\nStatus: closed\n'],
    ['a\nremove\nz\n', 'a\nz\n'],
    ['\nline', 'line'],
    ['abc', ''],
    ['abc', 'ab'],
    ['x'.repeat(60000), 'x'.repeat(60000) + 'y'],
    ['😀 same\n😀 same\n', '😀 same\n😀 different\n']
  ]) {
    const memo = nothingSent()
    const context = { note: 'sample.md', kind: 'note', excerpt: before, excerptCut: false }
    promptFor('Read', context, memo)
    const message = promptFor('Changed', { ...context, excerpt: after }, memo)
    const match = message.match(/At line (\d+), column (\d+).*\nBefore: (.*)\nAfter: (.*)/)
    assert.ok(match, message)
    const prefix = before.split('\n').slice(0, Number(match[1]) - 1)
    const offset = prefix.reduce((n, line) => n + line.length + 1, 0) + Number(match[2]) - 1
    const old = JSON.parse(match[3])
    const replacement = JSON.parse(match[4])
    assert.equal(before.slice(offset, offset + old.length), old)
    assert.equal(before.slice(0, offset) + replacement + before.slice(offset + old.length), after)
    assert.match(promptFor('Again', { ...context, excerpt: after }, memo), /still current/)
  }
  const table = promptFor('Sum', { note: 'table.csv', kind: 'data', rows: 1000, columns: 2,
    sampleRows: 2, sampleRowNumbers: [9, 3], text: 'x,y\na,1\nb,2', filteredBy: ['"status" excludes ["closed"]'], truncated: true })
  assert.match(table, /2 sampled rows/)
  assert.match(table, /9, 3/)
  assert.match(table, /complete file/)
  assert.match(table, /excludes \["closed"\]/)
  console.log('Copilot context: saved snapshots, attachment encodings, exact note deltas, and table samples passed')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
