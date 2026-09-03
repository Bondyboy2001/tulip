'use strict'

/* ------------------------------------------------------------------ review

   The scheduler's side of the study surface. Everything about *when* a card
   comes back is decided in src/srs.js, in the renderer; this only keeps the
   answers. See electron/review-store.js for why it lives in the vault and for
   the wipe that `prune`'s guard exists to prevent.

   The store travels with this module rather than staying in main.js: its only
   other callers there (the relocate on a rename, the remove on a delete) take
   it from the same instance the handlers use, so the answers and the file
   moves can never disagree about which vault they belong to.
   ================================================================== */

const { dialog, ipcMain } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { makeStore } = require('./review-store')

/**
 * @param {{
 *   getVaultPath: () => string | null,
 *   focusedWindow: () => Electron.BrowserWindow | null
 * }} ctx
 */
function makeReviewDomain (ctx) {
  const { getVaultPath, focusedWindow } = ctx

  /* Reads the vault through a function rather than being rebuilt on every vault
     switch: the store keys everything on the vault it was asked about, and
     re-reads when that changes. */
  const review = makeStore({ vault: () => getVaultPath() || '' })

  function register () {
    ipcMain.handle('review:all', async () => {
      if (!getVaultPath()) return {}
      return review.all()
    })

    ipcMain.handle('review:record', async (_e, entries) => {
      if (!getVaultPath()) return { ok: false }
      return review.record(entries)
    })

    /* A deck to import, picked and read but deliberately not parsed: the CSV
       dialect logic lives in the renderer (src/csv.js) beside the table the rows
       are joining. */
    ipcMain.handle('review:pick-csv', async () => {
      if (!getVaultPath()) throw new Error('Open a vault first.')
      /* Electron accepts a null parent here — it falls back to whatever window
         is focused — but its own typing does not say so. */
      const parent = /** @type {Electron.BaseWindow} */ (focusedWindow())
      const picked = await dialog.showOpenDialog(parent, {
        title: 'Import cards',
        properties: ['openFile'],
        buttonLabel: 'Import',
        filters: [{ name: 'Comma or tab separated', extensions: ['csv', 'tsv', 'txt'] }]
      })
      if (picked.canceled || !picked.filePaths[0]) return null
      const source = picked.filePaths[0]
      const stat = await fs.lstat(source)
      if (!stat.isFile()) throw new Error('That is not a file.')
      if (stat.size > 8 * 1024 * 1024) throw new Error('That file is too large to be a deck.')
      return { name: path.basename(source), text: await fs.readFile(source, 'utf8') }
    })

    ipcMain.handle('review:unrecord', async (_e, entry) => {
      if (!getVaultPath()) return { ok: false }
      return review.unrecord(entry)
    })

    ipcMain.handle('review:prune', async (_e, knownIds) => {
      if (!getVaultPath()) return { pruned: 0, refused: false }
      return review.prune(knownIds)
    })

    ipcMain.handle('review:history', async () => {
      if (!getVaultPath()) return []
      return review.history()
    })
  }

  return { review, register }
}

module.exports = { makeReviewDomain }
