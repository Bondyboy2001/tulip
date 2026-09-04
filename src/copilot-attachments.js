/* Attachment naming for the copilot panel.
   Split out of src/copilot.js: pure helpers with no DOM state. */
import { assetKind } from './assets.js'
import { NOTE_EXT, isLanguageTablePath, isPdfPath, isSitePath, isTexPath, isWhiteboardPath } from './vault-paths.js'

/** A filename, kept intact for the attachment card rather than shortened to
 *  the extensionless document titles used elsewhere in the panel. */
export const attachmentName = (path) => String(path || '').split('/').pop() || 'Attachment'

export const attachmentExtension = (path) => {
  const name = attachmentName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function attachmentKind (path) {
  if (isLanguageTablePath(path)) return 'language'
  if (isTexPath(path)) return 'tex'
  if (isPdfPath(path)) return 'pdf'
  if (isSitePath(path)) return 'site'
  if (isWhiteboardPath(path)) return 'whiteboard'
  if (NOTE_EXT.test(path || '')) return 'note'
  return assetKind(path)
}

const ATTACHMENT_TYPES = {
  note: 'Markdown',
  language: 'Language table',
  pdf: 'PDF',
  tex: 'TeX',
  site: 'Website',
  whiteboard: 'Whiteboard',
  video: 'Video',
  audio: 'Audio'
}

export function attachmentType (kind, path) {
  if (ATTACHMENT_TYPES[kind]) return ATTACHMENT_TYPES[kind]
  const suffix = attachmentExtension(path)
  return suffix ? suffix.toUpperCase() : 'File'
}
