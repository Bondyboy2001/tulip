'use strict'

/* ------------------------------------------------------------ vault kinds

   The vault's document kinds, their extensions and the names they go by —
   one projection of electron/vault-contract.json.

   This sits between the contract and everybody who asks "what is this file":
   main.js's walk, watcher, tree and search all import the predicates here,
   and so does the create-handler domain (electron/ipc-create.js). Before this
   module the definitions lived in main.js, which meant a newly supported kind
   had to be threaded through constants declared beside ten thousand other
   lines; now the contract is read once, in one place, and a kind added to the
   JSON arrives everywhere at once.

   The two expressions below are built from the contract rather than written
   by hand, and the same construction lives in src/vault-paths.js for the
   renderer — both sides strip a note's extension when they turn a path into
   a name, and a link resolves by comparing those names — so the two
   spellings drifting apart is a wikilink that points at a note the tree is
   showing.
   ================================================================== */

const path = require('node:path')
const VAULT_CONTRACT = require('./vault-contract.json')

/** A literal string, as a pattern that matches only itself. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const MD_EXT = new Set(VAULT_CONTRACT.noteExtensions)

const NOTE_EXT = new RegExp(
  `\\.(${VAULT_CONTRACT.noteExtensions
    .map((ext) => escapeRe(ext.replace(/^\./, ''))).join('|')})$`,
  'i'
)

/* The other document kinds a vault holds. `file:rename` and every create
   handler strip whatever extension the typed name carries, whichever kind was
   named — and stating them as one expression is what keeps that list from
   being the place a newly supported kind is forgotten. Word documents were:
   for a while this list did not know `.docx`, so renaming one and typing the
   name back the way the reader saw it in Finder filed it as
   `Report.docx.docx`. */
const DOCUMENT_EXT = new RegExp(
  `(${[
    VAULT_CONTRACT.texExtension,
    VAULT_CONTRACT.pdfExtension,
    VAULT_CONTRACT.siteExtension,
    VAULT_CONTRACT.whiteboardExtension,
    VAULT_CONTRACT.notebookExtension,
    VAULT_CONTRACT.docxExtension,
    ...VAULT_CONTRACT.codeExtensions,
    ...Object.keys(VAULT_CONTRACT.dataExtensions)
  ]
    .map(escapeRe).join('|')})$`,
  'i'
)

const TEX_EXT = VAULT_CONTRACT.texExtension
const isTex = (p) => path.extname(String(p || '')).toLowerCase() === TEX_EXT

/* Rendered artefacts — a manim video, a tikz drawing — are filed under the
   attachments folder beside the note that produced them. */
const ATTACHMENT_DIR = VAULT_CONTRACT.attachmentDirectory

/* A PDF's extracted text lives beside its highlights sidecar, under the same
   hidden folder, under a name derived from the PDF's own. */
const PDF_TEXT_SUFFIX = VAULT_CONTRACT.pdfTextSuffix

const LANGUAGE_TABLE_SUFFIX = VAULT_CONTRACT.languageTableSuffix
const LANGUAGE_FLAG = new RegExp(VAULT_CONTRACT.languageFlagPattern, 'u')
const isLanguageTable = (p) =>
  String(p || '').toLowerCase().endsWith(LANGUAGE_TABLE_SUFFIX)
const languageTableStem = (p) => {
  const name = path.basename(String(p || ''))
  return path.basename(name, path.extname(name))
}
const languageTableTemplates = VAULT_CONTRACT.languageTableTemplates
const LANGUAGE_TABLE_TEMPLATE = languageTableTemplates.vocabulary
const CUSTOM_TABLE_TEMPLATE = languageTableTemplates.custom
const languageName = (value) => {
  const text = String(value || '')
  const match = LANGUAGE_FLAG.exec(text)
  return { flag: match?.[1] || '', name: match ? text.slice(match[0].length) : text }
}
const languageTableLabel = (name) => /^vocabulary$/i.test(name) ? 'Words' : name

/* A PDF is the second thing the vault opens in a tab. It is not a note — it is
   never written to, never indexed for search, and has no links — so everything
   that walks the vault asks which of the two it is looking at rather than
   assuming a file is text. */
const PDF_EXT = VAULT_CONTRACT.pdfExtension
const isPdf = (p) => path.extname(p).toLowerCase() === PDF_EXT

