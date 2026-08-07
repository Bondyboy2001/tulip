'use strict'

/* Tests for electron/index-cache.js.
 *
 * Worth testing directly for the reason review-store is: the failure is silent.
 * A cache that hands back an entry it should have rejected is a note whose text
 * search looks in but which no longer says that — a result list that is missing
 * something and still looks complete. Every rejection path below is a case
 * where returning nothing is the only safe answer, and none of them is visible
 * from the app.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { makeIndexCache, MAX_CACHE_BYTES } = require('../electron/index-cache')

let passed = 0
let failed = 0
const check = async (what, run) => {
  try { await run(); console.log(`ok - ${what}`); passed++ } catch (error) {
    console.log(`not ok - ${what}\n  ${error.message}`); failed++
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tulip-index-cache-'))
const VAULT = '/somewhere/Vault'
const cache = () => makeIndexCache({ dir, vaultPath: VAULT })

const entry = (name, text, extra = {}) =>
  ({ name, text, mtime: 1000, size: text.length, ...extra })

/* The coalescing writer settles on a later tick, so a save has to be waited
   for before the file it wrote can be read back. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 60))

async function main () {
  await check('a vault with no cache loads as empty rather than failing', async () => {
    assert.equal((await cache().load()).size, 0)
  })

  await check('what was saved comes back', async () => {
    const store = cache()
    store.save(new Map([['a.md', entry('a', 'alpha')], ['b.md', entry('b', 'beta')]]))
    await settled()
    const back = await store.load()
    assert.equal(back.size, 2)
    assert.equal(back.get('a.md').text, 'alpha')
    assert.equal(back.get('b.md').name, 'b')
    assert.equal(back.get('a.md').mtime, 1000)
    assert.equal(back.get('a.md').size, 5)
  })

  await check('a later save replaces the one before it', async () => {
    const store = cache()
    store.save(new Map([['a.md', entry('a', 'rewritten')]]))
    await settled()
    const back = await store.load()
    assert.equal(back.size, 1)
    assert.equal(back.get('a.md').text, 'rewritten')
  })

  await check('a corrupt file is no cache, not a crash', async () => {
    const store = cache()
    await fsp.writeFile(store.path, '{ this is not json')
    assert.equal((await store.load()).size, 0)
  })

  await check('a cache written for another vault is not read', async () => {
    const store = cache()
    await fsp.writeFile(store.path, JSON.stringify({
      version: 2, vaultPath: '/somewhere/Else', at: Date.now(),
      entries: { 'a.md': entry('a', 'someone else\'s note') }
    }))
    assert.equal((await store.load()).size, 0)
  })

  await check('a cache from an older shape is dropped whole', async () => {
    const store = cache()
    await fsp.writeFile(store.path, JSON.stringify({
      version: 1, vaultPath: VAULT, entries: { 'a.md': entry('a', 'old') }
    }))
    assert.equal((await store.load()).size, 0)
  })

  await check('a mangled entry is skipped and its neighbours are not', async () => {
    const store = cache()
    await fsp.writeFile(store.path, JSON.stringify({
      version: 2,
      vaultPath: VAULT,
      entries: {
        'good.md': entry('good', 'kept'),
        'no-text.md': { name: 'x', mtime: 1, size: 1 },
        'text-not-a-string.md': { name: 'x', text: 42, mtime: 1, size: 1 },
        'no-stat.md': { name: 'x', text: 'y' },
        'stat-not-a-number.md': { name: 'x', text: 'y', mtime: '1', size: 1 }
      }
    }))
    const back = await store.load()
    assert.deepEqual([...back.keys()], ['good.md'])
  })

  await check('entries that are not an object at all are no cache', async () => {
    const store = cache()
    await fsp.writeFile(store.path, JSON.stringify({
      version: 2, vaultPath: VAULT, entries: 'nope'
    }))
    assert.equal((await store.load()).size, 0)
  })

  await check('a vault too large to cache is refused, and says so', async () => {
    const store = makeIndexCache({ dir, vaultPath: '/somewhere/Huge' })
    const huge = new Map([['big.md', entry('big', 'x'.repeat(MAX_CACHE_BYTES + 1))]])
    assert.deepEqual(store.save(huge), { skipped: 'too large' })
    await settled()
    assert.equal(fs.existsSync(store.path), false)
  })

  await check('refusing a large save leaves an earlier small one intact', async () => {
    const store = makeIndexCache({ dir, vaultPath: '/somewhere/Grew' })
    store.save(new Map([['a.md', entry('a', 'small and valid')]]))
    await settled()
    store.save(new Map([['a.md', entry('a', 'x'.repeat(MAX_CACHE_BYTES + 1))]]))
    await settled()
    const back = await store.load()
    assert.equal(back.get('a.md').text, 'small and valid')
  })

  await check('ride-along fields never reach the disk', async () => {
    /* Search annotates in-memory entries (`kind`, `fileTags`), alias
       resolution memoises `aliases` — bytes the load path would only throw
       away. The save must serialize the four real fields and nothing else. */
    const store = makeIndexCache({ dir, vaultPath: '/somewhere/Annotated' })
    store.save(new Map([['a.md', entry('a', 'text', {
      kind: 'note', fileTags: ['x', 'y'], aliases: ['other name']
    })]]))
    await settled()
    const raw = JSON.parse(await fsp.readFile(store.path, 'utf8'))
    assert.deepEqual(raw.entries['a.md'], { name: 'a', text: 'text', mtime: 1000, size: 4 })
  })

  await check('an oversized vault drops its largest notes and keeps the rest', async () => {
    const store = makeIndexCache({ dir, vaultPath: '/somewhere/Mostly' })
    const result = store.save(new Map([
      ['big.md', entry('big', 'x'.repeat(MAX_CACHE_BYTES + 1))],
      ['a.md', entry('a', 'alpha')],
      ['b.md', entry('b', 'beta')]
    ]))
    assert.ok(result.written, 'the trimmed cache is still written')
    assert.equal(result.dropped, 1)
    await settled()
    const back = await store.load()
    assert.deepEqual([...back.keys()].sort(), ['a.md', 'b.md'])
  })

  await check('two vaults do not share a file', async () => {
    const one = makeIndexCache({ dir, vaultPath: '/vaults/One' })
    const two = makeIndexCache({ dir, vaultPath: '/vaults/Two' })
    assert.notEqual(one.path, two.path)
    one.save(new Map([['a.md', entry('a', 'from one')]]))
    two.save(new Map([['a.md', entry('a', 'from two')]]))
    await settled()
    assert.equal((await one.load()).get('a.md').text, 'from one')
    assert.equal((await two.load()).get('a.md').text, 'from two')
  })

  await check('clearing leaves nothing behind', async () => {
    const store = makeIndexCache({ dir, vaultPath: '/vaults/Temporary' })
    store.save(new Map([['a.md', entry('a', 'here')]]))
    await settled()
    await store.clear()
    assert.equal((await store.load()).size, 0)
  })

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ''}`)
  if (failed) process.exit(1)
}

main()
