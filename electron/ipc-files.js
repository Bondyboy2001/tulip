'use strict'

/* ------------------------------------------------------------- file reads

   The read-and-inspect half of the file handlers: what a file says, what the
   filesystem knows about it, whether an unknown file is text at all, what the
   desktop opens it with, and the copy a sync conflict is saved into.

   What is deliberately NOT here: the write half and the rename/move/delete
   core. Those reach into the index, the history store and the claim system —
   they are the part where every data-loss bug in this project's history has
   lived, and they stay beside the machinery they mutate.

   Everything that belongs to the rest of main arrives through the context:
   the path guards, the language-history store the read syncs, the trust store
   that remembers first creations, the self-write bookkeeping and the two
   vault-change signals a conflict copy has to raise.
   ================================================================== */

const { ipcMain, shell } = require('electron')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const { decodeText } = require('./text-encoding')
const { MD_EXT, isTex, isCode, isData, isLanguageTable } = require('./vault-kinds')

/**
 * @param {{
 *   realSafePath: (relOrAbs: string) => Promise<string>,
 *   rel: (abs: string) => string,
 *   languageHistory: { sync: (p: string, text: string, opts?: any) => Promise<any> },
 *   getTrust: () => { creationTime: (p: string, at?: number) => number | null } | null,
 *   noteSelfWrite: (abs: string, stamp?: string | null) => void,
 *   markIndexDirty: (relPath?: string) => void,
 *   invalidateVaultSnapshot: () => void,
 *   freeName: (dir: string, base: string, ext?: string) => Promise<string>,
 *   maxOpenBytes: number,
 *   tooBig: (abs: string, size: number) => Error
 * }} ctx
 */