/* A website is the third, and the same argument applies twice over: it is not
   text the vault owns at all, only a line naming a page somewhere else. One
   address per file, so the file *is* the bookmark — nothing here needs to
   parse it, which is why the format is a URL on a line and not a record. */
const SITE_EXT = VAULT_CONTRACT.siteExtension
const isSite = (p) => path.extname(p).toLowerCase() === SITE_EXT

/* Portable Excalidraw JSON. Tulip owns the vault integration; the scene stays
   in the upstream format so it can be opened by other whiteboard editors. */
const WHITEBOARD_EXT = VAULT_CONTRACT.whiteboardExtension
const isWhiteboard = (p) => path.extname(p).toLowerCase() === WHITEBOARD_EXT

/* A Jupyter notebook. Text on disk — nbformat is JSON — so it is written,
   versioned and imported exactly as a note is; what it is *not* is a source
   file, because the editor would show the encoding rather than the cells. The
   renderer gives it a viewer of its own; see src/notebook.js. */
const NOTEBOOK_EXT = VAULT_CONTRACT.notebookExtension
const isNotebook = (p) => path.extname(String(p || '')).toLowerCase() === NOTEBOOK_EXT

/* A Word document. Read, shown and written back — but not the way a note is:
   the vault does not own the format, so a save splices into the file Word
   wrote rather than serialising this app's model over it. See electron/docx.js.
   Named here so the tree can give it its own icon and label instead of listing
   it among the files the vault has no view of. */
const DOCX_EXT = VAULT_CONTRACT.docxExtension
const isDocx = (p) => path.extname(String(p || '')).toLowerCase() === DOCX_EXT

/* A portable bank of quiz callouts. It is text and participates in the note
   index, but keeps its own kind so the tree and study controls can distinguish
   a bank from a prose note without reading its frontmatter first. */
const FLASHCARD_EXT = VAULT_CONTRACT.flashcardExtension
const isFlashcard = (p) => path.extname(String(p || '')).toLowerCase() === FLASHCARD_EXT

/* Source files and data files. Neither is a note — a `.py` is text the vault
   edits but never reads as prose, and a `.csv` is a table rather than a
   document at all — but both are text on disk that the vault owns, so unlike a
   PDF they are written, versioned and searched exactly as a note is.

   Sets rather than expressions: this is asked once per entry of every vault
   walk, and the lists are long enough that a regular expression alternation
   over sixty extensions is the wrong shape for the question. */
const CODE_EXT = new Set(VAULT_CONTRACT.codeExtensions)
const isCode = (p) => CODE_EXT.has(path.extname(String(p || '')).toLowerCase())

const DATA_EXT = new Set(Object.keys(VAULT_CONTRACT.dataExtensions))
const isData = (p) => DATA_EXT.has(path.extname(String(p || '')).toLowerCase())

/* The two together, for the watcher's classifier: a `.py` or a `.csv` changing
   on disk means the same to the caches as a `.tex` does, and the classifier
   has to be able to say so rather than falling through to its unknown-name
   fallback. */
const TEXT_DOCUMENT_EXT = new Set([...CODE_EXT, ...DATA_EXT])

/* The kinds a "new file" gesture may ask for by extension, checked against the
   contract's own lists rather than trusted — without that check,
   `source:create` is "write a file of any extension anywhere in the vault". */
const CREATABLE_FILE_EXT = new Set([
  ...TEXT_DOCUMENT_EXT, NOTEBOOK_EXT, DOCX_EXT, FLASHCARD_EXT
])

module.exports = {
  escapeRe,
  MD_EXT,
  NOTE_EXT,
  DOCUMENT_EXT,
  TEXT_DOCUMENT_EXT,
  CREATABLE_FILE_EXT,
  ATTACHMENT_DIR,
  PDF_TEXT_SUFFIX,
  TEX_EXT,
  isTex,
  LANGUAGE_TABLE_SUFFIX,
  LANGUAGE_FLAG,
  isLanguageTable,
  languageTableStem,
  LANGUAGE_TABLE_TEMPLATE,
  CUSTOM_TABLE_TEMPLATE,
  languageName,
  languageTableLabel,
  PDF_EXT,
  isPdf,
  SITE_EXT,
  isSite,
  WHITEBOARD_EXT,
  isWhiteboard,
  NOTEBOOK_EXT,
  isNotebook,
  DOCX_EXT,
  isDocx,
  FLASHCARD_EXT,
  isFlashcard,
  CODE_EXT,
  isCode,
  DATA_EXT,
  isData
}
