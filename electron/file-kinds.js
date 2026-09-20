'use strict'

/* ================================================================== file-kinds
   Which extensions the vault treats as which thing, once they are past the
   name-and-kind questions vault-kinds.js answers: what is indexed for search,
   what the turn review snapshots, what a note may embed, what an attachment
   is served as, and which folders are walked into anyway.

   One module so the walk, the watcher, the search indexer and the turn
   review all read the same tables — a set defined twice is a set that will
   disagree. The reasoning for each set is beside it; the constants themselves
   project out of electron/vault-contract.json and electron/asset-kinds.json.
   ================================================================== */

const path = require('node:path')

const VAULT_CONTRACT = require('./vault-contract.json')
const {
  MD_EXT, TEXT_DOCUMENT_EXT,
  ATTACHMENT_DIR,
  TEX_EXT,
  PDF_EXT, SITE_EXT, WHITEBOARD_EXT,
  NOTEBOOK_EXT, DOCX_EXT,
  CODE_EXT, DATA_EXT
} = require('./vault-kinds')

const FINDER_DOCUMENT_EXT = new Set(['.csv', PDF_EXT])

/* A `.website` file is indexed too, and it is the cheapest entry in the whole
   table: two short lines. Search used to be unable to find one at all — a site
   was reachable only by already knowing what its file was called — and now
   that the file carries the page's title on a `#` line (see `writeAddress` in
   src/site.js) there is something to find it by. */
const isIndexedDocumentExt = (ext) =>
  TEXT_DOCUMENT_EXT.has(ext) || ext === NOTEBOOK_EXT || ext === SITE_EXT

/* Every other text document the Copilot can edit, for the turn review. The
   review card is built by diffing before/after snapshots, and a snapshot that
   read only notes and TeX made an agent's write to a notebook, a table or a
   script invisible — unreviewable, and unrejectable. Kind is decided here;
   how much of a file is worth holding two copies of is a question of bytes,
   answered in `readDocumentSnapshot`.

   Stated over an extension rather than a path: the vault walk derives each
   file's extension once and every consumer of it below shares that answer. */
const isReviewedDocumentExt = (ext) =>
  ext === NOTEBOOK_EXT || ext === SITE_EXT || ext === WHITEBOARD_EXT ||
  CODE_EXT.has(ext) || DATA_EXT.has(ext)

/* Highlights drawn on a PDF, mirroring the vault's own shape:
   `Papers/thesis.pdf` is annotated in `.annotations/Papers/thesis.pdf.json`.

   In the vault rather than beside the app's config, because a highlight is the
   reader's work and should travel with the folder it is about — and because the
   copilot, which has the vault open and nothing else, can then read what the
   reader marked. Dotted so it stays out of Finder and out of the sidebar. */
const ANNOTATION_DIR = VAULT_CONTRACT.annotationDirectory

/* Everything a note can embed. Anything outside this set is not offered to the
   renderer as an attachment, so a vault full of unrelated files does not turn
   into a list of things to link to.

   Derived from the same table src/assets.js reads, because the two answers have
   to agree: a format listed here but not there is offered as an attachment and
   then rendered as an unclickable chip, and the reverse is an embed that never
   resolves. Adding a format is one edit, in the JSON. */
const ASSET_KINDS = require('./asset-kinds.json')

const ASSET_EXT = new Set(
  Object.entries(ASSET_KINDS)
    .filter(([kind]) => !kind.startsWith('_'))
    .flatMap(([, exts]) => /** @type {string[]} */ (exts).map((ext) => `.${ext}`))
)

/* Which viewer a file of no particular kind wants, keyed by the already
   lower-cased extension the walk measured. The same four words src/assets.js
   uses for an embed — a picture is a picture whether a note points at it or
   the tree does — and `file` for everything with nothing to show, which the
   renderer describes rather than draws. */
const ASSET_KIND_BY_EXT = new Map(
  Object.entries(ASSET_KINDS)
    .filter(([kind]) => !kind.startsWith('_'))
    .flatMap(([kind, exts]) => /** @type {string[]} */ (exts).map((ext) => [`.${ext}`, kind]))
)

const showAs = (ext) => {
  const kind = ASSET_KIND_BY_EXT.get(ext)
  return kind === 'image' || kind === 'video' || kind === 'audio' ? kind : 'file'
}

/* The snapshot's file list feeds only these consumers. Do not retain every
   regular file in a vault just to filter it into four arrays after the walk —
   attachment folders often contain thumbnails, exports, and other unrelated
   data.

   Over an extension, so the walk can ask this of a file it has already
   measured; `isSnapshotFile` is the same test for the callers that still hold
   a path. */
const isSnapshotExt = (ext) =>
  MD_EXT.has(ext) || ASSET_EXT.has(ext) ||
  ext === TEX_EXT || ext === PDF_EXT || ext === DOCX_EXT ||
  isReviewedDocumentExt(ext)

const isSnapshotFile = (p) =>
  isSnapshotExt(path.extname(String(p || '')).toLowerCase())

/* Source and data files are here for one bucket only: `documents`, the list the
   turn review's before/after snapshot is read from. They are still not
   *indexed* — every other bucket the snapshot sorts this list into is
   Markdown-shaped, built from headings, wikilinks, tags and frontmatter, and a
   Python file has none of those, so none of them can hold one. Dropping them
   from the walk entirely, which is what this used to do, is what made
   `documents` permanently empty: an agent could rewrite a `.cpp`, a `.csv` or a
   notebook and the turn ended with no review card and nothing to reject,
   however carefully `isReviewedDocumentExt` said otherwise.

   Searching inside them is a real thing to want and a different feature: it
   needs an index that is about lines rather than about notes. */

/* What each of those is served as. Only the range replies need this — see
   `_mime_comment` in the JSON — and anything not named there is a download
   rather than something a page can play. */
const assetMime = (p) =>
  ASSET_KINDS._mime[path.extname(p).toLowerCase().slice(1)] || 'application/octet-stream'

/* Everything a note carries with it — pasted pictures, and the videos and
   drawings rendered out of its own blocks — lands in
   `<vault>/.attachments/<Note name>/`. Dotted so the folder stays out of
   Finder and out of the sidebar, because attachments belong *to* the notes
   rather than beside them, and one folder per note so a vault's files are
   grouped the way its prose is.

   Named `.images` until 2026-07-28, which was already wrong when a note could
   render a video into it. Vaults written under the old name are moved on open
   — see `migrateAttachments` — and the old name is still walked, so a vault
   the migration could not finish keeps resolving its embeds either way. */
const LEGACY_ATTACHMENT_DIRS = ['.images']

/** Hidden folders the vault walk descends into anyway, because notes point at
 *  what is inside them. */
const ATTACHMENT_DIRS = new Set([ATTACHMENT_DIR, ...LEGACY_ATTACHMENT_DIRS])

/* Where a picture pasted into the copilot's message box is filed, inside the
   attachments folder. Its own folder because it belongs to a conversation and
   not to a note: dropped into a note's folder it would sit among that note's
   embeds, and the attachment sweep would have to decide whether an image no
   note embeds is rubbish. */
const CHAT_IMAGE_DIR = VAULT_CONTRACT.chatImageDirectory

module.exports = {
  FINDER_DOCUMENT_EXT,
  isIndexedDocumentExt,
  isReviewedDocumentExt,
  ANNOTATION_DIR,
  ASSET_EXT,
  showAs,
  isSnapshotExt,
  isSnapshotFile,
  assetMime,
  LEGACY_ATTACHMENT_DIRS,
  ATTACHMENT_DIRS,
  CHAT_IMAGE_DIR
}
