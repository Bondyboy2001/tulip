'use strict'

/* ------------------------------------------------------- file metadata

   The per-file metadata the renderer keeps beside the vault's contents: the
   tags a row shows, the mark a tab colour-codes by, and the column widths a
   table was left at. Three stores, one shape of handler — read and write by
   path, guarded and made vault-relative the same way.

   The stores themselves stay in main.js: the index and the search filters
   read them on every walk, so they live with the machinery that uses them
   most. The handlers travel with the reasoning for what each answer means.
   ================================================================== */

const { ipcMain } = require('electron')

/**
 * @param {{
 *   realSafePath: (relOrAbs: string) => Promise<string>,
 *   rel: (abs: string) => string,
 *   getVaultPath: () => string | null,
 *   fileTags: { get: (p: string) => Promise<any>, set: (p: string, v: unknown) => Promise<any> },
 *   fileMarks: { all: () => Promise<any>, set: (p: string, v: unknown) => Promise<any> },
 *   tableWidths: { get: (p: string) => Promise<any>, set: (p: string, v: unknown) => Promise<any> }
 * }} ctx
 */
function makeMetadataDomain (ctx) {
  const { realSafePath, rel, getVaultPath, fileTags, fileMarks, tableWidths } = ctx

  function register () {
    ipcMain.handle('file-tags:get', async (_e, p) => {
      const abs = await realSafePath(p)
      // Always a list: "no tags" is no entry in the store, and the renderer draws
      // a row of them either way.
      return (await fileTags.get(rel(abs))) || []
    })

    ipcMain.handle('file-tags:set', async (_e, p, values) => {
      const abs = await realSafePath(p)
      return (await fileTags.set(rel(abs), values)) || []
    })

    /* The whole map at once, because the tree draws every row it has: asking per
       row would be one round trip per note in the vault. */
    ipcMain.handle('file-marks:all', async () => (getVaultPath() ? await fileMarks.all() : {}))

    ipcMain.handle('file-marks:set', async (_e, p, mark) => {
      const abs = await realSafePath(p)
      // Always a string: the empty one is "no mark", which is no entry at all.
      return (await fileMarks.set(rel(abs), mark)) || ''
    })

    /**
     * The column widths a table was left at, and where they are put back.
     *
     * A `.csv` is its data and nothing else — there is no line in it that could
     * say how wide a column should be — so this is the only place the answer can
     * live. Bounded by the store's own cleaning: a layout for a file that has
     * since gained or lost columns is simply not applied, which csv.js decides,
     * because a width list of the wrong length says nothing about this file.
     */
    ipcMain.handle('table-widths:get', async (_e, p) => {
      const abs = await realSafePath(p)
      return (await tableWidths.get(rel(abs))) || null
    })

    ipcMain.handle('table-widths:set', async (_e, p, widths) => {
      const abs = await realSafePath(p)
      return (await tableWidths.set(rel(abs), widths)) || null
    })
  }

  return { register }
}

module.exports = { makeMetadataDomain }
