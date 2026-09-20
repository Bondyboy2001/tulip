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
const cache = () => makeIndexCache({ quietMs: 0, dir, vaultPath: VAULT })

const entry = (name, text, extra = {}) =>
  ({ name, text, mtime: 1000, size: text.length, ...extra })



async function main () {
  await check('a vault with no cache loads as empty rather than failing', async () => {
    assert.equal((await cache().load()).size, 0)
  })

  await check('what was saved comes back', async () => {
    const store = cache()
    store.save(new Map([['a.md', entry('a', 'alpha')], ['b.md', entry('b', 'beta')]]))
    await store.idle()
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
    await store.idle()
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
    const store = makeIndexCache({ quietMs: 0, dir, vaultPath: '/somewhere/Huge' })
    const huge = new Map([['big.md', entry('big', 'x'.repeat(MAX_CACHE_BYTES + 1))]])
    assert.deepEqual(store.save(huge), { skipped: 'too large' })
    await store.idle()
    assert.equal(fs.existsSync(store.path), false)
  })

  await check('refusing a large save leaves an earlier small one intact', async () => {
    const store = makeIndexCache({ quietMs: 0, dir, vaultPath: '/somewhere/Grew' })
    store.save(new Map([['a.md', entry('a', 'small and valid')]]))
    await store.idle()
    store.save(new Map([['a.md', entry('a', 'x'.repeat(MAX_CACHE_BYTES + 1))]]))
    await store.idle()
    const back = await store.load()
    assert.equal(back.get('a.md').text, 'small and valid')
  })

  await check('ride-along fields never reach the disk', async () => {
    /* Search annotates in-memory entries (`kind`, `fileTags`), alias
       resolution memoises `aliases` — bytes the load path would only throw
       away. The save must serialize the four real fields and nothing else. */
    const store = makeIndexCache({ quietMs: 0, dir, vaultPath: '/somewhere/Annotated' })
    store.save(new Map([['a.md', entry('a', 'text', {
      kind: 'note', fileTags: ['x', 'y'], aliases: ['other name']
    })]]))
    await store.idle()
    const raw = JSON.parse(await fsp.readFile(store.path, 'utf8'))
    assert.deepEqual(raw.entries['a.md'], { name: 'a', text: 'text', mtime: 1000, size: 4 })
  })

  await check('an oversized vault drops its largest notes and keeps the rest', async () => {
    const store = makeIndexCache({ quietMs: 0, dir, vaultPath: '/somewhere/Mostly' })
    const result = store.save(new Map([
      ['big.md', entry('big', 'x'.repeat(MAX_CACHE_BYTES + 1))],
      ['a.md', entry('a', 'alpha')],
      ['b.md', entry('b', 'beta')]
    ]))
    assert.ok(result.written, 'the trimmed cache is still written')
    assert.equal(result.dropped, 1)
    await store.idle()
    const back = await store.load()
    assert.deepEqual([...back.keys()].sort(), ['a.md', 'b.md'])
  })

  await check('two vaults do not share a file', async () => {
    const one = makeIndexCache({ quietMs: 0, dir, vaultPath: '/vaults/One' })
    const two = makeIndexCache({ quietMs: 0, dir, vaultPath: '/vaults/Two' })
    assert.notEqual(one.path, two.path)
    one.save(new Map([['a.md', entry('a', 'from one')]]))
    two.save(new Map([['a.md', entry('a', 'from two')]]))
    await Promise.all([one.idle(), two.idle()])
    assert.equal((await one.load()).get('a.md').text, 'from one')
    assert.equal((await two.load()).get('a.md').text, 'from two')
  })

  await check('clearing leaves nothing behind', async () => {
    const store = makeIndexCache({ quietMs: 0, dir, vaultPath: '/vaults/Temporary' })
    store.save(new Map([['a.md', entry('a', 'here')]]))
    await store.idle()
    await store.clear()
    assert.equal((await store.load()).size, 0)
  })

  /* ------------------------------------------------------------ delta */

  /* The sidecar path is what every save since this file's tests were written
     is about: a save that knows which keys moved appends one line each to
     `<cache>.delta` instead of serializing the vault, and the next load
     replays the lines over the main file. */
  await check('a save with a small changed set writes the sidecar, not the vault', async () => {
    const store = makeIndexCache({ quietMs: 0, dir, vaultPath: '/vaults/Delta' })
    const entries = new Map([
      ['a.md', entry('a', 'alpha')], ['b.md', entry('b', 'beta')],
      ['c.md', entry('c', 'gamma')], ['d.md', entry('d', 'delta')]
    ])
    store.save(entries)
    await store.idle()
    assert.equal(fs.existsSync(`${store.path}.delta`), false, 'a full save leaves no sidecar')

    entries.set('a.md', entry('a', 'alpha v2'))
    store.save(entries, new Set(['a.md']))
    await store.idle()
    assert.ok(fs.existsSync(`${store.path}.delta`), 'the changed-keys save appends the sidecar')
    const back = await store.load()
    assert.equal(back.get('a.md').text, 'alpha v2')
    assert.equal(back.get('b.md').text, 'beta')
  })

  await check('a deleted key is a tombstone, replayed as a delete', async () => {
    const store = makeIndexCache({ quietMs: 0, dir, vaultPath: '/vaults/DeltaGone' })
    const entries = new Map([
      ['a.md', entry('a', 'alpha')], ['b.md', entry('b', 'beta')],
      ['c.md', entry('c', 'gamma')], ['d.md', entry('d', 'delta')]
    ])
    store.save(entries)
    await store.idle()
    entries.delete('b.md')
    store.save(entries, new Set(['b.md']))
    await store.idle()
    const back = await store.load()
    assert.equal(back.has('b.md'), false)
    assert.equal(back.size, 3)
  })

  await check('a burst of changed saves merges into one append', async () => {
    const store = makeIndexCache({ quietMs: 30, dir, vaultPath: '/vaults/DeltaBurst' })
    const entries = new Map([
      ['a.md', entry('a', 'alpha')], ['b.md', entry('b', 'beta')],
      ['c.md', entry('c', 'gamma')], ['d.md', entry('d', 'delta')]
    ])
    store.save(entries)
    await store.idle()
    entries.set('a.md', entry('a', 'a2'))
    store.save(entries, new Set(['a.md']))
    entries.set('b.md', entry('b', 'b2'))
    store.save(entries, new Set(['b.md']))
    await store.idle()
    const lines = (await fsp.readFile(`${store.path}.delta`, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 2, 'both changed keys land as lines')
    const back = await store.load()
    assert.equal(back.get('a.md').text, 'a2')
    assert.equal(back.get('b.md').text, 'b2')
  })

  await check('a change set naming most of the vault takes the full write', async () => {
    const store = makeIndexCache({ quietMs: 0, dir, vaultPath: '/vaults/DeltaWide' })
    const entries = new Map([
      ['a.md', entry('a', 'alpha')], ['b.md', entry('b', 'beta')]
    ])
    store.save(entries)
    await store.idle()
    entries.set('a.md', entry('a', 'a2'))
    entries.set('b.md', entry('b', 'b2'))
    store.save(entries, new Set(['a.md', 'b.md']))
    await store.idle()
    assert.equal(fs.existsSync(`${store.path}.delta`), false,
      'half the vault changing is a serialize, not a journal')
    assert.equal((await store.load()).get('b.md').text, 'b2')
  })

  await check('a sidecar past its budget compacts into the next full write', async () => {
    /* Each line here is ~63 bytes, so a 100-byte budget lets two appends land
       and puts the third over — compaction, not the per-entry guard. */
    const store = makeIndexCache({ quietMs: 0, dir, vaultPath: '/vaults/DeltaFull', deltaMaxBytes: 100 })
    const entries = new Map([
      ['a.md', entry('a', 'alpha')], ['b.md', entry('b', 'beta')],
      ['c.md', entry('c', 'gamma')], ['d.md', entry('d', 'delta')]
    ])
    store.save(entries)
    await store.idle()
    entries.set('a.md', entry('a', 'a2'))
    store.save(entries, new Set(['a.md']))
    await store.idle()
    entries.set('b.md', entry('b', 'b2'))
    store.save(entries, new Set(['b.md']))
    await store.idle()
    assert.ok(fs.existsSync(`${store.path}.delta`), 'small changes still append')
    entries.set('c.md', entry('c', 'c2'))
    store.save(entries, new Set(['c.md']))
    await store.idle()
    assert.equal(fs.existsSync(`${store.path}.delta`), false,
      'the oversized sidecar is folded into a full write')
    const back = await store.load()
    assert.equal(back.get('a.md').text, 'a2')
    assert.equal(back.get('b.md').text, 'b2')
    assert.equal(back.get('c.md').text, 'c2')
  })

  await check('a torn last line of the sidecar costs only itself', async () => {
    const store = makeIndexCache({ quietMs: 0, dir, vaultPath: '/vaults/DeltaTorn' })
    const entries = new Map([
      ['a.md', entry('a', 'alpha')], ['b.md', entry('b', 'beta')],
      ['c.md', entry('c', 'gamma')], ['d.md', entry('d', 'delta')]
    ])
    store.save(entries)
    await store.idle()
    /* A crash mid-append leaves a partial JSON line. The lines before it —
       and the main file under them — still answer. */
    await fsp.writeFile(`${store.path}.delta`,
      JSON.stringify(['a.md', entry('a', 'a2')]) + '\n' + '["b.md", {"name": "b", "tex')
    const back = await store.load()
    assert.equal(back.get('a.md').text, 'a2')
    assert.equal(back.get('b.md').text, 'beta')
  })

  await check('a delta save of nothing writes nothing', async () => {
    const store = makeIndexCache({ quietMs: 0, dir, vaultPath: '/vaults/DeltaEmpty' })
    const entries = new Map([['a.md', entry('a', 'alpha')]])
    store.save(entries)
    await store.idle()
    const before = fs.statSync(store.path).mtimeMs
    const result = store.save(entries, new Set())
    await store.idle()
    assert.deepEqual(result, { written: 0 })
    assert.equal(fs.statSync(store.path).mtimeMs, before, 'no flush was scheduled')
  })

  await check('clearing removes the sidecar too', async () => {
    const store = makeIndexCache({ quietMs: 0, dir, vaultPath: '/vaults/DeltaClear' })
    const entries = new Map([
      ['a.md', entry('a', 'alpha')], ['b.md', entry('b', 'beta')],
      ['c.md', entry('c', 'gamma')], ['d.md', entry('d', 'delta')]
    ])
    store.save(entries)
    await store.idle()
    entries.set('a.md', entry('a', 'a2'))
    store.save(entries, new Set(['a.md']))
    await store.idle()
    assert.ok(fs.existsSync(`${store.path}.delta`))
    await store.clear()
    assert.equal(fs.existsSync(store.path), false)
    assert.equal(fs.existsSync(`${store.path}.delta`), false)
  })

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ''}`)
  if (failed) process.exit(1)
}

main()
