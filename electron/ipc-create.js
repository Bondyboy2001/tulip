'use strict'

/* ----------------------------------------------------------------- create

   The eight handlers behind every "new …" gesture in the app: a note, a
   folder, a TeX document, a website, a whiteboard, a language, a table, and
   one handler for every source or data format the vault can seed.

   They are one family and not eight coincidences: all of them run the typed
   name through the same rules a rename does, place the file beside whatever
   folder the tree asked from, record that the write was the app's own, and
   say that the vault changed. The kinds and extensions they choose between
   come from electron/vault-kinds.js, the one projection of the vault
   contract.

   Everything that belongs to the rest of main — the free-name search, the
   path guards, the self-write bookkeeping, the index's dirty flag — arrives
   through the context object. The `trust` store is read through a function
   because main builds it per vault.
   ================================================================== */

const { ipcMain } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { safeFileName } = require('./safe-name')
const { emptyWhiteboard } = require('./whiteboard-data')
const VAULT_CONTRACT = require('./vault-contract.json')
const {
  NOTE_EXT, DOCUMENT_EXT, TEX_EXT, SITE_EXT, WHITEBOARD_EXT, LANGUAGE_TABLE_SUFFIX,
  LANGUAGE_TABLE_TEMPLATE, CUSTOM_TABLE_TEMPLATE, NOTEBOOK_EXT, DOCX_EXT,
  FLASHCARD_EXT, DATA_EXT, CREATABLE_FILE_EXT
} = require('./vault-kinds')

/**
 * @param {{
 *   freeName: (dir: string, base: string, ext?: string) => Promise<string>,
 *   realSafePath: (relOrAbs: string) => Promise<string>,
 *   noteSelfWrite: (abs: string, stamp?: string | null) => void,
 *   rel: (abs: string) => string,
 *   getTrust: () => { creationTime: (p: string, at: number) => void } | null,
 *   markIndexDirty: (relPath?: string) => void,
 *   invalidateVaultSnapshot: () => void
 * }} ctx
 */
