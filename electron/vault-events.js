'use strict'

const path = require('node:path')

/** Decide which caches an external fs.watch event can actually affect.
 *  Missing names and directory-like unknowns stay conservative; known hidden
 *  app/tool state never wakes the renderer or starts a recursive vault scan. */
function classifyVaultEvent (filename, {
  ignoredDirs,
  attachmentDirs,
  noteExtensions,
  pdfExtension,
  siteExtension,
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

  const extension = path.posix.extname(relative).toLowerCase()
  if (attachmentDirs.has(root)) {
    return { ignore: false, index: false, snapshot: true, notify: true, pdf: null, path: relative }
  }
  if (noteExtensions.has(extension)) {
    return { ignore: false, index: true, snapshot: true, notify: true, pdf: null, path: relative }
  }
  if (extension === pdfExtension) {
    return { ignore: false, index: false, snapshot: true, notify: true, pdf: relative, path: relative }
  }
  if (extension === siteExtension || assetExtensions.has(extension)) {
    return { ignore: false, index: false, snapshot: true, notify: true, pdf: null, path: relative }
  }

  // Usually a directory rename, for which fs.watch supplies only the directory
  // name. It may contain any supported kind, so retain the old broad fallback.
  return { ignore: false, index: true, snapshot: true, notify: true, pdf: 'sweep', path: relative }
}

module.exports = { classifyVaultEvent }
