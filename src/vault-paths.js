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

/* A language table is `Name.language.md` — the `.language` is part of the
   extension for the purpose of stripping it, so the tree shows "Spanish" and
   not "Spanish.language". */
export const NOTE_EXT =
  new RegExp(`(?:\\.language)?\\.(${noteExtAlternation})$`, 'i')

export const PDF_EXT = new RegExp(`${escapeRe(VAULT_CONTRACT.pdfExtension)}$`, 'i')
export const SITE_EXT = new RegExp(`${escapeRe(VAULT_CONTRACT.siteExtension)}$`, 'i')

/* Regional-indicator pairs — the two codepoints a flag emoji is made of, and
   the prefix a language folder carries its country in. A source string in the
   contract because JSON has no regular expressions; `u` is what makes the
   \u{...} escapes mean codepoints rather than literal text. */
export const LANGUAGE_FLAG = new RegExp(VAULT_CONTRACT.languageFlagPattern, 'u')

export const isPdfPath = (path) => PDF_EXT.test(path || '')
export const isSitePath = (path) => SITE_EXT.test(path || '')

/* A picture pasted into the copilot's message box, which lives under the
   attachments folder like every other image but belongs to a conversation
   rather than to a note. Named here because the orphan sweep has to know: no
   note embeds these, and a sweep that did not know would call every screenshot
   anyone ever asked a question about clutter. */
const CHAT_IMAGE_PREFIX =
  `${VAULT_CONTRACT.attachmentDirectory}/${VAULT_CONTRACT.chatImageDirectory}/`

export const isChatImage = (path) => String(path || '').startsWith(CHAT_IMAGE_PREFIX)

/** A path's last segment with the extension taken off — the name to show. */
export const noteName = (path) =>
  String(path || '').split('/').pop().replace(NOTE_EXT, '')
