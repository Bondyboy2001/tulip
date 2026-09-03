'use strict'

const path = require('node:path')

const SCRATCH_EXTENSIONS = new Set([
  '.tmp', '.temp', '.part', '.partial', '.crdownload', '.download',
  '.lock', '.bak', '.orig', '.swp', '.swo', '.swx'
])

/** Decide which caches an external fs.watch event can actually affect.
 *  Missing names and directory-like unknowns stay conservative; known hidden
 *  app/tool state never wakes the renderer or starts a recursive vault scan. */
function classifyVaultEvent (filename, {
  ignoredDirs,
  attachmentDirs,
  noteExtensions,
  texExtension,
  pdfExtension,
  siteExtension,
  whiteboardExtension,
  notebookExtension,
  docxExtension,
  documentExtensions,
  assetExtensions
}) {
  if (!filename) {
    return { ignore: false, index: true, snapshot: true, notify: true, pdf: 'sweep', path: '' }
  }

  const relative = String(filename).replaceAll('\\', '/').replace(/^\/+/, '')
  const parts = relative.split('/').filter(Boolean)
  if (!parts.length) {
    return { ignore: false, index: true, snapshot: true, notify: true, pdf: 'sweep', path: '' }
  }

  const root = parts[0]
  if (ignoredDirs.has(root) || (root.startsWith('.') && !attachmentDirs.has(root))) {
    return { ignore: true, index: false, snapshot: false, notify: false, pdf: null, path: relative }
  }

  /* Word's own owner file. Opening a `.docx` writes `~$Report.docx` beside it
     and deleting it closes the document again, so a reader with Word open on a
     vault file generates a pair of events per session for a file that is not a
     document at all — and, being a `.docx` by extension, one that would
     otherwise reach the renderer and the index. It is not hidden by the leading
     dot rule because it does not begin with a dot. */
  const leaf = parts[parts.length - 1]
  if (leaf.startsWith('~$')) {
    return { ignore: true, index: false, snapshot: false, notify: false, pdf: null, path: relative }
  }

  const extension = path.posix.extname(relative).toLowerCase()
  /* Scratch: what editors, downloads, sync clients and this app's own atomic
     writes leave beside a file for a moment. None of it is a document, and
     none of it used to be named here, so each one fell through to the
     fallback at the end — a re-index, a snapshot, a renderer notification and
     a stat of every PDF in the vault, per temp file. A hidden leaf (`.DS_Store`,
     an editor's `.#lock`) is the same case with no extension to name. The
     rename that finishes an atomic write arrives as its own event, under the
     real name, and is handled as before. */
  if (SCRATCH_EXTENSIONS.has(extension) || leaf.startsWith('.')) {
    return { ignore: true, index: false, snapshot: false, notify: false, pdf: null, path: relative }
  }
  if (attachmentDirs.has(root)) {
    return { ignore: false, index: false, snapshot: true, notify: true, pdf: null, path: relative }
  }
  if (noteExtensions.has(extension)) {
    return { ignore: false, index: true, snapshot: true, notify: true, pdf: null, path: relative }
  }
  if (extension === texExtension) {
    return { ignore: false, index: false, snapshot: true, notify: true, pdf: null, path: relative }
  }
  if (extension === whiteboardExtension) {
    return { ignore: false, index: true, snapshot: true, notify: true, pdf: null, path: relative }
  }
  if (extension === pdfExtension) {
    return { ignore: false, index: false, snapshot: true, notify: true, pdf: relative, path: relative }
  }
  /* A notebook reaches the renderer — a Jupyter running beside Tulip and
     writing to the same file is the ordinary way to have one — and reaches the
     search index too, which holds its cells' sources. Named rather than left
     to the fallback below, which would answer every autosave from that Jupyter
     with a sweep of every PDF in the vault. */
  if (extension === notebookExtension) {
    return { ignore: false, index: true, snapshot: true, notify: true, pdf: null, path: relative }
  }
  /* A Word document. Not indexed by the note index — headings, wikilinks and
     tags are what that index is made of, and WordprocessingML has none of them;
     its own `docxIndex` is filled by the vault walk instead. Named here for the
     same reason the notebook above is: left to the fallback at the end, every
     autosave Word makes to an open document answered with a full recursive
     re-index of the vault *and* an extraction sweep of every PDF in it. */
  if (extension === docxExtension) {
    return { ignore: false, index: true, snapshot: true, notify: true, pdf: null, path: relative }
  }
  /* Source, data and plain-text files: documents in every way the app cares
     about — they open in the editor, they are autosaved, they are versioned,
     and their text sits in the document index so search can find it. Named for
     the same reason the notebook above is: left to the fallback, one `.py`
     written by an agent working beside Tulip answered with an extraction sweep
     of every PDF in the vault, once per write. `index` here reaches the
     targeted sync — one stat and, if the file moved, one read — never the full
     walk. */
  if (documentExtensions?.has(extension)) {
    return { ignore: false, index: true, snapshot: true, notify: true, pdf: null, path: relative }
  }
  if (extension === siteExtension || assetExtensions.has(extension)) {
    return { ignore: false, index: false, snapshot: true, notify: true, pdf: null, path: relative }
  }

  // Usually a directory rename, for which fs.watch supplies only the directory
  // name. It may contain any supported kind, so retain the old broad fallback.
  return { ignore: false, index: true, snapshot: true, notify: true, pdf: 'sweep', path: relative }
}

module.exports = { classifyVaultEvent }