function makeFilesDomain (ctx) {
  const {
    realSafePath, rel, languageHistory, getTrust,
    noteSelfWrite, markIndexDirty, invalidateVaultSnapshot, freeName,
    maxOpenBytes, tooBig
  } = ctx

  /* The open-size ceiling is main's — the docx read handler refuses through the
     same `tooBig`, so it crosses here rather than being restated. */

  /** The file's bytes and the stamp they were read at, from one handle: a stat
   *  taken separately describes a file that may already have been replaced, and
   *  the stamp is the whole basis on which a later write decides it is safe. */
  async function readWithStamp (abs) {
    const file = await fs.open(abs, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error('That is not a file.')
      if (stat.size > maxOpenBytes) throw tooBig(abs, stat.size)
      const buffer = await file.readFile()
      return { buffer, stamp: { mtimeMs: stat.mtimeMs, size: stat.size } }
    } finally {
      await file.close().catch(() => {})
    }
  }

  /* How much of a file is looked at to decide whether it is text. A binary
     announces itself in the first few bytes — a magic number, then a NUL — and a
     text file that begins with 8KB of clean UTF-8 is a text file. */
  const SNIFF_BYTES = 8192

  /* What the desktop would *run* rather than open. A vault is an ordinary
     folder that is shared and synced, so a file in it is not a file the reader
     put there; `shell.openPath` on a `.command` or a `.exe` is a double-click on
     it, with no dialog of Tulip's in between. Documents go through; programs
     are refused with the reason, and the reader can open them from the Finder
     where the OS asks its own questions. */
  const EXECUTABLE_EXT = new Set([
    '.app', '.command', '.sh', '.bash', '.zsh', '.tool', '.terminal', '.workflow',
    '.exe', '.bat', '.cmd', '.com', '.ps1', '.vbs', '.js', '.jse', '.wsf', '.wsh',
    '.scr', '.pif', '.lnk', '.msi', '.msp', '.reg', '.jar', '.pkg', '.dmg',
    '.run', '.bin', '.desktop', '.appimage', '.pyw', '.url'
  ])

  /* One conflict copy per episode, rather than one per save.

     A conflict is not usually a single event. Something outside Tulip is writing
     the file — Word, a sync client — and it writes again while the reader is
     still typing, so the next autosave conflicts too. Answering each of those
     with a file of its own turned a disagreement lasting a minute into forty
     files, all but the last of them superseded, and buried the one the reader
     actually needed.

     So a run of conflicts over one file shares one copy. The first makes it; the
     rest overwrite it, which keeps the other side's LATEST version rather than
     its earliest — the newest is the one worth having, and the older ones were
     never separately interesting. A quiet minute ends the episode, and the next
     conflict after that is a new disagreement and gets a file of its own. */
  const CONFLICT_EPISODE_MS = 60_000
  /** abs → the copy a live episode is writing to, and when it was last written. */
  const conflictEpisodes = new Map()

  function register () {
    /* The stamp a path was last served or written at, so a caller that wants to
       be sure it is overwriting the file it read can say which one that was. Kept
       here rather than derived on the fly because "the file has not changed" is a
       claim about a moment, and the moment is the read. */
    ipcMain.handle('file:read', async (_e, p, options = null) => {
      const abs = await realSafePath(p)
      const { buffer, stamp } = await readWithStamp(abs)
      const text = buffer.toString('utf8')
      if (isLanguageTable(abs)) {
        await languageHistory.sync(rel(abs), text, { trackNew: false }).catch((err) => {
          console.error('language history sync failed', err)
        })
      }
      /* A bare string by default, because that is what every caller in the app has
         always been handed and a note has nothing to add to it. The stamp is asked
         for by the callers that intend to write the file back and want the write
         to fail rather than clobber. */
      return options?.stamp ? { text, stamp } : text
    })

    /**
     * A file whose encoding the app did not choose.
     *
     * `file:read` above decodes as UTF-8 unconditionally, which is right for
     * everything the app itself wrote. It is wrong for the one kind of file people
     * hand a vault in quantity — a spreadsheet export — because Excel still writes
     * `.csv` in windows-1252, and still writes UTF-8 with a byte-order mark. Read
     * as UTF-8 those become U+FFFD and lost marks, and the next autosave makes both
     * permanent. See electron/text-encoding.js for what is sniffed and what is
     * deliberately not guessed at.
     */
    ipcMain.handle('file:read-encoded', async (_e, p) => {
      try {
        const abs = await realSafePath(p)
        const { buffer, stamp } = await readWithStamp(abs)
        const decoded = decodeText(buffer)
        return { ok: true, ...decoded, stamp }
      } catch (err) {
        return { ok: false, error: err.message, code: err.code || null }
      }
    })

    /**
     * What the filesystem knows about a file: its size and its two dates.
     *
     * The Info pane's top half. Everything else it shows is derived from text the
     * renderer already has in the buffer, and these three are the ones only the
     * disk can answer for. `birthtime` is a real creation date on APFS; where a
     * filesystem does not keep one it comes back as the epoch or as the mtime, so
     * the caller is told the number and decides whether it is worth showing.
     */
    ipcMain.handle('file:info', async (_e, p) => {
      try {
        const abs = await realSafePath(p)
        const stat = await fs.stat(abs)
        const filesystemCreated = stat.birthtimeMs || 0
        /* The same kinds `file:write` records a birthtime for: every text document
           is saved through a rename, which gives it a new inode and a new
           birthtime on every save, and the store is what remembers the first. */
        const created = (MD_EXT.has(path.extname(abs).toLowerCase()) || isTex(abs) || isCode(abs) || isData(abs))
          ? getTrust()?.creationTime(rel(abs), filesystemCreated) || filesystemCreated
          : filesystemCreated
        return {
          ok: true,
          size: stat.size,
          modified: stat.mtimeMs,
          created
        }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    })

    /**
     * Whether a file of no known kind is text, and how big it is.
     *
     * Asked at the door in the renderer, for the files the vault has no view of its
     * own for. An extension is a claim rather than a fact — a `.log`, a `.env`, a
     * `.rtf`, a file with no extension at all — so the bytes are what decides. A
     * NUL byte is the giveaway no text encoding produces; a decoder set to be
     * fussy catches what is left.
     *
     * A file that will not even be opened is not text, and is described rather than
     * shown — which is what the viewer does with a picture-less, playerless file
     * anyway, so the error needs no separate path.
     */
    ipcMain.handle('file:probe', async (_e, p) => {
      try {
        const abs = await realSafePath(p)
        const stat = await fs.stat(abs)
        if (!stat.isFile()) return { ok: false, error: 'That is not a file.' }

        const handle = await fs.open(abs, 'r')
        let head
        try {
          const buffer = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size))
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          head = buffer.subarray(0, bytesRead)
        } finally {
          await handle.close()
        }

        let text = !head.includes(0)
        if (text && head.length) {
          /* `fatal` is the whole point: the lenient decoder turns any byte into
             U+FFFD and would call a JPEG text. A multi-byte character cut in half
             by the sniff boundary would fail the same way, so the last few bytes
             are dropped before the check — four is the longest UTF-8 sequence. */
          const whole = head.length < stat.size ? head.subarray(0, Math.max(0, head.length - 4)) : head
          try { new TextDecoder('utf8', { fatal: true }).decode(whole) } catch { text = false }
        }

        return { ok: true, text, size: stat.size, modified: stat.mtimeMs }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    })

    /** A file handed to whatever the desktop opens it with. The one honest answer
     *  for a `.zip` or a `.key`: Tulip cannot show it, and the machine already has
     *  something that can — and for a `.docx`, which it can show but not edit, it
     *  is the way to the program that owns the format. Returns the reason when the
     *  OS refuses, which is what the viewer puts on screen. */
    ipcMain.handle('file:open-default', async (_e, p) => {
      try {
        const abs = await realSafePath(p)
        if (EXECUTABLE_EXT.has(path.extname(abs).toLowerCase())) {
          return { ok: false, error: 'That file is a program, not a document. Open it from the Finder if you mean to run it.' }
        }
        const problem = await shell.openPath(abs)
        return problem ? { ok: false, error: problem } : { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    })

    ipcMain.handle('file:reveal', async (_e, p) => {
      shell.showItemInFolder(await realSafePath(p))
    })

    /**
     * Put the version currently on disk somewhere safe, under a name of its own.
     *
     * A document changed on disk while it had unsaved edits in a buffer, and the
     * buffer is what the app is about to keep. For markdown that is a three-way
     * merge and both sides survive; for everything else — a whiteboard, a grid, a
     * notebook — there is nothing to merge line by line, so the disk's version was
     * simply dropped, with a toast to say so. A toast is not a copy. Whatever the
     * other side wrote, whether that was a sync client or a Jupyter running beside
     * this one, was gone the moment the next autosave landed.
     *
     * So it is copied first, and only then overwritten. The name follows the
     * convention every sync client already uses and every user has already seen,
     * which is the point: a file called `Analysis (conflicted copy).ipynb` sitting
     * next to `Analysis.ipynb` explains itself without a dialog.
     *
     * Copied byte for byte rather than read and rewritten as text — a notebook is
     * mostly base64 and a whiteboard is not ours to reformat. Returns the new
     * path, or null when there was nothing on disk to keep.
     */
    ipcMain.handle('file:conflict-copy', async (_e, p) => {
      const abs = await realSafePath(p)
      const now = Date.now()
      const episode = conflictEpisodes.get(abs)

      /* Still the same disagreement, and the copy it made is still there. Written
         over rather than added to. */
      if (episode && now - episode.at < CONFLICT_EPISODE_MS &&
        await fs.stat(episode.target).then(() => true).catch(() => false)) {
        try {
          await fs.copyFile(abs, episode.target)
        } catch {
          return null
        }
        episode.at = now
        noteSelfWrite(episode.target)
        markIndexDirty(rel(episode.target))
        invalidateVaultSnapshot()
        /* `repeat` so the window can say it once rather than once a second: the
           file it named the first time is the file this went into. */
        return { path: rel(episode.target), repeat: true }
      }

      const ext = path.extname(abs)
      const stem = path.basename(abs, ext)
      const target = await freeName(path.dirname(abs), `${stem} (conflicted copy)`, ext)
      try {
        /* `COPYFILE_EXCL` so this can never land on a file that appeared between
           `freeName` looking and the copy happening — losing the disk's version is
           the exact failure this handler exists to prevent, and doing it to a
           bystander would be worse. */
        await fs.copyFile(abs, target, fsSync.constants.COPYFILE_EXCL)
      } catch {
        return null
      }
      conflictEpisodes.set(abs, { target, at: now })
      noteSelfWrite(target)
      markIndexDirty(rel(target))
      invalidateVaultSnapshot()
      return { path: rel(target), repeat: false }
    })
  }

  return { register }
}

module.exports = { makeFilesDomain }
