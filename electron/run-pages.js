'use strict'

/* Which files a run block wrote, and which of them it may take away again.

   Its own module because it is the one part of the run path that *deletes*
   from the reader's vault, and a guess it gets wrong is a file that is gone.
   Out here it can be tested against a real directory without an Electron app
   around it — see scripts/test-run-pages.cjs, which is the point of the split.

   Nothing here reads the index, the config or Electron; `main.js` is the only
   caller. */

const fs = require('node:fs/promises')
const path = require('node:path')
const { mapLimit, WALK_LIMIT } = require('./map-limit')

/* A page a run wrote, shown rather than filed.

   A script that ends in `write("out.html", …); open("out.html")` is saying
   "look at this", and in a terminal that is what happens. Here the output box
   is the terminal, so the page goes into it — and a page the run invented,
   rather than one the reader keeps, does not stay in the vault where it would
   sit in the tree as a document nobody meant to save. Only the top level of the
   working directory is looked at, and only `.html` files. */
const RUN_PAGE_LIMIT = 4 * 1024 * 1024

/**
 * The `.html` files at the top of `dir`, each with what "unchanged since" means
 * for it: mtime, size, and when it came into being.
 *
 * `withFileTypes` answers `isFile()` without a stat, so only the handful of
 * `.html` entries are ever stat'd — and those go through `mapLimit` rather than
 * one after another. This runs before the child process is spawned, on every
 * run of every block, so it is latency the reader pays for on the way to
 * something else; a serial stat per file is the wrong place to spend it.
 */
async function htmlFilesIn (dir) {
  /** @type {import('node:fs').Dirent[]} */
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const names = entries
    .filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
    .map((entry) => entry.name)
  const stats = await mapLimit(names, WALK_LIMIT, (name) =>
    fs.stat(path.join(dir, name)).catch(() => null))
  const found = new Map()
  names.forEach((name, at) => {
    const stat = stats[at]
    if (stat) found.set(name, { mtime: stat.mtimeMs, size: stat.size, born: stat.birthtimeMs })
  })
  return found
}

/**
 * The pages this run wrote — and, only where it can be said safely, the files
 * to stop keeping.
 *
 * Removing a file from the reader's vault on the strength of "it was not here
 * when the run began" is a guess, and it was wrong in two directions. Two
 * blocks running at once share one working directory, and each saw the other's
 * page as its own to clear away. And a `.html` the reader saved — or a sync
 * client landed — in the vault root while a run was in flight was new by the
 * same test, so it went. Both are the reader's files; neither was written by
 * the run.
 *
 * So a removal now has to earn itself, three times over. `mayRemove` is false
 * whenever another run overlapped this one, because with two of them writing
 * into one directory there is no telling whose page is whose and neither may
 * claim any. The file must have been *born* while this run's program was
 * actually alive. And it must still, at the moment of removal, be the bytes
 * that were just read, so nothing written in the gap is lost.
 *
 * A page that fails any of them is shown and left where it is. That is the
 * safe direction to be wrong in: the reader sees the page either way, and the
 * worst case is a file to delete rather than a file that is gone. It is also
 * what happens on a filesystem with no birth time to report — `birthtimeMs`
 * comes back as 0 or the change time, neither of which falls inside the
 * window — which is the right way for this to degrade.
 */

/* `Date.now()` counts whole milliseconds and `birthtimeMs` does not, so a page
   written in the last fraction of a millisecond of a run reports a birth time
   *after* the integer the window closes on, and the run disowns the page it
   had just written. The window is opened by a millisecond at each end to cover
   the rounding. It cannot cost anything: the question being asked is "was this
   here before the run began", and nothing that happened within a millisecond
   of the answer could change it. */
const CLOCK_GRAIN_MS = 1

async function collectRunPages (dir, before, { alive, mayRemove }) {
  const pages = []
  const after = await htmlFilesIn(dir)
  for (const [name, now] of after) {
    const was = before.get(name)
    // There before the run and untouched by it: not this run's to show.
    if (was && was.mtime === now.mtime && was.size === now.size) continue
    const abs = path.join(dir, name)
    const html = await fs.readFile(abs, 'utf8').catch(() => null)
    if (html === null) continue
    pages.push({ name, html: html.slice(0, RUN_PAGE_LIMIT) })

    if (!mayRemove || was) continue
    if (!(now.born >= alive.from - CLOCK_GRAIN_MS &&
          now.born <= alive.to + CLOCK_GRAIN_MS)) continue
    const still = await fs.stat(abs).catch(() => null)
    if (!still || still.mtimeMs !== now.mtime || still.size !== now.size) continue
    await fs.rm(abs, { force: true }).catch(() => {})
  }
  return pages
}

module.exports = { htmlFilesIn, collectRunPages, RUN_PAGE_LIMIT }
