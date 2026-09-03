'use strict'

/* ------------------------------------------------------------ vault writes

   The write-and-restructure half of the file handlers: saving a note,
   renaming, moving, deleting, and importing what was dragged in from Finder.

   These are the handlers where every data-loss bug in this project's history
   has lived, and what makes them safe is not this file but the machinery they
   call: the atomic write, the path guards, the index touchers, the history
   and language-history stores, the claim system's relocate. That machinery
   stays in main.js — the watcher, the copilot's rename consumption and the
   index sync all drive the same pieces — and crosses here as the named
   context seams below. What this file owns is the sequence each gesture
   makes: what is read before the write, what is told afterwards, and in which
   order, so that a crash between any two steps leaves the vault consistent.
   ================================================================== */

const { ipcMain, shell } = require('electron')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const { safeFileName } = require('./safe-name')
const { forgetAll } = require('./path-store')
const { encodeText, isUnencodableError } = require('./text-encoding')
const {
  MD_EXT, CODE_EXT, DATA_EXT, NOTE_EXT, DOCUMENT_EXT,
  PDF_TEXT_SUFFIX, isTex, isCode, isData, isWhiteboard, isNotebook,
  isLanguageTable, languageName, languageTableStem
} = require('./vault-kinds')

/**
 * @param {{
 *   realSafePath: (relOrAbs: string) => Promise<string>,
 *   realSafeTargetPath: (relOrAbs: string) => Promise<string>,
 *   rel: (abs: string) => string,
 *   getVaultPath: () => string | null,
 *   freeName: (dir: string, base: string, ext?: string) => string,
 *   noteSelfWrite: (abs: string, stamp?: string | null) => void,
 *   markIndexDirty: () => void,
 *   invalidateVaultSnapshot: () => void,
 *   getTrust: () => { creationTime: (p: string, at?: number) => number | null, record: (op: any) => any, forgetCreations: (p: string) => void } | null,
 *   languageHistory: { sync: (p: string, text: string, opts?: any) => Promise<any>, remove: (p: string) => Promise<any> },
 *   review: { remove: (p: string) => Promise<any> },
 *   relocate: (srcAbs: string, targetAbs: string) => Promise<{ path: string, links: number }>,
 *   notesUnder: (target: string, isDir: boolean) => string[],
 *   trashAttachments: (relPath: string) => Promise<void>,
 *   isSnapshotFile: (p: string) => boolean,
 *   documentsChanged: () => void,
 *   touchIndex: (absPath: string, text: string, stamp: any) => void,
 *   touchDocumentIndex: (absPath: string, text: string, stamp: any) => void,
 *   touchWhiteboardIndex: (absPath: string, source: string, stamp: any, extractedText?: string | null) => void,
 *   getIndex: () => Map<string, any>,
 *   ensureIndex: () => Promise<void>,
 *   getPythonEnvs: () => { forget: (note: string) => Promise<any> },
 *   assertReal: (from: string) => Promise<void>,
 *   annotationFile: (relPath: string) => string,
 *   writeAtomic: (abs: string, content: any, opts?: any) => Promise<any>,
 *   readConfig: () => Record<string, any>,
 *   maxVersionedBytes: number,
 *   maxIndexBytes: number,
 *   ignoredDirs: Set<string>
 * }} ctx
 */
