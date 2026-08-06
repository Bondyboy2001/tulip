/* ===================================================== vault paths
   What a path in the vault means, built once from the contract both processes
   read. Every one of these matchers used to be written out by hand in two or
   three files at once — and a note the tree listed but the editor would not
   open is what it looks like when one of those copies drifts.

   The facts themselves live in electron/vault-contract.json, which
   electron/main.js requires and this module imports. Adding a note extension
   is one edit there, not four here.
   ================================================================== */

import VAULT_CONTRACT from '../electron/vault-contract.json'

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `.md`, `.markdown`… as an alternation, without the leading dots. */
const noteExtAlternation = VAULT_CONTRACT.noteExtensions
  .map((ext) => escapeRe(ext.replace(/^\./, '')))
  .join('|')

/* A language table is `Name.lang` — `.lang` is one of the contract's note
   extensions, so stripping it here is what makes the tree show "Spanish". */
export const NOTE_EXT =
  new RegExp(`\\.(${noteExtAlternation})$`, 'i')

/* Source files and data files, from the same contract. Both are lists rather
   than single extensions, so both are one alternation built once — a matcher
   rebuilt per call would be run against every entry of every vault walk.

   Anchored on a leading dot as well as the end, so `main.cpp` matches and a
   file actually named `cpp` does not. */
const extAlternation = (list) => list.map(escapeRe).join('|')

export const CODE_EXT =
  new RegExp(`(${extAlternation(VAULT_CONTRACT.codeExtensions)})$`, 'i')

/* The delimiter is the value, so the matcher is built from the keys. */
const DATA_DELIMITERS = VAULT_CONTRACT.dataExtensions
export const DATA_EXT =
  new RegExp(`(${extAlternation(Object.keys(DATA_DELIMITERS))})$`, 'i')

export const TEX_EXT = new RegExp(`${escapeRe(VAULT_CONTRACT.texExtension)}$`, 'i')
export const PDF_EXT = new RegExp(`${escapeRe(VAULT_CONTRACT.pdfExtension)}$`, 'i')
export const SITE_EXT = new RegExp(`${escapeRe(VAULT_CONTRACT.siteExtension)}$`, 'i')
export const WHITEBOARD_EXT = new RegExp(`${escapeRe(VAULT_CONTRACT.whiteboardExtension)}$`, 'i')

/* A Jupyter notebook. JSON on disk like a whiteboard is, and for the same
   reason not a source file: the editor would show the encoding — escaped
   newlines, base64 images — rather than the document, and the document is the
   cells. See src/notebook.js. */
export const NOTEBOOK_EXT = new RegExp(`${escapeRe(VAULT_CONTRACT.notebookExtension)}$`, 'i')

/* Regional-indicator pairs — the two codepoints a flag emoji is made of, and
   the prefix a language folder carries its country in. A source string in the
   contract because JSON has no regular expressions; `u` is what makes the
   \u{...} escapes mean codepoints rather than literal text. */
export const LANGUAGE_FLAG = new RegExp(VAULT_CONTRACT.languageFlagPattern, 'u')

export const isCodePath = (path) => CODE_EXT.test(path || '')
export const isDataPath = (path) => DATA_EXT.test(path || '')

/** How to split a row of the data file at `path` — the contract's delimiter for
 *  its extension, and a comma for anything that reached here without one. */
export const dataDelimiter = (path) => {
  const match = DATA_EXT.exec(path || '')
  return (match && DATA_DELIMITERS[match[1].toLowerCase()]) || ','
}

/** The word behind a source file's extension: `solve.py` → `py`, which is the
 *  spelling languages.js already knows as Python. Kept here because the
 *  extension is a path fact; what the word *means* is languages.js's business
 *  and is not restated in the contract. */
export const codeToken = (path) => {
  const match = CODE_EXT.exec(path || '')
  return match ? match[1].slice(1).toLowerCase() : ''
}

export const isTexPath = (path) => TEX_EXT.test(path || '')
export const isPdfPath = (path) => PDF_EXT.test(path || '')
export const isSitePath = (path) => SITE_EXT.test(path || '')
export const isWhiteboardPath = (path) => WHITEBOARD_EXT.test(path || '')
export const isNotebookPath = (path) => NOTEBOOK_EXT.test(path || '')

/** Whether the last segment carries an extension at all. A wikilink names a
 *  note without one — `[[Reading list]]` — and that is the difference between
 *  "a file of a kind nothing here handles" and "a note that may not exist
 *  yet". */
const HAS_EXT = /\.[^./]+$/

/**
 * A file the vault holds but has no view of its own for: a photograph, a
 * recording, a `.docx`, an archive.
 *
 * The vault is a folder on disk and people put things in folders. Everything
 * above this line is a kind Tulip knows how to *be* — a note, a paper, a board
 * — and everything else used to be simply absent: not in the tree, not in the
 * switcher, invisible in its own vault. It is listed now, and what opening one
 * means is decided at the door in renderer.js: text is text whatever it is
 * called, a picture gets a picture viewer, and what is left is described rather
 * than pretended at.
 */
export const isViewedFilePath = (path) => {
  const name = String(path || '').split('/').pop()
  if (!HAS_EXT.test(name)) return false
  return !NOTE_EXT.test(name) && !isTexPath(name) && !isPdfPath(name) &&
    !isSitePath(name) && !isWhiteboardPath(name) && !isDataPath(name) &&
    !isNotebookPath(name) && !isCodePath(name)
}

/* A file attached in the copilot's message box lives under the attachments
   folder but belongs to a conversation rather than to a note. Named here
   because the orphan sweep has to know: no note embeds these, and a sweep that
   did not know would call every screenshot anyone asked about clutter. */
const CHAT_ATTACHMENT_PREFIX =
  `${VAULT_CONTRACT.attachmentDirectory}/${VAULT_CONTRACT.chatImageDirectory}/`

export const isChatAttachment = (path) =>
  String(path || '').startsWith(CHAT_ATTACHMENT_PREFIX)

/** A path's last segment with the extension taken off — the name to show. */
export const noteName = (path) =>
  String(path || '').split('/').pop().replace(NOTE_EXT, '')