function makeCreateDomain (ctx) {
  const { freeName, realSafePath, noteSelfWrite, rel, getTrust, markIndexDirty, invalidateVaultSnapshot } = ctx

  const EMPTY_TEX_DOCUMENT = `\\documentclass{article}

\\begin{document}

\\end{document}
`

  /* Every create below runs the typed name through the same rules a rename does.
     `file:create` always did; the rest went straight to `freeName`, which only
     strips separators and leading dots — so "Notes: Monday" or "CON" became real
     files on macOS, legal here and unopenable the day the vault synced to a
     Windows machine. The rules live in electron/safe-name.js and are stated
     once; an empty ask is still not a failure, because "new document" with
     nothing typed is how most of them start. */
  const askedName = (name, fallback = 'Untitled') => {
    const asked = safeFileName(name || fallback, { strip: [NOTE_EXT, DOCUMENT_EXT] })
    if (!asked.ok) throw new Error(asked.error)
    return asked.name
  }

  function register () {
    ipcMain.handle('file:create', async (_e, dir, name) => {
      /* Same rules as a rename — a name that cannot be created is better refused
         here than turned into a file nobody can open. An empty ask is not a
         failure though: "new note" with nothing typed is how most of them start. */
      const asked = safeFileName(name || 'Untitled', { strip: [NOTE_EXT] })
      if (!asked.ok) throw new Error(asked.error)
      const target = await freeName(
        await realSafePath(dir || ''),
        asked.name,
        '.md'
      )
      await fs.mkdir(path.dirname(target), { recursive: true })
      noteSelfWrite(target)
      await fs.writeFile(target, '', 'utf8')
      getTrust()?.creationTime(rel(target), Date.now())
      markIndexDirty(rel(target))
      invalidateVaultSnapshot()
      return rel(target)
    })

    ipcMain.handle('tex:create', async (_e, dir, name) => {
      const target = await freeName(await realSafePath(dir || ''), askedName(name), TEX_EXT)
      await fs.mkdir(path.dirname(target), { recursive: true })
      noteSelfWrite(target)
      await fs.writeFile(target, EMPTY_TEX_DOCUMENT, 'utf8')
      getTrust()?.creationTime(rel(target), Date.now())
      invalidateVaultSnapshot()
      return rel(target)
    })

    /* A website file, empty. Created without an address rather than asking for one
       first: the tab it opens into has an address bar, and typing into that is a
       better way to say where it points than a modal that has to be answered
       before anything exists. */
    ipcMain.handle('site:create', async (_e, dir, name) => {
      const target = await freeName(await realSafePath(dir || ''), askedName(name), SITE_EXT)
      await fs.mkdir(path.dirname(target), { recursive: true })
      noteSelfWrite(target)
      await fs.writeFile(target, '', 'utf8')
      invalidateVaultSnapshot()
      return rel(target)
    })

    ipcMain.handle('whiteboard:create', async (_e, dir, name) => {
      const target = await freeName(
        await realSafePath(dir || ''),
        askedName(name),
        WHITEBOARD_EXT
      )
      await fs.mkdir(path.dirname(target), { recursive: true })
      noteSelfWrite(target)
      await fs.writeFile(target, emptyWhiteboard(), 'utf8')
      invalidateVaultSnapshot()
      return rel(target)
    })

    /* A language is one portable Markdown table of words the reader has learned.
       Nothing else is created with it: an alphabet, a table of sounds or a page of
       grammar are all the reader's own content, and seeding them would be guessing
       at what this language needs said about it. */
    ipcMain.handle('language:create', async (_e, dir, name) => {
      const folder = await freeName(await realSafePath(dir || ''), askedName(name, 'New language'))
      noteSelfWrite(folder)
      await fs.mkdir(folder, { recursive: true })

      const vocabulary = path.join(folder, `Words${LANGUAGE_TABLE_SUFFIX}`)
      noteSelfWrite(vocabulary)
      await fs.writeFile(vocabulary, LANGUAGE_TABLE_TEMPLATE, 'utf8')
      getTrust()?.creationTime(rel(vocabulary), Date.now())

      markIndexDirty(rel(vocabulary))
      invalidateVaultSnapshot()
      return { folder: rel(folder), vocabulary: rel(vocabulary) }
    })

    /* A new table uses the same focused, table-only document and file icon as
       Vocabulary, but starts neutral: editable COL1/COL2/COL3 headings and enough
       blank rows for its row add/delete controls to be useful immediately. */
    ipcMain.handle('table:create', async (_e, dir, name) => {
      const target = await freeName(
        await realSafePath(dir || ''),
        askedName(name),
        LANGUAGE_TABLE_SUFFIX
      )
      await fs.mkdir(path.dirname(target), { recursive: true })
      noteSelfWrite(target)
      await fs.writeFile(target, CUSTOM_TABLE_TEMPLATE, 'utf8')
      getTrust()?.creationTime(rel(target), Date.now())
      markIndexDirty(rel(target))
      invalidateVaultSnapshot()
      return rel(target)
    })

    /* A source or data file, empty apart from whatever the format needs to be
       openable at all.
     *
     * One handler for both, because the only thing that differs between them is
     * the extension — which the caller names, and which is checked against the
     * contract's own lists rather than trusted. Without that check this would be
     * "write a file of any extension anywhere in the vault", which is a wider door
     * than the feature needs. */
    ipcMain.handle('source:create', async (_e, dir, name, ext) => {
      const wanted = String(ext || '').toLowerCase()
      if (!CREATABLE_FILE_EXT.has(wanted)) {
        throw new Error('That is not a file type Tulip creates.')
      }

      /* A Word document is the one kind here that is not text at all, so it is
         written as bytes rather than seeded with a string. What it starts as is the
         smallest package Word opens without offering to repair it — including a
         stylesheet, so that a heading applied in Tulip is a heading when the file
         is opened in Word. See electron/docx.js. */
      if (wanted === DOCX_EXT) {
        const { blankDocxBuffer } = require('./docx')
        const made = await freeName(await realSafePath(dir || ''), askedName(name), wanted)
        await fs.mkdir(path.dirname(made), { recursive: true })
        noteSelfWrite(made)
        await fs.writeFile(made, blankDocxBuffer())
        getTrust()?.creationTime(rel(made), Date.now())
        invalidateVaultSnapshot()
        return rel(made)
      }
      const target = await freeName(await realSafePath(dir || ''), askedName(name), wanted)
      await fs.mkdir(path.dirname(target), { recursive: true })
      noteSelfWrite(target)
      /* A CSV with no header row opens as a grid with nothing to label its one
         column, and the first thing anyone does is name the columns — so it starts
         with a row to name them in. A source file starts genuinely empty: there is
         no line that belongs in every Python file. */
      /* A notebook has no empty form: nbformat requires the version fields, and a
         file without them is one every other Jupyter tool refuses to open. It
         starts with a single empty code cell for the same reason the CSV starts
         with a header row — that is the first thing anyone types into. The
         language is Python because that is what an unqualified "notebook" means;
         the file says so in metadata and any kernel can be named there later. */
      const seed = wanted === FLASHCARD_EXT
        ? '---\ntype: flashcards\n---\n\n'
        : DATA_EXT.has(wanted)
        ? `column 1${VAULT_CONTRACT.dataExtensions[wanted]}column 2\n`
        : wanted === NOTEBOOK_EXT
          ? `${JSON.stringify({
              cells: [{
                cell_type: 'code',
                execution_count: null,
                metadata: {},
                outputs: [],
                source: []
              }],
              metadata: {
                kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
                language_info: { name: 'python' }
              },
              nbformat: 4,
              nbformat_minor: 5
            }, null, 1)}\n`
          : ''
      await fs.writeFile(target, seed, 'utf8')
      getTrust()?.creationTime(rel(target), Date.now())
      invalidateVaultSnapshot()
      return rel(target)
    })

    ipcMain.handle('folder:create', async (_e, dir, name) => {
      const target = await freeName(await realSafePath(dir || ''), askedName(name, 'New folder'))
      noteSelfWrite(target)
      await fs.mkdir(target, { recursive: true })
      invalidateVaultSnapshot()
      return rel(target)
    })
  }

  return { register }
}

module.exports = { makeCreateDomain }
