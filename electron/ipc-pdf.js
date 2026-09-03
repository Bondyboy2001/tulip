'use strict'

/* ------------------------------------------------------------------- pdf

   The PDF handlers that are not the protocol handler: where the document's
   bytes come from, where the reader's highlights live, and the two ways a
   reading view becomes paper. The `tulip-file://vault` protocol itself stays
   in main.js — it is registered against the app's session, not asked through
   IPC — but the guarded URL it hands out starts here.

   What this file needs to know about everything else arrives through the
   context object. The annotation sidecar's path and the pdf-search facts are
   shared with main's index machinery, so they cross the boundary rather than
   being duplicated: one definition of where a document's highlights live, and
   one owner of when the search facts about it are stale.
   ================================================================== */

const { app, dialog, ipcMain } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

/**
 * @param {{
 *   realSafePath: (relOrAbs: string) => Promise<string>,
 *   rel: (abs: string) => string,
 *   isPdf: (p: string) => boolean,
 *   assertReal: (from: string) => Promise<void>,
 *   writeAtomic: (abs: string, content: string) => Promise<any>,
 *   annotationFile: (relPath: string) => string,
 *   forgetPdfSearchFacts: (relPath?: string) => void,
 *   ensurePdfText: (relPath: string, opts?: { onWork?: unknown }) => Promise<unknown>,
 *   windowOf: (event: Electron.IpcMainInvokeEvent) => Electron.BrowserWindow | null
 * }} ctx
 */
function makePdfDomain (ctx) {
  const {
    realSafePath, rel, isPdf, assertReal, writeAtomic,
    annotationFile, forgetPdfSearchFacts, ensurePdfText, windowOf
  } = ctx

  function register () {
    /* Give pdf.js a guarded URL instead of copying the whole document through IPC.
       Its range requests are answered by the protocol handler in main.js, so a
       large paper can begin rendering before its final bytes have been read. */
    ipcMain.handle('pdf:source', async (_e, p) => {
      const abs = await realSafePath(p)
      if (!isPdf(abs)) throw new Error('Only PDFs have a document source.')
      ensurePdfText(rel(abs)).catch(() => {})
      return `tulip-file://vault/${rel(abs).split(path.sep).map(encodeURIComponent).join('/')}`
    })

    ipcMain.handle('pdf:marks:load', async (_e, p) => {
      if (!isPdf(String(p || ''))) return []
      try {
        const abs = annotationFile(p)
        /* `safePath` is lexical: it settles that the path spells somewhere inside
           the vault, not that following it stays there. A vault synced from
           elsewhere can carry `.annotations/Papers` as a symlink to any folder on
           the machine, and this reads and parses whatever is at the other end.
           Saving already checks; reading did not. */
        await assertReal(abs)
        const text = await fs.readFile(abs, 'utf8')
        const parsed = JSON.parse(text)
        return Array.isArray(parsed?.highlights) ? parsed.highlights : []
      } catch {
        // No sidecar yet, or one that will not parse. Either way the document has
        // no highlights we can show, and saving over it is the right next move.
        return []
      }
    })

    ipcMain.handle('pdf:marks:save', async (_e, p, highlights) => {
      if (!isPdf(String(p || ''))) throw new Error('Only PDFs carry highlights.')
      const abs = annotationFile(p)
      await assertReal(abs)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      const body = JSON.stringify({ version: 1, pdf: p, highlights: highlights || [] }, null, 2)
      await writeAtomic(abs, body)
      // `.annotations/` is outside what the watcher reports, so the search pass is
      // told here or not at all.
      forgetPdfSearchFacts(p)
      return true
    })

    /* The open note as a PDF file. All the deciding happened in the renderer,
       which re-rendered the note in the paper palette before invoking; this side
       asks where the file goes, prints the window, and writes the bytes.

       `to` skips the save dialog: the scripted probes cannot click it, and a
       probe is how an export is verified. Nobody else hands a path. */
    ipcMain.handle('pdf:export', async (event, name, to) => {
      /* The window that asked, not whichever one is frontmost: an export is a
         picture of a particular note, and the ask came from the window showing it
         — which the save dialog it opens is about to take the focus away from. */
      const win = windowOf(event)
      if (!win) return { ok: false, error: 'There is no window to print from.' }

      const safe = String(name || 'note').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 120) || 'note'
      let filePath = typeof to === 'string' && to.endsWith('.pdf') ? to : null
      if (!filePath) {
        const chosen = await dialog.showSaveDialog(win, {
          title: 'Export as PDF',
          defaultPath: path.join(app.getPath('documents'), `${safe}.pdf`),
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        })
        if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true }
        filePath = chosen.filePath
      }

      try {
        const bytes = await win.webContents.printToPDF({
          printBackground: true,
          pageSize: 'Letter',
          preferCSSPageSize: true
        })
        await fs.writeFile(filePath, bytes)
        return { ok: true, path: filePath, bytes: bytes.length }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    })

    /* The same page as `pdf:export`, sent to a real printer through the system's
       own dialog instead of to a file. The renderer has already done the deciding
       — light palette, reading view, everything settled — before it invokes. */
    ipcMain.handle('pdf:print', async (event) => {
      const win = windowOf(event)
      if (!win) return { ok: false, error: 'There is no window to print from.' }
      return await new Promise((resolve) => {
        win.webContents.print({ printBackground: true }, (success, reason) => {
          if (success) resolve({ ok: true })
          else if (String(reason || '').includes('cancel')) resolve({ ok: false, canceled: true })
          else resolve({ ok: false, error: reason || 'Printing did not finish.' })
        })
      })
    })
  }

  return { register }
}

module.exports = { makePdfDomain }
