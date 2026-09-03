'use strict'

/* ---------------------------------------------------------------- drafts

   What was typed but not yet saved, kept somewhere a crash cannot take with it.

   The autosave is quick — 600 ms by default — but "quick" is not "always", and
   the gap is real: a renderer crash, a GPU process kill, a force quit, a power
   cut all land on a note whose last few seconds exist only in the editor's
   memory. Nothing on disk records them, so nothing can offer them back.

   A draft is that record. It is written on its own timer, beside the app's
   state rather than in the vault — an unfinished paragraph is not something to
   sync to other machines, and a stray file next to the note would be picked up
   by the tree, the index and the backlink scan as though it were one. It is
   removed the moment the real save succeeds, so the ordinary state of this
   folder is empty and anything in it at launch is by definition a note whose
   edits never reached disk.

   Lifted out of main.js with its state (the drafts directory is a function of
   the current vault and nothing else); main's `writeAtomic`, `safePath` and
   `sha1` arrive through the context object rather than being re-exported.
   ================================================================== */

const { app, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')

/**
 * @param {{
 *   getVaultPath: () => string | null,
 *   sha1: (text: string, chars?: number) => string,
 *   writeAtomic: (abs: string, content: string, opts?: { durable?: boolean }) => Promise<any>,
 *   safePath: (relOrAbs: string) => string
 * }} ctx
 */
function makeDraftDomain (ctx) {
  const { getVaultPath, sha1, writeAtomic, safePath } = ctx

  const DRAFT_DIR = () => path.join(app.getPath('userData'), 'drafts', sha1(getVaultPath() || ''))
  const draftFile = (rel) => path.join(DRAFT_DIR(), `${sha1(rel)}.json`)

  function register () {
    ipcMain.handle('draft:save', async (_e, rel, text) => {
      if (!getVaultPath() || typeof rel !== 'string' || typeof text !== 'string') return { ok: false }
      try {
        await fs.mkdir(DRAFT_DIR(), { recursive: true })
        /* Not durable, and deliberately so: this races the very crash it exists
           for, and an fsync per keystroke-pause would cost more than it buys. The
           rename still makes each draft whole-or-absent, which is the guarantee
           that matters — a half-written draft offered back as recovery would be
           worse than none. */
        await writeAtomic(draftFile(rel), JSON.stringify({ path: rel, text, at: Date.now() }), { durable: false })
        return { ok: true }
      } catch (err) {
        console.error('draft write failed', err)
        return { ok: false }
      }
    })

    ipcMain.handle('draft:clear', async (_e, rel) => {
      if (!getVaultPath() || typeof rel !== 'string') return { ok: false }
      await fs.unlink(draftFile(rel)).catch(() => {})
      return { ok: true }
    })

    /**
     * Every draft this vault has, with the file's current text beside it.
     *
     * The comparison is made here rather than in the renderer because it is the
     * whole question: a draft that matches the note on disk is one whose save did
     * land, and offering it back would be asking about nothing. Those are dropped
     * — and deleted — so the renderer only ever hears about real losses.
     */
    ipcMain.handle('draft:list', async () => {
      if (!getVaultPath()) return []
      let names
      try { names = await fs.readdir(DRAFT_DIR()) } catch { return [] }

      const out = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const file = path.join(DRAFT_DIR(), name)
        let draft
        try { draft = JSON.parse(await fs.readFile(file, 'utf8')) } catch { draft = null }
        if (!draft || typeof draft.path !== 'string' || typeof draft.text !== 'string') {
          await fs.unlink(file).catch(() => {})
          continue
        }
        /* The note may have been renamed, deleted or moved out of the vault since.
           `safePath` throws on anything that is not inside it, which is also the
           check that keeps a hand-edited draft from naming a file elsewhere. */
        /** @type {string | null} */
        let disk = null
        try { disk = await fs.readFile(safePath(draft.path), 'utf8') } catch { disk = null }
        if (disk === draft.text) { await fs.unlink(file).catch(() => {}); continue }
        out.push({ path: draft.path, text: draft.text, at: draft.at || 0, disk })
      }
      return out
    })
  }

  return { register }
}

module.exports = { makeDraftDomain }