function makeVaultWriteDomain (ctx) {
  const {
    realSafePath, realSafeTargetPath, rel, getVaultPath, freeName,
    noteSelfWrite, markIndexDirty, invalidateVaultSnapshot, getTrust,
    languageHistory, review, relocate, notesUnder, trashAttachments,
    isSnapshotFile, documentsChanged, touchIndex, touchDocumentIndex,
    touchWhiteboardIndex, getIndex, ensureIndex, getPythonEnvs, annotationFile,
    assertReal,
    writeAtomic, readConfig, maxVersionedBytes, maxIndexBytes, ignoredDirs
  } = ctx

  const index = getIndex

  /* At factory scope, not register's: the copilot's rename consumption takes
     this same route through the returned domain object. */
  async function renameDocument (p, nextName) {
    const abs = await realSafeTargetPath(p)
    const language = isLanguageTable(abs)
    /* The extension is the file's, not the name's: the tree shows a document
       without one, so a name typed back with `.pdf` or `.md` on it would other-
       wise be filed as `Paper.pdf.pdf`. */
    let ext = fsSync.statSync(abs).isDirectory()
      ? ''
      : path.extname(abs)
    /* Source and data files are the exception, because they are the one kind the
       tree labels *with* the extension. Someone renaming `notes.txt` to
       `notes.py` in a box that was prefilled `notes.txt` means the change, and
       keeping `.txt` would quietly ignore the only part they edited. Another
       kind's extension is still not honoured — this cannot turn a script into a
       PDF — so the answer is always a source file either way. */
    if (isCode(abs) || isData(abs)) {
      const typed = path.extname(String(nextName || '')).toLowerCase()
      if (CODE_EXT.has(typed) || DATA_EXT.has(typed)) ext = typed
    }
    /* Every rule about what a filename may be lives in safe-name.js — including
       the Windows ones, which a vault written here still has to keep to if it is
       ever going to open there. */
    const safe = safeFileName(nextName, { strip: [NOTE_EXT, DOCUMENT_EXT] })
    if (!safe.ok) throw new Error(safe.error)
    let clean = safe.name
    if (language) {
      const current = languageName(languageTableStem(abs))
      const asked = languageName(clean).name
      clean = current.flag ? `${current.flag} ${asked}` : asked
    }
    const target = await realSafeTargetPath(path.join(path.dirname(rel(abs)), clean + ext))
    if (target === abs) return { path: rel(abs), links: 0 }
    // Unlike the other routes into the vault, a rename says what it wants to be
    // called — silently landing on "${clean} 2" would ignore that.
    if (fsSync.existsSync(target)) {
      /* On a case-insensitive volume, `Languages` and `languages` both find the
         source entry. That is a valid rename, not a collision. Compare directory
         entries rather than spellings so case-only (and Unicode-normalisation-
         only) renames pass while a genuinely different sibling is still refused.
         `lstat` matters for links: two distinct links to one target are still two
         occupied names. */
      const sourceEntry = fsSync.lstatSync(abs)
      const targetEntry = fsSync.lstatSync(target)
      const sameEntry = sourceEntry.dev === targetEntry.dev &&
        sourceEntry.ino === targetEntry.ino
      if (!sameEntry) throw new Error(`"${clean}" already exists here.`)
    }

    const result = await relocate(abs, target)
    markIndexDirty()
    invalidateVaultSnapshot()
    return result
  }

  function register () {
    ipcMain.handle('file:write', async (_e, p, content, metadata = null) => {
      /* Fully resolved, exactly as `file:read` resolves it: content flows through
         the last component here, so a link standing where the note should be would
         put the note's text wherever it points. The two handlers agreeing also
         means a note this refuses to write is a note `file:read` already refused
         to open. */
      const abs = await realSafePath(p)

      /* Is this still the file the caller read?

         A caller that passes `expect` is saying which version of the file its text
         was derived from, and asking to be refused rather than to win. The watcher
         already spots an outside edit and opens the merge panel, but it spots it on
         a 180 ms debounce: a write that lands inside that window — a sync client
         pulling the other side down a moment before the autosave fires — was
         overwritten with nobody told. This closes that window, for whatever kind of
         document the caller is holding.

         Opt-in rather than always-on quite deliberately. Files enter the vault by
         routes that do not go through a read at all — import, move, restore from
         history, the link rewriter — and a gate they could not satisfy would refuse
         writes that are perfectly correct. */
      if (metadata?.expect && !metadata.force) {
        const now = await fs.stat(abs).catch(() => null)
        const expect = metadata.expect
        const moved = now
          ? (now.mtimeMs !== expect.mtimeMs || now.size !== expect.size)
          /* Gone. Recreating it is what the caller almost certainly wants, but it
             is not what it asked for, so say so and let it decide. */
          : true
        if (moved) {
          return {
            ok: false,
            stale: true,
            disk: now ? { mtimeMs: now.mtimeMs, size: now.size } : null,
            error: now
              ? 'That file has changed on disk since it was read.'
              : 'That file is no longer on disk.'
          }
        }
      }

      await fs.mkdir(path.dirname(abs), { recursive: true })
      /* Through the same temp-file-and-rename the link rewriter uses. This is the
         autosave path — the one write that happens constantly and unattended — so
         it is the last one that should be able to leave a half-written note behind
         if the power goes. */
      const isMarkdown = MD_EXT.has(path.extname(abs).toLowerCase())
      /* Source and data files are versioned like notes. They are the vault's own
         text, edited in the vault's own editor and autosaved by it — which is
         exactly the argument for keeping the copy that History restores from. A
         `.py` overwritten by a stray keystroke is no more recoverable from the
         filesystem than a note is. */
      /* A notebook is deliberately not on this list. It is text on disk, but most
         of that text is output — a single plot is a megabyte of base64 — and the
         history store keeps every version whole inside one 4 MB budget shared by
         the entire vault. Versioning notebooks here would mean one save of one
         notebook evicting the history of every note in it. */
      const isTextDocument = isMarkdown || isTex(abs) || isCode(abs) || isData(abs)
      const whiteboard = isWhiteboard(abs)
      /* The size of the file decides whether it gets a version, so it is asked for
         before the old text is read rather than alongside it. A stat is cheap; the
         read this can now skip is not. */
      const oldStat = isTextDocument ? await fs.stat(abs).catch(() => null) : null
      const versioned = isTextDocument &&
        (oldStat?.size ?? 0) <= maxVersionedBytes &&
        Buffer.byteLength(String(content), 'utf8') <= maxVersionedBytes
      /* The note as it stood before this write, read first: the snapshot has to be
         the same text the write is about to replace, and reading after would hand
         the history store the text being written. Read even when the file is new,
         so the note's first save is recorded as the thing it replaced — nothing. */
      /* Except when the index is already holding that same text. Its entry carries
         the mtime and size it was read at, and those matching the file this write
         is about to replace is the same freshness test the index sync itself
         trusts — so the read is of a note that is already in memory, on the path
         that runs every few seconds for as long as anyone is typing. */
      const held = versioned && isMarkdown ? index().get(rel(abs)) : null
      const before = !versioned
        ? null
        : (held && oldStat && held.mtime === oldStat.mtimeMs && held.size === oldStat.size &&
            typeof held.text === 'string' && held.size <= maxIndexBytes)
            ? held.text
            : await fs.readFile(abs, 'utf8').catch(() => null)
      /* Capture the old inode's birthtime before the atomic rename replaces it.
         Info can then keep saying when the note was created rather than when its
         newest crash-safe save landed. */
      if (oldStat) getTrust()?.creationTime(rel(abs), oldStat.birthtimeMs)
      /* Written back in the encoding it was read in, and with the mark it opened
         with, when the caller says what those were. Only `file:read-encoded`
         reports them, so in practice this is the data grid putting an Excel export
         back the way it found it; everything else omits the option object and gets
         the UTF-8 this handler has always written. A character the file's own
         encoding cannot spell is refused rather than substituted — see
         electron/text-encoding.js. */
      let payload = content
      if (metadata?.encoding && metadata.encoding !== 'utf8') {
        try {
          payload = encodeText(content, { encoding: metadata.encoding, bom: !!metadata.bom })
        } catch (err) {
          if (!isUnencodableError(err)) throw err
          return {
            ok: false,
            unencodable: true,
            character: err.character,
            encoding: err.encoding,
            error: err.message
          }
        }
      } else if (metadata?.bom) {
        payload = encodeText(content, { encoding: 'utf8', bom: true })
      }
      const stamp = await writeAtomic(abs, payload, {
        durable: readConfig().durability === 'full'
      })
      /* The bytes on disk have moved. Said here as well as in `touchIndex` below,
         which only hears about Markdown: a TeX document saved from the editor is
         deliberately outside the index and outside the vault snapshot's own
         generation, so this is the only place its save is announced. */
      documentsChanged()
      /* A copy of what the save replaced, so any version of the note can be put
         back from History. Only notes: the store is for writing, and a website
         file holds an address rather than prose. */
      if (versioned && String(before ?? '') !== String(content)) {
        getTrust()?.record({ source: 'save', changes: [{ path: rel(abs), before, after: String(content) }] })
      }
      /* The text is already here, so the next sync can skip re-reading it. Without
         this, every autosave would cost the index a read of the note being typed.

         Notes only. The index is what vault search and the link tables are built
         from, and a website file put into it would answer a search for the site's
         own name with a row that is not a note — until the next walk of the vault
         quietly dropped it again, which is the worse half of the bug. */
      if (isMarkdown) touchIndex(abs, content, stamp)
      if (whiteboard) touchWhiteboardIndex(abs, content, stamp, metadata?.whiteboardText)
      if (isCode(abs) || isData(abs) || isNotebook(abs)) touchDocumentIndex(abs, content, stamp)
      if (isLanguageTable(abs)) {
        await languageHistory.sync(rel(abs), content).catch((err) => {
          console.error('language history sync failed', err)
        })
      }
      /* The stamp the bytes landed with, so a caller doing this again in a moment
         can say which file it means. Callers that only ever wrote and moved on are
         unaffected: an object is as truthy as the `true` that used to be here. */
      return { ok: true, stamp }
    })

    ipcMain.handle('file:rename', (_e, p, nextName) => renameDocument(p, nextName))

    ipcMain.handle('file:move', async (_e, from, destDir) => {
      const src = await realSafeTargetPath(from)
      const dir = destDir ? await realSafePath(destDir)
        /* Without a vault, `realSafeTargetPath` above has already thrown,
           so the root is a string here however the type has to say it. */
        : path.resolve(/** @type {string} */ (getVaultPath()))

      if (!fsSync.existsSync(dir) || !fsSync.statSync(dir).isDirectory()) {
        throw new Error('That destination is not a folder.')
      }
      // Moving a folder inside itself would detach the subtree from the vault.
      if (src === dir || dir.startsWith(src + path.sep)) {
        throw new Error('A folder cannot be moved into itself.')
      }
      if (path.dirname(src) === dir) return { path: rel(src), links: 0 }

      const ext = path.extname(src)
      const result = await relocate(src, freeName(dir, path.basename(src, ext), ext))
      markIndexDirty()
      invalidateVaultSnapshot()
      return result
    })

    ipcMain.handle('file:delete', async (_e, p) => {
      const abs = await realSafeTargetPath(p)
      const deletingDirectory = fsSync.statSync(abs).isDirectory()
      /* Read while the notes are still there to be found: after the trash, the
         index no longer answers for what was under a deleted folder. */
      await ensureIndex()
      const losingEnvs = notesUnder(rel(abs), deletingDirectory)
      /* Read before the trash for the same reason the environments above were: the
         "does anything else answer to this name" question is asked of a vault that
         still contains the file being deleted, and excludes it by path. */
      const attachments = deletingDirectory ? null : rel(abs)
      // Goes to the system Trash, not an unlink — deletes should be recoverable.
      noteSelfWrite(abs)
      await shell.trashItem(abs)
      if (attachments) await trashAttachments(attachments)
      await forgetAll(rel(abs), deletingDirectory)
      /* The note is gone, so the environment its blocks ran in is nobody's. Not
         recoverable the way the note is — but it holds no work of the reader's,
         only packages, and a restored note builds a new one on its next run. */
      await Promise.all(losingEnvs.map((note) => getPythonEnvs().forget(note)))
      getTrust()?.forgetCreations(rel(abs))
      /* Attachment removal is followed immediately by a renderer refresh. The
         watcher invalidates these caches too, but only after its debounce; without
         doing it here that immediate refresh reads the old asset list and redraws
         the image Tulip just moved away. */
      markIndexDirty()
      invalidateVaultSnapshot()

      /* A PDF's highlights follow it into the Trash, so restoring the document
         brings back what was marked on it — and its extracted text goes too, which
         otherwise would be a copy of a deleted paper left where the copilot reads.
         Anything else has no sidecar and this finds nothing. */
      const stem = annotationFile(p).slice(0, -5)
      for (const sidecar of [annotationFile(p), stem + PDF_TEXT_SUFFIX, stem]) {
        if (!fsSync.existsSync(sidecar)) continue
        try {
          /* Where the path really leads, before anything is thrown away. Both the
             test above and `shell.trashItem` follow symlinks, so a linked
             `.annotations` folder in a synced vault turned "delete this PDF" into
             "move that file, wherever it is, to the Trash". */
          await assertReal(sidecar)
          noteSelfWrite(sidecar)
          await shell.trashItem(sidecar)
        } catch { /* not worth a dialog */ }
      }

      /* And the review history of anything that was a language table. Deliberate
         and unguarded, unlike `prune`: this is somebody saying the note is gone,
         not a scan concluding it. */
      await review.remove(p).catch(() => {})
      await languageHistory.remove(p).catch(() => {})
      return true
    })

    /**
     * Copies notes, PDFs and whiteboards dragged in from Finder into the vault.
     *
     * Copies rather than moves: what was dropped is somebody else's file until the
     * user says otherwise, and a drag that silently emptied a Finder window would
     * be a bad surprise. A dropped folder comes in with its shape intact, carrying
     * only the notes inside it — the extension filter is what stops this from
     * being a way to read arbitrary files into the vault.
     */
    ipcMain.handle('file:import', async (_e, destDir, sources) => {
      const root = await realSafePath(destDir || '')
      await fs.mkdir(root, { recursive: true })

      let imported = 0
      let skipped = 0
      /** @type {string | null} */
      let first = null

      const copyInto = async (source, dir) => {
        let stat
        try { stat = await fs.lstat(source) } catch { skipped++; return }
        // Symlinks are skipped outright: following one could walk out of what was
        // dropped — or around a `ln -s ..` loop forever.
        if (stat.isSymbolicLink()) { skipped++; return }

        if (stat.isDirectory()) {
          const name = path.basename(source)
          if (name.startsWith('.') || ignoredDirs.has(name)) return
          const target = freeName(dir, name)
          await fs.mkdir(target, { recursive: true })
          let entries = []
          try { entries = await fs.readdir(source) } catch { /* unreadable */ }
          for (const entry of entries) await copyInto(path.join(source, entry), target)
          return
        }

        /* Everything the vault holds — which is now the same test the walk itself
           applies, rather than a second list beside it.

           The filter used to be a hand-written chain: notes, TeX, PDFs,
           whiteboards, notebooks, source and data. Every kind added since had to
           remember to appear here as well, and Word documents did not — so a
           `.docx` dragged into the tree was counted as "skipped", in an app that
           reads, draws, edits and writes Word documents, and that will happily
           make one from the New menu. Pictures, recordings and everything else the
           tree lists were skipped for the same reason: the walk keeps them, the
           viewer opens them, and only this door was shut.

           `isSnapshotFile` is that walk's own test, so a kind is admitted here by
           being a kind the vault keeps — notebooks, sites and whiteboards among
           them, since it already asks about all three. Anything else is still
           skipped and still counted, which is what the "n skipped" in the import's
           report is for. */
        if (!isSnapshotFile(source)) { skipped++; return }
        const ext = path.extname(source)
        const target = freeName(dir, path.basename(source, ext), ext)
        noteSelfWrite(target)
        await fs.copyFile(source, target)
        /* The creation date is kept for the kinds whose history the trust store
           holds — which is now the same set that `file:write` versions, source and
           data files included. */
        if (MD_EXT.has(path.extname(target).toLowerCase()) || isTex(target) ||
            isCode(target) || isData(target)) {
          getTrust()?.creationTime(rel(target), Date.now())
        }
        imported++
        if (!first) first = rel(target)
      }

      for (const source of sources || []) {
        if (typeof source !== 'string' || !source) { skipped++; continue }
        // Dragging a note out of the vault and back in would otherwise duplicate
        // it against itself.
        if (path.resolve(source) === path.resolve(/** @type {string} */ (getVaultPath()))) { skipped++; continue }
        await copyInto(path.resolve(source), root)
      }

      markIndexDirty()
      invalidateVaultSnapshot()
      return { imported, skipped, first }
    })
  }

  return { register, renameDocument }
}

module.exports = { makeVaultWriteDomain }
