'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { makeCoalescedWriter } = require('../electron/atomic-store')
const { makeStore: makeReviewStore } = require('../electron/review-store')
const { TrustStore } = require('../electron/trust-store')
const { makeStore: makeLanguageStore, matchRows } = require('../electron/language-history-store')
const { classifyVaultEvent } = require('../electron/vault-events')
const { parseByteRange, streamFileRange } = require('../electron/range-response')

const table = (word, meaning) => `| Word | English |\n| --- | --- |\n| ${word} | ${meaning} |\n`

async function atomicStores () {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-stores-'))
  try {
    const direct = makeCoalescedWriter()
    const directFile = path.join(root, 'direct.json')
    const state = { notes: {} }
    const writes = []
    for (let index = 0; index < 50; index++) {
      state.notes[index] = index
      writes.push(direct.flush(directFile, () => JSON.stringify(state)))
    }
    const settled = await Promise.allSettled(writes)
    assert.equal(settled.filter((row) => row.status === 'fulfilled').length, 50)
    assert.equal(Object.keys(JSON.parse(await fs.readFile(directFile, 'utf8')).notes).length, 50)

    const reviewVault = path.join(root, 'review-vault')
    const review = makeReviewStore({ vault: () => reviewVault })
    await Promise.all(Array.from({ length: 50 }, (_, index) => review.record([{
      id: `Words.md|term-${index}|f`, at: index + 1, grade: 3,
      state: { due: index + 100, stability: 1, difficulty: 1 }
    }])))
    assert.equal(Object.keys(await review.all()).length, 50)

    const languageVault = path.join(root, 'language-vault')
    const language = makeLanguageStore({ vault: () => languageVault })
    await Promise.all(Array.from({ length: 50 }, (_, index) =>
      language.sync(`Language/${index}.language.md`, table(`word-${index}`, `meaning-${index}`))))
    const languageState = JSON.parse(await fs.readFile(
      path.join(languageVault, '.tulip', 'language-history.json'), 'utf8'))
    assert.equal(Object.keys(languageState.notes).length, 50)

    const trustBase = path.join(root, 'app-state')
    const trust = new TrustStore(trustBase)
    trust.setVault(path.join(root, 'trust-vault'))
    for (let index = 0; index < 50; index++) {
      trust.record({
        source: 'save',
        changes: [{ path: `${index}.md`, before: '', after: String(index) }]
      })
    }
    await Promise.all(Array.from({ length: 50 }, () => trust.flush()))
    const trustState = JSON.parse(await fs.readFile(trust.file(), 'utf8'))
    assert.equal(trustState.operations.length, 50)

    const files = []
    const walk = async (dir) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(abs)
        else files.push(abs)
      }
    }
    await walk(root)
    assert.deepEqual(files.filter((file) => file.endsWith('.tmp')), [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

function naiveMatch (current, previous) {
  const used = new Set()
  const matched = new Array(current.length).fill(null)
  const claim = (test) => current.forEach((row, at) => {
    if (matched[at]) return
    const found = previous.findIndex((record, index) => !used.has(index) && test(row, record))
    if (found < 0) return
    used.add(found)
    matched[at] = previous[found]
  })
  const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || [])
  claim((row, record) => same(row.cells, record.cells))
  claim((row, record) => row.cells[0] === record.cells?.[0])
  claim((row, record) => row.cells[1] === record.cells?.[1])
  const looseCurrent = current.map((_, index) => index).filter((index) => !matched[index])
  const loosePrevious = previous.map((_, index) => index).filter((index) => !used.has(index))
  if (looseCurrent.length === loosePrevious.length) {
    looseCurrent.forEach((at, index) => { matched[at] = previous[loosePrevious[index]] })
  }
  return matched
}

function indexedRows () {
  let seed = 0x5eed1234
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0x100000000
  }
  const pick = (list) => list[Math.floor(random() * list.length)]
  const words = ['one', 'two', 'two', 'three', 'four', 'five']
  const meanings = ['uno', 'dos', 'dos', 'tres', 'cuatro', 'cinco']

  for (let run = 0; run < 1000; run++) {
    const previous = Array.from({ length: Math.floor(random() * 40) }, (_, index) => ({
      id: `id-${run}-${index}`,
      cells: [pick(words), pick(meanings)]
    }))
    const current = previous
      .filter(() => random() > 0.2)
      .map((row, index) => ({
        row: index,
        cells: [random() < 0.15 ? pick(words) : row.cells[0], random() < 0.15 ? pick(meanings) : row.cells[1]]
      }))
      .sort(() => random() - 0.5)
    if (random() < 0.5) current.push({ row: current.length, cells: [pick(words), pick(meanings)] })

    const expected = naiveMatch(current, previous).map((row) => row?.id || null)
    const actual = matchRows(current, previous).map((row) => row?.id || null)
    assert.deepEqual(actual, expected)
  }
}

function vaultEvents () {
  const options = {
    ignoredDirs: new Set(['.git', '.obsidian', '.tulip', 'node_modules', '.trash']),
    attachmentDirs: new Set(['.attachments', '.images']),
    noteExtensions: new Set(['.md', '.markdown']),
    pdfExtension: '.pdf',
    siteExtension: '.website',
    assetExtensions: new Set(['.png', '.jpg', '.mp4'])
  }
  assert.equal(classifyVaultEvent('.git/index', options).ignore, true)
  assert.equal(classifyVaultEvent('.tulip/review.json', options).ignore, true)
  assert.deepEqual(
    classifyVaultEvent('Notes/Changed.md', options),
    { ignore: false, index: true, snapshot: true, notify: true, pdf: null, path: 'Notes/Changed.md' }
  )
  assert.equal(classifyVaultEvent('Papers/book.pdf', options).pdf, 'Papers/book.pdf')
  assert.equal(classifyVaultEvent('.attachments/Note/image.png', options).index, false)
  assert.equal(classifyVaultEvent('Renamed folder', options).pdf, 'sweep')
  assert.equal(classifyVaultEvent(null, options).snapshot, true)
}

async function rangeStreaming () {
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19 })
  assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseByteRange('bytes=10-', 100), { start: 10, end: 99 })
  assert.equal(parseByteRange('bytes=100-101', 100), null)
  assert.deepEqual(parseByteRange('bytes=0-', 20 * 1024 * 1024), {
    start: 0, end: 8 * 1024 * 1024 - 1
  })

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-range-'))
  try {
    const file = path.join(root, 'bytes.bin')
    const source = Buffer.alloc(512 * 1024)
    for (let index = 0; index < source.length; index++) source[index] = index % 251
    await fs.writeFile(file, source)
    const reader = streamFileRange(file, 1234, 400000).getReader()
    const chunks = []
    let largest = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      largest = Math.max(largest, value.byteLength)
      chunks.push(Buffer.from(value))
    }
    assert.equal(largest <= 64 * 1024, true)
    assert.deepEqual(Buffer.concat(chunks), source.subarray(1234, 400001))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

;(async () => {
  await atomicStores()
  indexedRows()
  vaultEvents()
  await rangeStreaming()
  console.log('optimizations: all checks passed')
})().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
