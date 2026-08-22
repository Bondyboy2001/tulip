'use strict'

/* The guards on the one thing the run path deletes.
 *
 * A run block's working directory is the vault, and a page a script writes is
 * shown in the output box rather than left in the tree. Deciding which files
 * that applies to is a guess about authorship, and the first version of the
 * guess — "it was not here when the run began" — was wrong in two ways that
 * cost the reader real files: two blocks running at once each claimed the
 * other's page, and an `.html` saved by hand (or landed by a sync client)
 * while a run was in flight was new by the same test and went.
 *
 * So most of what is below is about *not* deleting. A page that cannot be
 * proved to be the run's own is still shown; it is simply left where it is.
 * That is the safe direction to be wrong in, and it is the direction these
 * cases are weighted towards.
 */

const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert')

const { htmlFilesIn, collectRunPages } = require('../electron/run-pages')

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`) } catch (error) {
    failures++
    console.log(`  FAIL ${name} — ${error.message}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const scratch = () => fs.mkdtemp(path.join(os.tmpdir(), 'tulip-run-pages-'))
const there = (dir, name) => fsSync.existsSync(path.join(dir, name))

/** A run over `dir` that writes whatever `during` writes, timed as one would be. */
async function runOver (dir, during, { mayRemove = true } = {}) {
  const before = await htmlFilesIn(dir)
  const from = Date.now()
  await sleep(20)
  await during(dir)
  const to = Date.now()
  return collectRunPages(dir, before, { alive: { from, to }, mayRemove })
}

async function main () {
  await check('a page the run wrote is shown, and stops being a file', async () => {
    const dir = await scratch()
    const pages = await runOver(dir, (at) => fs.writeFile(path.join(at, 'out.html'), '<p>hi</p>'))
    assert.equal(pages.length, 1)
    assert.equal(pages[0].name, 'out.html')
    assert.equal(pages[0].html, '<p>hi</p>')
    assert.equal(there(dir, 'out.html'), false, 'the run\'s own page should have been taken away')
  })

  await check('a page that was already there is shown, but kept', async () => {
    const dir = await scratch()
    await fs.writeFile(path.join(dir, 'keep.html'), 'old')
    const pages = await runOver(dir, (at) => fs.writeFile(path.join(at, 'keep.html'), 'new'))
    assert.equal(pages.length, 1)
    assert.equal(pages[0].html, 'new', 'the reader should see what the run wrote')
    assert.equal(there(dir, 'keep.html'), true, 'a file the reader keeps must survive being written to')
  })

  await check('a page the run never touched is not mentioned at all', async () => {
    const dir = await scratch()
    await fs.writeFile(path.join(dir, 'idle.html'), 'same')
    const pages = await runOver(dir, async () => {})
    assert.equal(pages.length, 0)
    assert.equal(there(dir, 'idle.html'), true)
  })

  await check('a concurrent run may not take anything away', async () => {
    const dir = await scratch()
    const pages = await runOver(
      dir,
      (at) => fs.writeFile(path.join(at, 'other.html'), 'someone else\'s page'),
      { mayRemove: false }
    )
    assert.equal(pages.length, 1, 'still shown')
    assert.equal(there(dir, 'other.html'), true, 'but NOT deleted — it may be the other run\'s')
  })

  await check('a file born before the program started is not the run\'s to take', async () => {
    const dir = await scratch()
    const before = await htmlFilesIn(dir)
    await fs.writeFile(path.join(dir, 'theirs.html'), 'saved by hand')
    await sleep(20)
    // The program only begins now, after the file already existed.
    const from = Date.now()
    const pages = await collectRunPages(dir, before, { alive: { from, to: Date.now() }, mayRemove: true })
    assert.equal(pages.length, 1, 'still shown')
    assert.equal(there(dir, 'theirs.html'), true, 'but NOT deleted')
  })

  await check('a page written to again after it was read is left alone', async () => {
    const dir = await scratch()
    const abs = path.join(dir, 'racy.html')
    const real = fs.readFile
    /* Somebody writes in the gap between the page being read and the decision
       to remove it. Those bytes were never shown to anybody, so they are not
       the run's to throw away. */
    fs.readFile = async (...args) => {
      const text = await real(...args)
      await fs.writeFile(abs, 'second, longer')
      return text
    }
    try {
      await runOver(dir, () => fs.writeFile(abs, 'first'))
    } finally { fs.readFile = real }
    assert.equal(there(dir, 'racy.html'), true, 'the newer bytes must survive')
    assert.equal(await real(abs, 'utf8'), 'second, longer')
  })

  await check('a page written in the last instant of a run is still the run\'s', async () => {
    /* `Date.now()` counts whole milliseconds and `birthtimeMs` does not, so a
       page written as the run ends can report a birth time after the integer
       the window closes on. This ran ten times because the failure it guards
       against only showed up on about half of them. */
    for (let i = 0; i < 10; i++) {
      const dir = await scratch()
      const before = await htmlFilesIn(dir)
      const from = Date.now()
      await fs.writeFile(path.join(dir, 'late.html'), 'just made it')
      const pages = await collectRunPages(dir, before, { alive: { from, to: Date.now() }, mayRemove: true })
      assert.equal(pages.length, 1)
      assert.equal(there(dir, 'late.html'), false, `run ${i}: disowned its own page`)
    }
  })

  await check('only .html at the top level is ever considered', async () => {
    const dir = await scratch()
    await fs.mkdir(path.join(dir, 'deep'))
    const pages = await runOver(dir, async (at) => {
      await fs.writeFile(path.join(at, 'notes.txt'), 'not a page')
      await fs.writeFile(path.join(at, 'deep', 'buried.html'), '<p>too deep</p>')
    })
    assert.equal(pages.length, 0)
    assert.equal(there(dir, 'notes.txt'), true, 'a file that is not a page is never touched')
    assert.equal(fsSync.existsSync(path.join(dir, 'deep', 'buried.html')), true)
  })

  console.log(failures ? `\n${failures} failed` : '\nrun pages: every guard holds')
  process.exit(failures ? 1 : 0)
}

main()
