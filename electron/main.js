'use strict'

const {
  app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme, protocol, net, session,
  clipboard, utilityProcess, Notification
} = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { TurnLedger, turnId } = require('./ai-turns')
const { mergeChatHistory } = require('./chat-history')
const { restoreConflicts } = require('./copilot-restore')
const { TrustStore } = require('./trust-store')
const { makeStore: makeReviewStore } = require('./review-store')
const { makeIndexCache } = require('./index-cache')
const { makeSelfWrites } = require('./self-writes')
const { mapLimit, WALK_LIMIT } = require('./map-limit')
/* Which files a run wrote, and which it may take back. Lifted out so the
   deletion guards can be tested directly — see electron/run-pages.js. */
const { htmlFilesIn, collectRunPages } = require('./run-pages')
/* The per-note search scan. Lifted out of this file so it can be
   benchmarked directly — see electron/search-scan.js. */
const { findSpots, hitLines } = require('./search-scan')
const {
  REQUEST_PATH: AI_RENAME_REQUEST,
  isRequestPath: isAiRenameRequest,
  parseRequest: parseAiRenameRequest
} = require('./copilot-rename')
const {
  REQUEST_PATH: AI_SEARCH_REQUEST,
  RESULTS_PATH: AI_SEARCH_RESULTS,
  isRequestPath: isAiSearchRequest,
  parseRequest: parseAiSearchRequest
} = require('./copilot-search')
const { makeStore: makeLanguageHistoryStore } = require('./language-history-store')
const { classifyVaultEvent } = require('./vault-events')
const { narrowsFrom } = require('./search-narrow')
const { parseByteRange, streamFileRange } = require('./range-response')
const { ocrPagesOf, parsePages, relevantPdfContext } = require('./pdf-context')
const { sanitizeConfigPatch } = require('./config-keys')
/* Per-path sidecars — tags, table layouts — and the two calls that keep every
   one of them following a rename and forgotten on a delete. */
const { makePathStore, relocateAll, forgetAll, resetAll } = require('./path-store')
/* Where a `python` block's interpreter comes from, and what happens when the
   import it needs is not installed — see electron/python-env.js. */
const { makePythonEnvs, missingPackage, hasInlineDeps } = require('./python-env')
const { safeFileName } = require('./safe-name')
const { parseFrontmatter, propsOf, propValues } = require('./frontmatter.cjs')
const { emptyWhiteboard, whiteboardText } = require('./whiteboard-data')
const { killTree } = require('./kill-tree')
const PDF_TEXT_FORMAT = require('./pdf-text-format.json').version
const VAULT_CONTRACT = require('./vault-contract.json')
const WEB_PARTITIONS = require('./web-partitions.json')
/* The one address a guest may fetch, shared with the renderer that writes it
   into the scene's document — see src/threejs.js. */
const GUEST_LIBRARY = require('./guest-library.json')

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json')

/* ------------------------------------------------------------ crash guard

   Electron kills the process on an unhandled rejection, and the main process
   is what holds the autosave timer, the durability checkpoint and the trust
   store — so a stray rejection from a closed window or a dead child pipe can
   take the vault's pending writes with it.

   These handlers keep the app alive, but they never swallow: every throw is
   written to `crash.log` in the app's data directory with a timestamp, so the
   thing that would have shown up as "Tulip vanished" shows up as a line to
   read instead. */

const CRASH_LOG = () => path.join(app.getPath('userData'), 'crash.log')
const CRASH_LOG_MAX = 512 * 1024

function logCrash (kind, err) {
  const detail = err instanceof Error ? (err.stack || err.message) : String(err)
  console.error(`[${kind}]`, err)
  try {
    const file = CRASH_LOG()
    fsSync.mkdirSync(path.dirname(file), { recursive: true })
    /* Truncate rather than rotate: this file is read by a person looking for
       what just happened, and a crash loop should not be able to fill a disk. */
    if (fsSync.statSync(file, { throwIfNoEntry: false })?.size > CRASH_LOG_MAX) {
      fsSync.truncateSync(file, 0)
    }
    fsSync.appendFileSync(file, `${new Date().toISOString()} ${kind}\n${detail}\n\n`)
  } catch {
    // Logging the failure to log it would be the next thing to fail.
  }
}

process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason))
process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err)
  /* The vault is the part worth saving. Best effort, and guarded: these run
     inside an already-broken process. */
  try { flushDurabilitySync() } catch { /* nothing left to try */ }
  try { trust?.flushSync() } catch { /* nothing left to try */ }
  try { flushConfig() } catch { /* nothing left to try */ }
})

const IGNORED_DIRS = new Set(['.git', '.obsidian', '.tulip', 'node_modules', '.trash'])

/** A literal string, as a pattern that matches only itself. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const MD_EXT = new Set(VAULT_CONTRACT.noteExtensions)

/* The same expression src/vault-paths.js builds for the renderer, from the same
   contract. Both sides strip a note's extension when they turn a path into a
   name, and a link resolves by comparing those names — so the two spellings
   drifting apart is a wikilink that points at a note the tree is showing. */
const NOTE_EXT = new RegExp(
  `\\.(${VAULT_CONTRACT.noteExtensions
    .map((ext) => escapeRe(ext.replace(/^\./, ''))).join('|')})$`,
  'i'
)

/* The other document kinds a vault holds. Only `file:rename` needs them together —
   it strips whatever extension the typed name carries, whichever kind was
   renamed — and stating them as one expression is what keeps that list from
   being the place a newly supported kind is forgotten. */
const DOCUMENT_EXT = new RegExp(
  `(${[
    VAULT_CONTRACT.texExtension,
    VAULT_CONTRACT.pdfExtension,
    VAULT_CONTRACT.siteExtension,
    VAULT_CONTRACT.whiteboardExtension,
    VAULT_CONTRACT.notebookExtension,
    ...VAULT_CONTRACT.codeExtensions,
    ...Object.keys(VAULT_CONTRACT.dataExtensions)
  ]
    .map(escapeRe).join('|')})$`,
  'i'
)
const TEX_EXT = VAULT_CONTRACT.texExtension
const isTex = (p) => path.extname(String(p || '')).toLowerCase() === TEX_EXT
const LANGUAGE_TABLE_SUFFIX = VAULT_CONTRACT.languageTableSuffix
const LANGUAGE_FLAG = new RegExp(VAULT_CONTRACT.languageFlagPattern, 'u')
const isLanguageTable = (p) =>
  String(p || '').toLowerCase().endsWith(LANGUAGE_TABLE_SUFFIX)
const languageTableStem = (p) => {
  const name = path.basename(String(p || ''))
  return path.basename(name, path.extname(name))
}
const {
  vocabulary: LANGUAGE_TABLE_TEMPLATE,
  custom: CUSTOM_TABLE_TEMPLATE
} = VAULT_CONTRACT.languageTableTemplates
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

/* Every other text document the Copilot can edit, for the turn review. The
   review card is built by diffing before/after snapshots, and a snapshot that
   read only notes and TeX made an agent's write to a notebook, a table or a
   script invisible — unreviewable, and unrejectable. Kind is decided here;
   how much of a file is worth holding two copies of is a question of bytes,
   answered in `readDocumentSnapshot`. */
const isReviewedDocument = (p) =>
  isNotebook(p) || isSite(p) || isWhiteboard(p) || isCode(p) || isData(p)

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
    .flatMap(([, exts]) => exts.map((ext) => `.${ext}`))
)

/* Which viewer a file of no particular kind wants, by extension alone. The
   same four words src/assets.js uses for an embed — a picture is a picture
   whether a note points at it or the tree does — and `file` for everything
   with nothing to show, which the renderer describes rather than draws. */
const ASSET_KIND_BY_EXT = new Map(
  Object.entries(ASSET_KINDS)
    .filter(([kind]) => !kind.startsWith('_'))
    .flatMap(([kind, exts]) => exts.map((ext) => [`.${ext}`, kind]))
)

const showAs = (name) => {
  const kind = ASSET_KIND_BY_EXT.get(path.extname(name).toLowerCase())
  return kind === 'image' || kind === 'video' || kind === 'audio' ? kind : 'file'
}

/* The snapshot's file list feeds only these consumers. Do not retain every
   regular file in a vault just to filter it into four arrays after the walk —
   attachment folders often contain thumbnails, exports, and other unrelated
   data. */
const isSnapshotFile = (p) => {
  const extension = path.extname(String(p || '')).toLowerCase()
  return MD_EXT.has(extension) || ASSET_EXT.has(extension) ||
    isTex(p) || isPdf(p) || isDocx(p) || isReviewedDocument(p)
}

/* Source and data files are here for one bucket only: `documents`, the list the
   turn review's before/after snapshot is read from. They are still not
   *indexed* — every other bucket the snapshot sorts this list into is
   Markdown-shaped, built from headings, wikilinks, tags and frontmatter, and a
   Python file has none of those, so none of them can hold one. Dropping them
   from the walk entirely, which is what this used to do, is what made
   `documents` permanently empty: an agent could rewrite a `.cpp`, a `.csv` or a
   notebook and the turn ended with no review card and nothing to reject,
   however carefully `isReviewedDocument` said otherwise.

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
const ATTACHMENT_DIR = VAULT_CONTRACT.attachmentDirectory
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

/* The renderer reaches attachments through this scheme rather than file://,
   which the page's CSP does not admit. It has to be declared before the app is
   ready, so both sit at module scope.

   `tulip-app` serves the app's own bundle — the window's document and every
   script, stylesheet and font under dist/. It exists for ONE privilege that
   `file:` cannot be given: `codeCache`. Chromium keeps no V8 code cache for a
   file:// page, so around 570KB of real code (CodeMirror, lezer, markdown-it)
   was parsed and compiled from source on every single launch, and the same
   compile was thrown away at every quit. Served from here that work is done
   once and read back from the cache afterwards.

   `codeCache` requires `standard: true` — the two are documented together, and
   without the second the first is quietly ignored. `secure: true` keeps the
   page a secure context, which the existing CSP, the fonts and the workers all
   already assume. It is deliberately NOT `corsEnabled`: nothing cross-origin
   should be reading the app's own bundle. */
protocol.registerSchemesAsPrivileged([{
  scheme: 'tulip-file',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: true
  }
}, {
  scheme: 'tulip-app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    codeCache: true
  }
}])

/* The window's own address, and the escape hatch back to the old one.

   `TULIP_NO_APP_SCHEME=1` sends the window to `loadFile` instead, which is
   what this replaced. It is here for two reasons: bench/boot-bench.mjs takes
   both halves of its comparison from one build, and a protocol handler that
   turns out to be broken on someone's machine has a way to be ruled out
   without a rebuild. */
const APP_ORIGIN = 'tulip-app://app'
const useAppScheme = () => process.env.TULIP_NO_APP_SCHEME !== '1'

/* ==================================================================== windows
   Every window Tulip has open, and the two questions the rest of the file asks
   about them: send this to all of them, or send it to the one being used?

   There used to be a single `mainWindow`, and the difference did not arise. It
   arises everywhere now, and getting it wrong is not a crash — it is a ⌘S that
   saves the note in a window you are not looking at. So the choice is made at
   every call, by the name of the function called: `broadcast` for facts about
   the vault, which are true in every window at once, and `toFocused` for
   commands, which mean "here".

   ONE OF THEM IS THE PRIMARY WINDOW: the first one opened, and the one whose
   tab strip is the session that comes back at launch. Two windows writing
   `tabs` to a single config file would each overwrite the other's; rather than
   invent a merge for a shallow config, the second window keeps its strip for as
   long as it is open and writes none of it down. The copilot is the primary
   window's too — see `copilotWindow`. */
const windows = new Set()
let primaryWindow = null

/** The windows that still exist — a closed one lingers in the set until its
 *  own `closed` handler runs, and a destroyed one throws when written to. */
const liveWindows = () => [...windows].filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed())

/**
 * The window a command is about.
 *
 * The focused one, and the primary as the fallback for the moment when nothing
 * of ours has the focus — a menu picked from the dock, or a shortcut arriving
 * while a native dialog holds the keyboard. Doing nothing there would make the
 * menu look broken; doing it in every window would be worse than that.
 */
function focusedWindow () {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && windows.has(focused)) return focused
  const live = liveWindows()
  return live.includes(primaryWindow) ? primaryWindow : live[0] || null
}

/** The window that owns the copilot: the primary one, always. */
const copilotWindow = () => (primaryWindow && !primaryWindow.isDestroyed() ? primaryWindow : null)

/** A fact about the vault or the app — true in every window, so said to each. */
function broadcast (channel, payload) {
  for (const win of liveWindows()) win.webContents.send(channel, payload)
}

/** A command, to the window it is a command about. */
function toFocused (channel, payload) {
  sendTo(focusedWindow(), channel, payload)
}

/** The window an IPC call came from — for the handlers that answer a window
 *  rather than the app: a save dialog belongs over the page that opened it. */
const windowOf = (event) => BrowserWindow.fromWebContents(event.sender)

/** To one named window, if it is still there to hear it. */
function sendTo (win, channel, payload) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

let vaultPath = null
let kernels = null
let aiInstance = null

const cleanFileTags = (values) => {
  const tags = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().replace(/^#+/, '').toLowerCase())
    .filter(Boolean))]
  // Falsy for the store, which is how "no tags" becomes no entry at all.
  return tags.length ? tags : null
}

/* Tags a reader put on a file from outside its text. The index is built partly
   from these, so a write invalidates it. */
const fileTags = makePathStore({
  name: 'file-tags',
  vault: () => vaultPath,
  clean: cleanFileTags,
  onSave: () => { indexGeneration++ }
})

/* How wide the columns of a table were left. A `.csv` has nowhere inside it to
   record that — the file is the data and nothing else — so fitting the columns
   of a big export used to be undone by closing the tab. A width below the
   minimum, or a list that is not one, is not a layout and is not kept. */
const MIN_STORED_COLUMN = 40
const MAX_STORED_COLUMN = 4000

/* What a table may be separated by. The grid offers exactly these, and a
   stored value that is not one of them is not a delimiter — it is something
   that got into the file some other way, and is dropped rather than used to
   split somebody's data. */
const STORED_DELIMITERS = new Set([',', ';', '\t', '|'])

/* Which way a column was pointed by hand. Three answers and no others; a
   fourth is not an alignment and is dropped, leaving that column to read the
   way its content implies. */
const STORED_ALIGNMENTS = new Set(['left', 'center', 'right'])

const tableWidths = makePathStore({
  name: 'table-widths',
  vault: () => vaultPath,
  /* Two shapes, because this store predates the second half of what it holds.
     A bare array is a layout written before delimiters were kept and still
     means what it always did; `{ widths, delimiter }` is the current shape. An
     old sidecar therefore keeps working untouched, and is rewritten into the
     new shape the next time a column is dragged. */
  clean: (value) => {
    const list = Array.isArray(value) ? value : value?.widths
    const delimiter = Array.isArray(value) ? null : value?.delimiter
    if (!Array.isArray(list) || !list.length || list.length > 2000) return null
    const widths = list.map((width) => Math.round(Number(width)))
    const usable = widths.every((width) =>
      Number.isFinite(width) && width >= MIN_STORED_COLUMN && width <= MAX_STORED_COLUMN)
    if (!usable) return null
    /* One entry per column or nothing: a list of another length describes a
       different table, and pinning it on would point the wrong columns. Nulls
       are the columns nobody has said anything about, and a list that is all
       nulls is not worth keeping. */
    const asked = Array.isArray(value) ? null : value?.aligns
    const aligns = Array.isArray(asked) && asked.length === widths.length
      ? asked.map((how) => (STORED_ALIGNMENTS.has(how) ? how : null))
      : null
    const kept = { widths }
    if (aligns && aligns.some(Boolean)) kept.aligns = aligns
    if (STORED_DELIMITERS.has(delimiter)) kept.delimiter = delimiter
    return kept
  }
})
let watcher = null
let trust = null

/* The scheduler's memory. Reads `vaultPath` through a function rather than
   being rebuilt on every vault switch: the store keys everything on the vault
   it was asked about, and re-reads when that changes. */
const review = makeReviewStore({ vault: () => vaultPath || '' })
/* When a language row first became complete and when it last changed. Kept in
   the same hidden vault state area as review history, not in visible columns. */
const languageHistory = makeLanguageHistoryStore({ vault: () => vaultPath || '' })

/* ---------------------------------------------------------------- config */

/* Held in memory after the first read — main is the only writer, so the file
   cannot change underneath it. Persistence is debounced (a pinch zoom is a
   burst of writes) and goes through `writeAtomic`, so a crash mid-write cannot
   leave a half-written config behind. */
let config = null
let configTimer = null

/** @returns {Record<string, any>} */
function readConfig () {
  if (!config) {
    try {
      config = JSON.parse(fsSync.readFileSync(CONFIG_PATH(), 'utf8'))
    } catch {
      config = {}
    }
  }
  return config
}

function writeConfig (patch) {
  config = { ...readConfig(), ...patch }
  clearTimeout(configTimer)
  configTimer = setTimeout(persistConfig, 300)
  return config
}

async function persistConfig () {
  configTimer = null
  try {
    await fs.mkdir(path.dirname(CONFIG_PATH()), { recursive: true })
    await writeAtomic(CONFIG_PATH(), JSON.stringify(config, null, 2))
  } catch (err) {
    console.error('config write failed', err)
  }
}

/* On quit there is no later for a debounced write, so it lands synchronously —
   still through a rename, for the same reason as everywhere else. */
function flushConfig () {
  if (!configTimer) return
  clearTimeout(configTimer)
  configTimer = null
  try {
    fsSync.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true })
    const tmp = `${CONFIG_PATH()}.${process.pid}.tmp`
    fsSync.writeFileSync(tmp, JSON.stringify(config, null, 2))
    fsSync.renameSync(tmp, CONFIG_PATH())
  } catch (err) {
    console.error('config write failed', err)
  }
}

/* ------------------------------------------------------------ path guard */

/**
 * Every renderer-supplied path is resolved against the vault and rejected if it
 * escapes. The renderer is untrusted by construction, so this is the only place
 * that decides what counts as "inside the vault".
 */
function safePath (relOrAbs) {
  if (!vaultPath) throw new Error('No vault is open.')
  const abs = path.resolve(vaultPath, relOrAbs)
  const root = path.resolve(vaultPath)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Path is outside the vault.')
  }
  return abs
}

/** As `safePath`, for handlers that change or remove what they name. The root
 *  is a fine place to read or create into, but never a thing to rename, move
 *  or delete — `file:delete('')` must not trash the vault itself. */
function safeTargetPath (relOrAbs) {
  const abs = safePath(relOrAbs)
  if (abs === path.resolve(vaultPath)) throw new Error('That is the vault itself.')
  return abs
}

/**
 * The lexical check in `safePath` cannot see a symlink: a link *inside* the
 * vault can point anywhere on disk, and reading through it would serve
 * whatever it points at. Handlers that hand file contents out re-check where
 * the path really leads — via the deepest ancestor that exists, so a file not
 * yet written still passes on its directory's account.
 */
/* The vault's own real path, resolved once per vault rather than once per
   check. The hot caller is the tulip-file:// handler, which serves every
   embedded image and every font and cmap pdf.js asks for — a note of thirty
   pictures was thirty resolutions of a root that had not moved. Keyed on the
   vault so opening another one re-resolves without either assignment site
   having to remember to clear it. Failing to resolve caches nothing that could
   widen the check: a stale root only ever rejects. */
let realRoot = { of: null, real: null }

async function vaultRealRoot () {
  const root = path.resolve(vaultPath)
  if (realRoot.of !== root) {
    realRoot = { of: root, real: await fs.realpath(root).catch(() => root) }
  }
  return realRoot.real
}

async function assertReal (from) {
  const root = await vaultRealRoot()
  let probe = from
  for (;;) {
    let real
    try {
      real = await fs.realpath(probe)
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
      continue
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new Error('Path is outside the vault.')
    }
    break
  }
}

async function realSafePath (relOrAbs) {
  const abs = safePath(relOrAbs)
  await assertReal(abs)
  return abs
}

/**
 * As `safeTargetPath`, for the handlers that rename, move or delete.
 *
 * The lexical guard is as blind here as it is on the read side, and a write is
 * the worse place to be blind: a directory link inside the vault points
 * anywhere on disk, and creating or trashing *through* it lands outside. This
 * is the same check `realSafePath` makes, applied to the half of the IPC
 * surface that changes things rather than the half that reads them.
 *
 * The last component is deliberately left unresolved. A symlink in the vault is
 * itself a vault entry, and renaming or trashing one acts on the link and not
 * on whatever it points at — resolving it here would refuse the one operation
 * that tidies away a link the read guard has already made unopenable. What has
 * to be inside the vault is where the entry *lives*, so the parent is what gets
 * resolved.
 */
async function realSafeTargetPath (relOrAbs) {
  const abs = safeTargetPath(relOrAbs)
  await assertReal(path.dirname(abs))
  return abs
}

/* Every walk of the vault runs every path it finds through here, so the common
   case is spelled out rather than handed to `path.relative`: an absolute path
   under the vault is the vault's own prefix and then the rest, and slicing it
   off is a third of what normalising both sides and diffing them costs. The
   general answer stays for anything that is not under the vault — `realpath`
   resolves symlinks, and a link pointing outward has to come back as `..`. */
function rel (abs) {
  const root = vaultPath + path.sep
  return abs.startsWith(root)
    ? abs.slice(root.length).split(path.sep).join('/')
    : path.relative(vaultPath, abs).split(path.sep).join('/')
}

/* The app's own bundled files, for the one thing that asks for them by URL —
   pdf.js, whose worker loads fonts and decoders as it needs them. `dist` sits
   beside `electron` both in the checkout and inside the packaged bundle. */
const DIST = path.join(__dirname, '..', 'dist')

function appAsset (relPath) {
  const abs = path.resolve(DIST, relPath)
  if (abs !== DIST && !abs.startsWith(DIST + path.sep)) {
    throw new Error('Path is outside the app.')
  }
  return abs
}

const stripExt = (p) => p.replace(NOTE_EXT, '')

/**
 * An absolute path inside `dir` that nothing occupies: `<base><ext>`, or
 * `<base> 2<ext>` and upward. Every route by which a file enters the vault —
 * new note, new folder, move, import, pasted attachment — names it through
 * here, so the collision rule is stated once.
 */
function freeName (dir, base, ext = '') {
  const clean = base.replace(/[/\\]/g, '-').replace(/^\.+/, '') || 'Untitled'
  let target = path.join(dir, `${clean}${ext}`)
  let n = 1
  while (fsSync.existsSync(target)) target = path.join(dir, `${clean} ${++n}${ext}`)
  return target
}

/**
 * Pasted attachments always carry an explicit zero-based suffix. Besides
 * making their order obvious in Finder, this keeps a later paste predictable:
 * `saved-0.png`, `saved-1.png`, and upward, independent of the clipboard's
 * generic `image.png` name. Notes and folders retain `freeName`'s friendlier
 * unsuffixed-first convention.
 */
function freeAttachmentName (dir, base, ext) {
  const clean = base.replace(/[/\\]/g, '-').replace(/^\.+/, '') || 'Untitled'
  let n = 0
  let target = path.join(dir, `${clean}-${n}${ext}`)
  while (fsSync.existsSync(target)) target = path.join(dir, `${clean}-${++n}${ext}`)
  return target
}

/* ------------------------------------------------------------ note index */

/**
 * Every note's text, held in memory. Search used to re-read the whole vault on
 * each keystroke; now the disk is touched only for files whose mtime or size
 * moved since the last sync. The same index is what the link rewriter reads
 * when a rename has to be chased through the rest of the vault.
 */
const index = new Map()   // rel path -> { name, text, mtime, size }
const whiteboardIndex = new Map() // rel path -> extracted text, never image data
/* Word documents, on the same terms as whiteboards: a zip is not text, so what
   is held here is what electron/docx.js read out of one. Without it a `.docx`
   was a file the vault listed, opened and edited but could not find — and a
   search that silently skips a whole kind of document reads as "not in the
   vault" when it means "never looked". */
const docxIndex = new Map()       // rel path -> extracted text, never the zip

/* A note big enough to be a paste of a log file would cost more to hold than
   the search is worth; it is indexed as empty rather than skipped, so it still
   disappears from the index when it is deleted. */
/* How large a text document may be and still have every version of it kept.
 *
 * History holds each save whole — the text before and the text after — inside
 * one 4 MB budget shared by the entire vault, and evicts the oldest saves when
 * it overflows. That arrangement suits notes, which are prose and small. It
 * does not suit a data file: a 50 MB export autosaves the whole of itself
 * about a second after each pause in typing, and one such save would carry
 * 100 MB into a 4 MB store, evicting the recoverable history of every note in
 * the vault to make room for a version it cannot keep either. The same save
 * also has to read the previous 50 MB back off the disk to have something to
 * record, which is the cost paid whether or not the entry survives.
 *
 * This is the argument the comment beside `isTextDocument` already makes for
 * leaving notebooks out, applied by size rather than by extension — a large
 * `.md` is the same problem, and a small `.csv` is not a problem at all.
 *
 * Past this, the file is still written, still written atomically, and still
 * the vault's own text. It simply has no version history, the way a PDF or an
 * image does not.
 */
const MAX_VERSIONED_BYTES = 256 * 1024

const MAX_INDEX_BYTES = 4 * 1024 * 1024
const MAX_WHITEBOARD_INDEX_BYTES = 32 * 1024 * 1024
/* A Word document has to be unzipped and parsed before there is any text to
   index, so the cap is lower than a whiteboard's: past this the file is listed,
   opened and edited as usual, and search reports it as one it could not read
   rather than spending a second of every vault walk on it. */
const MAX_DOCX_INDEX_BYTES = 8 * 1024 * 1024

let indexDirty = true

/* Files the watcher named since the last sync, when it could name them. A
   single note saved by a sync client used to set `indexDirty` and cost a stat
   of every note, whiteboard and document in the vault — the classifier had
   worked out exactly which file moved, and the flag threw that away. These are
   synced one at a time; the full walk is kept for what genuinely needs it: a
   folder renamed, an event with no name, the app's own multi-file operations. */
const indexDirtyPaths = new Set()

/** Say the index is behind the disk — for one file when the file is known. */
function markIndexDirty (relPath) {
  if (indexDirty) return
  const ext = relPath ? path.posix.extname(relPath).toLowerCase() : ''
  const known = ext && (MD_EXT.has(ext) || ext === WHITEBOARD_EXT || ext === DOCX_EXT)
  if (known) indexDirtyPaths.add(relPath)
  else indexDirty = true
}
let syncing = null

/* The same index, on disk, so a launch does not start from nothing — see
   index-cache.js for what is and is not trusted about it. Rebuilt when the
   vault changes; null until there is a vault to have one for. */
let indexCache = null
/* Whether this process has already tried to seed the index from that file. One
   attempt per vault: after the first sync the Map in memory is the better copy
   of the two, and reading the file again could only put back something older. */
let indexCacheSeeded = false

const INDEX_CACHE_DIR = () => path.join(app.getPath('userData'), 'index-cache')

function useIndexCacheFor (dir) {
  indexCache = dir ? makeIndexCache({ dir: INDEX_CACHE_DIR(), vaultPath: dir }) : null
  indexCacheSeeded = false
}

/**
 * Fill the empty index from the last session's copy.
 *
 * Nothing here is believed: `syncIndex` checks every entry against the real
 * file's mtime and size before it uses one, exactly as it does for an entry it
 * put there itself a moment ago. What this saves is the read, not the check.
 */
async function seedIndexFromCache () {
  if (indexCacheSeeded || !indexCache || index.size) return
  indexCacheSeeded = true
  try {
    for (const [key, entry] of await indexCache.load()) index.set(key, entry)
  } catch (error) {
    /* A cache that cannot be read is a cache that is not used. Worth a line in
       the log, worth nothing else — the vault is still the source of truth. */
    logCrash('indexCache', error)
  }
}

/* Which state of the index an answer belongs to. Only the narrowed search
   below reads it: a result set held from the last keystroke describes the
   notes as they were, and one edit anywhere in the vault — the reader's own
   autosave included — is enough to make "the notes that matched" the wrong
   set to look in. Bumped by every writer of `index`, so the cache expires by
   being unable to recognise itself rather than by being remembered about. */
let indexGeneration = 0

/**
 * Brings the index back in line with the disk. `indexDirty` is cleared before
 * the walk, not after, so a change that lands mid-walk leaves the flag set and
 * the next caller syncs again rather than trusting a half-stale pass.
 */
async function syncIndex () {
  indexGeneration++
  if (!vaultPath) {
    index.clear()
    whiteboardIndex.clear()
    docxIndex.clear()
    indexDirtyPaths.clear()
    forgetLinkTables()
    return
  }

  /* Named files only, when that is all that moved. Each is stat'ed and, if it
     has changed, read — or dropped when it is gone — and nothing else in the
     vault is touched. A name that turns out to be a folder, or a file whose
     kind this cannot place, hands over to the full walk below. */
  if (!indexDirty && indexDirtyPaths.size) {
    const targeted = [...indexDirtyPaths]
    indexDirtyPaths.clear()
    let changed = false
    let fallBack = false
    await mapLimit(targeted, WALK_LIMIT, async (key) => {
      const abs = path.join(vaultPath, ...key.split('/'))
      const ext = path.posix.extname(key).toLowerCase()
      const table = MD_EXT.has(ext) ? index : ext === WHITEBOARD_EXT ? whiteboardIndex : docxIndex
      let stat
      try { stat = await fs.stat(abs) } catch {
        if (table.delete(key)) changed = true
        return
      }
      if (!stat.isFile()) { fallBack = true; return }
      const cached = table.get(key)
      if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return
      const entry = await indexEntryFor(abs, stat, ext)
      if (!entry) return
      table.set(key, entry)
      changed = true
    })
    if (!fallBack) {
      if (changed) {
        forgetLinkTables()
        saveIndexCache()
      }
      return
    }
    indexDirty = true
  }

  indexDirty = false
  indexDirtyPaths.clear()

  /* Before the walk, and only ever on the first sync of a vault: what the last
     session read, so the walk below has something to compare against instead
     of reading every note again. Each entry is still checked against the file
     it claims to be — see the loop. */
  await seedIndexFromCache()

  const { notes, whiteboards = [], docx = [] } = await getVaultSnapshot()

  /* Whether anything in any table moved. A walk that confirms every entry —
     the common outcome of a watcher event about something else — has nothing
     to write out, and used to serialize the whole vault to say so. */
  let changed = false

  const seen = new Set()
  await mapLimit(notes, WALK_LIMIT, async (abs) => {
    const key = rel(abs)
    seen.add(key)

    let stat
    try { stat = await fs.stat(abs) } catch { return }

    const cached = index.get(key)
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return

    let text = ''
    if (stat.size <= MAX_INDEX_BYTES) {
      try { text = await fs.readFile(abs, 'utf8') } catch { return }
    }
    index.set(key, {
      name: stripExt(path.basename(abs)),
      text,
      mtime: stat.mtimeMs,
      size: stat.size
    })
    changed = true
  })

  for (const key of [...index.keys()]) if (!seen.has(key)) { index.delete(key); changed = true }

  const seenWhiteboards = new Set()
  await mapLimit(whiteboards, WALK_LIMIT, async (abs) => {
    const key = rel(abs)
    seenWhiteboards.add(key)
    let stat
    try { stat = await fs.stat(abs) } catch { return }
    const cached = whiteboardIndex.get(key)
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return
    let text = ''
    if (stat.size <= MAX_WHITEBOARD_INDEX_BYTES) {
      const source = await fs.readFile(abs, 'utf8').catch(() => '')
      text = whiteboardText(source)
    }
    whiteboardIndex.set(key, {
      name: path.basename(abs, path.extname(abs)),
      text,
      mtime: stat.mtimeMs,
      size: stat.size,
      kind: 'whiteboard'
    })
    changed = true
  })
  for (const key of [...whiteboardIndex.keys()]) {
    if (!seenWhiteboards.has(key)) { whiteboardIndex.delete(key); changed = true }
  }

  /* Word documents are unzipped and parsed to be indexed, which is dearer than
     reading a note — so it happens only when the file's mtime or size has
     moved, exactly as it does for everything else here. A document too big to
     be worth parsing on a walk is held with empty text rather than skipped, so
     that a search can say it went unread instead of quietly leaving it out. */
  const seenDocx = new Set()
  await mapLimit(docx, WALK_LIMIT, async (abs) => {
    const key = rel(abs)
    seenDocx.add(key)
    let stat
    try { stat = await fs.stat(abs) } catch { return }
    const cached = docxIndex.get(key)
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return
    docxIndex.set(key, {
      name: path.basename(abs, path.extname(abs)),
      text: stat.size <= MAX_DOCX_INDEX_BYTES ? await docxTextOf(abs) : '',
      mtime: stat.mtimeMs,
      size: stat.size,
      kind: 'docx'
    })
    changed = true
  })
  for (const key of [...docxIndex.keys()]) if (!seenDocx.has(key)) { docxIndex.delete(key); changed = true }

  // Which notes exist may have changed, and that is the whole of what the link
  // tables are built from.
  forgetLinkTables()

  if (changed) saveIndexCache()
}

/** One file's entry, as the walk would build it; null where it cannot be read. */
async function indexEntryFor (abs, stat, ext) {
  const name = ext === DOCX_EXT || ext === WHITEBOARD_EXT
    ? path.basename(abs, path.extname(abs))
    : stripExt(path.basename(abs))
  const base = { name, mtime: stat.mtimeMs, size: stat.size }
  if (ext === DOCX_EXT) {
    return { ...base, kind: 'docx', text: stat.size <= MAX_DOCX_INDEX_BYTES ? await docxTextOf(abs) : '' }
  }
  if (ext === WHITEBOARD_EXT) {
    let text = ''
    if (stat.size <= MAX_WHITEBOARD_INDEX_BYTES) text = whiteboardText(await fs.readFile(abs, 'utf8').catch(() => ''))
    return { ...base, kind: 'whiteboard', text }
  }
  let text = ''
  if (stat.size <= MAX_INDEX_BYTES) {
    try { text = await fs.readFile(abs, 'utf8') } catch { return null }
  }
  return { ...base, text }
}

/* Out to disk, coalesced, so the next launch starts from here. Not awaited:
   the index in memory is already correct and every caller is waiting on that,
   not on the copy. A vault too big to cache whole gets its largest notes
   dropped from the copy — worth a line in the log, because the symptom (a
   slow first search, every launch) points nowhere. */
function saveIndexCache () {
  const saved = indexCache?.save(index)
  if (saved?.dropped) console.warn(`index cache over budget: ${saved.dropped} largest notes left out`)
  else if (saved?.skipped) console.warn('index cache skipped: vault too large to cache at all')
}

function ensureIndex () {
  if (!indexDirty && !indexDirtyPaths.size && !syncing) return Promise.resolve()
  if (!syncing) {
    syncing = syncIndex().finally(() => { syncing = null })
  }
  return syncing
}

/* Reviewed-document text by rel path, keyed on mtime/size — the same shape as
   `whiteboardIndex`. Snapshots run twice per Copilot turn, and without this
   each one re-reads every TeX document, notebook, table and script in the
   vault. */
const documentSnapshotCache = new Map() // rel path -> { mtime, size, text }
const MAX_SNAPSHOT_CACHE_BYTES = 64 * 1024 * 1024

/**
 * A counter that moves whenever any document in the vault might have.
 *
 * `indexGeneration` is not that fact: a TeX document is deliberately outside
 * the Markdown index, so saving one from the editor moves neither it nor the
 * vault snapshot's own generation. This is bumped from the three places a
 * document's bytes can change — the editor's own save, the index being told
 * about a write, and any watched change the classifier did not ignore — which
 * is what makes it sound to reuse a snapshot taken while it stood still.
 */
let documentsGeneration = 0
const documentsChanged = () => { documentsGeneration++ }

/* The last snapshot, and the generation it was taken at.
 *
 * A turn ends by snapshotting the vault, and the next one begins by
 * snapshotting it again — usually with nothing but a pause for thought in
 * between. Held, that second walk is free; and because the baseline is only
 * ever compared, never written into, the same Map can safely be handed to
 * both. */
let heldSnapshot = null   // { at, notes }

async function snapshotNotes () {
  if (heldSnapshot && heldSnapshot.at === documentsGeneration) return heldSnapshot.notes
  const taken = documentsGeneration
  const notes = await readDocumentSnapshot()
  /* Only if nothing moved while we were reading. A change that landed mid-walk
     leaves the answer already behind, and holding it would hand the next turn a
     baseline that never existed. */
  if (documentsGeneration === taken) heldSnapshot = { at: taken, notes }
  return notes
}

async function readDocumentSnapshot () {
  await ensureIndex()
  const snapshot = new Map([...index].map(([key, entry]) => [key, entry.text]))
  /* TeX is edited in the same CodeMirror surface and by the same Copilot, but
     it deliberately is not part of the Markdown search/link index. The other
     documents — notebooks, tables, scripts, whiteboards — are not in it
     either, and for years an agent's write to any of them produced no review
     card and could not be rejected. All are read here so the turn's diff sees
     them. The vault walk is shared with the index; only the document bytes are
     additional — and bounded: a reviewed document over `MAX_VERSIONED_BYTES`
     would carry two copies of itself into a 4 MB trust store and evict the
     history of everything else, so past that it goes unreviewed, exactly as
     it already goes unversioned. TeX keeps its old unbounded reading. */
  const { tex = [], documents = [] } = await getVaultSnapshot()
  const seen = new Set()
  const sized = [
    ...tex.map((abs) => [abs, Infinity]),
    ...documents.map((abs) => [abs, MAX_VERSIONED_BYTES])
  ]
  const read = await mapLimit(sized, WALK_LIMIT, async ([abs, cap]) => {
    try {
      const key = rel(abs)
      seen.add(key)
      const stat = await fs.stat(abs)
      if (stat.size > cap) {
        // A held copy of the smaller file it used to be must not linger as if
        // it were current.
        documentSnapshotCache.delete(key)
        return null
      }
      const cached = documentSnapshotCache.get(key)
      if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
        return [key, cached.text]
      }
      const text = await fs.readFile(abs, 'utf8')
      documentSnapshotCache.set(key, { mtime: stat.mtimeMs, size: stat.size, text })
      return [key, text]
    } catch { return null }
  })
  let held = 0
  for (const [key, entry] of documentSnapshotCache) {
    if (!seen.has(key)) documentSnapshotCache.delete(key)
    else held += entry.text.length
  }
  /* Bounded in total as well as per file. With code and data files included, a
     vault carrying a checked-out project could otherwise pin the text of
     thousands of files in main-process memory for the life of the session.
     Cleared whole rather than evicted piecemeal: the cache only saves
     re-reads, so the rare vault that overflows it pays a fresh read per turn
     rather than growing a leak. */
  if (held > MAX_SNAPSHOT_CACHE_BYTES) documentSnapshotCache.clear()
  for (const document of read) if (document) snapshot.set(...document)
  return snapshot
}

function changedNotes (before, after) {
  const keys = new Set([...before.keys(), ...after.keys()])
  return [...keys].sort().map((key) => ({
    path: key,
    before: before.has(key) ? before.get(key) : null,
    after: after.has(key) ? after.get(key) : null
  })).filter((change) => change.before !== change.after)
}

/**
 * Record a write we just made, so the next search does not re-read the file.
 *
 * `stamp` is the mtime and size `writeAtomic` already read off its own open
 * handle. Every caller has one, and the alternative — a synchronous stat — was
 * a blocking syscall on the autosave path, which runs every few seconds for as
 * long as anyone is typing, and one per note during a replace-all.
 */
function touchIndex (absPath, text, stamp) {
  try {
    const stat = stamp || fsSync.statSync(absPath)
    indexGeneration++
    documentsChanged()
    // A note this index has not seen before is a key the link tables lack.
    if (!index.has(rel(absPath))) forgetLinkTables()
    index.set(rel(absPath), {
      name: stripExt(path.basename(absPath)),
      text,
      mtime: stat.mtimeMs,
      size: stat.size
    })
  } catch {
    indexDirty = true
  }
}

/** A Word document's words, or '' where it cannot be read. A file that will
 *  not parse is not an error here: it is a document search cannot see into,
 *  and the walk carries on. */
async function docxTextOf (abs) {
  try {
    const { readDocxBufferAsync, docxText } = require('./docx')
    return docxText((await readDocxBufferAsync(await fs.readFile(abs))).blocks)
  } catch {
    return ''
  }
}

/** The same, for a document this app has just written: search should find what
 *  was typed a moment ago without waiting for the next walk of the vault. */
function touchDocxIndex (absPath, blocks, stamp) {
  try {
    const { docxText } = require('./docx')
    const stat = stamp || fsSync.statSync(absPath)
    indexGeneration++
    documentsChanged()
    docxIndex.set(rel(absPath), {
      name: path.basename(absPath, path.extname(absPath)),
      text: stat.size <= MAX_DOCX_INDEX_BYTES ? docxText(blocks) : '',
      mtime: stat.mtimeMs,
      size: stat.size,
      kind: 'docx'
    })
  } catch {
    indexDirty = true
  }
}

function touchWhiteboardIndex (absPath, source, stamp, extractedText = null) {
  try {
    const stat = stamp || fsSync.statSync(absPath)
    indexGeneration++
    whiteboardIndex.set(rel(absPath), {
      name: path.basename(absPath, path.extname(absPath)),
      text: stat.size <= MAX_WHITEBOARD_INDEX_BYTES
        ? (typeof extractedText === 'string' ? extractedText : whiteboardText(source))
        : '',
      mtime: stat.mtimeMs,
      size: stat.size,
      kind: 'whiteboard'
    })
  } catch {
    indexDirty = true
  }
}

/* -------------------------------------------------------------- the tree */

/* One collator, built once. `a.localeCompare(b, undefined, { numeric: true })`
   reads as the same thing, but the options object means a fresh collator per
   comparison rather than the cached default one — which made the sort below
   two thirds of everything the tree walk did, and the walk is what the sidebar
   waits on when a vault opens. The ordering is identical; only the setup is
   hoisted out of the comparator. */
const BY_NAME = new Intl.Collator(undefined, { numeric: true })

/* One directory traversal supplies every consumer that used to walk the vault
   independently: the sidebar, attachment resolver, note index and PDF sweep.
   Calls in the same startup burst share the in-flight promise; renderer
   refreshes explicitly ask for a fresh generation. */
/** @type {any} */
let vaultSnapshotCache = null
let vaultSnapshotting = null
/* Which state of the vault a scan belongs to, counted up by every change the
   app knows it made. A walk already in flight began reading before the write a
   caller is now refreshing for, so sharing it hands back an answer that predates
   the change — the pasted image missing from the asset list, and the embed drawn
   as a broken chip a moment after it was made. Only a scan started since the
   last change may be shared.

   Bumped by real changes and not by asking for a fresh snapshot: two refreshes
   in the same breath share one walk, which is the whole point of holding it. */
let vaultSnapshotGeneration = 0
let vaultSnapshottingFor = -1

const invalidateVaultSnapshot = () => {
  vaultSnapshotCache = null
  vaultSnapshotGeneration++
  /* Which PDFs there are has changed, so what the search pass believes about
     them is worth nothing. Everything that creates, renames, deletes or
     restores says so here, which makes this the one place that has to. */
  forgetPdfSearchFacts()
  /* Every create, rename, delete and restore in the app already says so here,
     which makes this the one place a held document snapshot has to be told
     about all of them. */
  documentsChanged()
}

async function scanVaultDirectory (dir, includeInTree = true) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch {
    return { tree: [], files: [], evicted: 0 }
  }

  /* A `.icloud` file is iCloud's placeholder for something it has not
     downloaded: it is not the note, and opening it hands the user the
     placeholder's own bytes. Counted rather than walked — everything else
     starting with a dot is hidden from the tree (see `kept`) — so the sync
     readout can say "12 files are not here yet". */
  const evictedHere = entries.filter((entry) => entry.name.endsWith('.icloud')).length
  const kept = entries.filter((entry) => {
    if (IGNORED_DIRS.has(entry.name)) return false
    return !entry.name.startsWith('.') || ATTACHMENT_DIRS.has(entry.name)
  })
  const parts = await mapLimit(kept, WALK_LIMIT, async (entry) => {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const show = includeInTree && !entry.name.startsWith('.')
      const child = await scanVaultDirectory(abs, show)
      return {
        files: child.files,
        evicted: child.evicted,
        node: show
          ? { type: 'folder', name: entry.name, path: rel(abs), children: child.tree }
          : null
      }
    }

    let node = null
    if (includeInTree && MD_EXT.has(path.extname(entry.name).toLowerCase())) {
      const language = isLanguageTable(abs)
      const identity = language ? languageName(languageTableStem(entry.name)) : null
      const folderIdentity = language ? languageName(path.basename(dir)) : null
      node = {
        type: 'file',
        kind: language ? 'language' : 'note',
        name: languageTableLabel(identity?.name || stripExt(entry.name)),
        flag: identity?.flag || folderIdentity?.flag || '',
        path: rel(abs)
      }
    } else if (includeInTree && isTex(entry.name)) {
      node = {
        type: 'file', kind: 'tex',
        name: path.basename(entry.name, path.extname(entry.name)), path: rel(abs)
      }
    } else if (includeInTree && isPdf(entry.name)) {
      node = {
        type: 'file', kind: 'pdf',
        name: path.basename(entry.name, path.extname(entry.name)), path: rel(abs)
      }
    } else if (includeInTree && isSite(entry.name)) {
      node = {
        type: 'file', kind: 'site',
        name: path.basename(entry.name, path.extname(entry.name)), path: rel(abs)
      }
    } else if (includeInTree && isWhiteboard(entry.name)) {
      node = {
        type: 'file', kind: 'whiteboard',
        name: path.basename(entry.name, path.extname(entry.name)), path: rel(abs)
      }
    } else if (includeInTree && isNotebook(entry.name)) {
      node = {
        type: 'file', kind: 'notebook',
        name: path.basename(entry.name, path.extname(entry.name)), path: rel(abs)
      }
    } else if (includeInTree && isDocx(entry.name)) {
      node = {
        type: 'file', kind: 'docx',
        name: path.basename(entry.name, path.extname(entry.name)), path: rel(abs)
      }
    } else if (includeInTree && (isCode(entry.name) || isData(entry.name))) {
      /* The one kind whose extension stays in the label. Every other document
         is named without one because its kind is already said by the icon
         beside it — but `solve.py`, `solve.c` and `solve.jl` in one folder are
         three files, and stripping the extension would show three rows all
         called "solve". */
      node = {
        type: 'file',
        kind: isData(entry.name) ? 'data' : 'code',
        name: entry.name,
        path: rel(abs)
      }
    } else if (includeInTree && !entry.name.endsWith('.icloud')) {
      /* Everything else the folder holds. A vault is a folder on disk and
         people keep things in folders — a photograph beside the notes about
         it, a recording, a spreadsheet somebody sent — and every one of them
         used to be missing from its own vault: not in the tree, not in the
         switcher, not openable. The kind here is only how it wants to be
         *shown*, taken from the extension; what opening one means is decided in
         the renderer, which can afford to look inside it.

         A `.icloud` placeholder is the exception, and stays counted rather than
         listed: it is not the file, it is iCloud saying the file is elsewhere,
         and the sync readout is where that belongs. */
      node = {
        type: 'file',
        kind: showAs(entry.name),
        // With the extension, like source files: `photo.png` and `photo.heic`
        // are two files, and the icon says "picture" for both of them.
        name: entry.name,
        path: rel(abs)
      }
    }
    return { files: isSnapshotFile(entry.name) ? [abs] : [], evicted: 0, node }
  })

  const tree = parts.map((part) => part.node).filter(Boolean)
  tree.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return BY_NAME.compare(a.name, b.name)
  })
  return {
    tree,
    files: parts.flatMap((part) => part.files),
    evicted: evictedHere + parts.reduce((sum, part) => sum + part.evicted, 0)
  }
}

/**
 * A short stand-in for everything the renderer draws off a snapshot.
 *
 * The sidebar and the asset resolver are rebuilt only when the vault actually
 * moved, and the renderer used to establish that by receiving the whole tree
 * and joining it into a signature itself — so an outside change to one note
 * (a sync client, or the copilot editing files as it works) cost a structured
 * clone of every node in the vault across the IPC boundary, plus the join,
 * only to conclude that nothing on screen had changed. Computed here instead,
 * once per walk, and handed over as a string the renderer can compare against
 * the one it is holding; see the `known` argument of `vault:snapshot`.
 *
 * Hashed rather than kept whole because it is sent on its own: the signature
 * of a large vault is the same order of size as the tree it stands for, which
 * would give back the transfer this exists to avoid.
 *
 * `flag` joins the fields the old renderer-side signature covered — a language
 * note that gains one redraws its row, which it did not before. Anything the
 * revision misses is a change the sidebar will not notice, so it errs towards
 * naming a field that does not need it rather than omitting one that does.
 */
function snapshotRevision ({ tree, assets }) {
  /* Field and record separators, written as escapes rather than as the bytes
     themselves: neighbouring fields must not be able to spell each other — a
     note named `ab` with no kind and one named `a` of kind `b` are different
     vaults, and a bare concatenation would hand both the same signature. The
     same characters, and the same reasoning, as the tree signature this
     replaces (see SHAPE_SEP in src/renderer.js). */
  const FIELD = '\x1f'
  const RECORD = '\x1e'

  const hash = crypto.createHash('sha1')
  const walk = (nodes) => {
    for (const node of nodes) {
      hash.update(
        [node.type, node.path, node.name, node.kind || '', node.flag || '']
          .join(FIELD) + RECORD
      )
      if (node.children) walk(node.children)
    }
  }
  /* Signed apart, because they are guarded apart on the other side: pasting
     an image changes the attachments and not a single row of the tree, and one
     combined signature would make the renderer redraw the whole sidebar for
     it. */
  walk(tree)
  const treeRevision = hash.digest('base64')

  const assetHash = crypto.createHash('sha1')
  for (const asset of assets) assetHash.update(asset + RECORD)

  return { tree: treeRevision, assets: assetHash.digest('base64') }
}

async function getVaultSnapshot ({ fresh = false } = {}) {
  if (!vaultPath) return { tree: [], assets: [], notes: [], pdfs: [], evicted: 0 }
  // The held answer is the thing being refused; a scan started since the last
  // change is still the current one and is joined rather than repeated.
  if (fresh) vaultSnapshotCache = null
  if (vaultSnapshotCache) return vaultSnapshotCache
  if (vaultSnapshotting && vaultSnapshottingFor === vaultSnapshotGeneration) return vaultSnapshotting

  const vault = vaultPath
  const generation = vaultSnapshotGeneration
  const earlier = vaultSnapshotting
  const run = (async () => {
    // An older walk is left to finish rather than run a second one beside it —
    // two recursive traversals of the same vault at once is the one thing this
    // shared snapshot exists to avoid.
    if (earlier) await earlier.catch(() => {})
    if (vaultSnapshotCache && vaultSnapshotGeneration === generation) return vaultSnapshotCache

    const { tree, files, evicted } = await scanVaultDirectory(vault)
    if (vaultPath !== vault) return { tree: [], assets: [], notes: [], pdfs: [], evicted: 0 }
    const snapshot = {
      tree,
      evicted,
      assets: files.filter((abs) => ASSET_EXT.has(path.extname(abs).toLowerCase())).map(rel),
      notes: files.filter((abs) => MD_EXT.has(path.extname(abs).toLowerCase())),
      tex: files.filter(isTex),
      pdfs: files.filter(isPdf).map(rel),
      whiteboards: files.filter(isWhiteboard),
      docx: files.filter(isDocx),
      documents: files.filter(isReviewedDocument)
    }
    snapshot.revision = snapshotRevision(snapshot)
    // Something changed while we were reading; the answer is already behind.
    if (vaultSnapshotGeneration === generation) vaultSnapshotCache = snapshot
    return snapshot
  })()

  vaultSnapshotting = run
  vaultSnapshottingFor = generation
  run.catch(() => {}).finally(() => {
    if (vaultSnapshotting !== run) return
    vaultSnapshotting = null
    vaultSnapshottingFor = -1
  })
  return run
}

/* ---------------------------------------------------- wikilink rewriting */

/**
 * One pass that recognises fenced blocks, inline code spans, and wikilinks —
 * in that order, so the first two get to claim their text before the third
 * sees it. A `[[Note]]` written inside backticks is a piece of writing *about*
 * a link, not a link, and the editor already refuses to render it as one; a
 * rename that quietly edited it would put the two out of step.
 */
const CODE_OR_LINK = new RegExp([
  // The unterminated-fence fallback has to be absolute end-of-input, not `$`:
  // under the `m` flag `$` matches the end of the opening line, which would
  // close every fence on the line it opened and expose its contents.
  '(?<fence>^[ \\t]*(?<ticks>`{3,}|~{3,})[\\s\\S]*?(?:^[ \\t]*\\k<ticks>[^\\n]*$|(?![\\s\\S])))',
  '(?<code>(?<open>`+)[^`\\n]*\\k<open>)',
  '(?<link>\\[\\[(?<target>[^\\[\\]|]+)(?<alias>\\|[^\\[\\]]*)?\\]\\])'
].join('|'), 'gm')

/** How the renderer reads a link target, so the two agree on what resolves. */
function normaliseTarget (raw) {
  return stripExt(raw.trim().replace(/\\/g, '/')).replace(/\/+$/, '')
}

/** Notes sharing a basename, counted over a set of note paths. */
function basenameCounts (paths) {
  const counts = new Map()
  for (const p of paths) {
    const base = path.basename(stripExt(p)).toLowerCase()
    counts.set(base, (counts.get(base) || 0) + 1)
  }
  return counts
}

/**
 * The new target for one link, or null if this move does not touch it.
 *
 * A path-qualified link (`[[Folder/Note]]`) always follows the file. A bare
 * link (`[[Note]]`) is only rewritten when that name was unambiguous before the
 * move — otherwise the link was already pointing at whichever note happened to
 * be found first, and rewriting it would silently redirect it somewhere new.
 * The short form is kept if it still resolves, so a plain rename does not
 * litter the vault with full paths.
 */
function retarget (link, move, before, after) {
  const from = normaliseTarget(move.from)
  const to = normaliseTarget(move.to)
  const fromBase = path.basename(from).toLowerCase()
  const wanted = link.toLowerCase()

  const aimsHere = wanted === from.toLowerCase() ||
                   (wanted === fromBase && before.get(fromBase) === 1)
  if (!aimsHere) return null

  // Keep whichever form still resolves: a link written short stays short as
  // long as the new name is unambiguous, so a plain rename does not litter the
  // vault with full paths.
  const toBase = path.basename(to)
  return !link.includes('/') && after.get(toBase.toLowerCase()) === 1 ? toBase : to
}

function rewriteLinks (text, moves, before, after) {
  return text.replace(CODE_OR_LINK, (whole, ...rest) => {
    // Named groups arrive as the last argument, after the numbered ones.
    // `isLink` is set only when the wikilink alternative is what matched.
    const { link: isLink, target, alias = '' } = rest.at(-1)
    if (!isLink) return whole            // a fence or a code span: left untouched

    // A `#heading` suffix is not part of the note's identity, but it has to
    // survive the rewrite intact.
    const hash = target.indexOf('#')
    const head = hash === -1 ? target : target.slice(0, hash)
    const frag = hash === -1 ? '' : target.slice(hash)
    const link = normaliseTarget(head)
    if (!link) return whole

    for (const move of moves) {
      const next = retarget(link, move, before, after)
      if (next !== null) return `[[${next}${frag}${alias}]]`
    }
    return whole
  })
}

/**
 * Chases a rename or a move through every note that linked to it.
 *
 * Both name counts come from one sync. The post-move index is what the vault
 * now looks like; the pre-move counts are that, with each move undone — a
 * rename changes exactly two basenames, so re-walking the disk to learn them
 * would be asking a question already answered.
 *
 * Returns the notes that were edited — the count feeds the toast, and the
 * paths let the renderer refresh any of them it has open, since its own
 * writes no longer come back through the watcher.
 */
async function followMoves (moves) {
  if (!moves.length) return []

  indexDirty = true
  await ensureIndex()
  const after = basenameCounts(index.keys())

  const before = new Map(after)
  const nudge = (key, by) => before.set(key, (before.get(key) || 0) + by)
  for (const { from, to } of moves) {
    nudge(path.basename(stripExt(from)).toLowerCase(), +1)
    nudge(path.basename(stripExt(to)).toLowerCase(), -1)
  }

  /* Only notes that mention one of the moved names can possibly change. A
     `[[` test would keep almost every note in a vault that uses wikilinks; this
     rejects the ones that never named the thing, which is nearly all of them. */
  const mentions = new RegExp(
    [...new Set(moves.map((m) => path.basename(stripExt(m.from))))].map(escapeRe).join('|'),
    'i'
  )

  /* Decided first, written second. The rewrite itself is synchronous string
     work over the index, and doing it in its own pass keeps `touchIndex` from
     writing into the map this loop is walking. */
  const pending = []
  for (const [key, entry] of index) {
    if (!mentions.test(entry.text)) continue
    const next = rewriteLinks(entry.text, moves, before, after)
    if (next === entry.text) continue
    pending.push({ key, abs: path.resolve(vaultPath, key), next, previous: entry.text })
  }

  /* Concurrently: `writeAtomic` fsyncs both the file and its directory, so a
     folder rename that touches a hundred backlinks was two hundred fsyncs one
     after another with the main process pinned for all of them. The notes are
     different files and the writes do not depend on one another. */
  const touched = await mapLimit(pending, WALK_LIMIT, async ({ key, abs, next, previous }) => {
    try {
      touchIndex(abs, next, await writeAtomic(abs, next))
      return { key, previous, next }
    } catch (err) {
      console.error('link rewrite failed', key, err)
      return null
    }
  })

  /* Recorded as one entry, like a copilot turn: these are notes the user never
     opened, edited by the app's own decision, and History is the only account
     of it there is. The rename itself is undone by renaming back — which comes
     back through here and rewrites the links again — so what this entry has to
     hold is the link text, which nothing else remembers. */
  const written = touched.filter(Boolean)
  if (written.length) {
    trust?.record({
      source: 'rename',
      changes: written.map(({ key, previous, next }) => ({
        path: key, before: previous, after: next
      }))
    })
  }
  return written.map(({ key }) => key)
}

/**
 * Move something inside the vault and chase every link that named it.
 *
 * Both callers below go through here because the ordering is the subtle part:
 * which notes a move carries with it can only be read from the index *before*
 * the file leaves its old path, and the rewrite can only run after. Stating
 * that once means the second caller cannot get it half right.
 */
async function relocate (srcAbs, targetAbs) {
  const isDir = fsSync.statSync(srcAbs).isDirectory()
  const fromPath = rel(srcAbs)
  const toPath = rel(targetAbs)
  await ensureIndex()
  const moves = notesMovedBy(rel(srcAbs), rel(targetAbs), isDir)

  noteSelfWrite(srcAbs)
  noteSelfWrite(targetAbs)
  await fs.rename(srcAbs, targetAbs)
  /* Everything filed against a path rather than inside the file — tags, the
     table's column widths, and whatever is registered next — moves with it. */
  await relocateAll(fromPath, toPath, isDir)
  /* A python environment cannot be carried to a new path — see `relocate` in
     electron/python-env.js — so the notes that moved give theirs up and build
     again on their next run. A folder move is every note under it. */
  await Promise.all(
    (isDir ? moves : [{ from: fromPath, to: toPath }])
      .map(({ from, to }) => pythonEnvs.relocate(from, to))
  )
  await carryAnnotations(rel(srcAbs), rel(targetAbs))
  /* A card's identity begins with the path of the note it came from, so a
     rename that did not carry the review state would silently reset every word
     in the table to never-seen — the same loss as throwing the history away,
     and harder to notice, because all the words are still there. */
  await review.relocate(rel(srcAbs), rel(targetAbs)).catch(() => {})
  await languageHistory.relocate(rel(srcAbs), rel(targetAbs)).catch(() => {})
  /* TeX/PDF/site files are not in the Markdown link index, but their own
     identity still moves. In particular TeX creation dates must not reset
     merely because Copilot renamed the document. */
  trust?.relocateCreations(isDir ? moves : [{ from: rel(srcAbs), to: rel(targetAbs) }])
  const rewritten = await followMoves(moves)
  return { path: rel(targetAbs), links: rewritten.length, rewritten }
}

/**
 * The `.md` files a move carries with it: the file itself, or — when a folder
 * moves — every note underneath it. Must be read from the index *before* the
 * move happens, while those paths still exist.
 */
function notesMovedBy (from, to, isDir) {
  if (!isDir) return MD_EXT.has(path.extname(from).toLowerCase()) ? [{ from, to }] : []
  const prefix = from + '/'
  return notesUnder(from, true)
    .map((key) => ({ from: key, to: `${to}/${key.slice(prefix.length)}` }))
}

/**
 * The `.md` paths a single path stands for: itself, or — for a folder — every
 * note beneath it. Read from the index, so like `notesMovedBy` it must be
 * called while those paths still exist.
 */
function notesUnder (target, isDir) {
  if (!isDir) return MD_EXT.has(path.extname(target).toLowerCase()) ? [target] : []
  const prefix = target + '/'
  return [...index.keys()].filter((key) => key.startsWith(prefix))
}

/* Paths the app itself has just written, so the watcher can tell an autosave
   echoing back from an edit made outside the app. Without this, every save
   dropped the caches and sent the renderer off on two vault walks that
   discovered nothing. */
/* See electron/self-writes.js: a clock for renames and temp files, and the
   finished file's own mtime and size for a write that has one. */
const selfWrites = makeSelfWrites({ rootFor: () => vaultPath })

function noteSelfWrite (abs, stamp = null) {
  if (!vaultPath) return
  const p = rel(abs)
  if (p.startsWith('..')) return   // config and chat files live outside the vault
  selfWrites.note(p, stamp)
}

function isSelfWrite (filename) {
  if (!filename) return false   // no name means no way to tell; let it through
  return selfWrites.isOurs(filename.split(path.sep).join('/'))
}

/**
 * Write through a temporary file in the same directory, then rename over the
 * target. A crash mid-write leaves the previous note intact instead of a
 * truncated one. Full durability fsyncs immediately; balanced durability
 * checkpoints later. The temp name is unique per write, so two writers of the
 * same note cannot interleave on one path.
 */
let writeSerial = 0
const pendingDurability = new Set()
let durabilityTimer = null
let durabilityFlushing = null
const DURABILITY_INTERVAL_MS = 30000

async function syncDirectory (dirPath) {
  const dir = await fs.open(dirPath, 'r')
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}

async function syncExistingFile (abs) {
  const file = await fs.open(abs, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
  await syncDirectory(path.dirname(abs))
}

function flushPendingDurability () {
  if (durabilityFlushing) return durabilityFlushing
  clearTimeout(durabilityTimer)
  durabilityTimer = null

  durabilityFlushing = (async () => {
    /* Drain rather than take one snapshot: a save that lands while an earlier
       checkpoint is syncing belongs to this same request to make the vault
       durable before the app hides or closes. */
    while (pendingDurability.size) {
      const paths = [...pendingDurability]
      pendingDurability.clear()
      await mapLimit(paths, 4, async (abs) => {
        try {
          await syncExistingFile(abs)
        } catch {
          // A deleted or moved note no longer needs its former path checkpointed.
        }
      })
    }
  })().finally(() => {
    durabilityFlushing = null
  })

  return durabilityFlushing
}

/**
 * The same checkpoint, but synchronous — for `before-quit`, which does not wait
 * on promises. Without it a balanced-durability save made in the last thirty
 * seconds is renamed into place but never fsynced, so a power cut after a clean
 * quit can still lose it.
 */
function flushDurabilitySync () {
  clearTimeout(durabilityTimer)
  durabilityTimer = null
  const paths = [...pendingDurability]
  pendingDurability.clear()
  const dirs = new Set()
  for (const abs of paths) {
    try {
      const fd = fsSync.openSync(abs, 'r')
      try {
        fsSync.fsyncSync(fd)
      } finally {
        fsSync.closeSync(fd)
      }
      dirs.add(path.dirname(abs))
    } catch {
      // A deleted or moved note no longer needs its former path checkpointed.
    }
  }
  /* One fsync per directory rather than one per note: the rename entries all
     live in the same few directories, and quitting is not the moment to do the
     same work three hundred times. */
  for (const dir of dirs) {
    try {
      const fd = fsSync.openSync(dir, 'r')
      try {
        fsSync.fsyncSync(fd)
      } finally {
        fsSync.closeSync(fd)
      }
    } catch {
      // Same reason as above.
    }
  }
}

function checkpointLater (abs) {
  pendingDurability.add(abs)
  if (!durabilityTimer && !durabilityFlushing) {
    durabilityTimer = setTimeout(
      () => flushPendingDurability().catch(() => {}),
      DURABILITY_INTERVAL_MS
    )
    durabilityTimer.unref?.()
  }
}

async function writeAtomic (abs, content, { durable = true } = {}) {
  const tmp = path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.${process.pid}.${++writeSerial}${TEMP_SUFFIX}`
  )
  noteSelfWrite(tmp)
  noteSelfWrite(abs)
  const file = await fs.open(tmp, 'w')
  let stamp = null
  try {
    await file.writeFile(content, 'utf8')
    if (durable) await file.sync()
    /* Read off the handle we already hold rather than by stat'ing the
       destination afterwards: rename keeps the inode, so these are the finished
       file's own mtime and size, and the index gets them for free. */
    stamp = await file.stat().then((s) => ({ mtimeMs: s.mtimeMs, size: s.size }), () => null)
  } catch (err) {
    await file.close().catch(() => {})
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
  await file.close()
  /* The rename is the only step after the handle closes, and it is the one that
     used to leave litter: a destination that cannot be replaced left the temp
     file behind for good, under a name nothing would ever look for again. */
  try {
    await fs.rename(tmp, abs)
    /* Stamped again now the rename has landed. The stamp taken before the write
       starts covers a window that opens too early: a durable write fsyncs the
       file and then its directory, and on a large note or a networked volume
       that can outrun SELF_WRITE_MS — the rename's own watch event then arrives
       to an expired stamp and the app reads its own autosave as an outside
       edit. The window has to start when the event the watcher will see is
       generated, not when the write was asked for.

       And with the stamp, so that the window closes the moment the file is no
       longer the one this write produced: a sync client replacing it inside
       the half second is an outside edit, not an echo. */
    noteSelfWrite(abs, stamp)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
  // The rename itself, made durable. Best effort: not every filesystem will
  // fsync a directory, and the content above has already landed.
  if (durable) {
    await syncDirectory(path.dirname(abs)).catch(() => {})
  } else {
    checkpointLater(abs)
  }
  return stamp
}

function watchVault () {
  clearTimeout(watchRetryTimer)
  watchRetryTimer = null
  if (watcher) { watcher.close(); watcher = null }
  if (!vaultPath) return

  let timer = null
  /* Which files moved, gathered across the quiet window. The renderer needs
     more than "something happened": it holds one note in a buffer that may have
     unsaved edits in it, and whether *that* file is in here is the difference
     between a warning worth reading and one that fires because a sync client
     touched a folder on the other side of the vault. */
  let changed = new Set()
  let changedPdfs = new Set()
  let sweepPdfs = new Set()   // folder prefixes to sweep; '' means everything
  let notifyUnknown = false
  try {
    watcher = fsSync.watch(vaultPath, { recursive: true }, (_event, filename) => {
      // The app's own saves come back through here — the temp file and the
      // rename of every autosave. Nothing changed that the caches do not
      // already know, so a self-write neither dirties them nor wakes the
      // renderer. External changes carry unfamiliar names and get through.
      if (isSelfWrite(filename)) return
      const change = classifyVaultEvent(filename, {
        ignoredDirs: IGNORED_DIRS,
        attachmentDirs: ATTACHMENT_DIRS,
        noteExtensions: MD_EXT,
        texExtension: TEX_EXT,
        pdfExtension: PDF_EXT,
        siteExtension: SITE_EXT,
        whiteboardExtension: WHITEBOARD_EXT,
        notebookExtension: NOTEBOOK_EXT,
        documentExtensions: TEXT_DOCUMENT_EXT,
        assetExtensions: ASSET_EXT
      })
      if (change.ignore) return
      /* Immediately, not on the debounce, and for every kind rather than only
         the indexed ones: a Copilot turn ending inside the quiet window must
         not be handed a snapshot taken before the write it is about to be
         asked to review. */
      documentsChanged()
      // Marked immediately, not on the debounce: a search that lands inside the
      // quiet window must still see that something moved.
      if (change.index) markIndexDirty(change.path)
      if (change.snapshot) invalidateVaultSnapshot()
      if (change.notify && change.path) changed.add(change.path)
      if (change.notify && !change.path) notifyUnknown = true
      if (change.pdf === 'sweep') sweepPdfs.add(change.path || '')
      else if (change.pdf) changedPdfs.add(change.pdf)
      clearTimeout(timer)
      timer = setTimeout(() => {
        const paths = [...changed]
        changed = new Set()
        if (paths.length || notifyUnknown) notifyVaultChanged(paths)
        notifyUnknown = false
        const pdfs = [...changedPdfs]
        changedPdfs = new Set()
        if (sweepPdfs.size) {
          const prefixes = [...sweepPdfs]
          sweepPdfs = new Set()
          sweepPdfText(prefixes).catch(() => {})
          for (const pdf of pdfs) if (!prefixes.includes('')) ensurePdfText(pdf).catch(() => {})
        } else {
          for (const pdf of pdfs) ensurePdfText(pdf).catch(() => {})
        }
      }, 180)
    })
    // Watching again from scratch: a later blip should be retried promptly
    // rather than inheriting the backoff the last one had climbed to.
    watchRetryDelay = 0
    // A watcher that fails at runtime — the vault unmounted, or the system out
    // of watch descriptors — must not take the process with it.
    watcher.on('error', (err) => {
      console.error('vault watch failed', err)
      try { watcher?.close() } catch { /* already gone */ }
      watcher = null
      /* And must not leave the vault unwatched for the rest of the session.
         Losing the watcher silently disables the only way the app hears about
         an outside edit: the merge panel never opens, and the next autosave
         writes over a note a sync client changed hours earlier. A network
         volume that blips takes a moment to come back, so this backs off
         rather than spinning on a mount that is still gone. */
      scheduleWatchRetry()
    })
  } catch (err) {
    console.error('watch failed', err)
    scheduleWatchRetry()
  }
}

/* How long to wait before trying the watch again, doubling to a ceiling so a
   vault that never comes back costs nothing to keep hoping for. Reset whenever
   a watch succeeds, so a second blip is retried promptly. */
let watchRetryTimer = null
let watchRetryDelay = 0
const WATCH_RETRY_MIN = 2000
const WATCH_RETRY_MAX = 60000

function scheduleWatchRetry () {
  if (watchRetryTimer) return
  watchRetryDelay = watchRetryDelay ? Math.min(watchRetryDelay * 2, WATCH_RETRY_MAX) : WATCH_RETRY_MIN
  const root = vaultPath
  watchRetryTimer = setTimeout(() => {
    watchRetryTimer = null
    // The vault may have been switched or closed while we were waiting; that
    // switch armed its own watch, and this one is for a folder nobody is in.
    if (!vaultPath || vaultPath !== root || watcher) return
    watchVault()
    /* Whatever changed while nothing was watching is unknown, so the renderer
       is told the vault moved without naming files. It reloads the tree and
       re-reads the open note, and a buffer with edits in it goes through the
       merge rather than being overwritten. */
    notifyVaultChanged()
  }, watchRetryDelay)
}

/** Tell every renderer the vault may have moved under it. */
function notifyVaultChanged (paths = []) {
  broadcast('vault:changed', { paths })
}

/**
 * Moves a vault written under an older attachment folder into the current one.
 *
 * Per note folder rather than wholesale, so a vault that has been opened by
 * both versions merges instead of refusing. A name already taken in the new
 * folder is left alone: the file there is the one the notes have been
 * resolving to, and overwriting it to tidy up a folder name would be a poor
 * trade. Anything left behind stays readable — `.images` is still walked.
 *
 * Failures are swallowed on purpose. This runs on the way to opening a vault,
 * and a vault that will not tidy itself is still a vault worth opening.
 */
async function migrateAttachments (dir) {
  for (const legacy of LEGACY_ATTACHMENT_DIRS) {
    const from = path.join(dir, legacy)
    const to = path.join(dir, ATTACHMENT_DIR)
    let notes
    try { notes = await fs.readdir(from, { withFileTypes: true }) } catch { continue }

    for (const note of notes) {
      const target = path.join(to, note.name)
      try {
        await fs.mkdir(to, { recursive: true })
        await fs.rename(path.join(from, note.name), target)
      } catch {
        // Already there under the same name — merge the files one by one.
        if (!note.isDirectory()) continue
        let files = []
        try { files = await fs.readdir(path.join(from, note.name)) } catch { continue }
        for (const file of files) {
          await fs.rename(path.join(from, note.name, file), path.join(target, file))
            .catch(() => {})
        }
        await fs.rmdir(path.join(from, note.name)).catch(() => {})
      }
    }
    // Only if the move emptied it; a folder with anything left keeps working.
    await fs.rmdir(from).catch(() => {})
  }
}

/* The vaults connected before this one, newest first.
   ⚠️ Written by main and never by the renderer, which is why `recentVaults` is
   not in electron/config-keys.js: a list of folder paths is exactly the shape
   of key that allowlist exists to keep out of the renderer's reach, and
   nothing about a menu of past vaults requires it to be settable from there. */
const MAX_RECENT_VAULTS = 8

function rememberVault (dir) {
  const cfg = readConfig()
  const before = Array.isArray(cfg.recentVaults) ? cfg.recentVaults : []
  /* Filtered by path, so reopening one moves it to the front rather than
     appearing twice. Kept even when the folder has gone: the list is offered
     through a picker that checks before it opens, and quietly dropping an
     entry because a drive was unmounted is how a vault gets forgotten. */
  const after = [dir, ...before.filter((seen) => seen !== dir)].slice(0, MAX_RECENT_VAULTS)
  writeConfig({ recentVaults: after })
}

/** The recent vaults, and whether each is somewhere Tulip can still reach. */
ipcMain.handle('vault:recent', () => {
  const cfg = readConfig()
  const seen = Array.isArray(cfg.recentVaults) ? cfg.recentVaults : []
  return seen
    .filter((dir) => typeof dir === 'string' && dir && dir !== vaultPath)
    .map((dir) => ({ path: dir, name: path.basename(dir), missing: !fsSync.existsSync(dir) }))
})

/** Connect one of them. Refused rather than half-done if it has gone away. */
ipcMain.handle('vault:open', async (_event, dir) => {
  if (typeof dir !== 'string' || !dir) return { ok: false, reason: 'no folder was named' }
  /* Only a folder this app has opened before. The renderer may not name an
     arbitrary path here — choosing a *new* vault goes through `vault:pick`,
     which is a native dialog and so is the reader's own choice by definition. */
  const cfg = readConfig()
  const known = Array.isArray(cfg.recentVaults) ? cfg.recentVaults : []
  if (!known.includes(dir)) return { ok: false, reason: 'that folder is not a vault Tulip knows' }
  if (!fsSync.existsSync(dir)) return { ok: false, reason: 'that folder is no longer there' }

  /* The same handshake `pickVault` uses, and for the same reason: the buffer
     has to reach disk while `vaultPath` still points at the vault it belongs
     to. See the account there. */
  await flushAllWindows()
  await openVault(dir)
  return { ok: true }
})

async function openVault (dir) {
  vaultPath = dir
  /* The kernels belonged to the vault that is closing, and their namespaces
     describe notebooks nothing is showing any more. */
  if (kernels) {
    kernels.dispose().catch(() => {})
    kernels.setRoot(dir)
  }
  // The next read of each is of the new vault's own file.
  resetAll()
  // Environments are keyed by vault, so none of what is remembered about which
  // ones exist describes this one.
  pythonEnvs.reset()
  rememberVault(dir)
  trust?.setVault(dir, readConfig().historyInVault === true)
  /* The vault open is the vault remembered — there is no second, separately
     chosen "default" any more, so connecting a folder here is the whole of
     saying which one Tulip starts in. `defaultVaultPath` was that second key;
     it is dropped on the way past so a config carrying it cannot later be
     mistaken for a newer answer than this one. */
  writeConfig({ vaultPath: dir, defaultVaultPath: undefined })
  await migrateAttachments(dir).catch(() => {})
  index.clear()
  whiteboardIndex.clear()
  docxIndex.clear()
  documentSnapshotCache.clear()
  forgetLinkTables()
  /* A different vault means a different cache file, and the index just emptied
     is now allowed to be seeded from it again. */
  useIndexCacheFor(dir)
  indexDirty = true
  invalidateVaultSnapshot()
  watchVault()
  // Whatever a killed write left beside a note in this vault. Background work
  // like the two sweeps around it; nothing waits on the tidying.
  sweepTemporaryFiles(dir, { recursive: true }).catch(() => {})
  /* Every window shows the same vault — there is one `vaultPath` and every
     path in the app is resolved against it — so opening another one is an
     event all of them have to hear. A window that missed it would keep a strip
     of tabs naming notes in the vault that has just been left, and its next
     autosave would write one of them into the new vault's root. */
  for (const win of liveWindows()) {
    win.setTitle(path.basename(dir))
    sendTo(win, 'vault:opened', { path: dir, name: path.basename(dir), sync: syncProviderFor(dir) })
  }
}

/* --------------------------------------------------------------- the app */

/**
 * The renderer is asked to save before its window may close. `beforeunload`
 * cannot wait for an async IPC write, so the close is held open until the
 * renderer answers `app:flushed` — or 1.5 s pass, because a wedged page must
 * not hold the door.
 */
let quitting = false
ipcMain.handle('app:version', () => app.getVersion())

/* ------------------------------------------------------------- updates

   Tulip has no updater and is not getting one. What it did not have either was
   any way to find out that a new version existed: the README said "pull and
   re-run the build script", which is advice for the person who wrote it and
   nobody else, and CI threw every build it made away.

   So: asked for, never volunteered. Nothing here runs on a timer, at launch,
   or in the background — the one caller is a command somebody typed, and if
   nobody types it Tulip makes no network request in its life. That is the
   whole of the design. An app whose entire premise is a folder of files on
   your own disk should not be quietly talking to a server about it.

   The answer names the newest tag and where to get it. Downloading, replacing
   and relaunching stay the reader's, which is also what makes this safe to
   have: there is no code path here that can install anything. */

/* The project itself, for the Help menu — the API endpoint below is the same
   repository seen through GitHub's API, and they are written apart so that
   neither has to be derived from the other. */
const REPO_URL = 'https://github.com/Bondyboy2001/tulip'

const RELEASES = 'https://api.github.com/repos/Bondyboy2001/tulip/releases/latest'

/** `v0.1.26` and `0.1.26` alike, as numbers, so they can be compared. */
function versionParts (text) {
  return String(text).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
}

/** Whether `candidate` is a later version than `current`. */
function isNewer (candidate, current) {
  const a = versionParts(candidate)
  const b = versionParts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return false
}

ipcMain.handle('app:update-check', async () => {
  const current = app.getVersion()
  let latest
  try {
    /* `net.fetch` rather than the global one: it goes through Chromium's stack,
       which is what already knows about this machine's proxy and certificates. */
    const res = await net.fetch(RELEASES, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `Tulip/${current}`
      }
    })
    /* A repository with no releases yet answers 404, which is an answer and not
       a failure — it means there is nothing newer, which is true. */
    if (res.status === 404) return { ok: true, current, latest: null, newer: false }
    if (!res.ok) return { ok: false, current, reason: `GitHub answered ${res.status}` }
    latest = await res.json()
  } catch (error) {
    return { ok: false, current, reason: error.message || 'the network could not be reached' }
  }

  const tag = String(latest?.tag_name || '')
  if (!tag) return { ok: true, current, latest: null, newer: false }
  return {
    ok: true,
    current,
    latest: tag.replace(/^v/, ''),
    newer: isNewer(tag, current),
    url: String(latest?.html_url || '')
  }
})

/**
 * Something went wrong in the window, and now somebody knows.
 *
 * Main has kept a crash log since it had a crash to log; the renderer had
 * nothing at all, and an exception thrown there went to a DevTools console
 * nobody had open. That is not a theoretical gap — three unhandled TypeErrors
 * were being thrown on every single launch, quietly skipping the first note's
 * spellcheck pass and the disk-conflict check that runs on window focus, and
 * they were found by attaching a debugger rather than by using the app.
 *
 * Fire-and-forget on the renderer's side: the reporting of a failure must not
 * be able to fail in a way that matters, least of all inside a handler that is
 * already dealing with one.
 */
ipcMain.on('app:error', (_event, kind, detail) => {
  /* Trusted for its shape, not its content: this crosses the same bridge as
     everything else the renderer says, and it ends up in a file a person
     reads. Bounded so a loop cannot fill the log with one message. */
  logCrash(`renderer/${String(kind).slice(0, 40)}`, String(detail).slice(0, 4000))
})

/**
 * The crash log, shown to the person the toast told about it.
 *
 * The renderer has said "the details are in the crash log" since it learned to
 * report its own failures, and until now there was no way to reach one from
 * inside the app: you had to know that it lives in the app's data directory and
 * go there yourself. A message whose only next step is knowledge the reader
 * does not have is barely better than no message.
 *
 * Revealed rather than opened. What lands in this file is a stack trace, and
 * the useful thing to do with one is send it somewhere — which starts in a file
 * manager, not in whatever has claimed .log on this machine.
 */
ipcMain.handle('app:reveal-log', () => {
  const file = CRASH_LOG()
  if (!fsSync.existsSync(file)) return false
  shell.showItemInFolder(file)
  return true
})

/**
 * Everything worth putting in a bug report, as text ready to paste.
 *
 * Deliberately assembled here rather than in the renderer: the versions and the
 * log are main's to know, and a reader who is reporting a fault should not have
 * to collect five facts from four places to do it.
 *
 * The vault is described by shape and never by name — a count of notes says
 * what a maintainer needs (is this a vault of 12 files or 12,000?) while a path
 * would carry the reader's own directory names, and often their real one, into
 * whatever they paste this into.
 */
ipcMain.handle('app:diagnostics', async () => {
  const lines = [
    `Tulip ${app.getVersion()}`,
    `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}`,
    `${process.platform} ${process.arch} ${os.release()}`,
    `Windows open: ${liveWindows().length}`
  ]

  if (vaultPath) {
    try {
      await ensureIndex()
      const bytes = [...index.values()].reduce((sum, entry) => sum + (entry.size || 0), 0)
      // Bytes below a kilobyte, because "0 KB" beside a note count that is
      // plainly not zero reads as a fault in the report rather than a rounding.
      const size = bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`
      lines.push(`Vault: ${index.size} notes, ${size} indexed`)
    } catch {
      lines.push('Vault: could not be read')
    }
  } else {
    lines.push('Vault: none open')
  }

  /* The end of the log, not the whole of it. It is capped at 512KB, which is
     far more than anybody pastes into a report, and what explains a fault is
     nearly always the last thing in it. */
  let tail = ''
  try {
    const raw = await fs.readFile(CRASH_LOG(), 'utf8')
    tail = raw.split('\n').slice(-60).join('\n').trim()
  } catch {
    /* No log is the ordinary case, and the good one. */
  }

  return {
    text: lines.join('\n') + (tail ? `\n\nLast entries in the crash log:\n${tail}` : '\n\nThe crash log is empty.'),
    hasLog: Boolean(tail)
  }
})

/* The window's own reveal, set by createWindow and called from the renderer's
   `app:painted` — see the account there. A no-op before there is a window and
   after the first show, so a second announcement (a boot retried after an
   error) costs nothing. */
/* Keyed by the webContents that will announce itself, because every window
   paints once and each has to be revealed by its own announcement. A single
   `revealMainWindow` here showed whichever window was built last — so opening
   a second one left the first hidden until its 4-second backstop fired. */
const reveals = new Map()
// The first paint warms the run cache once, not once per window.
let runCachePruned = false
ipcMain.on('app:painted', (event) => {
  reveals.get(event.sender.id)?.()
  /* The first paint is also the moment to warm the search index. Left alone,
     the first full vault walk runs when the first note open asks for its
     backlinks — on top of the renderer's opening burst of requests, which is
     the one moment this process is already busy. Kicked from here instead,
     the walk happens while the reader is still looking at the tree, and the
     backlink call that would have started it awaits the same `syncing`
     promise it would have created. A moment's delay lets the paint's own
     round trip finish first; when the index is already clean this is a
     resolved promise and nothing more. */
  if (vaultPath) {
    setTimeout(() => { ensureIndex().catch((error) => logCrash('warmIndex', error)) }, 50)
  }

  /* And the two other pieces of warming that used to run before there was a
     window at all. The login shell is a whole profile evaluation — nvm, pyenv,
     a prompt framework — and the run cache is a walk of a temp directory;
     neither is wanted before the first Run, and both were competing with the
     first paint for the same process. Warmed here so clicking Run still does
     not wait on a login shell, and idempotent, so a second window's paint
     costs nothing. */
  ensureLoginPath()
  if (!runCachePruned) {
    runCachePruned = true
    pruneRunCache().catch(() => {})
  }
})

ipcMain.handle('app:flushed', async (event) => {
  await flushPendingDurability()
  flushWaits.get(event.sender.id)?.reply()
})

/* One entry per window with a flush in flight. Per window rather than one
   global pair: two windows closing together each send their own `app:flushed`,
   and a single `flushReply` would have the first answer resolve the second
   window's promise as well — releasing a close before that window had written
   anything down. */
const flushWaits = new Map()

/* How long a silent renderer gets before the door closes anyway. Short,
   because this is the wedged-page case and the window has to close. */
const FLUSH_QUIET_MS = 1500
/* And the most a *working* renderer gets, however much it says it is still
   going. A notebook holding a session's worth of plots is tens of megabytes of
   base64 to re-serialise and write, and 1.5 s of that is not a hung page — it
   is a large file being saved correctly. Without the ceiling a renderer stuck
   in a loop that keeps reporting progress could hold a quit open for ever. */
const FLUSH_CEILING_MS = 20_000

/* Said by a renderer that is still writing. Every one of these buys another
   quiet period, up to the ceiling — see `askRendererToFlush`. */
ipcMain.on('app:flushing', (event) => flushWaits.get(event.sender.id)?.working())

/**
 * Ask one window's renderer to write what it is holding, and wait for it.
 *
 * A page that is wedged, or one whose renderer died, must not hold the door:
 * the timer resolves the promise whatever happens. But a fixed deadline cannot
 * tell "wedged" from "busy", and the documents most likely to be slow here are
 * the ones with no draft to fall back on — a grid, a board, a notebook. So the
 * deadline is a quiet period rather than a total: a renderer that keeps saying
 * it is working keeps the door open, and a renderer that says nothing loses it
 * on the same 1.5 s as before.
 *
 * Asking twice for the same window is the same ask — ⌘⇧W pressed twice, or ⌘Q
 * arriving while a close is already waiting, must not leave the first promise
 * stranded on its timer.
 */
function askRendererToFlush (win) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve()
  const key = win.webContents.id
  const already = flushWaits.get(key)
  if (already) return already.promise

  const entry = {}
  entry.promise = new Promise((resolve) => {
    const startedAt = Date.now()
    let timer = setTimeout(resolve, FLUSH_QUIET_MS)
    const done = () => { clearTimeout(timer); resolve() }
    entry.reply = done
    entry.working = () => {
      const left = FLUSH_CEILING_MS - (Date.now() - startedAt)
      if (left <= 0) return done()
      clearTimeout(timer)
      timer = setTimeout(resolve, Math.min(FLUSH_QUIET_MS, left))
    }
  }).finally(() => flushWaits.delete(key))

  flushWaits.set(key, entry)
  win.webContents.send('app:flush')
  return entry.promise
}

/** Every window's unsaved work on its way to disk — what a quit waits for. */
const flushAllWindows = () => Promise.all(liveWindows().map(askRendererToFlush))

/* The app draws its own title bar (see `.titlebar` in styles.css — a 38px drag
   strip the document scrolls under), so the system one is hidden. What replaces
   it is not the same on both platforms:

   macOS keeps its traffic lights and only needs them moved down into the strip.
   Windows has no equivalent — `hiddenInset` there means `hidden`, which removes
   the caption buttons and leaves a window that cannot be minimised, maximised
   or closed except by keyboard. `titleBarOverlay` is the supported way back:
   Windows draws Minimise/Maximise/Close over our strip, in colours we choose,
   and reserves the space through the env-var-free `titlebarAreaInset` CSS vars
   the renderer already has access to. */
const CAPTION_HEIGHT = 38

function overlayColors () {
  const dark = nativeTheme.shouldUseDarkColors
  return {
    color: dark ? '#141317' : '#FBFAF8',      // matches backgroundColor below
    symbolColor: dark ? '#E8E4DE' : '#3A3631',
    height: CAPTION_HEIGHT
  }
}

function windowChrome () {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 } }
  }
  if (process.platform === 'win32') {
    return { titleBarStyle: 'hidden', titleBarOverlay: overlayColors() }
  }
  /* Everything else keeps the window manager's own frame. A hidden title bar
     with no overlay is how you ship a window with no way to close it. */
  return {}
}

/* The overlay's colours are baked in at creation, so a system switch to dark
   would otherwise leave three light-grey caption buttons on a near-black strip
   until the next launch. */
if (process.platform === 'win32') {
  nativeTheme.on('updated', () => {
    for (const win of liveWindows()) {
      try { win.setTitleBarOverlay(overlayColors()) } catch { /* window went */ }
    }
  })
}

/* Each new window steps down and right from the last, the way every document
   app opens its second window: exactly on top of the first is the one place it
   cannot be told apart from the window it was opened from. */
const CASCADE = 28

function cascadeFrom (win) {
  if (!win || win.isDestroyed()) return {}
  const [x, y] = win.getPosition()
  const [width, height] = win.getSize()
  return { x: x + CASCADE, y: y + CASCADE, width, height }
}

/**
 * A window on the vault.
 *
 * The first one is the primary — the session's own window, the one that
 * restores the tab strip that was left behind and the one the copilot belongs
 * to. Every window after it is an ordinary one: same vault, same everything it
 * can do to the vault, but its strip lives only as long as it does.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.open]  a vault-relative path to open in it
 */
function createWindow ({ open = null } = {}) {
  /* The first window keeps the size it always had, and takes the whole screen;
     a second one is sized and placed from the window it was opened out of, so
     it lands somewhere the reader is already looking. */
  const parent = windows.size ? focusedWindow() : null
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 680,
    minHeight: 460,
    ...cascadeFrom(parent),
    ...windowChrome(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141317' : '#FBFAF8',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload uses only contextBridge, ipcRenderer, and webUtils — all
      // available inside the sandbox, so there is no reason to leave it off.
      sandbox: true,
      /* For one thing only: the YouTube player a note embeds, which cannot be
         an <iframe> — see the account in src/assets.js. What a guest is then
         allowed to do is decided in guardGuests() below, not here. */
      webviewTag: true
    }
  })

  windows.add(win)
  // Claimed by `window:role` during boot, and gone once it has been read.
  if (open) pendingOpens.set(win.webContents.id, open)
  /* The first window to exist is the primary one for as long as it does. It is
     not handed on when that window closes: the strip a later window is holding
     was never the session's, and promoting it would write it over the session
     that is on disk — a window opened for one look at one note would become
     what the next launch comes back to. */
  if (!primaryWindow) primaryWindow = win
  const primary = primaryWindow === win

  /* The first window opens filling the screen. The width and height above stay
     what they are — they are the size it returns to when it is un-maximised,
     and a restore size equal to the screen would make the green button do
     nothing. A second window keeps the size it was cascaded at: it was opened
     to be looked at beside something, which a maximise would undo. */
  if (primary) win.maximize()

  /* Shown when there is something to read, not when there is a frame to fill.
     `ready-to-show` fires as soon as the document has painted once — about
     half a second in — which is well before the renderer has read the config,
     walked the vault and opened the last note. Showing then meant the launch
     was an empty window wearing a "Opening your workspace" card for the
     remaining half second. The window now waits for `app:painted`, so the
     launch is a dock bounce and then the note.

     The timer is the backstop: a renderer that throws before it can say
     anything, or never finishes loading, must still leave a window on screen
     — with the boot screen's error card in it, which is the one thing the
     splash was actually good for. */
  let shown = false
  let revealBackstop = null
  const reveal = () => {
    if (shown || win.isDestroyed()) return
    shown = true
    clearTimeout(revealBackstop)
    win.show()
    /* A window opened while another one has the screen has to come forward as
       well as appear, or the reader's ⌘⌥N looks like it did nothing. */
    if (!primary) win.focus()
  }
  reveals.set(win.webContents.id, reveal)
  win.once('ready-to-show', () => { revealBackstop = setTimeout(reveal, 4000) })
  win.webContents.on('render-process-gone', reveal)
  win.webContents.on('did-fail-load', reveal)
  win.on('closed', () => clearTimeout(revealBackstop))

  /* Over `tulip-app` rather than `file:`, for the V8 code cache — see the
     scheme registration. The handler is installed in `whenReady` before any
     window is built, so there is never a load racing it. */
  if (useAppScheme()) win.loadURL(`${APP_ORIGIN}/index.html`)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  // External links open in the browser; the vault never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  /* The window shows dist/index.html and nothing else, ever. Without this, a
     note could carry an <a href="tulip-file://vault/page.html"> and a click
     would swap the app for a document of the vault's choosing — same origin,
     same preload, so `window.tulip` and every filesystem call with it. The
     app never navigates its own top frame (views swap in-page), so refusing
     all of it costs nothing. In-page #anchors don't raise this event. */
  win.webContents.on("will-navigate", (event) => event.preventDefault())

  /* The native context menu, and it only ever shows up over text you can
     type in. Right-clicks elsewhere are the renderer's to draw — the tree,
     tables and images all build their menus in-page and call preventDefault,
     which keeps this event from firing. What is native is what only the
     platform knows: spelling. Over a word the checker has underlined this is
     its suggestions and the way to teach it the word — unlearnable again from
     Settings → Markdown — and over any other editable text it is the standard
     cut, copy and paste. */
  win.webContents.on("context-menu", (_event, params) => {
    const word = params.misspelledWord
    const spelling = []
    /* A menu outlives the click that opened it: the window can be closed while
       it is still up, and calling into a destroyed webContents throws from a
       place with no caller to catch it. */
    const live = () => !win.isDestroyed() && !win.webContents.isDestroyed()
    if (word) {
      for (const to of params.dictionarySuggestions.slice(0, 5)) {
        spelling.push({ label: to, click: () => { if (live()) win.webContents.replaceMisspelling(to) } })
      }
      if (!spelling.length) spelling.push({ label: 'No suggestions', enabled: false })
      spelling.push({ type: 'separator' }, {
        label: `Add “${word}” to Dictionary`,
        // Through teachWord rather than straight at the session: the app's own
        // dictionary has to hear about it too, or the word keeps its underline.
        click: () => { if (live()) teachWord(word) }
      })
    }
    const edit = params.isEditable ? [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] : []
    const template = spelling.length && edit.length
      ? [...spelling, { type: 'separator' }, ...edit]
      : [...spelling, ...edit]
    if (template.length) Menu.buildFromTemplate(template).popup()
  })

  /* The fence a note's embeds attach behind. Registered here, per window, so
     that a window built by the Dock's `activate` gets one too — see the
     account above `fenceWebviewAttach`. */
  fenceWebviewAttach(win)

  /* Nothing a note started outlives the window that started it — the runs that
     window asked for, and, when it is the window the copilot belongs to, the
     CLI behind it. That process runs with the vault as its working directory
     and holds tools that write notes: left alive by ⌘W it kept editing the
     vault with no window to show for it, and every event it sent was dropped
     on the floor, including the one that records what it changed — so the
     edits landed with no way to review or undo them. */
  /* Read now, not in the handler below. By the time `closed` fires the
     webContents is gone, and `win.webContents` on a destroyed window does not
     answer null — it throws "Object has been destroyed". So the first line of
     that handler threw, every line after it was skipped, and the crash guard
     logged it where nobody was looking: closing a window left its runs and its
     kernels alive, and ⌘W on the first window left the copilot's CLI running
     against the vault with no window to show for it. Which is the exact failure
     the comment above this describes, arriving by the route that was meant to
     prevent it. */
  const contentsId = win.webContents.id

  win.on('closed', () => {
    windows.delete(win)
    reveals.delete(contentsId)
    documentZoomClaims.delete(contentsId)
    stopRunsOwnedBy(win)
    stopKernelsOwnedBy(win)
    if (primary) {
      primaryWindow = null
      try { aiInstance?.stopAll('SIGKILL') } catch { /* nothing running */ }
    }
  })

  // Held open until unsaved edits reach the disk — see askRendererToFlush.
  let flushed = false
  let flushing = false
  win.on('close', (event) => {
    if (flushed) return
    event.preventDefault()
    // A second close attempt while the first is still waiting is the same
    // close, not another one.
    if (flushing) return
    flushing = true
    askRendererToFlush(win).then(() => {
      flushed = true
      /* A quit is every window's business and closing one is its own: `close`
         here is this window going, and the quit that provoked it will come
         round to the rest of them on their own `close` events. */
      if (quitting) app.quit()
      else if (!win.isDestroyed()) win.close()
    })
  })

  // Restore the saved zoom once the page exists, and report it so the status
  // bar agrees with reality from the first frame.
  win.webContents.on('did-finish-load', () => {
    const saved = readConfig().zoom || DEFAULT_ZOOM
    if (saved !== 1) win.webContents.setZoomFactor(saved)
    sendTo(win, 'zoom', Math.round(saved * 100))
  })

  /* No `zoom-changed` listener: the window is not pinched. Ctrl+scroll and
     trackpad pinch are swallowed in the renderer — over a note because two
     fingers there mean nothing, over a PDF or a website because the document
     resizes itself — so the only sizes the window ever takes are the ones the
     menu, the keys and the settings stepper ask for. */
  return win
}

/**
 * Another window on the same vault, optionally showing a particular note.
 *
 * The path is not resolved here and nothing is read with it: it is handed to
 * the new window, which opens it the way it opens anything the reader clicks —
 * through `file:read`, which is realpath-contained like every other path that
 * arrives from a renderer. So this adds no reach; it is a string being passed
 * between two windows that could each already ask for it.
 */
/* What a window was opened to show, held between its creation and the moment
   its renderer is far enough along to ask. Keyed by webContents rather than by
   window because that is what an IPC event carries back. */
const pendingOpens = new Map()

/**
 * What kind of window this is, asked for rather than announced.
 *
 * Asked, because the answer is needed at a particular point in boot and a
 * message pushed from main would race the renderer's own startup — arriving
 * either before there was a listener for it or after the strip it decides had
 * already been drawn.
 */
ipcMain.handle('window:role', (event) => {
  const win = windowOf(event)
  const key = event.sender.id
  const open = pendingOpens.get(key) || null
  // Read once: a reload of the page is a fresh start, not a second delivery of
  // a note somebody asked for a window of some time ago.
  pendingOpens.delete(key)
  return { primary: !!win && win === primaryWindow, open }
})

ipcMain.handle('window:new', (_e, open) => {
  const wanted = typeof open === 'string' && open.length <= 1024 ? open : null
  createWindow({ open: wanted })
  return { ok: true }
})

/* ======================================================= a tab between windows

   Dragging a tab from one window's strip onto another's is arbitrated here
   rather than carried by the drag itself.

   A drag between two BrowserWindows leaves the page and becomes an OS drag, and
   what survives that crossing is a short list of standard flavours — not a
   custom MIME type, and not reliably on every platform. Writing the note's path
   into `text/plain` so it would survive means every drop target outside the app
   receives a filesystem path it did not ask for, which is a worse bargain than
   asking main.

   So the strip says what it has picked up, the receiving strip asks what is in
   flight, and main is the one place both of them agree with. `dragend` always
   runs in the window that started the drag — including when the drop happened
   somewhere else entirely — so the claim cannot outlive the gesture. */
let tabInFlight = null

/* Keyed by `event.sender.id` throughout rather than by the window object: the
   id is what every side of this can compare without holding a reference to a
   window that may close mid-drag. */
ipcMain.on('tab:drag-start', (event, path) => {
  if (typeof path !== 'string' || !path || path.length > 1024) return
  tabInFlight = { path, from: event.sender.id }
})

ipcMain.on('tab:drag-end', (event) => {
  // Only the window that picked it up may put it down: a stale end from another
  // window would cancel a drag it was never part of.
  if (tabInFlight && tabInFlight.from === event.sender.id) tabInFlight = null
})

/**
 * What another window is dragging, if anything.
 *
 * Answers null for the window that started the drag, so an ordinary reorder
 * inside one strip is never mistaken for a handoff.
 */
ipcMain.handle('tab:dragging', (event) => {
  if (!tabInFlight || tabInFlight.from === event.sender.id) return null
  return { path: tabInFlight.path }
})

/**
 * The receiving window has taken the tab: tell the window that had it to let go.
 *
 * The claim is consumed here, so two strips cannot both take one tab — a drop
 * that arrives second gets null and does nothing.
 */
ipcMain.handle('tab:claim', async (event) => {
  const claim = tabInFlight
  if (!claim || claim.from === event.sender.id) return null
  // Consumed before the await, not after: two drops landing in the same frame
  // would otherwise both find a claim here and both open the note.
  tabInFlight = null
  const from = liveWindows().find((w) => w.webContents.id === claim.from)
  if (from) {
    /* The buffer reaches the disk BEFORE the other window reads it. The
       receiving window opens the note off the disk, so without this it would
       open the version from before whatever was just typed — and then the
       window that had the edit closes its tab, taking the edit with it. Same
       ordering `openInNewWindow` keeps, for the same reason. */
    await askRendererToFlush(from)
    sendTo(from, 'tab:claimed', claim.path)
  }
  return { path: claim.path }
})

/**
 * The copilot belongs to the primary window, and answers only to it.
 *
 * One CLI session, and one chat file per vault written whole on every save: a
 * second window holding a conversation would overwrite the first window's
 * transcripts with its own copy of them. Rather than invent a merge, the
 * copilot is offered in one window — the second window hides the panel, and
 * this is the fence behind that, because a hidden control is a decision the
 * renderer could change its mind about and this one is not the renderer's.
 */
function assertCopilotWindow (event) {
  if (windowOf(event) !== copilotWindow()) {
    throw new Error('The copilot runs in the main window.')
  }
}

/** The copilot's events, to the one window that is allowed to hold it. */
function toCopilot (channel, payload) {
  sendTo(copilotWindow(), channel, payload)
}

/**
 * A run's output, to the window that started it.
 *
 * Broadcasting instead would put one window's program output into the code
 * block of every other window showing the same note — the renderer keys these
 * by run id, and a second window opening the same note has its own block with
 * its own id, so the text would land in a block that did not ask for it.
 */
function toRun (channel, payload) {
  sendTo(runOwners.get(payload?.id), channel, payload)
  /* `run:done` is the last thing ever said about a run, so the entry goes with
     it. Without this the map holds a reference to every window that has ever
     run a block, and closing one would not be the end of it. */
  if (channel === 'run:done') runOwners.delete(payload?.id)
}

/* ---------------------------------------------------------------- zoom */

/* Browser-style stops rather than Electron's 1.2^level curve, so the reported
   percentage is always a round number someone would recognise — and beside
   them, where a window starts and where ⌘0 puts it back.

   Shared with the settings pane's stepper and the status bar through the JSON,
   the way the asset table already is: the menu, the stepper and the indicator
   must agree about the stops and about which one is home, and hand-kept copies
   would eventually disagree. Adding a stop, or moving home, is one edit. */
const { steps: ZOOM_STEPS, start: DEFAULT_ZOOM } = require('./zoom-steps.json')

/* Set by the renderer whenever what is on screen zooms itself: a PDF, a
   website. While one of those is open, ⌘+ is a question about the document. */
/* Per window, because a PDF open in one of them says nothing about what ⌘+
   means in another: a global flag here had a document in the second window
   quietly swallowing the first window's zoom keys. */
const documentZoomClaims = new Set()
const documentOwnsZoom = (win) => !!win && documentZoomClaims.has(win.webContents.id)

/* Zoom is per window — it is the size of the text in front of you, and a
   second window opened to read something beside the first has every reason to
   be at a different one. What is written to the config is the last size asked
   for anywhere, which is what a new window starts at. */
function zoomFactor () {
  const win = focusedWindow()
  if (!win) return 1
  return win.webContents.getZoomFactor()
}

function applyZoom (factor) {
  const win = focusedWindow()
  if (!win) return
  const clamped = Math.min(ZOOM_STEPS.at(-1), Math.max(ZOOM_STEPS[0], factor))
  win.webContents.setZoomFactor(clamped)
  writeConfig({ zoom: clamped })
  sendTo(win, 'zoom', Math.round(clamped * 100))
}

/**
 * ⌘+, ⌘− and ⌘0 — to the window, or to what the window is showing.
 *
 * A PDF resizes itself, and while one is open the size the reader means by ⌘+
 * is the page's, not the app's: the viewer takes the keystroke and says what it
 * did in its own toolbar. The same claim decides where a pinch goes, because it
 * is the same question — whose zoom is this? — asked with two fingers instead.
 *
 * @param {1|-1|0} direction  in, out, or back to the default size
 */
function zoomCommand (direction) {
  if (documentOwnsZoom(focusedWindow())) {
    toFocused('menu', direction === 0 ? 'zoom-reset' : direction > 0 ? 'zoom-in' : 'zoom-out')
    return
  }
  if (direction === 0) applyZoom(DEFAULT_ZOOM)
  else nudgeZoom(direction)
}

function nudgeZoom (direction) {
  const current = zoomFactor()
  let index = ZOOM_STEPS.findIndex((s) => Math.abs(s - current) < 0.005)
  if (index === -1) {
    /* A size that is not a stop — a config written by a version that pinched
       the window, or a stop since removed from the list. Step from whichever
       stop is nearest, which is how a session gets back onto the list. */
    index = ZOOM_STEPS.reduce(
      (best, s, i) => (Math.abs(s - current) < Math.abs(ZOOM_STEPS[best] - current) ? i : best),
      0
    )
  }
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction))
  applyZoom(ZOOM_STEPS[next])
}

/* ------------------------------------------------------ custom hotkeys */

/**
 * Which menu commands can be rebound, and to what — see the Hotkeys section
 * of the Settings pane. The menu template is the registry: every item that
 * sends a command over the `menu` channel carries `command:` beside its
 * click, and this pass collects them (label, menu, default key) and swaps in
 * whatever the config says instead. An empty override means "no key at all".
 *
 * The catalogue is rebuilt with the menu, so `hotkeys:list` always describes
 * the menu actually installed.
 */
let hotkeyCatalogue = []

/* Electron throws out of `buildFromTemplate` on an accelerator it cannot
   parse, and this one arrives from a config file — a mangled entry must cost
   that one binding, never the whole menu at boot. */
const ACCELERATOR_SHAPE = new RegExp(
  '^(?:(?:Cmd|Ctrl|CmdOrCtrl|Alt|Option|Shift|Super|Meta)\\+)*' +
  '(?:[A-Za-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Plus|Space|Tab|Backspace|Delete|' +
  "Return|Enter|Esc|Escape|Up|Down|Left|Right|Home|End|PageUp|PageDown|" +
  "[\\[\\]\\\\/,.'=;`-])$"
)
const usableAccelerator = (value) =>
  typeof value === 'string' && (value === '' || ACCELERATOR_SHAPE.test(value))

function applyHotkeys (template) {
  const overrides = readConfig().hotkeys || {}
  const seen = new Map()
  const walk = (items, menuLabel) => {
    for (const item of items || []) {
      if (Array.isArray(item.submenu)) walk(item.submenu, item.label || menuLabel)
      if (!item.command) continue
      if (!seen.has(item.command)) {
        seen.set(item.command, {
          command: item.command,
          label: item.label,
          section: menuLabel || '',
          accelerator: item.accelerator || ''
        })
      }
      const wanted = overrides[item.command]
      if (!usableAccelerator(wanted)) continue
      /* A hidden twin exists only to carry a second spelling of the default —
         ⌘\ beside ⌘B — and a rebound command must not keep the stale key
         alive underneath the new one. */
      if (item.visible === false) { delete item.accelerator; continue }
      if (wanted) item.accelerator = wanted
      else delete item.accelerator
    }
  }
  walk(template, '')
  hotkeyCatalogue = [...seen.values()]
}

/* Every accelerator here is `CmdOrCtrl`, never a bare `Cmd`. Electron treats
   Cmd as macOS-only and simply drops the binding everywhere else, so the
   Windows build shipped a menu whose shortcuts — Save, Find, New Note, all of
   them — did nothing at all, while still printing the key beside the item.
   `CmdOrCtrl` is ⌘ on a Mac and Ctrl elsewhere, which is what both platforms
   already expect. scripts/test-platform.mjs asserts the bare form stays gone. */
function buildMenu () {
  const template = [
    {
      label: 'Tulip',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        /* Which vault is open is a fact about the app rather than about a file
           in it, so it is asked for here rather than under File — where it sat
           among New Note and Save, and where nobody looking to switch vaults
           thought to look. */
        /* Both of these existed only as palette commands. "Check for Updates…"
           is the single most conventional item in a Mac application menu, and
           a reader who wants to know whether they are behind looks here before
           anywhere else; "Open Recent" is where every editor puts the list. */
        { label: 'Check for Updates…', command: 'check-for-updates', click: () => toFocused('menu', 'check-for-updates') },
        { type: 'separator' },
        { label: 'Open Vault…', accelerator: 'CmdOrCtrl+Shift+O', click: () => pickVault() },
        { label: 'Open Recent Vault…', command: 'open-recent-vault', click: () => toFocused('menu', 'open-recent-vault') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', command: 'settings', click: () => toFocused('menu', 'settings') },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+N', command: 'new-note', click: () => toFocused('menu', 'new-note') },
        { label: 'New Whiteboard', command: 'new-whiteboard', click: () => toFocused('menu', 'new-whiteboard') },
        { label: 'New Website', command: 'new-website', click: () => toFocused('menu', 'new-website') },
        { label: 'New Language', command: 'new-language', click: () => toFocused('menu', 'new-language') },
        { label: 'New Folder', accelerator: 'CmdOrCtrl+Shift+N', command: 'new-folder', click: () => toFocused('menu', 'new-folder') },
        { type: 'separator' },
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', command: 'new-tab', click: () => toFocused('menu', 'new-tab') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', command: 'close-tab', click: () => toFocused('menu', 'close-tab') },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', command: 'reopen-tab', click: () => toFocused('menu', 'reopen-tab') },
        { type: 'separator' },
        { label: 'Reveal in Finder', command: 'reveal', click: () => toFocused('menu', 'reveal') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', command: 'save', click: () => toFocused('menu', 'save') },
        /* The toolbar's own Run for the source file on screen, reachable from
           the keyboard. ⌘R is free here — this menu has never carried the
           browser's reload. The renderer guards it: with anything but a
           runnable source file open, the command says so and does nothing. */
        { label: 'Run File', accelerator: 'CmdOrCtrl+R', command: 'run-file', click: () => toFocused('menu', 'run-file') },
        /* Not Cmd+P, which has always been the command palette here. */
        { label: 'Print…', accelerator: 'CmdOrCtrl+Alt+P', command: 'print-note', click: () => toFocused('menu', 'print-note') },
        { label: 'Export as PDF…', command: 'export-pdf', click: () => toFocused('menu', 'export-pdf') },
        { label: 'Export as HTML…', command: 'export-html', click: () => toFocused('menu', 'export-html') },
        { label: 'Export as Markdown…', command: 'export-markdown', click: () => toFocused('menu', 'export-markdown') },
        { label: 'Export Whiteboard as PNG…', command: 'export-whiteboard-png', click: () => toFocused('menu', 'export-whiteboard-png') },
        { label: 'Export Whiteboard as SVG…', command: 'export-whiteboard-svg', click: () => toFocused('menu', 'export-whiteboard-svg') },
        { label: 'Export Notebook as Script…', command: 'export-notebook-script', click: () => toFocused('menu', 'export-notebook-script') },
        { label: 'Export Notebook as HTML…', command: 'export-notebook-html', click: () => toFocused('menu', 'export-notebook-html') }
      ]
    },
    {
      /* Running is a menu of its own rather than items under Edit, because
         running is not editing — and because these are the commands a notebook
         has that nothing else in the app does. Every one of them does nothing
         at all while anything but a notebook is open, which is what the
         renderer's own guard is for; a menu that greys out per document would
         need the menu rebuilt on every tab switch. */
      label: 'Notebook',
      submenu: [
        /* No accelerator on this one, deliberately. ⇧⏎, ⌘⏎ and ⌥⏎ are already
           the three Enters a notebook has, and they are handled in the page
           where the difference between them lives — a menu accelerator would
           swallow the key app-wide and hand all three to this one command,
           which is only the first of the three. */
        { label: 'Run Cell', command: 'nb-run-cell', click: () => toFocused('menu', 'nb-run-cell') },
        { label: 'Run All', command: 'nb-run-all', click: () => toFocused('menu', 'nb-run-all') },
        { label: 'Run All Above', command: 'nb-run-above', click: () => toFocused('menu', 'nb-run-above') },
        { label: 'Run All Below', command: 'nb-run-below', click: () => toFocused('menu', 'nb-run-below') },
        { type: 'separator' },
        { label: 'Interrupt', accelerator: 'CmdOrCtrl+.', command: 'nb-interrupt', click: () => toFocused('menu', 'nb-interrupt') },
        { label: 'Restart Kernel…', command: 'nb-restart', click: () => toFocused('menu', 'nb-restart') },
        { label: 'Restart and Run All…', command: 'nb-restart-all', click: () => toFocused('menu', 'nb-restart-all') }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        /* Sent to the renderer rather than left as roles, because what ⌘Z
           means depends on what is on screen: a note undoes an edit, a PDF
           undoes a highlight, and a plain text field wants the browser's own
           history — which the renderer asks for back through `edit:undo`. */
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', command: 'undo', click: () => toFocused('menu', 'undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', command: 'redo', click: () => toFocused('menu', 'redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Note', accelerator: 'CmdOrCtrl+F', command: 'find', click: () => toFocused('menu', 'find') },
        { label: 'Search Vault', accelerator: 'CmdOrCtrl+Shift+F', command: 'search', click: () => toFocused('menu', 'search') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', command: 'back', click: () => toFocused('menu', 'back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', command: 'forward', click: () => toFocused('menu', 'forward') },
        { type: 'separator' },
        { label: 'Previous Tab', accelerator: 'Alt+CmdOrCtrl+Left', command: 'prev-tab', click: () => toFocused('menu', 'prev-tab') },
        { label: 'Next Tab', accelerator: 'Alt+CmdOrCtrl+Right', command: 'next-tab', click: () => toFocused('menu', 'next-tab') },
        { type: 'separator' },
        { label: 'Quick Switcher', accelerator: 'CmdOrCtrl+O', command: 'switcher', click: () => toFocused('menu', 'switcher') },
        { label: 'Jump to Heading', command: 'headings', click: () => toFocused('menu', 'headings') },
        { label: 'Command Palette', accelerator: 'CmdOrCtrl+P', command: 'commands', click: () => toFocused('menu', 'commands') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', command: 'sidebar', click: () => toFocused('menu', 'sidebar') },
        // The old key still works. A menu item carries one accelerator, so the
        // second one needs a twin of its own, kept out of the menu.
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', visible: false, command: 'sidebar', click: () => toFocused('menu', 'sidebar') },
        { label: 'Toggle Outline', accelerator: 'CmdOrCtrl+Shift+E', command: 'outline', click: () => toFocused('menu', 'outline') },
        { label: 'Toggle Backlinks', accelerator: 'CmdOrCtrl+Shift+K', command: 'links', click: () => toFocused('menu', 'links') },
        { label: 'Toggle Info', accelerator: 'CmdOrCtrl+Shift+I', command: 'info', click: () => toFocused('menu', 'info') },
        { label: 'Toggle Copilot', accelerator: 'CmdOrCtrl+Shift+A', command: 'copilot', click: () => toFocused('menu', 'copilot') },
        { label: 'Reading View', accelerator: 'CmdOrCtrl+1', command: 'view-read', click: () => toFocused('menu', 'view-read') },
        { label: 'Editing View', accelerator: 'CmdOrCtrl+2', command: 'view-edit', click: () => toFocused('menu', 'view-edit') },
        { label: 'Raw View', accelerator: 'CmdOrCtrl+3', command: 'view-raw', click: () => toFocused('menu', 'view-raw') },
        { label: 'Toggle Reading View', accelerator: 'CmdOrCtrl+E', command: 'reading', click: () => toFocused('menu', 'reading') },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+Shift+L', command: 'theme', click: () => toFocused('menu', 'theme') },
        { label: 'Change Theme…', command: 'themes', click: () => toFocused('menu', 'themes') },
        { type: 'separator' },
        { label: 'Default Size', accelerator: 'CmdOrCtrl+0', click: () => zoomCommand(0) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => zoomCommand(1) },
        // ⌘= is what the key actually produces unshifted; both reach the same place.
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, click: () => zoomCommand(1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoomCommand(-1) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      /* Spelled out rather than `role: 'windowMenu'`, which puts Close on ⌘W —
         the key that now closes a tab. A window with eight tabs open should
         not vanish because you meant to shut one of them. */
      label: 'Window',
      submenu: [
        /* Not ⌘N: that has been New Note since Tulip had one window, and a
           note is what people press it for far more often than a window. */
        { label: 'New Window', accelerator: 'CmdOrCtrl+Alt+N', click: () => createWindow() },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        { type: 'separator' },
        { role: 'front' }
      ]
    },
    {
      /* There was no Help menu at all. Everything under it existed already —
         in the command palette — which is only findable by someone who knows
         ⌘P, and the two diagnostics items are exactly what a reader reaches
         for at the moment something has gone wrong and nothing is working the
         way they expect. The keyboard sheet is the one thing here that is not
         in the palette: an app whose whole interface is chords should be able
         to list them. */
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', command: 'shortcuts', click: () => toFocused('menu', 'shortcuts') },
        { type: 'separator' },
        { label: 'Tulip on GitHub', click: () => shell.openExternal(REPO_URL) },
        { label: 'Report an Issue…', click: () => shell.openExternal(`${REPO_URL}/issues/new`) },
        { type: 'separator' },
        { label: 'Reveal Crash Log', command: 'reveal-crash-log', click: () => toFocused('menu', 'reveal-crash-log') },
        { label: 'Copy Diagnostics', command: 'copy-diagnostics', click: () => toFocused('menu', 'copy-diagnostics') }
      ]
    }
  ]
  applyHotkeys(template)
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function pickVault () {
  const res = await dialog.showOpenDialog(focusedWindow(), {
    title: 'Open Vault',
    message: 'Choose a folder of markdown files.',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Open Vault'
  })
  if (res.canceled || !res.filePaths[0]) return null
  /* The buffer goes to disk while `vaultPath` still points at the folder it
     came from. A note's path is relative to its vault, so an autosave that
     fires after the switch resolves the old note's path against the new root
     — and `file:write` makes the directories it needs — quietly depositing a
     copy of a note from the old vault into the new one. The same handshake the
     window close uses; the renderer closes its tabs when `vault:opened`
     arrives, which is after this. */
  await flushAllWindows()
  await openVault(res.filePaths[0])
  return res.filePaths[0]
}

/* ------------------------------------------------------------------- IPC */

ipcMain.handle('vault:pick', () => pickVault())

/* -------------------------------------------------------------- sync health

   Tulip owns no sync client by design: a vault is synced by whatever the
   folder already is — iCloud Drive, Dropbox, Git — and the app's share of
   the bargain is to be a good citizen of it (atomic writes, watching for
   outside changes, merging over an unsaved buffer) and to say which citizen
   it is being. The readout answers from the folder's own address: each
   provider keeps its roots in known places on macOS.
   ================================================================== */

/**
 * The sync provider a vault's path says it lives under, or null.
 *
 * Compared against the real path as well as the literal one: an iCloud vault
 * reached through a symlink still resolves into `Library/Mobile Documents`.
 * The `Library/CloudStorage` roots are the post-2022 file-provider locations;
 * `~/Dropbox` survives for the accounts that predate the move.
 */
function syncProviderFor (dir) {
  if (!dir) return null
  let real = dir
  try { real = fsSync.realpathSync(dir) } catch {}

  for (const where of new Set([dir, real])) {
    const p = where.replace(/\\/g, '/')
    if (/Library\/Mobile Documents\/com~apple~CloudDocs(\/|$)/.test(p)) {
      return { id: 'icloud', label: 'iCloud Drive' }
    }
    const cloudStorage = /Library\/CloudStorage\/([^/]+)/.exec(p)
    if (cloudStorage) {
      const root = cloudStorage[1]
      if (/^Dropbox/i.test(root)) return { id: 'dropbox', label: 'Dropbox' }
      if (/^GoogleDrive/i.test(root)) return { id: 'googledrive', label: 'Google Drive' }
      if (/^OneDrive/i.test(root)) return { id: 'onedrive', label: 'OneDrive' }
      return { id: 'fileprovider', label: root }
    }
    if (/(^|\/)Dropbox(\/|$)/.test(p)) return { id: 'dropbox', label: 'Dropbox' }
  }
  /* A Git vault is visible at its root rather than by address — and worth
     saying, because its sync behaviour is the manual kind: history travels
     only if `.tulip/` is committed. */
  if (fsSync.existsSync(path.join(dir, '.git'))) return { id: 'git', label: 'Git' }
  return null
}

ipcMain.handle('vault:current', () => {
  if (!vaultPath) return null
  return { path: vaultPath, name: path.basename(vaultPath), sync: syncProviderFor(vaultPath) }
})

/**
 * The tree and the attachments, or word that they are the ones already held.
 *
 * `known` is the revision the renderer last drew from. The walk still has to
 * happen — it is how the question is answered at all — but when it lands on
 * the same vault the caller is already showing, the tree is not sent: an
 * outside change to a single note (a sync client, or the copilot working
 * through a series of edits) used to clone every node in the vault across
 * this boundary so the renderer could compute a signature and discard the
 * lot. Callers with nothing to compare — the asset refresh after a paste —
 * pass nothing and always get the whole answer.
 */
ipcMain.handle('vault:snapshot', async (_e, known) => {
  const { tree, assets, evicted, revision } = await getVaultSnapshot()
  const same = known && revision &&
    known.tree === revision.tree && known.assets === revision.assets
  if (same) return { unchanged: true, revision, evicted }
  return { tree, assets, evicted, revision }
})

ipcMain.handle('file:read', async (_e, p) => {
  const abs = await realSafePath(p)
  const text = await fs.readFile(abs, 'utf8')
  if (isLanguageTable(abs)) {
    await languageHistory.sync(rel(abs), text, { trackNew: false }).catch((err) => {
      console.error('language history sync failed', err)
    })
  }
  return text
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
    const created = (MD_EXT.has(path.extname(abs).toLowerCase()) || isTex(abs))
      ? trust?.creationTime(rel(abs), filesystemCreated) || filesystemCreated
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

/* How much of a file is looked at to decide whether it is text. A binary
   announces itself in the first few bytes — a magic number, then a NUL — and a
   text file that begins with 8KB of clean UTF-8 is a text file. */
const SNIFF_BYTES = 8192

/**
 * A Word document, read into the blocks the renderer draws.
 *
 * The whole file at once rather than page by page: a `.docx` is a zip, and a
 * zip is read from its end, so there is no cheaper half of one to fetch first.
 * The parsing is electron/docx.js's — it takes bytes and knows nothing about
 * Electron, which is what lets scripts/test-docx.cjs read a document without a
 * window. Held nowhere afterwards: the reply is the document, and a second look
 * at the same file is a second read, which is what makes a document edited in
 * Word and looked at again show the edit.
 */
/* The bytes a Word document had when it was read, kept by path.

   A save splices the page's edits into the file on disk by offset, so it has
   to be the file that was read. When it is not — Word saved it again, a sync
   client brought the other side's — the splice is refused, and the reader's
   edits would be stuck in a page that can never be written: the disk is a
   different document now, and reopening it would throw the typing away. The
   way out is the same bargain a note gets: the disk's version is copied aside,
   and the page is written over it — spliced into *these* bytes, the ones its
   offsets are offsets into. A few entries, because a document is a few
   megabytes and the reader has a handful open at most. */
const docxOriginals = new Map()
const DOCX_ORIGINALS_KEPT = 6
const DOCX_ORIGINAL_MAX_BYTES = 64 * 1024 * 1024
function rememberDocxOriginal (abs, buffer) {
  docxOriginals.delete(abs)
  if (buffer.length > DOCX_ORIGINAL_MAX_BYTES) return
  docxOriginals.set(abs, buffer)
  while (docxOriginals.size > DOCX_ORIGINALS_KEPT) {
    docxOriginals.delete(docxOriginals.keys().next().value)
  }
}

ipcMain.handle('docx:read', async (_e, p) => {
  try {
    const abs = await realSafePath(p)
    const stat = await fs.stat(abs)
    if (!stat.isFile()) return { ok: false, error: 'That is not a file.' }
    const { readDocxBufferAsync } = require('./docx')
    const buffer = await fs.readFile(abs)
    const doc = await readDocxBufferAsync(buffer)
    rememberDocxOriginal(abs, buffer)
    return { ok: true, ...doc, size: stat.size, modified: stat.mtimeMs }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

/**
 * A Word document written back, and read again.
 *
 * The edit is a list of items rather than a document — see the account at the
 * top of electron/docx.js. The file on disk is what it is spliced into, which
 * is why it is read here and not sent from the renderer: what has to be
 * preserved is the bytes Word wrote, and a round trip through a window is a
 * round trip through this app's model of them.
 *
 * The reply carries the document as it now stands. The offsets the renderer
 * holds are offsets into the file that was read, and this write has moved them
 * all; handing back the new reading is what keeps the next save spliceable.
 */
ipcMain.handle('docx:write', async (_e, p, edit) => {
  try {
    const abs = await realSafePath(p)
    const { readDocxBuffer, writeDocxBuffer, isStaleDocxError } = require('./docx')
    let made
    try {
      made = writeDocxBuffer(await fs.readFile(abs), edit)
    } catch (err) {
      if (!isStaleDocxError(err)) throw err
      /* The file is not the one the page was read from. Without `force` the
         renderer is told so and decides — it puts the disk's version aside
         first, then asks again with `force`, and the page is spliced into the
         bytes it was read from rather than the stranger's. */
      const original = edit?.force ? docxOriginals.get(abs) : null
      if (!original) return { ok: false, stale: true, error: err.message }
      made = writeDocxBuffer(original, edit)
    }
    await writeAtomic(abs, made, { durable: readConfig().durability === 'full' })
    rememberDocxOriginal(abs, made)
    documentsChanged()
    const stat = await fs.stat(abs).catch(() => null)
    const document = readDocxBuffer(made)
    /* Search should find what was typed a moment ago rather than waiting for
       the next walk of the vault — the same courtesy `touchIndex` does a note
       on every autosave. */
    touchDocxIndex(abs, document.blocks, stat)
    return {
      ok: true,
      document: {
        ok: true,
        ...document,
        size: stat?.size ?? made.length,
        modified: stat?.mtimeMs ?? Date.now()
      }
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

/**
 * Every note's text, in one message.
 *
 * For the sweeps that have to read all of them and resolve what they find with
 * the renderer's own scanners — the orphaned-image search is the one — which
 * cannot run here. Asking note by note was a round trip, a `realSafePath` and a
 * `readFile` each, thousands of times over, for text the index is already
 * holding in memory on this side.
 *
 * A note too large to index (see MAX_INDEX_BYTES) is read from disk rather than
 * returned empty: a sweep that quietly skips a note is a sweep that calls a
 * picture orphaned on the strength of not having looked at the note that uses
 * it — and the dialog on the other end of this offers to delete them.
 */
ipcMain.handle('vault:notes', async () => {
  if (!vaultPath) return []
  await ensureIndex()
  return mapLimit([...index.entries()], WALK_LIMIT, async ([key, entry]) => {
    if (entry.size <= MAX_INDEX_BYTES) return { path: key, text: entry.text }
    const text = await fs.readFile(path.resolve(vaultPath, key), 'utf8').catch(() => '')
    return { path: key, text }
  })
})

/* Give pdf.js a guarded URL instead of copying the whole document through IPC.
   Its range requests are answered by the protocol handler below, so a large
   paper can begin rendering before its final bytes have been read. */
ipcMain.handle('pdf:source', async (_e, p) => {
  const abs = await realSafePath(p)
  if (!isPdf(abs)) throw new Error('Only PDFs have a document source.')
  ensurePdfText(rel(abs)).catch(() => {})
  return `tulip-file://vault/${rel(abs).split(path.sep).map(encodeURIComponent).join('/')}`
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
  const ext = path.extname(abs)
  const stem = path.basename(abs, ext)
  const target = freeName(path.dirname(abs), `${stem} (conflicted copy)`, ext)
  try {
    /* `COPYFILE_EXCL` so this can never land on a file that appeared between
       `freeName` looking and the copy happening — losing the disk's version is
       the exact failure this handler exists to prevent, and doing it to a
       bystander would be worse. */
    await fs.copyFile(abs, target, fsSync.constants.COPYFILE_EXCL)
  } catch {
    return null
  }
  noteSelfWrite(target)
  indexDirty = true
  invalidateVaultSnapshot()
  return rel(target)
})

ipcMain.handle('file:write', async (_e, p, content, metadata = null) => {
  /* Fully resolved, exactly as `file:read` resolves it: content flows through
     the last component here, so a link standing where the note should be would
     put the note's text wherever it points. The two handlers agreeing also
     means a note this refuses to write is a note `file:read` already refused
     to open. */
  const abs = await realSafePath(p)
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
    (oldStat?.size ?? 0) <= MAX_VERSIONED_BYTES &&
    Buffer.byteLength(String(content), 'utf8') <= MAX_VERSIONED_BYTES
  /* The note as it stood before this write, read first: the snapshot has to be
     the same text the write is about to replace, and reading after would hand
     the history store the text being written. Read even when the file is new,
     so the note's first save is recorded as the thing it replaced — nothing. */
  /* Except when the index is already holding that same text. Its entry carries
     the mtime and size it was read at, and those matching the file this write
     is about to replace is the same freshness test the index sync itself
     trusts — so the read is of a note that is already in memory, on the path
     that runs every few seconds for as long as anyone is typing. */
  const held = versioned && isMarkdown ? index.get(rel(abs)) : null
  const before = !versioned
    ? null
    : (held && oldStat && held.mtime === oldStat.mtimeMs && held.size === oldStat.size &&
        typeof held.text === 'string' && held.size <= MAX_INDEX_BYTES)
        ? held.text
        : await fs.readFile(abs, 'utf8').catch(() => null)
  /* Capture the old inode's birthtime before the atomic rename replaces it.
     Info can then keep saying when the note was created rather than when its
     newest crash-safe save landed. */
  if (oldStat) trust?.creationTime(rel(abs), oldStat.birthtimeMs)
  const stamp = await writeAtomic(abs, content, {
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
    trust?.record({ source: 'save', changes: [{ path: rel(abs), before, after: String(content) }] })
  }
  /* The text is already here, so the next sync can skip re-reading it. Without
     this, every autosave would cost the index a read of the note being typed.

     Notes only. The index is what vault search and the link tables are built
     from, and a website file put into it would answer a search for the site's
     own name with a row that is not a note — until the next walk of the vault
     quietly dropped it again, which is the worse half of the bug. */
  if (isMarkdown) touchIndex(abs, content, stamp)
  if (whiteboard) touchWhiteboardIndex(abs, content, stamp, metadata?.whiteboardText)
  if (isLanguageTable(abs)) {
    await languageHistory.sync(rel(abs), content).catch((err) => {
      console.error('language history sync failed', err)
    })
  }
  return true
})

ipcMain.handle('file:create', async (_e, dir, name) => {
  /* Same rules as a rename — a name that cannot be created is better refused
     here than turned into a file nobody can open. An empty ask is not a
     failure though: "new note" with nothing typed is how most of them start. */
  const asked = safeFileName(name || 'Untitled', { strip: [NOTE_EXT] })
  if (!asked.ok) throw new Error(asked.error)
  const target = freeName(
    await realSafePath(dir || ''),
    asked.name,
    '.md'
  )
  await fs.mkdir(path.dirname(target), { recursive: true })
  noteSelfWrite(target)
  await fs.writeFile(target, '', 'utf8')
  trust?.creationTime(rel(target), Date.now())
  indexDirty = true
  invalidateVaultSnapshot()
  return rel(target)
})

const EMPTY_TEX_DOCUMENT = `\\documentclass{article}

\\begin{document}

\\end{document}
`

ipcMain.handle('tex:create', async (_e, dir, name) => {
  const target = freeName(await realSafePath(dir || ''), name || 'Untitled', TEX_EXT)
  await fs.mkdir(path.dirname(target), { recursive: true })
  noteSelfWrite(target)
  await fs.writeFile(target, EMPTY_TEX_DOCUMENT, 'utf8')
  trust?.creationTime(rel(target), Date.now())
  invalidateVaultSnapshot()
  return rel(target)
})

/* A website file, empty. Created without an address rather than asking for one
   first: the tab it opens into has an address bar, and typing into that is a
   better way to say where it points than a modal that has to be answered
   before anything exists. */
ipcMain.handle('site:create', async (_e, dir, name) => {
  const target = freeName(await realSafePath(dir || ''), name || 'Untitled', SITE_EXT)
  await fs.mkdir(path.dirname(target), { recursive: true })
  noteSelfWrite(target)
  await fs.writeFile(target, '', 'utf8')
  invalidateVaultSnapshot()
  return rel(target)
})

ipcMain.handle('whiteboard:create', async (_e, dir, name) => {
  const target = freeName(
    await realSafePath(dir || ''),
    name || 'Untitled',
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
  const folder = freeName(await realSafePath(dir || ''), name || 'New language')
  noteSelfWrite(folder)
  await fs.mkdir(folder, { recursive: true })

  const vocabulary = path.join(folder, `Words${LANGUAGE_TABLE_SUFFIX}`)
  noteSelfWrite(vocabulary)
  await fs.writeFile(vocabulary, LANGUAGE_TABLE_TEMPLATE, 'utf8')
  trust?.creationTime(rel(vocabulary), Date.now())

  indexDirty = true
  invalidateVaultSnapshot()
  return { folder: rel(folder), vocabulary: rel(vocabulary) }
})

/* A new table uses the same focused, table-only document and file icon as
   Vocabulary, but starts neutral: editable COL1/COL2/COL3 headings and enough
   blank rows for its row add/delete controls to be useful immediately. */
ipcMain.handle('table:create', async (_e, dir, name) => {
  const target = freeName(
    await realSafePath(dir || ''),
    name || 'Untitled',
    LANGUAGE_TABLE_SUFFIX
  )
  await fs.mkdir(path.dirname(target), { recursive: true })
  noteSelfWrite(target)
  await fs.writeFile(target, CUSTOM_TABLE_TEMPLATE, 'utf8')
  trust?.creationTime(rel(target), Date.now())
  indexDirty = true
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
  if (!CODE_EXT.has(wanted) && !DATA_EXT.has(wanted) &&
    wanted !== NOTEBOOK_EXT && wanted !== DOCX_EXT) {
    throw new Error('That is not a file type Tulip creates.')
  }

  /* A Word document is the one kind here that is not text at all, so it is
     written as bytes rather than seeded with a string. What it starts as is the
     smallest package Word opens without offering to repair it — including a
     stylesheet, so that a heading applied in Tulip is a heading when the file
     is opened in Word. See electron/docx.js. */
  if (wanted === DOCX_EXT) {
    const { blankDocxBuffer } = require('./docx')
    const made = freeName(await realSafePath(dir || ''), name || 'Untitled', wanted)
    await fs.mkdir(path.dirname(made), { recursive: true })
    noteSelfWrite(made)
    await fs.writeFile(made, blankDocxBuffer())
    trust?.creationTime(rel(made), Date.now())
    invalidateVaultSnapshot()
    return rel(made)
  }
  const target = freeName(await realSafePath(dir || ''), name || 'Untitled', wanted)
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
  const seed = DATA_EXT.has(wanted)
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
  trust?.creationTime(rel(target), Date.now())
  invalidateVaultSnapshot()
  return rel(target)
})

ipcMain.handle('folder:create', async (_e, dir, name) => {
  const target = freeName(await realSafePath(dir || ''), name || 'New folder')
  noteSelfWrite(target)
  await fs.mkdir(target, { recursive: true })
  invalidateVaultSnapshot()
  return rel(target)
})

/* Both of these answer with `{ path, links }` — where the thing ended up, and
   how many *other* notes had to be edited to keep pointing at it. Copilot uses
   this function too: its request must take the same route as a title or tree
   rename so links, study state and history follow the file. */
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
  indexDirty = true
  invalidateVaultSnapshot()
  return result
}

ipcMain.handle('file:rename', (_e, p, nextName) => renameDocument(p, nextName))

ipcMain.handle('file:move', async (_e, from, destDir) => {
  const src = await realSafeTargetPath(from)
  const dir = destDir ? await realSafePath(destDir) : path.resolve(vaultPath)

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
  indexDirty = true
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
  // Goes to the system Trash, not an unlink — deletes should be recoverable.
  noteSelfWrite(abs)
  await shell.trashItem(abs)
  await forgetAll(rel(abs), deletingDirectory)
  /* The note is gone, so the environment its blocks ran in is nobody's. Not
     recoverable the way the note is — but it holds no work of the reader's,
     only packages, and a restored note builds a new one on its next run. */
  await Promise.all(losingEnvs.map((note) => pythonEnvs.forget(note)))
  trust?.forgetCreations(rel(abs))
  /* Attachment removal is followed immediately by a renderer refresh. The
     watcher invalidates these caches too, but only after its debounce; without
     doing it here that immediate refresh reads the old asset list and redraws
     the image Tulip just moved away. */
  indexDirty = true
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

ipcMain.handle('file-tags:get', async (_e, p) => {
  const abs = await realSafePath(p)
  // Always a list: "no tags" is no entry in the store, and the renderer draws
  // a row of them either way.
  return (await fileTags.get(rel(abs))) || []
})

ipcMain.handle('file-tags:set', async (_e, p, values) => {
  const abs = await realSafePath(p)
  return (await fileTags.set(rel(abs), values)) || []
})

/**
 * The column widths a table was left at, and where they are put back.
 *
 * A `.csv` is its data and nothing else — there is no line in it that could
 * say how wide a column should be — so this is the only place the answer can
 * live. Bounded by the store's own cleaning: a layout for a file that has
 * since gained or lost columns is simply not applied, which csv.js decides,
 * because a width list of the wrong length says nothing about this file.
 */
ipcMain.handle('table-widths:get', async (_e, p) => {
  const abs = await realSafePath(p)
  return (await tableWidths.get(rel(abs))) || null
})

ipcMain.handle('table-widths:set', async (_e, p, widths) => {
  const abs = await realSafePath(p)
  return (await tableWidths.set(rel(abs), widths)) || null
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
  let first = null

  const copyInto = async (source, dir) => {
    let stat
    try { stat = await fs.lstat(source) } catch { skipped++; return }
    // Symlinks are skipped outright: following one could walk out of what was
    // dropped — or around a `ln -s ..` loop forever.
    if (stat.isSymbolicLink()) { skipped++; return }

    if (stat.isDirectory()) {
      const name = path.basename(source)
      if (name.startsWith('.') || IGNORED_DIRS.has(name)) return
      const target = freeName(dir, name)
      await fs.mkdir(target, { recursive: true })
      let entries = []
      try { entries = await fs.readdir(source) } catch { /* unreadable */ }
      for (const entry of entries) await copyInto(path.join(source, entry), target)
      return
    }

    /* Notes, PDFs, whiteboards, and now source and data files: the documents
       the vault can validate by extension and then actually open. The filter
       is the point — a drag is a copy *into* the vault, and one that accepted
       anything would make the tree a place unopenable files accumulate.

       Source and data files earn their place here by the same test as the
       rest: the app opens them, edits them and versions them, so a dragged-in
       `.py` is a document and not a stowaway. Anything outside these lists is
       still skipped and still counted, which is what the "n skipped" in the
       import's report is for. */
    if (!MD_EXT.has(path.extname(source).toLowerCase()) && !isTex(source) &&
        !isPdf(source) && !isWhiteboard(source) && !isNotebook(source) &&
        !isCode(source) && !isData(source)) { skipped++; return }
    const ext = path.extname(source)
    const target = freeName(dir, path.basename(source, ext), ext)
    noteSelfWrite(target)
    await fs.copyFile(source, target)
    /* The creation date is kept for the kinds whose history the trust store
       holds — which is now the same set that `file:write` versions, source and
       data files included. */
    if (MD_EXT.has(path.extname(target).toLowerCase()) || isTex(target) ||
        isCode(target) || isData(target)) {
      trust?.creationTime(rel(target), Date.now())
    }
    imported++
    if (!first) first = rel(target)
  }

  for (const source of sources || []) {
    if (typeof source !== 'string' || !source) { skipped++; continue }
    // Dragging a note out of the vault and back in would otherwise duplicate
    // it against itself.
    if (path.resolve(source) === path.resolve(vaultPath)) { skipped++; continue }
    await copyInto(path.resolve(source), root)
  }

  indexDirty = true
  invalidateVaultSnapshot()
  return { imported, skipped, first }
})

ipcMain.handle('file:reveal', async (_e, p) => {
  shell.showItemInFolder(await realSafePath(p))
})

/* ----------------------------------------------------------- TeX preview */

const TEX_PREVIEW_DIR = () => path.join(app.getPath('userData'), 'tex-preview')
let texCompiler = null
let texCompilerVault = ''

ipcMain.handle('tex:compile', async (_e, p) => {
  if (!vaultPath) return { ok: false, error: 'Open a vault first.' }
  let abs
  try { abs = await realSafePath(p) } catch (err) {
    return { ok: false, error: err.message || 'That TeX file is not available.' }
  }
  if (!isTex(abs)) return { ok: false, error: 'Only TeX files can be compiled.' }

  if (!texCompiler || texCompilerVault !== vaultPath) {
    texCompiler?.stop()
    texCompilerVault = vaultPath
    const { createTexCompiler } = require('./tex-compile')
    texCompiler = createTexCompiler({
      vault: vaultPath,
      cacheRoot: TEX_PREVIEW_DIR(),
      // Read per compile, not captured here: the compiler outlives a trip to
      // the settings pane, and the engine chosen there has to take effect on
      // the next compile rather than the next vault.
      engine: () => readConfig().texEngine || 'pdflatex'
    })
  }
  try {
    const result = await texCompiler.compile(abs)
    return {
      ok: true,
      url: `tulip-file://tex-preview/${result.artifact}?v=${Date.now()}`,
      root: result.root,
      compiler: result.compiler,
      log: result.log
    }
  } catch (err) {
    return { ok: false, error: err.message || 'LaTeX could not compile this document.', log: err.log || '' }
  }
})

ipcMain.handle('shell:open', async (_e, url) => {
  if (/^(?:https?|mailto):/i.test(url)) await shell.openExternal(url)
})

/* Electron's clipboard rather than the page's. `navigator.clipboard.writeText`
   refuses outright — "Document is not focused" — whenever the window is not the
   focused one, which is exactly the state a page is in while a native context
   menu is up, and it can only be found out about after the copy silently did
   not happen. This one has no such condition. */
ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text ?? ''))
  return true
})

/* The words the spellchecker has been told to leave alone. They usually go in
   from the context menu over a red underline (see the context-menu handler in
   createWindow); Settings is where the list can be read, added to by hand, and
   pruned — removing a word puts it back under the checker's eye. */
ipcMain.handle('dictionary:words', async () => {
  const words = await session.defaultSession.listWordsInSpellCheckerDictionary()
  return words.sort((a, b) => a.localeCompare(b))
})
/**
 * Teach the checkers a word, wherever the asking came from — this handler, or
 * the native context menu over an underlined word.
 *
 * Both checkers, or the note keeps its underline under a word the app has been
 * told to accept: Chromium's list is the one Settings shows and the one that
 * survives a restart, and the Hunspell copy is the one the underlines and the
 * pane are actually drawn from.
 */
function teachWord (word) {
  const w = String(word ?? '').trim()
  if (!w) return false
  speller?.add(w)
  forgetSpellVerdicts()
  const done = session.defaultSession.addWordToSpellCheckerDictionary(w)
  // The renderer is holding a pass that is now out of date by one word.
  broadcast('dictionary:changed')
  return done
}

ipcMain.handle('dictionary:add', (_e, word) => teachWord(word))
ipcMain.handle('dictionary:remove', (_e, word) => {
  const w = String(word ?? '').trim()
  if (!w) return false
  // nspell has no way to take a word back out, so the checker is thrown away
  // and rebuilt without it on the next question.
  speller = null
  forgetSpellVerdicts()
  const done = session.defaultSession.removeWordFromSpellCheckerDictionary(w)
  broadcast('dictionary:changed')
  return done
})

/* ---------------------------------------------------------- spelling

   Chromium underlines misspellings in the editor and tells no one which words
   they were: there is no API for reading them back, and the panel in the
   sidebar needs a list. So the app keeps a Hunspell dictionary of its own (see
   src/spellcheck.js) and asks it here — the same side as the custom
   dictionary, which only exists in this process.

   Nothing is loaded until the first question. The dictionaries are a megabyte
   of word list to parse, and most sessions never open the pane. */
let speller = null
let spellerLoading = null

/* One extra language's Hunspell pair, from the gzipped files the build put in
   dist/dict (see build.mjs). The id has been through the config's validator
   and appAsset refuses to leave dist, but the shape check keeps a stray value
   to a missing-file miss rather than a path error. A pair that is not there —
   an id from a newer config under an older build — returns null, and the
   checker simply goes without that language. */
function loadSpellDictionary (id) {
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(String(id || ''))) return null
  try {
    const { gunzipSync } = require('node:zlib')
    return {
      aff: gunzipSync(fsSync.readFileSync(appAsset(`dict/${id}.aff.gz`))),
      dic: gunzipSync(fsSync.readFileSync(appAsset(`dict/${id}.dic.gz`)))
    }
  } catch {
    return null
  }
}

function spellerNow () {
  if (speller) return Promise.resolve(speller)
  if (spellerLoading) return spellerLoading
  spellerLoading = (async () => {
    const { createSpeller, variantForLocale } = require(appAsset('spellcheck.cjs'))
    /* The words taught from the context menu are the app's answer for "this is
       not a mistake", and the panel has to honour it the same way the
       underlines do. */
    const taught = await session.defaultSession.listWordsInSpellCheckerDictionary().catch(() => [])
    const languages = readConfig().spellLanguages
    speller = createSpeller(variantForLocale(app.getLocale()), taught, {
      languages: Array.isArray(languages) ? languages : [],
      loadDictionary: loadSpellDictionary
    })
    return speller
  })()
  spellerLoading.finally(() => { spellerLoading = null })
  return spellerLoading
}

/* A ceiling on one question. A note is a few thousand distinct words at the
   very outside; a number far past that is a bug or a paste of something that
   is not prose, and neither is worth blocking this process over. */
const MAX_SPELL_WORDS = 8000

/* One verdict per word, kept between passes.
   The panel asks again on every pause in typing, and it asks about the whole
   note each time — so a three-thousand-word note was three thousand Hunspell
   lookups every half second, on the event loop that also serves file reads and
   the app's own assets. A word's spelling does not change; only the dictionary
   can change the answer, and both the ways it can do that clear this map (they
   are the two places `dictionary:changed` is announced).

   Bounded, and cleared whole rather than evicted one at a time: this only ever
   saves repeated work, so the rare session that overflows it pays for one cold
   pass rather than growing without end. */
const spellVerdicts = new Map()
const MAX_SPELL_MEMO = 40000
/* Moved by a dictionary change and by nothing else — not by the memo simply
   filling up, which is this process tidying after itself rather than the
   answers changing. A pass in flight compares it against what it captured to
   find out whether the checker it is holding has been superseded. */
let spellGeneration = 0
function forgetSpellVerdicts () { spellVerdicts.clear(); spellGeneration++ }

/* How many unknown words are looked up before yielding. The very first pass
   over a long note has nothing memoised and is the one that can block; broken
   up, an IPC call that arrives in the middle of it waits for a chunk instead of
   the note. */
const SPELL_CHUNK = 500

/* One walk of the unknown words, into a map of this pass's own.
 *
 * Kept out of the memo until the walk is over because of what the yields
 * between chunks let in: a word removed from the dictionary mid-pass sets
 * `speller` aside and clears the memo, and the loop — holding the checker it
 * captured before its first await — used to resume and write that discarded
 * checker's verdicts into the freshly cleared map. The removed word was
 * recorded as correctly spelt and stayed that way until the next dictionary
 * change. `stable` is how the caller learns its answers are of the dictionary
 * that is still in force.
 */
async function spellPass (fresh) {
  const mine = spellGeneration
  const checker = await spellerNow()
  const out = new Map()
  for (let i = 0; i < fresh.length; i += SPELL_CHUNK) {
    const chunk = fresh.slice(i, i + SPELL_CHUNK)
    const bad = new Set(checker.check(chunk))
    for (const word of chunk) out.set(word, bad.has(word))
    if (i + SPELL_CHUNK < fresh.length) await new Promise((done) => setImmediate(done))
  }
  return { out, stable: spellGeneration === mine }
}

ipcMain.handle('spell:check', async (_e, words) => {
  if (!Array.isArray(words) || !words.length) return []
  const asked = words.slice(0, MAX_SPELL_WORDS).map((word) => String(word || '')).filter(Boolean)

  const fresh = [...new Set(asked.filter((word) => !spellVerdicts.has(word)))]
  if (!fresh.length) return asked.filter((word) => spellVerdicts.get(word))

  /* A dictionary change during the walk means the answers are of a dictionary
     nobody is using any more, so it is walked again against the new one. Twice
     over is a bound rather than a belief: the pane re-asks on
     `dictionary:changed` anyway, so a reader holding down Remove costs one
     stale-looking pass and not an unbounded run of retries. */
  let answer = await spellPass(fresh)
  for (let tries = 0; !answer.stable && tries < 2; tries++) answer = await spellPass(fresh)

  if (answer.stable) {
    // The memo's own cap, which is not a change of answer — hence the plain
    // clear rather than `forgetSpellVerdicts`.
    if (spellVerdicts.size + fresh.length > MAX_SPELL_MEMO) spellVerdicts.clear()
    for (const [word, bad] of answer.out) spellVerdicts.set(word, bad)
  }

  // This pass's own answers first: a clear may have emptied the memo under it.
  return asked.filter((word) => answer.out.get(word) ?? spellVerdicts.get(word))
})

ipcMain.handle('spell:suggest', async (_e, word) => {
  const w = String(word ?? '').trim()
  if (!w) return []
  return (await spellerNow()).suggest(w)
})

/* ------------------------------------------------------------- searching

   A query is mostly words to find. The rest of it is filters — `tag:`,
   `path:`, `file:` — which say which notes are worth opening rather than what
   to look for inside them, and quotes, which make a run of words one phrase
   instead of several terms.

   The distinction earns its keep in the scan below: a filter is answered from
   the note's path or its name, so a note that fails one is never read at all.
   Terms are AND-ed, because a two-word query almost always means "the note
   that has both" and almost never "either of these".
   ================================================================== */

/* A word character, for the whole-word switch. `\b` is ASCII-only in
   JavaScript, so searching for "café" whole-word would find it inside
   "cafés" — these classes are what the tag grammar already uses. */
const WORD_BEFORE = '(?<![\\p{L}\\p{N}_])'
const WORD_AFTER = '(?![\\p{L}\\p{N}_])'

/**
 * One term as a regex.
 *
 * The whole-word switch is ignored in regex mode: the lookarounds would fight
 * whatever the pattern's own anchors say, and someone writing a pattern has
 * `\b` to hand. The `u` flag goes on only for the literal case, where this
 * function wrote every character of the source and knows it is valid under it
 * — a hand-written pattern can carry escapes that `u` rejects.
 */
/* A quantifier wrapped around a group that already holds one — `(a+)+`,
   `(\w+\s?)*`, `(x|xx)+` — is the shape that backtracks exponentially. A
   pattern like that against a line of a few dozen characters does not take a
   moment longer, it takes longer than the session: JavaScript cannot interrupt
   a running match, and there is no watchdog to reach for, so the main process
   is simply gone — no autosave, no watcher, no quit.

   Refused rather than run. This costs the small number of legitimate patterns
   of that shape, all of which can be written another way; the alternative
   costs the vault. Only ever applied to patterns the user wrote — see
   `termRegex`, where a literal search escapes its term first. */
const NESTED_QUANTIFIER = /\((?:\?:)?[^()]*[+*][^()]*\)\s*[+*{]/

/* The other shape: a repeated group whose branches can match the same text, so
   the engine has two ways to consume it and tries both — `(x|xx)+`. Branches
   that cannot overlap are not this, which is why `(cat|dog)+` is left alone; a
   shared prefix is the cheap test for whether they can. */
const REPEATED_ALTERNATION = /\((?:\?:)?([^()|]*\|[^()]*)\)\s*[+*]/g

function overlappingAlternation (source) {
  for (const match of source.matchAll(REPEATED_ALTERNATION)) {
    const branches = match[1].split('|').filter(Boolean)
    for (const one of branches) {
      if (branches.some((other) => other !== one && other.startsWith(one))) return true
    }
  }
  return false
}

function termRegex (term, { regex, caseSensitive, word }) {
  if (regex && (NESTED_QUANTIFIER.test(term) || overlappingAlternation(term))) {
    const refused = new Error(
      'That pattern can take forever to match. Try writing it without a repeat inside a repeat.'
    )
    refused.sayWhy = true
    throw refused
  }
  const source = regex
    ? term
    : word
      ? `${WORD_BEFORE}(?:${escapeRe(term)})${WORD_AFTER}`
      : escapeRe(term)
  // `u` only where this function wrote the source; see above.
  const flags = (caseSensitive ? '' : 'i') + (!regex && word ? 'u' : '')
  /* Two of the same pattern. `find` walks a note collecting positions; `has`
     answers "is this term in this note at all" and stops at the first match,
     which is what rejects a note without scanning it for the others. They
     cannot be one regex: `lastIndex` is per-regex, and the rejecting pass runs
     inside the collecting one's loop. */
  return { find: new RegExp(source, `g${flags}`), has: new RegExp(source, flags) }
}

const FILTER = /^(tag|path|file|prop|type):(.*)$/i
const TOKEN = /"([^"]*)"|(\S+)/g

/**
 * Splits a query into its filters and its terms, then compiles the terms.
 *
 * `usable` is what the caller checks before scanning: a query of one character
 * would walk every note in the vault to report that almost all of them match,
 * which is not a search but a pause. A filter is specific by construction, so
 * `tag:x` on its own is allowed to stand.
 *
 * `prop:` is the one filter with two halves: `prop:status` asks for the mere
 * existence of the property, `prop:status=reading` for a value — and a list
 * property answers when any of its items says it.
 */
function compileQuery (raw, opts = {}) {
  const filters = { tag: [], path: [], file: [], prop: [], type: [] }
  const words = []
  // Once, not per iteration: `TOKEN` is global, so it walks the string it was
  // handed, and building a fresh copy of it each time round is pure waste.
  const text = String(raw || '')

  TOKEN.lastIndex = 0
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    const quoted = m[1] !== undefined
    const piece = quoted ? m[1] : m[2]
    if (!piece) continue

    // Only an unquoted token can be a filter: `"tag:x"` asks for that text.
    const filter = !quoted && FILTER.exec(piece)
    if (filter) {
      const kind = filter[1].toLowerCase()
      const value = filter[2].replace(/^"|"$/g, '').toLowerCase()
      if (kind === 'prop') {
        const eq = value.indexOf('=')
        const key = (eq === -1 ? value : value.slice(0, eq)).trim()
        if (key) filters.prop.push({ key, value: eq === -1 ? null : value.slice(eq + 1).trim() })
        continue
      }
      if (value) filters[kind].push(value)
      continue
    }
    words.push(piece)
  }

  const filtered = filters.tag.length + filters.path.length + filters.file.length +
    filters.prop.length + filters.type.length > 0
  let terms
  try {
    terms = words.map((w) => termRegex(w, opts))
  } catch (err) {
    /* Two ways to get here, both of them a pattern in regex mode: one the
       engine will not compile — a half-typed one, which is most keystrokes on
       the way to a whole one — and one it would compile but must not run. The
       second says why; the first has nothing to add. */
    return {
      error: err?.sayWhy ? err.message : 'Not a valid pattern.',
      terms: [], filters, usable: false
    }
  }

  return { terms, words, filters, usable: filtered || words.some((w) => w.length >= 2) }
}

/* `#tag`, matched the way both views match it — see the hashtag rule in
   renderer.js. `tag:book` answers for `#book/fiction` too, so a filter names a
   branch of the tag tree rather than one leaf of it. */
const HASHTAG = /(^|\s)#([\p{L}\p{N}][\p{L}\p{N}/_-]*)/gu

function hasTag (text, wanted) {
  HASHTAG.lastIndex = 0
  for (let m = HASHTAG.exec(text); m; m = HASHTAG.exec(text)) {
    const tag = m[2].toLowerCase()
    if (tag === wanted || tag.startsWith(`${wanted}/`)) return true
  }
  return false
}

/**
 * A note's properties, parsed once and held against the entry. The object is
 * replaced wholesale by `syncIndex`/`touchIndex` when the note changes, so
 * caching on it cannot hand back stale values.
 */
function entryProps (entry) {
  if (entry.props === undefined) {
    entry.props = propsOf(parseFrontmatter(entry.text))
  }
  return entry.props
}

/**
 * Whether a note survives the query's filters, answered before it is read.
 *
 * Each test is skipped when nothing asked for it. Most queries carry no filter
 * at all, and lowercasing a path and a name per note per keystroke is two
 * allocations for every note in the vault to answer a question nobody asked.
 * Ordered cheapest first: the tag and property tests are the only ones that
 * walk the text, and the property one walks only its head.
 */
/**
 * `facts` is what this *query* knows about the entry — its kind, and the tags
 * assigned to its path — as opposed to what the index holds about the note.
 *
 * Passed in rather than read off the entry because the two used to be the same
 * object: the search loop wrote `kind` and `fileTags` onto every entry in the
 * index, for every note in the vault, on every keystroke. That is a vault's
 * worth of writes into a long-lived cache to carry one query's worth of state
 * — and the state leaked, far enough that `index-cache.js` has to strip both
 * fields back out before it is allowed to write the cache to disk.
 */
function passesFilters (key, entry, filters, facts = entry) {
  if (filters.type.length && !filters.type.every((kind) => kind === facts.kind)) return false
  if (filters.path.length) {
    const where = key.toLowerCase()
    if (!filters.path.every((p) => where.includes(p))) return false
  }
  if (filters.file.length) {
    const named = entry.name.toLowerCase()
    if (!filters.file.every((f) => named.includes(f))) return false
  }
  if (filters.tag.length) {
    const assigned = facts.fileTags || []
    if (!filters.tag.every((wanted) =>
      assigned.some((tag) => tag === wanted || tag.startsWith(`${wanted}/`)) ||
      hasTag(entry.text, wanted))) return false
  }
  if (filters.prop.length) {
    const props = entryProps(entry)
    for (const { key: wantKey, value: wantValue } of filters.prop) {
      const prop = props.find((p) => p.key.toLowerCase() === wantKey)
      if (!prop) return false
      /* No value asked: existence. With one: equality against any of the
         property's values — one for a scalar, one per item for a list, all
         compared lowercase, so `prop:status=Reading` finds `status: reading`. */
      if (wantValue === null || wantValue === '') continue
      if (!propValues(prop).includes(wantValue)) return false
    }
  }
  return true
}

/* What the search pass already knows about a PDF: whether its extracted text
   is current, and the highlights it carries.

   Both are answered from the sidecars, and both were asked afresh for every PDF
   in the vault on every keystroke — two realpaths, two stats and a header read
   for the first, a whole read and a `JSON.parse` for the second, times the
   library. Held for a moment rather than for a generation because the sidecars
   are written under `.annotations/`, which the vault watcher deliberately
   ignores: a short life is the honest way to hold something nothing will tell
   us about. It is far shorter than a reader can retype a query, which is where
   the whole cost was.

   Cleared outright whenever this process is the one changing a sidecar — a
   highlight saved, an extraction finished, a PDF deleted — so the reader's own
   action is never the thing this is stale about. */
const pdfSearchFacts = new Map()
const PDF_FACTS_MS = 2000

const forgetPdfSearchFacts = (relPath) => {
  if (relPath) pdfSearchFacts.delete(String(relPath))
  else pdfSearchFacts.clear()
  /* What a PDF answers has changed, and the *narrowing* believes something
     about that too: a typed-into query only re-asks the PDFs that matched the
     query before it. A highlight saved on a document that matched nothing, or
     text extracted for one that had none, would be invisible to every longer
     query until the reader cleared the box — their own highlight, unfindable.
     `documentsGeneration` is what that held list is checked against, so moving
     it here is how the narrowing hears about it. */
  documentsChanged()
}

function pdfFacts (pdfPath) {
  const held = pdfSearchFacts.get(pdfPath)
  if (held && Date.now() - held.at < PDF_FACTS_MS) return held
  const fresh = { at: Date.now() }
  pdfSearchFacts.set(pdfPath, fresh)
  return fresh
}

async function pdfTextIsCurrentCached (pdfPath) {
  const facts = pdfFacts(pdfPath)
  if (facts.current === undefined) facts.current = await pdfTextIsCurrent(pdfPath)
  return facts.current
}

async function pdfMarksForSearch (pdfPath) {
  const facts = pdfFacts(pdfPath)
  if (facts.marks) return facts.marks
  try {
    const file = annotationFile(pdfPath)
    await assertReal(file)
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    facts.marks = Array.isArray(parsed?.highlights) ? parsed.highlights : []
  } catch { facts.marks = [] }
  return facts.marks
}

/** Search the local page-text and highlight sidecars that the PDF reader and
 * Copilot already share. Missing sidecars are reported, never generated in the
 * keystroke path; the background PDF sweep is responsible for preparation. */
async function searchPdfDocuments (q, only = null) {
  const { pdfs: all } = await getVaultSnapshot()
  /* The PDFs the last answer left in the running, when this query is a
     narrowing of it — the same reasoning the note loop rests on, and for the
     same reason: a document that does not hold `phys` cannot hold `physi`, so
     the ones that answered nothing then have nothing to answer now. Left out of
     the narrowing until now, so a search library of four hundred books paid for
     all of them on every keystroke while the notes paid for a handful. */
  const pdfs = only ? all.filter((pdfPath) => only.has(pdfPath)) : all
  const assignedTags = await fileTags.all()
  const results = []
  const unsearchedPaths = []
  // What this pass leaves for the next one to narrow from: everything that
  // answered, and everything that could not be read to answer with.
  const keys = new Set()

  /* Bounded, like every other walk of the vault here. Each PDF costs a couple
     of stats, an eighty-byte header read and — when the sidecar is current and
     not already cached — the page text, and this runs on the keystroke path: a
     library of four hundred PDFs was four hundred of those in flight at once,
     which is enough open handles to make the ones that matter wait. */
  await mapLimit(pdfs, WALK_LIMIT, async (pdfPath) => {
    const name = path.basename(pdfPath)
    const base = {
      name, text: '', kind: 'pdf', props: [],
      fileTags: assignedTags[pdfPath] || []
    }
    const wantsPdf = !q.filters.type.length || q.filters.type.includes('pdf')
    const wantsHighlights = !q.filters.type.length || q.filters.type.includes('highlight')
    const pathPasses = (kind) => passesFilters(pdfPath, { ...base, kind }, q.filters)

    if (wantsPdf && pathPasses('pdf')) {
      if (!q.terms.length) {
        keys.add(pdfPath)
        results.push({
          path: pdfPath, name, kind: 'pdf',
          hits: [{ page: 1, text: 'PDF document', source: 'pdf' }], total: 0, score: 0
        })
      } else if (await pdfTextIsCurrentCached(pdfPath)) {
        try {
          const entry = await pdfPagesOf(pdfTextFile(pdfPath))
          const hits = []
          let total = 0
          for (const page of entry.pages) {
            const found = findSpots(page.text, q.terms)
            if (!found) continue
            total += found.total
            for (const hit of hitLines(page.text, found.spots, 3)) {
              if (hits.length >= 6) break
              hits.push({ ...hit, page: page.page, source: 'pdf' })
            }
          }
          if (hits.length) {
            keys.add(pdfPath)
            const named = q.terms.filter((term) => term.has.test(name)).length
            results.push({ path: pdfPath, name, kind: 'pdf', hits, total, score: total + named * 8 })
          }
        } catch {
          keys.add(pdfPath)
          unsearchedPaths.push(pdfPath)
        }
      } else {
        /* Nothing extracted yet. Carried forward for the same reason an
           over-large note is: the narrower query still has to be able to say
           this document went unread rather than quietly dropping the caveat —
           and the sweep may well have prepared it by then. */
        keys.add(pdfPath)
        unsearchedPaths.push(pdfPath)
      }
    }

    if (wantsHighlights && pathPasses('highlight')) {
      const marks = await pdfMarksForSearch(pdfPath)
      const hits = []
      let total = 0
      for (const mark of marks) {
        const text = String(mark?.text || '')
        if (!text) continue
        if (!q.terms.length) {
          hits.push({ page: mark.rects?.[0]?.page || 1, text: text.slice(0, 220), source: 'highlight', mark: mark.id })
          continue
        }
        const found = findSpots(text, q.terms)
        if (!found) continue
        total += found.total
        hits.push({ page: mark.rects?.[0]?.page || 1, text: text.trim().slice(0, 220), source: 'highlight', mark: mark.id })
        if (hits.length >= 6) break
      }
      if (hits.length) {
        keys.add(pdfPath)
        results.push({
          path: pdfPath, name, kind: 'highlight', hits, total,
          score: total + 6
        })
      }
    }
  })

  return { results, unsearchedPaths: [...new Set(unsearchedPaths)], keys }
}

/**
 * Runs against the in-memory index rather than the disk. The first query after
 * a change pays for a sync — a stat per note plus a read of whatever actually
 * moved — and every query after it is a scan of strings already in memory.
 *
 * A note larger than MAX_INDEX_BYTES is held with empty text, so it is never
 * found and — see `search:replace` — never rewritten either.
 */
/* The last query answered, and the notes that answered it — kept so that the
   next keystroke can look at those notes instead of the whole vault. Whether
   it may is electron/search-narrow.js; this is only the holding of it.

   `keys` holds every note that passed the filters and either matched or was
   too large to read, not merely the ones shown: the cap is applied to the
   answer, and narrowing from a truncated result would quietly lose the notes
   ranked below it. */
/** @type {any} */
let lastSearch = null

/* A named function rather than an inline handler because the search now has
   two callers: the overlay, and the Copilot's request file — see
   `consumeAiSearch`. */
async function searchVault (raw, opts = {}) {
  // One shape, whichever way this answers.
  const nothing = { results: [], truncated: false, unsearched: 0, unsearchedPaths: [] }
  if (!vaultPath) return nothing
  const q = compileQuery(raw, opts)
  if (q.error) return { ...nothing, error: q.error }
  if (!q.usable) return nothing
  await ensureIndex()
  const assignedTags = await fileTags.all()

  const results = []

  /* Notes this query would have read had they been indexed, and could not:
     one held with empty text for its size. Counted here rather than over the
     whole index, so the number describes the search that was actually run —
     a `path:` filter narrows it, and a query with no terms to look for has
     nothing to report. A search that quietly skips notes reads as "covered
     everything" when it did not; and the names travel alongside the count,
     because "3 notes" with no way to learn which three is a caveat that
     cannot be acted on. */
  let unsearched = 0
  const unsearchedPaths = []

  /* Where to look. The previous answer when this query is a narrowing of the
     one that produced it — see narrowsFrom — and the whole index otherwise.
     The filters do not have to be re-applied to a narrowed set: they are the
     same filters over the same index, so they would drop the same notes. */
  const narrowed = narrowsFrom(lastSearch, q, opts, indexGeneration)
  const looking = narrowed
    ? lastSearch.keys.map((key) => [key, index.get(key)]).filter(([, entry]) => entry)
    : index
  const whiteboardsLooking = narrowed
    ? (lastSearch.whiteboardKeys || [])
        .map((key) => [key, whiteboardIndex.get(key)]).filter(([, entry]) => entry)
    : whiteboardIndex
  const docxLooking = narrowed
    ? (lastSearch.docxKeys || [])
        .map((key) => [key, docxIndex.get(key)]).filter(([, entry]) => entry)
    : docxIndex

  // What this answer will be narrowed from next, gathered as it is built.
  const keys = []
  const whiteboardKeys = []
  const docxKeys = []

  for (const [key, entry] of looking) {
    const facts = { kind: 'note', fileTags: assignedTags[key] || [] }
    if (!narrowed && !passesFilters(key, entry, q.filters, facts)) continue

    /* A filter on its own is a query: `tag:book` asks for the notes carrying
       it, and the note's opening line is the only context there is to show. */
    if (!q.terms.length) {
      keys.push(key)
      results.push({ path: key, name: entry.name, kind: 'note', hits: hitLines(entry.text, [0], 1), total: 0, score: 0 })
      continue
    }

    if (entry.size > MAX_INDEX_BYTES) {
      unsearched++
      // Twenty is all a reader will open; the count keeps the whole truth.
      if (unsearchedPaths.length < 20) unsearchedPaths.push(key)
      /* Carried forward even though it matched nothing: it passed the filters,
         and the narrower query still has to be able to report that this note
         went unread rather than quietly dropping the caveat. */
      keys.push(key)
      continue
    }

    const found = findSpots(entry.text, q.terms)
    if (!found) continue
    const hits = hitLines(entry.text, found.spots)

    /* What a note is worth, rather than how often it repeats itself. A term in
       the title is the strongest signal a vault offers — it is what someone
       typing two words is usually reaching for — and a term in a heading says
       the note has a section about it rather than a passing mention. */
    const named = q.terms.filter((term) => term.has.test(entry.name)).length
    const score = found.total + named * 8 + hits.filter((h) => h.heading).length * 3

    keys.push(key)
    results.push({ path: key, name: entry.name, kind: 'note', hits, total: found.total, score })
  }

  /* Whiteboards are indexed from text elements only. Their JSON may contain
     megabytes of pasted-image data, which is neither useful search text nor a
     string the search path should scan on every keystroke. */
  for (const [key, entry] of whiteboardsLooking) {
    const facts = { kind: entry.kind, fileTags: assignedTags[key] || [] }
    if (!narrowed && !passesFilters(key, entry, q.filters, facts)) continue
    if (!q.terms.length) {
      whiteboardKeys.push(key)
      results.push({
        path: key, name: entry.name, kind: 'whiteboard',
        hits: hitLines(entry.text, [0], 1), total: 0, score: 0
      })
      continue
    }
    if (entry.size > MAX_WHITEBOARD_INDEX_BYTES) {
      unsearched++
      if (unsearchedPaths.length < 20) unsearchedPaths.push(key)
      whiteboardKeys.push(key)
      continue
    }
    const found = findSpots(entry.text, q.terms)
    if (!found) continue
    const hits = hitLines(entry.text, found.spots)
    const named = q.terms.filter((term) => term.has.test(entry.name)).length
    whiteboardKeys.push(key)
    results.push({
      path: key, name: entry.name, kind: 'whiteboard', hits,
      total: found.total, score: found.total + named * 8
    })
  }

  /* Word documents, indexed from the text electron/docx.js reads out of the
     zip — never the zip itself, which is compressed bytes and a stylesheet.
     Everything else is a note's rules: the same filters, the same scoring, the
     same report when one was too large to read. */
  for (const [key, entry] of docxLooking) {
    const facts = { kind: entry.kind, fileTags: assignedTags[key] || [] }
    if (!narrowed && !passesFilters(key, entry, q.filters, facts)) continue
    if (!q.terms.length) {
      docxKeys.push(key)
      results.push({
        path: key, name: entry.name, kind: 'docx',
        hits: hitLines(entry.text, [0], 1), total: 0, score: 0
      })
      continue
    }
    if (entry.size > MAX_DOCX_INDEX_BYTES) {
      unsearched++
      if (unsearchedPaths.length < 20) unsearchedPaths.push(key)
      docxKeys.push(key)
      continue
    }
    const found = findSpots(entry.text, q.terms)
    if (!found) continue
    const hits = hitLines(entry.text, found.spots)
    const named = q.terms.filter((term) => term.has.test(entry.name)).length
    docxKeys.push(key)
    results.push({
      path: key, name: entry.name, kind: 'docx', hits,
      total: found.total, score: found.total + named * 8
    })
  }

  /* PDFs are narrowed on one more condition than notes are. `narrowsFrom` asks
     about `indexGeneration`, which a PDF appearing or being re-extracted does
     not move — it is not in the Markdown index — so `documentsGeneration`, which
     every watched change and every write does move, is what says the held list
     of PDFs still describes the vault. */
  const pdfOnly = narrowed && lastSearch.pdfKeys && lastSearch.pdfAt === documentsGeneration
    ? lastSearch.pdfKeys
    : null
  const pdfsAt = documentsGeneration
  const pdfAnswer = await searchPdfDocuments(q, pdfOnly)
  results.push(...pdfAnswer.results)
  for (const pdfPath of pdfAnswer.unsearchedPaths) {
    unsearched++
    if (unsearchedPaths.length < 20) unsearchedPaths.push(pdfPath)
  }

  /* Assigned file tags are metadata, so they also make non-Markdown documents
     (TeX and websites) searchable without putting syntax into their content.
     A plain tag name is accepted as well as `tag:name`: tagging a file should
     make finding it require no special grammar. */
  const already = new Set(results.map((result) => result.path))
  for (const [taggedPath, tags] of Object.entries(assignedTags)) {
    if (already.has(taggedPath)) continue
    const normalized = cleanFileTags(tags)
    if (q.filters.tag.length && !q.filters.tag.every((wanted) =>
      normalized.some((tag) => tag === wanted || tag.startsWith(`${wanted}/`)))) continue
    if (q.filters.path.length && !q.filters.path.every((part) => taggedPath.toLowerCase().includes(part))) continue
    const name = path.basename(taggedPath, path.extname(taggedPath))
    if (q.filters.file.length && !q.filters.file.every((part) => name.toLowerCase().includes(part))) continue
    if (q.filters.type.length) continue
    const label = normalized.join(' ')
    if (q.terms.length && !q.terms.every((term) => term.has.test(label))) continue
    if (!q.terms.length && !q.filters.tag.length) continue
    const kind = isPdf(taggedPath) ? 'pdf' : isWhiteboard(taggedPath) ? 'whiteboard' : 'note'
    results.push({
      path: taggedPath, name, kind,
      hits: [{ line: 1, col: 0, page: 1, text: normalized.map((tag) => `#${tag}`).join(' ') }],
      total: 0, score: 12
    })
  }

  lastSearch = {
    generation: indexGeneration,
    words: q.words,
    filters: q.filters,
    opts: { regex: !!opts.regex, word: !!opts.word, caseSensitive: !!opts.caseSensitive },
    keys,
    whiteboardKeys,
    docxKeys,
    pdfKeys: pdfAnswer.keys,
    /* The state of the vault the PDF pass was run against, not the state it
       finished in: a PDF that changed while it ran is one this list may already
       be wrong about, and the next query must go back to the whole set. */
    pdfAt: pdfsAt
  }

  /* Sorted before the cap, not after. Ranking the first 200 notes the index
     happened to hold is not ranking the vault — on a query that matches widely
     the best note could be absent altogether, which is the opposite of what the
     ordering is for. */
  /* `localeCompare` with no options, deliberately. The tree walk above hoists
     `BY_NAME` because its comparator passed an options object, which built a
     fresh collator per comparison; a bare `localeCompare` is the cached default
     one already and beats an explicit `Intl.Collator` here by about 2.5×. It is
     also the ordering this has always had — `BY_NAME` is `numeric: true`, which
     would quietly move "Note 10" from before "Note 2" to after "Note 9". */
  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

  const truncated = results.length > 200

  /* Answered as an object rather than a bare array with a property hung off
     it: a custom property on an array does not survive the structured clone
     the IPC boundary performs, so the flag arrived as undefined every time and
     the cap was silent. */
  return { results: truncated ? results.slice(0, 200) : results, truncated, unsearched, unsearchedPaths }
}

ipcMain.handle('search:vault', (_e, raw, opts = {}) => searchVault(raw, opts))

/**
 * Every tag in the vault and how many notes carry it — the inventory the
 * editor's `#` completion offers and the search overlay lists. One count per
 * note rather than per occurrence: a note that says `#book` five times is one
 * book-note, not five.
 *
 * Held against `indexGeneration`, exactly as `aliasTable` is: the scan is the
 * HASHTAG expression over the full text of every note in the vault, and the
 * completion asks for it on a keystroke. It cannot go stale, because the
 * generation moves whenever anything the count is made of does — including the
 * assigned file tags, whose store bumps it on save.
 */
let tagCountsCache = null
let tagCountsAt = -1

ipcMain.handle('tags:vault', async () => {
  if (!vaultPath) return []
  await ensureIndex()
  if (tagCountsCache && tagCountsAt === indexGeneration) return tagCountsCache

  const taken = indexGeneration
  const counts = new Map()
  const assigned = await fileTags.all()
  for (const tags of Object.values(assigned)) {
    for (const tag of cleanFileTags(tags) || []) counts.set(tag, (counts.get(tag) || 0) + 1)
  }
  for (const [key, entry] of index) {
    if (!entry.text) continue
    const seenHere = new Set(cleanFileTags(assigned[key]))
    HASHTAG.lastIndex = 0
    for (let m = HASHTAG.exec(entry.text); m; m = HASHTAG.exec(entry.text)) {
      const tag = m[2].toLowerCase()
      if (seenHere.has(tag)) continue
      seenHere.add(tag)
      counts.set(tag, (counts.get(tag) || 0) + 1)
    }
  }

  const table = [...counts]
    .map(([tag, notes]) => ({ tag, notes }))
    .sort((a, b) => b.notes - a.notes || a.tag.localeCompare(b.tag))
  /* Only if nothing moved across the await above: a count taken partly before
     an edit and partly after describes a vault that never existed, and holding
     it would keep saying so. */
  if (indexGeneration === taken) {
    tagCountsCache = table
    tagCountsAt = taken
  }
  return table
})

/* One line of what a replace would do, for the preview: the first line the two
   texts disagree on, before and after. A line is the right unit because it is
   what the reader can check the pattern against — "workspace → vault" is not
   obviously right or wrong until you see it standing in a sentence.

   Compared line by line rather than by character offset: a replacement of a
   different length shifts every offset after it, and the interesting thing is
   which line changed, not where in the file it now sits. */
const SAMPLE_CHARS = 200
function firstChangedLine (before, after) {
  const was = before.split('\n')
  const now = after.split('\n')
  const clip = (line) => {
    const text = String(line ?? '').trim()
    return text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS)}…` : text
  }
  for (let i = 0; i < Math.max(was.length, now.length); i++) {
    if (was[i] === now[i]) continue
    return { line: i + 1, before: clip(was[i]), after: clip(now[i]) }
  }
  return null
}

/**
 * The same query, used to rewrite rather than to find.
 *
 * One term only. A multi-term query means "the note holding both of these",
 * which names notes and not text — there is no honest answer to what replacing
 * it would mean, so it is refused rather than guessed at. Quoting makes a
 * phrase one term, which is the way to replace several words at once.
 *
 * Every write goes through `writeAtomic`, so a failure part-way through the
 * vault leaves the notes it did not reach untouched rather than truncated, and
 * the paths come back for the renderer to reload anything it has open — its
 * own buffer is now older than the disk.
 *
 * Two options decide whether anything is written at all:
 *
 * `preview` counts and matches exactly as a real run would, and then returns
 * instead of writing. This is the only edit in Tulip that touches notes nobody
 * has open, which is what makes a wrong pattern expensive — the undo stack of
 * a closed note is not a thing that exists, and the batch entry in the trust
 * store is the only way back. Being able to look first is cheaper than being
 * able to undo.
 *
 * `only` narrows a real run to a named set of paths. The renderer passes back
 * exactly the paths its preview showed, so what gets rewritten is what was on
 * screen when the reader said yes — a note that grew a match in between is not
 * quietly swept in with the rest.
 */
ipcMain.handle('search:replace', async (_e, raw, replacement, opts = {}) => {
  if (!vaultPath) return { notes: 0, hits: 0, rewritten: [] }
  const q = compileQuery(raw, opts)
  if (q.error) return { error: q.error }
  if (!q.usable) return { error: 'Too short to replace on.' }
  if (q.terms.length !== 1) {
    return { error: 'Replace takes one term. Quote a phrase to replace several words.' }
  }
  await ensureIndex()

  const { find, has } = q.terms[0]
  /* `$1` belongs to whoever wrote a pattern. In literal mode nobody wrote one,
     so a `$` in the replacement is a dollar sign and is escaped to stay one. */
  const into = opts.regex ? String(replacement) : String(replacement).replace(/\$/g, '$$$$')

  /* Counted and rewritten first, written second. `find` carries a `lastIndex`
     between the count and the replace, so the matching has to stay one note at
     a time — but the writes below do not. */
  const only = Array.isArray(opts.only) ? new Set(opts.only) : null

  /* Asked for here rather than inherited. These filters read a note's kind and
     its assigned tags, and this pass used to see whatever the *last search* had
     written onto the index entries — so `tag:` in a replace meant the right
     thing only because a search had usually just run, and meant nothing at all
     when one had not. It is one map lookup; it may as well be true. */
  const replaceTags = await fileTags.all()

  const pending = []
  for (const [key, entry] of index) {
    if (only && !only.has(key)) continue
    if (!passesFilters(key, entry, q.filters,
      { kind: 'note', fileTags: replaceTags[key] || [] })) continue
    // Nothing to count and nothing to write: the overwhelming common case.
    if (!has.test(entry.text)) continue

    let n = 0
    find.lastIndex = 0
    for (let m = find.exec(entry.text); m; m = find.exec(entry.text)) {
      n++
      if (m[0] === '') find.lastIndex++
    }
    if (!n) continue

    find.lastIndex = 0
    const next = entry.text.replace(find, into)
    if (next === entry.text) continue

    pending.push({ key, abs: path.resolve(vaultPath, key), next, n, previous: entry.text })
  }

  /* Asked what it would do, not told to do it. Everything above has already
     run — the same filters, the same matching, the same rewrite — so what
     comes back is the actual outcome rather than an estimate of it. */
  if (opts.preview) {
    return {
      preview: true,
      notes: pending.length,
      hits: pending.reduce((sum, p) => sum + p.n, 0),
      /* Sorted by weight: the note a mistake would damage most is the one
         worth reading first, and a hundred-file list is scrolled, not read. */
      files: pending
        .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key))
        .map(({ key, n, previous, next }) => ({ path: key, hits: n, sample: firstChangedLine(previous, next) }))
    }
  }

  /* Concurrently, for the same reason the link rewriter is: a replace across
     three hundred notes was six hundred sequential fsyncs. */
  const done = await mapLimit(pending, WALK_LIMIT, async ({ key, abs, next, n, previous }) => {
    try {
      touchIndex(abs, next, await writeAtomic(abs, next))
      return { key, n, previous, next }
    } catch (err) {
      console.error('replace failed', key, err)
      return null
    }
  })

  const written = done.filter(Boolean)
  /* One entry for the whole batch. A replace across the vault is the only edit
     in Tulip with no inverse anywhere else — the notes it rewrites are mostly
     closed, so neither the editor's undo stack nor the autosave snapshots have
     them — and getting the pattern slightly wrong is easy. */
  if (written.length) {
    trust?.record({
      source: 'replace',
      changes: written.map(({ key, previous, next }) => ({
        path: key, before: previous, after: next
      }))
    })
  }

  const rewritten = written.map((r) => r.key)
  const hits = written.reduce((sum, r) => sum + r.n, 0)
  return { notes: rewritten.length, hits, rewritten }
})

/* ------------------------------------------------------------- backlinks

   Which notes point here, and which ones say the name without pointing.

   Both answers come off the same index the search and the link rewriter read,
   and both are scanned with `CODE_OR_LINK` — the one pass in this file that
   knows a `[[Note]]` written inside backticks is writing *about* a link rather
   than making one. A backlink panel that counted those would disagree with
   both views, which already refuse to render them.
   ================================================================== */

/**
 * Every note's basename and full path, for resolving what a link names.
 *
 * Held between asks. This is asked for on every note switch, and it depends on
 * which notes exist rather than on what is in them — so it survives every edit
 * and is dropped only when the index gains or loses a key. Building it walks
 * every path in the vault through `stripExt`, `basename` and `toLowerCase`,
 * which is not work to repeat for a click that changed nothing.
 */
let linkTableCache = null

const forgetLinkTables = () => { linkTableCache = null }

function linkTables () {
  if (linkTableCache) return linkTableCache
  const byBase = new Map()
  const byPath = new Map()
  for (const key of index.keys()) {
    const bare = stripExt(key)
    byPath.set(bare.toLowerCase(), key)
    const base = path.basename(bare).toLowerCase()
    if (!byBase.has(base)) byBase.set(base, [])
    byBase.get(base).push(key)
  }
  linkTableCache = { byBase, byPath }
  return linkTableCache
}

/**
 * The other names a note answers to: its frontmatter `aliases`.
 *
 * Obsidian's oldest property, and the one a vault moved over misses hardest —
 * without it every `[[Other Name]]` in an imported vault resolves to nothing,
 * and the first click on one does not report a broken link, it creates a note
 * with the alias for a title. That is a silent fork of a note that already
 * exists, written to disk before anyone can see it happen.
 *
 * Unlike `linkTables` this depends on what is *in* the notes, so it is held
 * against the index generation rather than against the set of keys — every
 * write bumps that. The parse itself is cached per entry by `entryProps`, so a
 * rebuild is a walk over already-parsed heads.
 */
let aliasTableCache = null
let aliasTableAt = -1

function aliasesOf (entry) {
  if (entry.aliases) return entry.aliases
  const prop = entryProps(entry).find((one) => String(one.key).toLowerCase() === 'aliases' ||
    String(one.key).toLowerCase() === 'alias')
  entry.aliases = prop ? propValues(prop) : []
  return entry.aliases
}

function aliasTable () {
  if (aliasTableCache && aliasTableAt === indexGeneration) return aliasTableCache
  const byAlias = new Map()
  for (const [key, entry] of index) {
    for (const alias of aliasesOf(entry)) {
      if (!byAlias.has(alias)) byAlias.set(alias, [])
      byAlias.get(alias).push(key)
    }
  }
  aliasTableCache = byAlias
  aliasTableAt = indexGeneration
  return byAlias
}

/**
 * Every alias in the vault, for the renderer — which resolves links itself,
 * from the flattened tree, and has no way to see inside a note it has not
 * opened. Sent as one object rather than asked per link: a vault's aliases are
 * a short list even when its notes are not.
 */
ipcMain.handle('vault:aliases', async () => {
  if (!vaultPath) return {}
  await ensureIndex()
  return Object.fromEntries(aliasTable())
})

/**
 * Which note `[[Name]]` means when the vault holds more than one by that name.
 *
 * The rule the renderer follows in `bestLinkTarget`: the note beside the one
 * doing the linking wins, failing that the one sharing the most of the way
 * there, with the shorter path then the alphabetical path breaking ties. The
 * two are one rule on purpose — this side resolves links for the backlink
 * scan, the other side for clicks, and a twin attributed differently by each
 * is how a backlink used to land on the wrong note of the same name.
 */
function nearestNamed (candidates, fromKey) {
  if (candidates.length < 2) return candidates[0] || null

  const dirOf = (key) => (path.dirname(key) === '.' ? '' : path.dirname(key))
  const here = dirOf(fromKey)
  const shared = (key) => {
    const dir = dirOf(key)
    if (dir === here) return Infinity
    const a = here ? here.split('/') : []
    const b = dir ? dir.split('/') : []
    let n = 0
    while (n < a.length && n < b.length && a[n] === b[n]) n++
    return n
  }

  return [...candidates].sort((x, y) =>
    shared(y) - shared(x) || x.length - y.length || x.localeCompare(y))[0]
}

/** The note one link target names, read from the note the link is written in. */
function linkTarget (rawTarget, fromKey, { byBase, byPath }) {
  const hash = rawTarget.indexOf('#')
  const link = normaliseTarget(hash === -1 ? rawTarget : rawTarget.slice(0, hash))
  if (!link) return null                     // `[[#Heading]]`: this note itself
  const wanted = link.toLowerCase()
  /* A name, then a path, then an alias — the order the renderer resolves them
     in. Aliases last because a note actually called `Wanted` outranks one that
     merely answers to it, which is also Obsidian's order. */
  return nearestNamed(byBase.get(wanted) || [], fromKey) ||
    byPath.get(wanted) ||
    nearestNamed(aliasTable().get(wanted) || [], fromKey) ||
    null
}

/**
 * Sorts spans and folds the overlaps together, so the search below can assume
 * what it needs to: ordered, and no span inside another. They do overlap — a
 * `#tag` written inside a fenced block is claimed twice over.
 */
function mergeSpans (spans) {
  spans.sort((a, b) => a[0] - b[0])
  const out = []
  for (const span of spans) {
    const last = out[out.length - 1]
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else out.push([span[0], span[1]])
  }
  return out
}

/** Whether `at` falls inside one of a set of sorted, non-overlapping spans. */
function inside (spans, at) {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (at < spans[mid][0]) hi = mid - 1
    else if (at >= spans[mid][1]) lo = mid + 1
    else return true
  }
  return false
}

/** One note's row in either list, with the first few places it is shown. */
function mentionRow (key, entry, spots) {
  return {
    path: key,
    name: entry.name,
    hits: hitLines(entry.text, spots, 6),
    total: spots.length
  }
}

/* The last few answers, each good for as long as the index it was read from.
   Nothing here was cached before: the whole vault was scanned again for the
   backlinks of a note on every switch to it — A, B, back to A — and again on
   every `vault:changed`, for a pane that mostly shows the same rows. The index
   generation moves on every write to the index, the reader's own autosave
   included, so an answer can never outlive the text it was built from. */
const linksToMemo = new Map()
const LINKS_TO_MEMO_KEPT = 8

ipcMain.handle('links:to', async (_e, notePath) => {
  const none = { linked: [], unlinked: [], outgoing: [] }
  if (!vaultPath || !notePath) return none
  await ensureIndex()
  const held = linksToMemo.get(notePath)
  if (held && held.generation === indexGeneration && held.vault === vaultPath) return held.answer
  const answer = computeLinksTo(notePath)
  linksToMemo.delete(notePath)
  linksToMemo.set(notePath, { generation: indexGeneration, vault: vaultPath, answer })
  while (linksToMemo.size > LINKS_TO_MEMO_KEPT) linksToMemo.delete(linksToMemo.keys().next().value)
  return answer
})

function computeLinksTo (notePath) {
  const none = { linked: [], unlinked: [], outgoing: [] }

  const self = index.get(notePath)
  if (!self) return none

  const tables = linkTables()
  const name = self.name

  /* Which notes this one links to — the other direction of the same question.
     One row per distinct target, first occurrence's line. A link that names
     nothing in the vault is kept and marked missing: it is a promise of a note
     rather than a reference to one, and the pane offers to create it. Self
     links (`[[#Heading]]`) name this note and are nobody's outgoing, so they
     are left out. */
  const outgoing = []
  {
    const scanner = new RegExp(CODE_OR_LINK.source, CODE_OR_LINK.flags)
    const seen = new Map()   // identity → index into outgoing
    const spots = []         // positions of first occurrences, in document order
    for (let m = scanner.exec(self.text); m; m = scanner.exec(self.text)) {
      const { link, target } = m.groups
      if (!link) continue
      if (target.trim().startsWith('#')) continue   // `[[#Heading]]`: this note itself
      const resolved = linkTarget(target, notePath, tables)
      if (resolved === notePath) continue
      const identity = (resolved || link.toLowerCase())
      if (seen.has(identity)) continue
      seen.set(identity, outgoing.length)
      spots.push({ order: outgoing.length, at: m.index })
      /* What to call it: the note's own name when it resolved, the target as
         written when it did not — "Fundamentals" rather than
         "fundamentales 2" is the point of resolving. */
      const bare = target.split('#')[0].split('|')[0].trim()
      outgoing.push({
        target,
        path: resolved,
        name: resolved ? index.get(resolved)?.name || path.basename(stripExt(resolved)) : bare,
        missing: !resolved
      })
    }
    /* First occurrence per target — the place a click lands on. Counted here
       rather than through `hitLines`, which would collapse two links sharing a
       line into one row and misnumber every target after them. */
    let lineAt = 1
    let scanned = 0
    for (const spot of spots) {
      for (let i = self.text.indexOf('\n', scanned); i !== -1 && i < spot.at; i = self.text.indexOf('\n', i + 1)) lineAt++
      scanned = spot.at
      outgoing[spot.order].line = lineAt
    }
  }


  /* The name in prose. Whole-word, so a note called "Set" is not found inside
     every "Settings" in the vault — the same lookarounds the search's
     whole-word switch uses, and for the same reason.

     `present` is the same pattern without `g`, for rejecting a note outright.
     It has to be a regex and not `text.toLowerCase().includes(name)`: that
     lowercases a copy of every note in the vault on every note switch, which
     is megabytes of garbage per click. A case-insensitive regex scans the
     string where it lies. */
  let mention
  let present
  try {
    const body = `${WORD_BEFORE}${escapeRe(name)}${WORD_AFTER}`
    mention = new RegExp(body, 'giu')
    present = new RegExp(body, 'iu')
  } catch {
    return none
  }

  /* A copy per ask. The shared one is global, and `rewriteLinks` drives it
     through `String.replace` — borrowing it here would mean two readers of one
     `lastIndex`. */
  const scanner = new RegExp(CODE_OR_LINK.source, CODE_OR_LINK.flags)

  const linked = []
  const unlinked = []

  for (const [key, entry] of index) {
    if (key === notePath) continue
    /* The cheap rejection first, and it rejects nearly everything: a note that
       never says the name can hold neither a link to it nor a mention of it,
       and answering that costs one scan rather than three. */
    if (!entry.text || !present.test(entry.text)) continue

    const aimed = []
    /* Code spans, fenced blocks, and every wikilink — whether or not it points
       here. All of them are places where the name is already spoken for, so
       none of them can also be an unlinked mention. */
    const claimed = []

    scanner.lastIndex = 0
    for (let m = scanner.exec(entry.text); m; m = scanner.exec(entry.text)) {
      claimed.push([m.index, m.index + m[0].length])
      const groups = m.groups
      if (!groups.link) continue
      if (linkTarget(groups.target, key, tables) === notePath) aimed.push(m.index)
    }
    if (aimed.length) linked.push(mentionRow(key, entry, aimed))

    /* Tags are spoken for too. `#project/tulip` names the note as surely as
       the prose does, but it is already a piece of structure — offering it as
       a link waiting to be made would be asking to turn a tag into something
       it was deliberately not. */
    HASHTAG.lastIndex = 0
    for (let m = HASHTAG.exec(entry.text); m; m = HASHTAG.exec(entry.text)) {
      claimed.push([m.index, m.index + m[0].length])
    }

    const spans = mergeSpans(claimed)
    const bare = []
    mention.lastIndex = 0
    for (let m = mention.exec(entry.text); m; m = mention.exec(entry.text)) {
      if (!inside(spans, m.index)) bare.push(m.index)
    }
    if (bare.length) unlinked.push(mentionRow(key, entry, bare))
  }

  const rank = (a, b) => b.total - a.total || a.name.localeCompare(b.name)
  linked.sort(rank)
  unlinked.sort(rank)

  return { linked: linked.slice(0, 200), unlinked: unlinked.slice(0, 200), outgoing: outgoing.slice(0, 200) }
}

/**
 * Files a pasted or dropped attachment. The layout is decided here rather than
 * in the renderer, so there is one answer to where an image lives:
 *
 *     <vault>/.attachments/<Note name>/<Note name>-0.png
 *     <vault>/.attachments/<Note name>/<Note name>-1.png
 *
 * The picture is named after the note it was pasted into and sits in that
 * note's own folder, so a vault's images are as navigable as its prose even
 * though the folder itself is hidden. The bytes arrive as a Uint8Array.
 */
/* The extension a pasted file will be given. The renderer reads it off a MIME
   type it does not control, so anything that is not a plain extension is not
   one — and a picture with no name at all is a PNG, which is what a clipboard
   image almost always is. Both paste routes ask, so both get the same answer. */
const pastedExtension = (ext) =>
  /^\.[a-z0-9]+$/i.test(ext || '') ? ext.toLowerCase() : '.png'

ipcMain.handle('asset:write', async (_e, noteName, ext, bytes) => {
  const base = String(noteName || 'Untitled')
  const suffix = pastedExtension(ext)

  const folder = await realSafePath(path.join(ATTACHMENT_DIR, base.replace(/[/\\]/g, '-')))
  await fs.mkdir(folder, { recursive: true })

  const target = freeAttachmentName(folder, base, suffix)
  /* Claimed as the app's own before the bytes land, the way `writeAtomic` does
     it. Without this a paste read as an outside change: the watcher woke, and
     the renderer answered with a full recursive walk of the vault, a re-read of
     the open note and a full-text backlink scan over every note in it — all to
     learn about a file it had just asked for and is about to embed itself. */
  noteSelfWrite(target)
  await fs.writeFile(target, Buffer.from(bytes))
  noteSelfWrite(target)
  // The renderer re-reads the list straight away, before the watcher's debounce.
  invalidateVaultSnapshot()
  return { path: rel(target), name: path.basename(target) }
})

/**
 * An image pasted into the copilot's message box.
 *
 * None of the three CLIs takes a picture over its message stream — they read
 * files — so a paste has to become a file before it can become a question. It
 * goes under the attachments folder like every other picture the app files, in
 * a folder of its own: these belong to a conversation rather than to a note, and
 * mixing them into a note's folder would leave the note carrying images it never
 * embeds. Named by digest, so pasting the same screenshot twice writes once.
 *
 * The path handed back is vault-relative. That is what the agent is told to
 * resolve everything against, and it keeps a screenshot readable by a CLI whose
 * idea of what it may open stops at the vault.
 */
ipcMain.handle('ai:attach', async (event, ext, bytes) => {
  assertCopilotWindow(event)
  if (!vaultPath) throw new Error('Open a vault first.')
  const suffix = pastedExtension(ext)
  const buffer = Buffer.from(bytes)

  const folder = await realSafePath(path.join(ATTACHMENT_DIR, CHAT_IMAGE_DIR))
  await fs.mkdir(folder, { recursive: true })
  const target = path.join(folder, `paste-${sha1(buffer, 10)}${suffix}`)
  await assertReal(target)

  noteSelfWrite(target)
  await fs.writeFile(target, buffer)
  noteSelfWrite(target)
  invalidateVaultSnapshot()
  if (isPdf(target)) ensurePdfText(rel(target)).catch(() => {})
  return { path: rel(target) }
})

/**
 * Files chosen from the copilot's paperclip.
 *
 * The native picker is the grant to read them. Main copies each regular file
 * straight into the conversation attachment folder, preserving its useful
 * name and extension without carrying potentially large bytes through the
 * renderer. Symlinks and non-files are ignored, and collisions get the same
 * friendly numeric suffix as every other imported file.
 */
ipcMain.handle('ai:pick-attachments', async () => {
  if (!vaultPath) throw new Error('Open a vault first.')
  const picked = await dialog.showOpenDialog(focusedWindow(), {
    title: 'Attach files or images',
    properties: ['openFile', 'multiSelections'],
    buttonLabel: 'Attach'
  })
  if (picked.canceled) return []

  const folder = await realSafePath(path.join(ATTACHMENT_DIR, CHAT_IMAGE_DIR))
  await fs.mkdir(folder, { recursive: true })
  const attached = []

  for (const source of picked.filePaths) {
    let stat
    try { stat = await fs.lstat(source) } catch { continue }
    if (!stat.isFile() || stat.isSymbolicLink()) continue

    const parsed = path.parse(source)
    const target = freeName(folder, parsed.name, parsed.ext)
    await assertReal(target)
    noteSelfWrite(target)
    await fs.copyFile(source, target)
    noteSelfWrite(target)
    const relative = rel(target)
    attached.push(relative)
    if (isPdf(target)) ensurePdfText(relative).catch(() => {})
  }

  if (attached.length) invalidateVaultSnapshot()
  return attached
})

/* --------------------------------------------------------- pdf highlights

   What the reader marked on a PDF, kept in a sidecar that mirrors the PDF's own
   path under `.annotations/`. One file per document, rewritten whole: a page of
   highlights is a few kilobytes, and a single write is what makes the file
   either the old set or the new one and never half of each. */

const annotationFile = (relPath) => safePath(path.join(ANNOTATION_DIR, `${relPath}.json`))

ipcMain.handle('pdf:marks:load', async (_e, p) => {
  if (!isPdf(String(p || ''))) return []
  try {
    const abs = annotationFile(p)
    /* `safePath` is lexical: it settles that the path spells somewhere inside
       the vault, not that following it stays there. A vault synced from
       elsewhere can carry `.annotations/Papers` as a symlink to any folder on
       the machine, and this reads and parses whatever is at the other end.
       Saving already checks; reading did not. */
    await assertReal(abs)
    const text = await fs.readFile(abs, 'utf8')
    const parsed = JSON.parse(text)
    return Array.isArray(parsed?.highlights) ? parsed.highlights : []
  } catch {
    // No sidecar yet, or one that will not parse. Either way the document has
    // no highlights we can show, and saving over it is the right next move.
    return []
  }
})

ipcMain.handle('pdf:marks:save', async (_e, p, highlights) => {
  if (!isPdf(String(p || ''))) throw new Error('Only PDFs carry highlights.')
  const abs = annotationFile(p)
  await assertReal(abs)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const body = JSON.stringify({ version: 1, pdf: p, highlights: highlights || [] }, null, 2)
  await writeAtomic(abs, body)
  // `.annotations/` is outside what the watcher reports, so the search pass is
  // told here or not at all.
  forgetPdfSearchFacts(p)
  return true
})

/* --------------------------------------------------------- pdf export

   The open note as a PDF file. All the deciding happened in the renderer,
   which re-rendered the note in the paper palette before invoking; this side
   asks where the file goes, prints the window, and writes the bytes.

   `to` skips the save dialog: the scripted probes cannot click it, and a
   probe is how an export is verified. Nobody else hands a path. */

ipcMain.handle('pdf:export', async (event, name, to) => {
  /* The window that asked, not whichever one is frontmost: an export is a
     picture of a particular note, and the ask came from the window showing it
     — which the save dialog it opens is about to take the focus away from. */
  const win = windowOf(event)
  if (!win) return { ok: false, error: 'There is no window to print from.' }

  const safe = String(name || 'note').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 120) || 'note'
  let filePath = typeof to === 'string' && to.endsWith('.pdf') ? to : null
  if (!filePath) {
    const chosen = await dialog.showSaveDialog(win, {
      title: 'Export as PDF',
      defaultPath: path.join(app.getPath('documents'), `${safe}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true }
    filePath = chosen.filePath
  }

  try {
    const bytes = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      preferCSSPageSize: true
    })
    await fs.writeFile(filePath, bytes)
    return { ok: true, path: filePath, bytes: bytes.length }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

/* The same page as `pdf:export`, sent to a real printer through the system's
   own dialog instead of to a file. The renderer has already done the deciding
   — light palette, reading view, everything settled — before it invokes. */
ipcMain.handle('pdf:print', async (event) => {
  const win = windowOf(event)
  if (!win) return { ok: false, error: 'There is no window to print from.' }
  return await new Promise((resolve) => {
    win.webContents.print({ printBackground: true }, (success, reason) => {
      if (success) resolve({ ok: true })
      else if (String(reason || '').includes('cancel')) resolve({ ok: false, canceled: true })
      else resolve({ ok: false, error: reason || 'Printing did not finish.' })
    })
  })
})

/* ------------------------------------------------------- html export

   The reading view as one self-contained file: the renderer hands over the
   settled, light-palette markup it prepared (the same preparation the PDF
   export does), and this side folds in everything the page would otherwise
   have to ask Tulip for — the stylesheet, the fonts it names, and every
   image, as data URIs — so the result opens anywhere with nothing beside it. */

const EXPORT_IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp'
}
const EXPORT_IMAGE_CAP = 10 * 1024 * 1024

/** Stylesheet with every `url(./fonts/…)` it names carried inline. */
async function inlineExportCss (file) {
  let css
  try { css = await fs.readFile(path.join(DIST, file), 'utf8') } catch { return '' }
  const jobs = []
  css.replace(/url\((["']?)\.\/fonts\/([^"')]+)\1\)/g, (_whole, _q, font) => {
    jobs.push(font)
    return _whole
  })
  const fonts = new Map()
  for (const font of new Set(jobs)) {
    try {
      const bytes = await fs.readFile(path.join(DIST, 'fonts', font))
      fonts.set(font, `url(data:font/woff2;base64,${bytes.toString('base64')})`)
    } catch { /* a font that cannot be read falls back to the system's */ }
  }
  return css.replace(/url\((["']?)\.\/fonts\/([^"')]+)\1\)/g,
    (whole, _q, font) => fonts.get(font) || whole)
}

/** Every `tulip-file://vault/…` image in the markup, made self-contained. */
async function inlineExportImages (html) {
  const sources = new Set()
  html.replace(/(["'])tulip-file:\/\/vault\/([^"']+)\1/g, (_whole, _q, rel) => {
    sources.add(rel)
    return _whole
  })
  const data = new Map()
  for (const encoded of sources) {
    try {
      const rel = encoded.split('/').map(decodeURIComponent).join('/')
      const mime = EXPORT_IMAGE_MIME[path.extname(rel).toLowerCase()]
      if (!mime) continue                       // audio and video stay external
      const abs = await realSafePath(rel)
      const stat = await fs.lstat(abs)
      if (!stat.isFile() || stat.size > EXPORT_IMAGE_CAP) continue
      const bytes = await fs.readFile(abs)
      data.set(encoded, `data:${mime};base64,${bytes.toString('base64')}`)
    } catch { /* an unreadable image exports as its broken self */ }
  }
  return html.replace(/(["'])tulip-file:\/\/vault\/([^"']+)\1/g,
    (whole, quote, rel) => (data.has(rel) ? `${quote}${data.get(rel)}${quote}` : whole))
}

ipcMain.handle('note:export-html', async (event, name, html, to) => {
  const win = windowOf(event)
  if (!win) return { ok: false, error: 'There is no window to export from.' }

  const safe = String(name || 'note').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 120) || 'note'
  let filePath = typeof to === 'string' && to.endsWith('.html') ? to : null
  if (!filePath) {
    const chosen = await dialog.showSaveDialog(win, {
      title: 'Export as HTML',
      defaultPath: path.join(app.getPath('documents'), `${safe}.html`),
      filters: [{ name: 'HTML', extensions: ['html'] }]
    })
    if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true }
    filePath = chosen.filePath
  }

  try {
    const css = [await inlineExportCss('renderer.css'), await inlineExportCss('katex.css')]
      .filter(Boolean).join('\n')
    const body = await inlineExportImages(String(html || ''))
    const page = `<!doctype html>
<html data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safe.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>
<style>${css}</style>
<style>
/* Standing in for the app around the page: the reading column gets the page
   to itself, and the controls that only meant something inside Tulip go. */
body { margin: 0; background: var(--paper, #fff); }
.reading { overflow: visible; height: auto; padding: 2rem clamp(1rem, 8vw, 5rem); }
.code-tools, .tk-copy, .fold-chevron, .reading-fold, .embed-resize-grip { display: none !important; }
</style>
</head>
<body>
${body}
</body>
</html>
`
    await fs.writeFile(filePath, page, 'utf8')
    return { ok: true, path: filePath, bytes: Buffer.byteLength(page) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

/* ----------------------------------------------------- markdown export

   The note as a portable folder: the text with its embeds rewritten to plain
   relative links, and the files those links now name copied beside it. The
   renderer resolved the embeds — it owns the resolution rules — and this
   side owns the destination dialog and the copying. */

ipcMain.handle('note:export-markdown', async (event, name, text, files, to) => {
  const win = windowOf(event)
  if (!win) return { ok: false, error: 'There is no window to export from.' }

  const safe = String(name || 'note').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 120) || 'note'
  let filePath = typeof to === 'string' && to.endsWith('.md') ? to : null
  if (!filePath) {
    const chosen = await dialog.showSaveDialog(win, {
      title: 'Export as Markdown',
      defaultPath: path.join(app.getPath('documents'), `${safe}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true }
    filePath = chosen.filePath
  }

  try {
    await fs.writeFile(filePath, String(text || ''), 'utf8')
    let copied = 0
    for (const file of Array.isArray(files) ? files : []) {
      if (!file?.rel || !file?.as) continue
      /* `as` came from the renderer; contained under the note's own folder or
         refused, so a mangled name cannot write outside the destination. */
      const target = path.resolve(path.dirname(filePath), String(file.as))
      if (!target.startsWith(path.dirname(filePath) + path.sep)) continue
      try {
        const source = await realSafePath(String(file.rel))
        const stat = await fs.lstat(source)
        if (!stat.isFile()) continue
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.copyFile(source, target)
        copied++
      } catch { /* a missing attachment exports as its broken link */ }
    }
    return { ok: true, path: filePath, copied }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

/* A rendered whiteboard leaves the canvas as PNG or SVG bytes. The renderer
   owns rendering because that is where Excalidraw and its fonts live; main
   owns the native destination picker and the filesystem write. */
ipcMain.handle('whiteboard:export', async (event, name, ext, bytes, to) => {
  const suffix = ext === 'svg' ? 'svg' : 'png'
  const safe = String(name || 'whiteboard')
    .replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 120) || 'whiteboard'
  let filePath = typeof to === 'string' && to.toLowerCase().endsWith(`.${suffix}`)
    ? to
    : null
  if (!filePath) {
    const chosen = await dialog.showSaveDialog(windowOf(event), {
      title: `Export whiteboard as ${suffix.toUpperCase()}`,
      defaultPath: path.join(app.getPath('documents'), `${safe}.${suffix}`),
      filters: [{ name: suffix.toUpperCase(), extensions: [suffix] }]
    })
    if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true }
    filePath = chosen.filePath
  }
  try {
    await fs.writeFile(filePath, Buffer.from(bytes))
    return { ok: true, path: filePath, bytes: bytes?.length || 0 }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

/* ---------------------------------------------------------- pdf text

   A PDF's words, in a file beside its highlights: `Papers/thesis.pdf` reads out
   into `.annotations/Papers/thesis.pdf.txt`, one marked section per page.

   For the copilot. None of the CLIs it can be reads a PDF as a document — they
   read files as text and answer "I can't read PDFs directly", which is a paper
   left unreadable for want of a step nobody can take from the chat. Extracting
   it once here makes the answer the same for all of them, and cheaper than the
   pages would be as images either way.

   Written rather than made on demand because the agent has no way to ask for
   it — it gets a directory and its own tools, and a file either is there when
   it looks or is not. */

const PDF_TEXT_SUFFIX = VAULT_CONTRACT.pdfTextSuffix
const PDF_TEXT_MARKER = `Tulip-PDF-Text: ${PDF_TEXT_FORMAT}`

const pdfTextFile = (relPath) => safePath(path.join(ANNOTATION_DIR, `${relPath}${PDF_TEXT_SUFFIX}`))

/* A ceiling on one document. The worker answers with a message or dies, and a
   PDF that sends pdf.js somewhere it never returns from does neither — leaving
   a promise that never settles at the head of a queue every later extraction
   chains onto, so one bad document silently ends PDF text for the session. Set
   far above what a real book costs (seconds), because the only thing being
   caught here is "never". */
const PDF_TEXT_TIMEOUT_MS = 10 * 60 * 1000

function extractPdfTextOffThread (pdf, relPath) {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, 'pdf-text-worker.js'), [], {
      serviceName: 'Tulip PDF text'
    })
    let settled = false
    let timer = null
    const finish = (err, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      err ? reject(err) : resolve(result)
    }
    timer = setTimeout(
      () => finish(new Error(`PDF text worker timed out after ${PDF_TEXT_TIMEOUT_MS / 1000}s`)),
      PDF_TEXT_TIMEOUT_MS
    )
    timer.unref?.()
    child.once('message', (message) => {
      finish(message.error ? new Error(message.error) : null, message)
    })
    child.once('exit', (code) => {
      if (!settled) finish(new Error(`PDF text worker exited with code ${code}`))
    })
    child.once('spawn', () => {
      child.postMessage({
        pdf,
        name: path.basename(relPath),
        extractor: appAsset('pdf-text.cjs'),
        ocr: appAsset('pdf-ocr'),
        fonts: path.join(appAsset('pdfjs'), 'standard_fonts') + path.sep,
        cmaps: path.join(appAsset('pdfjs'), 'cmaps') + path.sep,
        wasm: path.join(appAsset('pdfjs'), 'wasm') + path.sep
      })
    })
  })
}

/* One document at a time. Parsing is CPU on the thread that also answers every
   file the renderer asks for, and a vault of papers opened at once would hold
   the window's first paint behind fourteen of them. The map is what keeps a
   burst of watcher ticks from queueing the same document twice.

   Waiting in the queue is not the same as waiting for a queue that is about to
   matter, though: `sweepPdfText` puts every PDF in the vault into it at open,
   and a question asked about the document on screen a moment later would sit
   behind all of them — a wait of minutes, silently, because the panel only
   knows to say "Preparing PDF" once this document's own job starts. So the
   queue is a list rather than a promise chain, and a caller that is waiting on
   an answer takes the next slot: at most one background document to sit out,
   never the whole shelf. */
let pdfTextRunning = null
const pdfTextWaiting = []
const pdfTextQueued = new Map()

function pumpPdfText () {
  if (pdfTextRunning || !pdfTextWaiting.length) return
  let at = pdfTextWaiting.findIndex((record) => record.urgent)
  if (at < 0) at = 0
  const record = pdfTextWaiting.splice(at, 1)[0]
  pdfTextRunning = record.start()
  pdfTextRunning.then(() => {
    pdfTextRunning = null
    pumpPdfText()
  }, () => {
    pdfTextRunning = null
    pumpPdfText()
  })
}

/**
 * Whether a PDF's extracted text is already on disk and still true of the file.
 *
 * Two stats and eighty bytes, which is the whole reason it is worth asking
 * separately from doing the work: the answer decides whether a turn has
 * anything to wait for, and the copilot used to announce "Preparing PDF" before
 * anyone had looked. The format marker is checked as well as the times, because
 * an extractor upgrade has to invalidate sidecars the PDF itself never touched
 * — the OCR release must revisit the old "no selectable text" files rather than
 * trusting their newer mtime.
 */
async function pdfTextIsCurrent (relPath) {
  try {
    const pdf = await realSafePath(relPath)
    const sidecar = pdfTextFile(relPath)
    await assertReal(sidecar)

    const [source, existing] = await Promise.all([
      fs.stat(pdf),
      fs.stat(sidecar).catch(() => null)
    ])
    if (!existing || existing.mtimeMs < source.mtimeMs) return false

    const handle = await fs.open(sidecar, 'r')
    try {
      const prefix = Buffer.alloc(80)
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
      return prefix.subarray(0, bytesRead).toString('utf8').startsWith(PDF_TEXT_MARKER)
    } finally {
      await handle.close()
    }
  } catch {
    // Unreadable, missing, outside the vault: all of them mean "there is work
    // to do", and the work itself is where they get reported properly.
    return false
  }
}

/**
 * The extracted text, split into pages, for as long as the file behind it is
 * unchanged.
 *
 * The sidecar is written once and then read on every turn that mentions the
 * document — and reading it is the cheap half. Splitting a four-hundred-page
 * book on its page markers and folding every page to compare against a query is
 * work that produced exactly the same pages the last question produced, and it
 * happened again for each one. The extraction was cached; the parse was not.
 *
 * Keyed by the sidecar's own identity — path, size and mtime — so a re-extract
 * replaces the entry without anyone having to remember to clear it.
 */
const pdfPagesCache = new Map()
/* Enough for a library, not just for what is open. This was eight, chosen for
   the copilot's turn — one document, maybe its neighbours. Vault search reaches
   every PDF there is on every keystroke, so on any shelf bigger than eight the
   cache evicted the whole set between one letter and the next and re-split
   every book each time. The entries hold extracted text, which is small beside
   the PDFs it came from. */
const PDF_PAGES_CACHED = 64

async function pdfPagesOf (sidecar) {
  const stamp = await fs.stat(sidecar)
  const hit = pdfPagesCache.get(sidecar)
  if (hit && hit.mtimeMs === stamp.mtimeMs && hit.size === stamp.size) {
    // Re-inserted so it counts as recently used: `set` on a key the Map already
    // has leaves it where it was, which would evict by first sight rather than
    // by use — and the document a reader keeps coming back to is exactly the
    // one that would go first.
    pdfPagesCache.delete(sidecar)
    pdfPagesCache.set(sidecar, hit)
    return hit
  }

  const text = await fs.readFile(sidecar, 'utf8')
  const entry = {
    mtimeMs: stamp.mtimeMs,
    size: stamp.size,
    pages: parsePages(text),
    // Read off the header the extractor wrote, once, rather than of the whole
    // book on every turn — and as the count it actually is.
    ocrPages: ocrPagesOf(text)
  }
  /* A handful of documents, because that is how many a reader has in play at
     once and the pages hold the book's text in memory. Least recently used out
     first — Map keeps insertion order, and every hit above re-inserts itself,
     so the first key is the one longest untouched. */
  pdfPagesCache.delete(sidecar)
  pdfPagesCache.set(sidecar, entry)
  if (pdfPagesCache.size > PDF_PAGES_CACHED) {
    pdfPagesCache.delete(pdfPagesCache.keys().next().value)
  }
  return entry
}

/**
 * Writes `<pdf>.txt` if the PDF is newer than it. Resolves either way — a
 * document that will not parse is worth a line in the log and nothing else.
 *
 * `onWork` is called if — and only if — this actually has to read a document,
 * which is the one moment anybody waits for. It is how the copilot knows to say
 * "Preparing PDF" without asking the same question the job is about to ask
 * itself: the caller that wants to say so passes a callback, and the background
 * sweep, which has nobody to tell, passes nothing. A caller joining a job
 * already queued or in flight is told too, because it waits just the same — and
 * passing a callback is also what marks the job as one somebody is waiting on,
 * which is what takes it to the front of the queue.
 *
 * The absolute sidecar path comes back with the answer. It was validated to get
 * here, and the callers that need it were re-deriving and re-validating it.
 */
function ensurePdfText (relPath, { onWork } = {}) {
  if (!isPdf(relPath)) return Promise.resolve({ ok: false, error: 'Only PDFs can be prepared.' })
  /* Turned off in settings (PDF › Read PDFs out for the copilot), which is a
     decision about what may be written into the vault — so it is answered here,
     where the writing is asked for, rather than at each of the five call sites
     that ask. What is already extracted stays; this only stops more. */
  if (readConfig().pdfText === false) {
    return Promise.resolve({ ok: false, error: 'Reading PDFs out is turned off in settings.' })
  }
  /* Relative paths are meaningful only inside the current vault. Including the
     root prevents a queued extraction from one vault being joined by a same-
     named PDF after the user switches folders. */
  const queueKey = `${vaultPath || ''}\0${relPath}`
  const running = pdfTextQueued.get(queueKey)
  if (running) {
    if (onWork) {
      running.urgent = true
      if (running.working) onWork()
      else running.watchers.add(onWork)
    }
    return running.job
  }

  const record = { working: false, urgent: Boolean(onWork), watchers: new Set() }
  if (onWork) record.watchers.add(onWork)
  const announce = () => {
    record.working = true
    for (const watcher of record.watchers) {
      try { watcher() } catch { /* telling someone is never the point of the job */ }
    }
    record.watchers.clear()
  }

  record.start = () => (async () => {
    const vault = vaultPath
    try {
      const pdf = await realSafePath(relPath)
      const sidecar = pdfTextFile(relPath)
      await assertReal(sidecar)

      if (await pdfTextIsCurrent(relPath)) {
        return { ok: true, textPath: rel(sidecar), sidecar, cached: true }
      }

      announce()
      const extracted = await extractPdfTextOffThread(pdf, relPath)

      // The vault can change under a long extraction — a book is a second of
      // parsing, and `safePath` resolved against the old one would write into
      // a folder the user has closed.
      if (vaultPath !== vault) return { ok: false, error: 'The vault changed while the PDF was being prepared.' }
      await fs.mkdir(path.dirname(sidecar), { recursive: true })
      await writeAtomic(sidecar, extracted.text)
      // There is text to search now where the last pass found none.
      forgetPdfSearchFacts(relPath)
      return {
        ok: true,
        textPath: rel(sidecar),
        sidecar,
        pages: extracted.pages || 0,
        ocrPages: extracted.ocrPages || 0
      }
    } catch (err) {
      console.error('pdf text failed', relPath, err.message)
      return { ok: false, error: err.message }
    }
  })()

  /* The promise the callers hold is settled by the run whenever the queue gets
     to it — so a job can be waiting, jumped over, and joined by a second caller
     without anything it handed out having to change. */
  record.job = new Promise((resolve) => { record.resolve = resolve })
  const run = record.start
  record.start = () => {
    const done = run()
    done.then(record.resolve, record.resolve)
    return done
  }

  pdfTextQueued.set(queueKey, record)
  pdfTextWaiting.push(record)
  record.job.finally(() => {
    if (pdfTextQueued.get(queueKey) === record) pdfTextQueued.delete(queueKey)
  }).catch(() => {})
  pumpPdfText()

  return record.job
}

/**
 * Refresh every PDF after a broad filesystem event. Ordinary startup and
 * opening a PDF stay on-demand: the copilot prepares the document it actually
 * needs, while a directory rename or watcher event still has a conservative
 * way to refresh all sidecars.
 */
/** Every PDF under `prefixes` (vault-relative folders; '' for the whole vault)
 *  checked for a text sidecar. A folder renamed used to mean every PDF in the
 *  vault, when the classifier had said which folder. */
async function sweepPdfText (prefixes = ['']) {
  if (!vaultPath) return
  const { pdfs } = await getVaultSnapshot()
  const under = prefixes.includes('')
    ? () => true
    : (abs) => { const key = rel(abs); return prefixes.some((p) => key === p || key.startsWith(`${p}/`)) }
  for (const pdf of pdfs) if (under(pdf)) ensurePdfText(pdf)
}

/** PDFs that this turn actually concerns: the document on screen and PDF
 * attachments. Other vault PDFs stay out of the prompt and out of the wait. */
function turnPdfs (context) {
  const paths = []
  if (context?.kind === 'pdf' && context.note) paths.push(context.note)
  for (const attachment of context?.attachments || []) {
    if (isPdf(String(attachment || ''))) paths.push(attachment)
  }
  return [...new Set(paths)]
}

/**
 * A small attached file, quoted rather than named.
 *
 * An attachment used to travel as a path and a line telling the agent to open
 * it, which costs a whole turn of latency — the model asks for the file, the
 * tool answers, and only then is the question addressed. For anything short
 * that is a round trip spent moving bytes the prompt could have carried for the
 * same tokens. So the small ones go inline and the rest keep the instruction:
 * a long file is exactly the one worth reading selectively.
 *
 * Text only, and only what `safeTargetPath` will resolve — an attachment is a
 * vault path the renderer offered, but it arrives over IPC and is treated as an
 * assertion rather than a fact.
 */
const INLINE_ATTACHMENT_BYTES = 4096
const INLINE_ATTACHMENT_EXT = new Set([
  ...MD_EXT, TEX_EXT, '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.bib',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.sh', '.css', '.html', '.xml', '.toml', '.ini'
])

async function inlineAttachments (context) {
  const paths = (context?.attachments || [])
    .map((file) => String(file || ''))
    .filter((file) => INLINE_ATTACHMENT_EXT.has(path.extname(file).toLowerCase()))
  if (!paths.length) return []

  const read = await Promise.all(paths.map(async (file) => {
    try {
      const abs = await realSafeTargetPath(file)
      const stat = await fs.stat(abs)
      if (!stat.isFile() || stat.size > INLINE_ATTACHMENT_BYTES) return null
      return { path: file, text: await fs.readFile(abs, 'utf8') }
    } catch { return null }
  }))
  return read.filter(Boolean)
}

async function preparePdfTurn (question, context, turnId = null) {
  const inlined = await inlineAttachments(context)
  if (inlined.length) context = { ...(context || {}), attachmentTexts: inlined }

  const paths = turnPdfs(context)
  if (!paths.length) return { context: context || null, failures: [] }

  /* Said once however many documents a turn carries, and only if one of them
     actually has to be read — see `ensurePdfText`, which is where that is
     known. Two PDFs both needing extraction are one wait, not two phases. */
  let announced = false
  const onWork = () => {
    if (announced) return
    announced = true
    toCopilot('ai:event', { k: 'preparing-pdf', turnId })
  }

  const prepared = await Promise.all(paths.map(async (pdfPath) => {
    const result = await ensurePdfText(pdfPath, { onWork })
    if (!result?.ok) return { path: pdfPath, error: result?.error || 'PDF extraction failed.' }
    try {
      // The sidecar path arrives validated from the job that wrote it.
      const { pages, ocrPages } = await pdfPagesOf(result.sidecar)
      return {
        path: pdfPath,
        textPath: result.textPath,
        pages,
        openPage: context?.kind === 'pdf' && context.note === pdfPath ? context.page : 0,
        ocrPages: result.ocrPages || ocrPages
      }
    } catch (err) {
      return { path: pdfPath, error: err.message }
    }
  }))

  const failures = prepared.filter((document) => document.error)
  const documents = prepared.filter((document) => !document.error)
  return {
    failures,
    context: {
      ...(context || {}),
      /* The pages are for ranking here, and what crosses to the agent is the
         path to the file they came out of — which it can read for itself. The
         page count stays: a model that knows a book has 400 pages reads one
         page at a time instead of dumping the whole sidecar into context. */
      pdfDocuments: documents.map(({ pages, ...document }) => ({ ...document, pages: pages.length })),
      pdfContext: relevantPdfContext(question, documents)
    }
  }
}

/**
 * Keeps a PDF's highlights attached to it through a rename, a move, or a
 * delete. Called for notes too, which simply have no sidecar to find — the
 * check is cheaper than deciding which of the two moved, and a folder move
 * carries a whole mirrored subtree in one rename either way.
 */
async function carryAnnotations (fromRel, toRel) {
  let from
  let to
  try {
    from = annotationFile(fromRel)
    to = annotationFile(toRel)
  } catch { return }

  /* Three shapes under `.annotations/`, and a path is at most one of them: the
     highlights, the extracted text beside them, and — for a folder, which has
     no `.json` of its own — the mirrored directory the two live in. */
  const stem = from.slice(0, -5)
  const stemTo = to.slice(0, -5)
  for (const [src, dest] of [
    [from, to],
    [stem + PDF_TEXT_SUFFIX, stemTo + PDF_TEXT_SUFFIX],
    [stem, stemTo]
  ]) {
    if (!fsSync.existsSync(src)) continue
    try {
      /* Both ends, before either is touched: `safePath` only settles the
         spelling, and a symlinked `.annotations` subtree would otherwise let a
         rename inside the vault move a file that lives outside it. */
      await assertReal(src)
      await assertReal(dest)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.rename(src, dest)
    } catch { /* highlights are not worth failing the move over */ }
  }
}

/* ------------------------------------------------------- running a block
   A fenced block can be executed and its output shown under it. Everything
   here runs in the main process: the renderer has no node access by design and
   asks for a run by name, the same way it asks for a file.

   Output is streamed back and held only by the page that asked for it — it is
   never written into the note, so a run leaves the file on disk untouched. */

/* The word after the fence, mapped to what turns that block into a running
   program. Nothing else is runnable: a `json` or `diff` block is data, and a
   language Tulip merely highlights is not one it can promise to execute.

   Not every language has an interpreter to hand the file to. Rust has to be
   compiled first, so a runner is a *sequence* of commands rather than one, and
   the sequence stops at the first that fails — which is how a program that does
   not compile shows you the compiler's complaint instead of a missing binary.

   `file` is what the block is written as: extensions carry meaning to these
   tools, and `go run` will not look at anything that is not a .go file. */
const RUNNERS = new Map()

/* The aliases are shared with the renderer — see electron/runnable-languages.json
   — so a runner added here draws its Run button without a second edit. Naming
   an id the file does not declare is a boot-time throw rather than a language
   that quietly never runs. */
const { runners: RUNNER_LANGUAGES } = require('./runnable-languages.json')

const runner = (id, spec) => {
  const langs = RUNNER_LANGUAGES[id]
  if (!langs) throw new Error(`no aliases declared for runner "${id}" in runnable-languages.json`)
  spec.id = id
  for (const lang of langs) RUNNERS.set(lang, spec)
}

/* Marks a step as a build rather than the program. A build is not what the
   timeout is about — "ten seconds" should mean ten seconds of your code
   running, not ten seconds minus however long rustc took — so it gets its own
   generous budget and its time is reported separately. */
const BUILD = { build: true }
const STAGE = { build: true, report: false }
const BUILD_TIMEOUT_MS = 120_000

/* Copying the built binary into its slot, and moving a finished build over the
   name it is cached under, used to be `/bin/cp` and `/bin/mv` — two paths that
   simply do not exist on Windows, where every compiled block therefore failed
   at the step after the one that did the work. Both are a single fs call, so
   they are made here instead of spawned.

   Still steps, and not something done around the sequence, because their place
   in it is the point: the cancel check, the stop-on-first-failure and the
   build clock above all apply to them exactly as they did to the tools. */
const fsStep = (run, opts) => [run, null, { ...opts, fs: true }]

/* The mode goes with it. The file is about to be executed, and a copy that
   arrives without its executable bit is a permission error at the last step. */
const stageBinary = (from, to) => fsStep(async () => {
  await fs.copyFile(from, to)
  await fs.chmod(to, 0o755)
}, STAGE)

const publishBinary = (from, to) => fsStep(() => fs.rename(from, to), BUILD)

const sha1 = (text, chars = 16) =>
  crypto.createHash('sha1').update(text).digest('hex').slice(0, chars)

/* Compiled blocks' binaries, surviving restarts so a note full of Rust opens
   ready to re-run. Bounded: the newest stay, the rest go. */
const RUN_CACHE_KEEP = 64
const EXEC_SLOT_PREFIX = 'exec-'

function runCacheDir () {
  const dir = path.join(app.getPath('userData'), 'run-cache')
  fsSync.mkdirSync(dir, { recursive: true })
  return dir
}

async function pruneRunCache () {
  // Resolved once: runCacheDir mkdirs on every call, and this loops over the
  // whole cache.
  const dir = runCacheDir()
  let entries
  try { entries = await fs.readdir(dir) } catch { return }
  const stats = []
  for (const name of entries) {
    // Stable execution slots are infrastructure, not compiled-result entries.
    // Keeping their inode is what avoids making macOS validate a brand-new
    // local executable after every edit to a compiled block.
    if (name.startsWith(EXEC_SLOT_PREFIX)) continue
    const abs = path.join(dir, name)
    // A .tmp is a build that never finished; it is junk at any age.
    if (name.endsWith('.tmp')) { fs.rm(abs, { force: true }).catch(() => {}); continue }
    const stat = await fs.stat(abs).catch(() => null)
    if (stat) stats.push({ abs, mtime: stat.mtimeMs })
  }
  stats.sort((a, b) => b.mtime - a.mtime)
  for (const { abs } of stats.slice(RUN_CACHE_KEEP)) {
    fs.rm(abs, { force: true }).catch(() => {})
  }
}

/* A compiled result is cached by source hash, but executing that cache file
   directly gives every edit a brand-new Mach-O inode. macOS then spends about
   150–250 ms validating it before main() begins. Copying into a small stable
   slot retains the inode and the cache: compilation is still source-keyed,
   while execution pays that admission once per concurrent slot. */
const executionSlots = new Map()

function claimExecutionSlot (kind) {
  let slots = executionSlots.get(kind)
  if (!slots) executionSlots.set(kind, (slots = []))
  let slot = slots.find((candidate) => !candidate.busy)
  if (!slot) {
    slot = {
      path: path.join(runCacheDir(), `${EXEC_SLOT_PREFIX}${kind}-${slots.length}`),
      busy: false
    }
    slots.push(slot)
  }
  slot.busy = true
  return {
    path: slot.path,
    release: () => { slot.busy = false }
  }
}

function compiledPlan (kind, binary, buildSteps) {
  const slot = claimExecutionSlot(kind)
  return {
    steps: [
      ...buildSteps,
      stageBinary(binary, slot.path),
      [slot.path, []]
    ],
    release: slot.release
  }
}

runner('node', {
  // Node needs `.mjs` before it will accept a top-level `import`, and `.js`
  // before it will accept `require`.
  file: (code) => (/^\s*(import\s|export\s)/m.test(code) ? 'block.mjs' : 'block.js'),
  steps: (file) => [['node', [file]]]
})

/* The environments a `python` block runs in. Lazily built, kept outside the
   vault, and rebuilt without comment whenever one is missing. */
const pythonEnvs = makePythonEnvs({
  root: () => app.getPath('userData'),
  vault: () => vaultPath || '',
  pathFor: runnerPath,
  installerOverride: () => readConfig().pythonInstaller || null
})

/** Off only if the reader turns it off: installing is what makes a block that
 *  imports something work at all, and the alternative is a traceback. */
const mayInstallPython = () => readConfig().autoInstallPythonDeps !== false

/* stdout is a pipe, so Python otherwise block-buffers it and a long-running
   block can look silent until it exits. `-u` makes each print available to the
   streaming panel immediately; the renderer coalesces the resulting chunks. */
runner('python', {
  file: 'block.py',
  /* Which interpreter, decided before the steps are built — see `prepare`
     below and electron/python-env.js for why it is not the system's. Falls
     back to `python3` when an environment cannot be made, so a block still
     runs on a machine where nothing can be installed. */
  /* The environment comes back with the run rather than being looked up again
     when something needs installing: which environment a note belongs to is
     one decision, and asking twice invites the install and the run to disagree
     about where they are pointed. */
  prepare: async (noteRel, code) => {
    /* A script that declares its own dependencies gets them, at the versions
       it asked for, instead of the note's shared environment and whatever
       "latest" means today. uv reads the block; nothing here parses it. */
    if (hasInlineDeps(code) && await pythonEnvs.usesUv()) return { script: true }

    const dir = await pythonEnvs.dirFor(noteRel)
    const python = await pythonEnvs.ensure(dir)
    /* Not just the interpreter: a block that shells out to `pip`, or calls a
       console script it installed, has to land inside the same environment its
       imports came from. See `activation` in electron/python-env.js. */
    return { dir, python, env: python ? pythonEnvs.activation(dir) : null }
  },
  steps: (f, _dir, _code, ready) => (ready?.script
    /* Resolving the declared dependencies is a build: it is one-time work that
       belongs to getting the script ready, and holding it to the program's
       ten seconds would kill the first run of anything with a real dependency
       list. `--no-project` so a pyproject.toml elsewhere in the vault cannot
       adopt the script; `--no-sync` because the build step just did that. */
    ? [
        ['uv', ['sync', '--script', f], BUILD],
        ['uv', ['run', '--no-project', '--no-sync', '--script', f]]
      ]
    : [[ready?.python || 'python3', ['-u', f]]])
})
runner('sh', { file: 'block.sh', steps: (f) => [['sh', [f]]] })
runner('bash', { file: 'block.sh', steps: (f) => [['bash', [f]]] })
runner('zsh', { file: 'block.sh', steps: (f) => [['zsh', [f]]] })

/* Julia compiles as it goes, and the first second or three of any run is the
   language starting up rather than the block doing anything. Holding it to the
   same clock as a shell one-liner would kill working code. */
/* --startup-file=no: a snippet runs in isolation, not inside whatever
   ~/.julia/config/startup.jl sets up — and skipping it takes measured startup
   from ~600ms to ~160ms. (--compile=min would shave a little more and was
   measured too, but it deoptimises the code the block actually came to run.) */
runner('julia', {
  file: 'block.jl',
  timeout: 60_000,
  steps: (f) => [['julia', ['--startup-file=no', f]]]
})

/* `go run` compiles and runs in one command, but only for a file that is a
   whole `package main` — which is what a Go snippet worth running is anyway.
   Because the compile is inside that one command it cannot be timed
   separately, so the whole thing gets the longer clock. */
runner('go', { file: 'main.go', timeout: 60_000, steps: (f) => [['go', ['run', f]]] })

/* Lean means two different things by "run". `lean file` *checks* the file and
   prints what its #eval lines say — which is how Lean is mostly written — and
   `lean --run` additionally executes `main`. The block says which it wants by
   whether it defines one. Startup is the language's, not the block's, so it
   shares the compiled languages' clock. */
runner('lean', {
  file: 'block.lean',
  timeout: 60_000,
  steps: (f, _dir, code) => [
    ['lean', /^\s*(unsafe\s+|partial\s+)?def\s+main\b/m.test(code) ? ['--run', f] : [f]]
  ]
})

/* Register the common compiled-language lifecycle once: source-keyed cache,
   atomic build, LRU touch, stable execution slot, and a tiny program for the
   idle warmup. Only the compiler command and language-specific names vary. */
function compiledRunner (id, { file, prefix, seed, warmCode, compile }) {
  const binaryFor = (code) => path.join(runCacheDir(), `${prefix}-${sha1(`${seed}\n${code}`)}`)
  const build = (source, output) => [...compile(source, output), BUILD]
  const compiled = { slot: prefix, warmCode, build }

  runner(id, {
    file,
    /* Compiled languages are where the heavy numeric blocks live — a ray
       tracer in a note is C++, not zsh — so they share go and julia's longer
       clock rather than the shell one-liners' ten seconds. */
    timeout: 60_000,
    compiled,
    cached: (code) => fsSync.existsSync(binaryFor(code)),
    steps: (source, _dir, code) => {
      const binary = binaryFor(code)
      if (fsSync.existsSync(binary)) {
        // A hit is a use; the prune keeps recently-used, not recently-built.
        try { fsSync.utimesSync(binary, new Date(), new Date()) } catch {}
        return compiledPlan(prefix, binary, [])
      }
      return compiledPlan(prefix, binary, [
        build(source, `${binary}.tmp`),
        publishBinary(`${binary}.tmp`, binary)
      ])
    }
  })
}

/* rustc defaults to edition 2015 when called bare. Pinning 2021 keeps modern
   snippets modern; warning about unused practice-code helpers is just noise. */
compiledRunner('rust', {
  file: 'main.rs',
  prefix: 'rs',
  seed: '2021 -O',
  warmCode: 'fn main() {}\n',
  compile: (source, output) => [
    'rustc', ['-O', '--edition', '2021', '-A', 'dead_code', '-o', output, source]
  ]
})

/* `c++` follows the platform compiler; pin the standard so its default age
   does not decide whether a note's structured bindings or lambdas compile.
   `-O2` because a numeric block runs 3-4× faster and the compile is on the
   build clock, not the program's — measured on a ray-tracer note: 6.4s a
   frame unoptimised, 1.7s with -O2, for a compile 0.2s slower. */
compiledRunner('cpp', {
  file: 'main.cpp',
  prefix: 'cpp',
  seed: 'c++20 -O2',
  warmCode: 'int main() { return 0; }\n',
  compile: (source, output) => ['c++', ['-O2', '-std=c++20', '-o', output, source]]
})

/* CUDA is C++ that nvcc splits into host code and device code, so a ```cu
   block compiles and runs exactly like a ```cpp one — the difference is only
   which compiler sees it, and that the machine needs a GPU and a driver at run
   time rather than at build time. A machine without either still compiles the
   block; what it prints is the failing cudaError, which is the honest answer.

   `-std=c++17` because that is the newest standard every shipping nvcc
   accepts for host code — c++20 is still gated on the host compiler in CUDA 12
   and would refuse blocks that have nothing to do with the GPU. The device
   architecture is deliberately left at nvcc's default: `-arch=native` reads the
   card in the machine doing the compiling, which is wrong for the note author
   who has no card at all, and the default's embedded PTX is JIT-compiled by
   the driver for whatever card actually runs it. */
compiledRunner('cuda', {
  file: 'main.cu',
  prefix: 'cu',
  seed: 'nvcc c++17 -O2',
  warmCode: 'int main() { return 0; }\n',
  compile: (source, output) => ['nvcc', ['-O2', '-std=c++17', '-o', output, source]]
})

/**
 * The PATH to run snippets with.
 *
 * An app launched from Finder or the Dock inherits launchd's PATH, not the one
 * your shell spends a login building — so Homebrew, nvm, pyenv, volta and
 * everything else people actually install with are invisible, and `node` is
 * reported "not installed" on a machine where it plainly is. (On Apple silicon
 * Homebrew lives in /opt/homebrew/bin, which launchd has never heard of.)
 *
 * So ask the login shell, once, for the PATH it would hand an interactive
 * session. The well-known locations below are a fallback for when that fails,
 * and a backstop for shells that only export PATH for interactive use.
 *
 * Windows has no login shell to ask — a process started from Explorer already
 * inherits the machine and user PATH that installers write to — so the probe is
 * skipped there rather than spawning a shell that is not present. But "most
 * installers register themselves" is not "all of them do": the Python.org
 * installer leaves "Add to PATH" unticked by default, TeX Live and MiKTeX
 * install under their own roots, and a user-scope Node or Rust toolchain lands
 * in AppData. Those are the same holes the list below plugs on macOS, so
 * Windows gets its own version of it rather than nothing at all.
 */

/* Where Windows puts things, from the environment rather than assumed: a
   machine with a D: drive or a redirected profile has none of the C:\ paths a
   literal list would name. */
const WINDOWS_ROOTS = () => {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const programs = process.env.ProgramFiles || 'C:\\Program Files'
  const systemDrive = process.env.SystemDrive || 'C:'
  const found = [
    /* The Python.org installer's per-user location, which is the default and
       the one whose "Add Python to PATH" box is unticked. Each minor version
       gets its own folder, so the directory is listed and its children added —
       newest last, so a later version wins the lookup. */
    path.join(local, 'Programs', 'Python'),
    path.join(local, 'Microsoft', 'WindowsApps'),   // the Store's Python and others
    path.join(roaming, 'npm'),                      // npm's global bin, user scope
    path.join(local, 'Programs', 'nodejs'),
    path.join(os.homedir(), '.cargo', 'bin'),
    path.join(os.homedir(), '.elan', 'bin'),        // Lean, via elan
    path.join(programs, 'nodejs'),
    // TeX, for ```tikz — both distributions, at their own default roots.
    `${systemDrive}\\texlive`,
    path.join(programs, 'MiKTeX', 'miktex', 'bin', 'x64')
  ]
  /* Two of those are parents rather than bin directories: a Python install is
     `…\Python\Python312\` and a TeX Live one is `…\texlive\2025\bin\windows`.
     Expanding them is a few `readdirSync`s at startup, and the alternative is
     naming a year and a minor version in the source. */
  const expanded = []
  for (const dir of found) {
    expanded.push(dir)
    if (!dir.includes('Python') && !dir.includes('texlive')) continue
    let children = []
    try { children = fsSync.readdirSync(dir).sort() } catch { continue }
    for (const child of children) {
      const at = path.join(dir, child)
      if (dir.includes('texlive')) expanded.push(path.join(at, 'bin', 'windows'))
      else expanded.push(at, path.join(at, 'Scripts'))
    }
  }
  return expanded
}

/* Worked out on the first Run, not at `require` time. On Windows the list is
   `WINDOWS_ROOTS()`, which is several `readdirSync`s of Program Files — a
   handful of blocking directory reads that used to happen while this module was
   still being evaluated, ahead of anything at all being on screen, for a value
   nothing needs until someone runs a code block. */
let fallbackPathsCache = null

function fallbackPaths () {
  if (!fallbackPathsCache) fallbackPathsCache = process.platform === 'win32' ? WINDOWS_ROOTS() : POSIX_FALLBACK_PATHS
  return fallbackPathsCache
}

const POSIX_FALLBACK_PATHS = [
  '/opt/homebrew/bin', '/opt/homebrew/sbin',   // Homebrew, Apple silicon
  '/usr/local/bin', '/usr/local/sbin',         // Homebrew, Intel — and much else
  '/opt/local/bin',                            // MacPorts
  path.join(os.homedir(), '.local/bin'),
  path.join(os.homedir(), '.cargo/bin'),
  path.join(os.homedir(), '.elan/bin'),           // Lean, via elan
  '/Library/TeX/texbin',                          // MacTeX, for ```tikz
  /* The CUDA toolkit installs outside every shell's default PATH and expects
     the profile to add it, which the launchd-inherited environment never has —
     so ```cu reported nvcc missing on machines with a working toolkit. The
     unversioned symlink is what a normal install leaves pointing at the
     newest. */
  '/usr/local/cuda/bin'
]

let loginPath = null        // resolved once, on the first paint
let loginPathReady = null

/**
 * The login shell's PATH, asked for once.
 *
 * `$SHELL -lic` evaluates somebody's whole profile — nvm, pyenv, a prompt
 * framework — which is tens to hundreds of milliseconds of a subprocess and its
 * I/O. It used to be spawned at `whenReady`, ahead of the window being built,
 * competing with the first paint for a value nothing wants until the first Run,
 * TeX or kernel. It is kicked off at the first paint instead, and everything
 * that spawns a tool awaits this rather than reading a `loginPath` that has not
 * arrived — which would silently run against a PATH short of what the reader's
 * profile puts there, and report the tool missing.
 */
function ensureLoginPath () {
  if (!loginPathReady) {
    loginPathReady = readLoginPath()
      .then((value) => { loginPath = value })
      .catch(() => {})
  }
  return loginPathReady
}

function readLoginPath () {
  /* See `fallbackPaths`: there is no login shell to ask on Windows, and asking
     means spawning `/bin/zsh` to watch it fail on every launch. */
  if (process.platform === 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    // -l runs the profile files, -i because an interactive session is where
    // most people's PATH edits actually take effect. The value is fenced so a
    // chatty profile's banner cannot be mistaken for it.
    /* Its own process group. The bail-out below kills `-pid`, which names a
       group rather than a process — and without `detached` the child is not a
       group leader, so no group by that id exists and the kill threw ESRCH
       into an empty catch every time. A profile that hangs waiting for input
       was never actually killed; it was only stopped being waited for. */
    const child = spawn(shell, ['-lic', 'printf "\\0%s\\0" "$PATH"'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true
    })
    // Detached, so it must not keep the app alive on its own account.
    child.unref()

    let out = ''
    let settled = false
    let bail = null
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(bail)
      resolve(value)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    // The kill below tears this pipe down; its complaint is not a crash.
    child.stdout.on('error', () => {})
    child.on('error', () => finish(null))
    child.on('close', () => finish(out.split('\0')[1]?.trim() || null))

    // A profile that waits for input would otherwise hang this forever. The
    // whole group goes, so a pipeline the profile started goes with it.
    bail = setTimeout(() => {
      killTree(child, 'SIGKILL')
      finish(null)
    }, 4000)
    bail.unref?.()
  })
}

/** Longest-first, de-duplicated, in preference order. */
function runnerPath () {
  const seen = new Set()
  return [loginPath, process.env.PATH, ...fallbackPaths()]
    .filter(Boolean)
    .flatMap((part) => part.split(path.delimiter))
    .filter((dir) => dir && !seen.has(dir) && seen.add(dir))
    .join(path.delimiter)
}

/* Enough output to be worth reading, capped so a runaway `yes` cannot grow the
   main process without bound. Each stream gets its own budget. PPM images are
   the exception — `P3\n800 600\n` is already 7 bytes but the pixels that follow
   are the picture, so a blackhole render would be cut after ~85k pixels (a
   band across the top) at 256KB. */
const MAX_RUN_BYTES = 1024 * 1024
/* Sized for animation, not a still: a 480×360 P3 frame is ~1.9 MB of ASCII,
   so ten megabytes cut an 8-frame render mid-frame. 32 MB holds ~16 such
   frames — or a 1600×1200 still — before the truncation warning is earned. */
const MAX_PPM_BYTES = 32 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
/* Enough to hold a deep traceback and the line that matters at the end of it.
   Read by the missing-import retry in `run:start` and by nothing else. */
const STDERR_TAIL_BYTES = 8192

const runs = new Map()   // id -> { child, timer, dir, done }
let nextRunId = 0

/* Which window asked for each run, so its output goes back to the block that
   is waiting for it and to no other. Kept beside `runs` rather than inside it
   because a run is only in `runs` while a step of it is actually running, and
   the owner has to outlast the gaps — a tikz render is two programs with a
   pause between them, and both halves report to the same block. */
const runOwners = new Map()   // id -> BrowserWindow

/** Record who a run belongs to, and hand its id straight back. */
function ownRun (id, event) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) runOwners.set(id, win)
  return id
}

/** Stop what a window started, when that window goes. */
function stopRunsOwnedBy (win) {
  for (const [id, owner] of [...runOwners]) {
    if (owner !== win) continue
    runOwners.delete(id)
    stopRun(id)
  }
}

function runnerFor (lang) {
  return RUNNERS.get(String(lang || '').trim().toLowerCase()) || null
}

/**
 * Spawns one command, streams it to the page under `id`, and resolves when it
 * is over. Both the Run control and Manim go through here, so the timeout, the
 * output cap, the process-group kill and the shape of what the renderer hears
 * are written once.
 *
 * @returns {Promise<{code:number|null, signal:string|null, timedOut:boolean, error?:string}>}
 */
function startRun (id, cmd, args, { cwd, timeoutMs, env: extraEnv, quiet = false }) {
  const child = spawn(cmd, args, {
    cwd,
    /* The output lands in a panel, not a terminal, and a tool that colours
       anyway (FORCE_COLOR honourers, Python's rich) leaves escape codes as
       litter there. Stated three ways because tools check different flags; the
       renderer still strips whatever ignores all three. */
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb',
      PATH: runnerPath(),
      TULIP_VAULT: vaultPath || '',
      ...extraEnv
    },
    // Its own process group, so killing a shell takes the pipeline it started
    // with it rather than leaving orphans behind.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const run = { child, done: false, timer: null, killTimer: null, timedOut: false }
  runs.set(id, run)

  const started = Date.now()
  const sizes = { stdout: 0, stderr: 0 }
  let truncated = false

  // PPM header is visible in the first bytes of stdout. If it is there,
  // the pixels are the image, not a transcript — keep up to MAX_PPM_BYTES
  // so a multi-frame render survives intact.
  let isPPMStream = false
  /* The tail of stderr, kept rather than only streamed. A traceback is the one
     piece of a run's output the main process has a use for after the fact: it
     is where "no module named x" is said, and installing x is the difference
     between a block that works and one that never can. The tail, not the
     whole, because the interesting line is the last one — and a run that
     printed a megabyte to stderr has not earned a megabyte of retention. */
  /* Kept as the last few chunks rather than as one growing string. Rebuilding
     `tail = (tail + text).slice(-8192)` copies eight kilobytes for every chunk
     that arrives, so a program that writes a megabyte to stderr in small
     pieces pays for the tail hundreds of times over. Chunks are pushed and the
     front is dropped once there is more than a tail's worth; the join happens
     once, if anyone asks. */
  const errChunks = []
  let errHeld = 0
  const keepStderr = (text) => {
    errChunks.push(text)
    errHeld += text.length
    while (errChunks.length > 1 && errHeld - errChunks[0].length >= STDERR_TAIL_BYTES) {
      errHeld -= errChunks.shift().length
    }
  }
  const stderrTail = () => {
    const joined = errChunks.length === 1 ? errChunks[0] : errChunks.join('')
    return joined.length > STDERR_TAIL_BYTES ? joined.slice(-STDERR_TAIL_BYTES) : joined
  }

  const pipe = (stream, name) => {
    stream.setEncoding('utf8')
    stream.on('data', (text) => {
      if (name === 'stderr') keepStderr(text)
      if (!isPPMStream && name === 'stdout' && sizes[name] === 0) {
        const head = String(text).trimStart()
        if (head.startsWith('P3\n') || head.startsWith('P3\r') || head.startsWith('P3 ')) isPPMStream = true
      }
      const limit = isPPMStream && name === 'stdout' ? MAX_PPM_BYTES : MAX_RUN_BYTES
      if (sizes[name] >= limit) return
      const room = limit - sizes[name]
      const chunk = text.length > room ? text.slice(0, room) : text
      sizes[name] += chunk.length
      if (chunk.length < text.length) truncated = true
      if (!quiet) toRun('run:out', { id, stream: name, text: chunk })
    })
    /* A pipe whose reader died mid-run errors on the stream, not on the child,
       and an unhandled stream error ends the main process. `close` below is
       already telling this run's story; there is nothing to add here. */
    stream.on('error', () => {})
  }
  pipe(child.stdout, 'stdout')
  pipe(child.stderr, 'stderr')

  return new Promise((resolve) => {
    const finish = (payload) => {
      if (run.done) return
      run.done = true
      clearTimeout(run.timer)
      clearTimeout(run.killTimer)
      runs.delete(id)
      resolve({ ms: Date.now() - started, truncated, errTail: stderrTail(), ...payload })
    }

    child.on('error', (err) => {
      // The commonest failure by far: the command is not installed.
      finish({
        code: null,
        error: err.code === 'ENOENT'
          ? `${cmd} could not be found. Tulip looked in ${runnerPath()}`
          : err.message
      })
    })
    child.on('close', (code, signal) => finish({ code, signal, timedOut: run.timedOut }))

    run.timer = setTimeout(() => {
      run.timedOut = true
      stopRun(id)
    }, timeoutMs)
  })
}

function runTimeoutMs (key, fallback) {
  const seconds = Number(readConfig()[key])
  return seconds > 0 ? Math.min(3600, seconds) * 1000 : fallback
}

/**
 * A run is a file in a private temp directory rather than a here-string on
 * stdin: an interpreter that has a file can report the line a failure happened
 * on, and `sh` can still read from stdin itself.
 */
/**
 * Runs a language's steps in order, stopping at the first that does not
 * succeed. The clock is the whole sequence's, not each step's: "ten seconds"
 * has to mean ten seconds from pressing Run, or a language that compiles first
 * would quietly get twice the budget of one that does not.
 */
/**
 * @returns {Promise<{ code: number | null, signal?: string | null, error?: string | null,
 *   timedOut?: boolean, ms: number, buildMs: number }>} what the last step
 *   answered, with the whole sequence's timings folded in. Spelled out because
 *   the shape is a union assembled across the loop below — the early breaks
 *   each contribute a different field — and a caller asking "did this finish
 *   cleanly?" needs to be able to see all of them.
 */
/**
 * @param {number} id
 * @param {any[][]} steps
 * @param {{cwd: string, timeoutMs: number, cleanup?: string,
 *   env?: Record<string, string>|null, quiet?: boolean}} how
 * @returns {Promise<{code: number|null, signal?: string|null, error?: string|null,
 *   timedOut?: boolean, errTail?: string, ms: number, buildMs: number}>}
 */
async function runSequence (id, steps, how) {
  const { cwd, timeoutMs, cleanup, env, quiet = false } = how
  // The PATH these steps run under, before the first of them is spawned.
  await ensureLoginPath()
  let left = timeoutMs        // the program's remaining budget
  let ms = 0                  // wall clock across every step, build included
  let buildMs = 0
  /** @type {{code: number|null, signal?: string|null, error?: string|null,
   *   timedOut?: boolean, errTail?: string, ms?: number}|null} */
  let result = null

  /** @type {{build?: boolean, report?: boolean, fs?: boolean}} */
  const NO_OPTS = {}
  for (const [cmd, args, opts = NO_OPTS] of steps) {
    // Stop pressed between a compile and the program it produced: without this
    // the kill lands on a process that has already exited and the next step
    // starts anyway.
    if (cancelled.has(id)) {
      result = { ...(result || {}), signal: 'SIGTERM', code: null }
      break
    }
    if (!opts.build && left <= 0) {
      result = { ...(result || {}), timedOut: true, code: null }
      break
    }

    if (opts.fs) {
      /* An fs step answers in the same shape a spawned one does, so the loop
         below it — the timing, the break on failure — reads one kind of
         result and not two. A failed copy is a failed step, not a throw:
         the sequence's job is to stop and report, and a rejection here would
         take the cleanup and the slot release with it. */
      const at = Date.now()
      try {
        await cmd()
        result = { code: 0, ms: Date.now() - at }
      } catch (error) {
        result = { code: 1, error: error.message, ms: Date.now() - at }
      }
    } else {
      result = await startRun(id, cmd, args, {
        cwd,
        timeoutMs: opts.build ? BUILD_TIMEOUT_MS : left,
        env,
        quiet
      })
    }

    const took = result.ms || 0
    ms += took
    if (opts.build) {
      if (opts.report !== false) buildMs += took
    } else {
      left -= took
    }

    if (result.error || result.timedOut || result.signal || result.code !== 0) break
  }

  cancelled.delete(id)
  if (cleanup) await fs.rm(cleanup, { recursive: true, force: true }).catch(() => {})
  // The reported time is the whole thing — a run that took four seconds should
  // not claim 182ms because most of it was the compiler.
  return { ...(result || { code: null }), ms, buildMs }
}

/** A simple runner returns its steps; a compiled runner also owns a reserved
 *  stable execution slot which must be released after the sequence settles. */
function executionPlan (made) {
  return Array.isArray(made) ? { steps: made, release: null } : made
}

/* One prewarm per compiled language and app launch. The source is deliberately
   written into the ordinary temp run directory, not the persistent cache: its
   job is to page the compiler in and validate the stable execution slot, not
   to masquerade as a result from one of the reader's blocks. */
const runnerWarmups = new Map()

function warmRunner (lang) {
  const spec = runnerFor(lang)
  if (!spec?.compiled) return Promise.resolve({ ok: false })
  const existing = runnerWarmups.get(spec.id)
  if (existing) return existing

  const warming = (async () => {
    const id = ++nextRunId
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `tulip-warm-${spec.id}-`))
    const source = path.join(dir, spec.file)
    const binary = path.join(dir, 'program')
    const slot = claimExecutionSlot(spec.compiled.slot)

    try {
      await fs.writeFile(source, spec.compiled.warmCode, 'utf8')
      const result = await runSequence(id, [
        spec.compiled.build(source, binary),
        stageBinary(binary, slot.path),
        [slot.path, []]
      ], { cwd: dir, timeoutMs: DEFAULT_TIMEOUT_MS, cleanup: dir, quiet: true })
      return { ok: result.code === 0 }
    } finally {
      slot.release()
      discard(dir)
    }
  })()
  runnerWarmups.set(spec.id, warming)
  warming.catch(() => {
    if (runnerWarmups.get(spec.id) === warming) runnerWarmups.delete(spec.id)
  })
  return warming
}

/* How many runs are in flight, and how many have ever begun. Together they
   answer the one question `collectRunPages` needs: did anything else run while
   this did? Nothing was running when we started, and nothing has started
   since, is the whole of "this run had the directory to itself". */
let runsInFlight = 0
let runsEverStarted = 0

ipcMain.handle('run:warm', (_e, lang) => warmRunner(lang))

ipcMain.handle('run:start', async (event, lang, code, noteRel) => {
  const spec = runnerFor(lang)
  if (!spec) throw new Error(`Tulip cannot run "${lang}" blocks.`)
  if (typeof code !== 'string') throw new Error('Nothing to run.')

  /* If its control already started a compiler warmup, let that finish before
     compiling a new block. A cache hit skips the wait: it has no need for a
     warm compiler, and can claim another slot if the warmup still owns one. */
  if (spec.compiled && !spec.cached(code)) {
    await warmRunner(lang).catch(() => {})
  }

  const id = ownRun(++nextRunId, event)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-run-'))
  const file = path.join(dir, typeof spec.file === 'function' ? spec.file(code) : spec.file)
  await fs.writeFile(file, code, 'utf8')

  /* Whatever the language needs in place before it can name a command — for
     python, the environment this note's blocks run in. The PATH a probe here
     would use has to be the PATH the run gets, so it is settled first. */
  await ensureLoginPath()
  const note = typeof noteRel === 'string' && noteRel ? noteRel : null
  const ready = spec.prepare ? await spec.prepare(note, code).catch(() => null) : null

  const plan = executionPlan(spec.steps(file, dir, code, ready))
  const steps = plan.steps
  // A language that spends its first seconds starting itself up says so; the
  // `runTimeout` setting still overrides whatever it asked for.
  const timeoutMs = runTimeoutMs('runTimeout', spec.timeout || DEFAULT_TIMEOUT_MS)

  // The vault is the working directory, so a snippet's relative paths mean what
  // they mean in the note. Without one, the scratch directory stands in.
  const cwd = vaultPath || dir
  const pagesBefore = vaultPath ? await htmlFilesIn(cwd) : new Map()

  /* Claimed before the first step is spawned and released when the last one
     settles, so the window these describe is the whole of the run rather than
     the part of it that happened to be executing. See `collectRunPages`. */
  const alone = runsInFlight === 0
  const startedNth = ++runsEverStarted
  runsInFlight++
  const from = Date.now()

  /* The temp directory is this handler's to remove, not `runSequence`'s: a run
     that installs a missing import runs the same file twice, and a sequence
     that tidied up after the first attempt would leave the second nothing to
     run. Removed in `finally`, so both paths out of here are covered. */
  runWithMissingImports(id, steps, { cwd, timeoutMs, ready })
    .then(async (result) => {
      /* Only a run that finished on its own terms may take a file away. One
         that was stopped, timed out or failed has left the directory in a
         state nobody described, and guessing which of the leavings were its
         own is exactly the guess this is here to stop making. */
      const clean = !result.error && !result.timedOut && !result.signal && result.code === 0
      const pages = vaultPath
        ? await collectRunPages(cwd, pagesBefore, {
            alive: { from, to: Date.now() },
            mayRemove: clean && alone && runsEverStarted === startedNth
          })
        : []
      // `errTail` is the retry's working material and means nothing to the
      // renderer, which was streamed every one of those bytes as they arrived.
      const { errTail: _tail, ...reportable } = result
      toRun('run:done', { id, ...reportable, pages })
    })
    /* A failure before `run:done` is sent leaves the block on screen saying
       "Running…" for the rest of the session — and unrunnable, since the
       renderer keeps the state keyed by its code and Stop cannot find an id
       that was never registered. An invalid working directory (the vault
       unmounted, or renamed while the app was open) is enough to reach here.
       The failure is reported as the run's own, which is what it is. */
    .catch((err) => {
      console.error('run failed', err)
      toRun('run:done', {
        id,
        code: null,
        error: err?.message || 'This block could not be run.'
      })
      discard(dir)
    })
    .finally(() => {
      runsInFlight--
      plan.release?.()
      discard(dir)
    })

  /* The first step that is actually spawned. An fs step carries a function
     where a command name goes, which does not survive the trip over IPC — and
     is not what a caller asking "what is this running?" means anyway: for a
     compiled block already in the cache, the first step is the copy into the
     execution slot rather than the program. */
  const spawned = steps.find(([, , opts = {}]) => !opts.fs)
  return { id, cmd: spawned ? spawned[0] : null, timeoutMs }
})

/* How many times a single Run may stop to install something. Each pass
   installs one distribution and runs again, so a block importing three absent
   packages is three passes — slower than resolving them all at once, but a
   traceback only ever names the first import that failed, so there is nothing
   to resolve all at once from. The cap is what stops a block whose import
   fails for some *other* reason from installing forever. */
const MAX_IMPORT_INSTALLS = 3

/**
 * Run a block, and if it died only because something was not installed,
 * install it and run again.
 *
 * The reader sees one run. The traceback from the attempt that failed has
 * already streamed into the panel by the time anything is installed — it is
 * the honest account of what happened, and hiding it would mean holding every
 * run's output back on the chance it might be retried.
 */
async function runWithMissingImports (id, steps, { cwd, timeoutMs, ready }) {
  let result = await runSequence(id, steps, { cwd, timeoutMs, env: ready?.env })

  /* Nothing to install into: either the language has no environment of its
     own, or one could not be made and the block ran on the system interpreter
     — where installing is not this app's business.

     A script carrying its own dependency list is also left alone. It said what
     it needs; if an import is still missing, the list is wrong, and quietly
     installing the package would hide the one thing worth telling the author. */
  if (!ready?.python || !mayInstallPython()) return result

  const tried = new Set()
  for (let pass = 0; pass < MAX_IMPORT_INSTALLS; pass++) {
    /* Only a program that ran and failed on its own. A run that was stopped by
       hand, timed out, or never started is not asking for anything to be
       installed — and retrying a stopped run would restart the very thing the
       reader just stopped. */
    if (result.error || result.timedOut || result.signal || result.code === 0) break

    const pkg = missingPackage(result.errTail)
    /* Already installed once this run and still missing: installing it again
       will not change the answer. The commonest cause is a distribution whose
       import name this table maps wrongly, and looping on it would be the
       worst possible response. */
    if (!pkg || tried.has(pkg)) break
    tried.add(pkg)

    toRun('run:out', { id, stream: 'stdout', text: `\nInstalling ${pkg}…\n` })
    const installed = await pythonEnvs.install(ready.dir, pkg, {
      // The installer's own progress, so a large download is visibly working
      // rather than apparently hung.
      onOutput: (text) => toRun('run:out', { id, stream: 'stdout', text })
    })
    if (!installed.ok) {
      /* Why, not just that. "No network", "there is no such package" and "no
         wheel for this platform" are the same sentence without the reason, and
         they are three quite different things to do next. */
      const why = installed.reason ? ` ${installed.reason}` : ''
      toRun('run:out', { id, stream: 'stderr', text: `Could not install ${pkg}.${why}\n` })
      break
    }
    // Stop pressed while the download was going: honour it rather than
    // starting the program the reader has stopped waiting for.
    if (cancelled.has(id)) break

    /* The run after an install gets a build's budget rather than a program's.
       The first import of a freshly installed library does one-time work —
       writing bytecode, building font and shader caches — that belongs to
       installing it and not to the block: measured at ~10s for manim against
       0.7s for every import after it. Judged by the ordinary ten-second
       timeout that first run is killed every time, and because the kill
       interrupts the very work that would have made the next run fast, it is
       killed every time *again*. The reader sees a library that installs
       perfectly and then never runs. */
    result = await runSequence(id, steps, {
      cwd, env: ready.env, timeoutMs: Math.max(timeoutMs, BUILD_TIMEOUT_MS)
    })
  }

  return result
}

/* Runs the page has asked to stop. Kept separately from `runs` because a
   sequence is only *in* `runs` while one of its steps is actually running. */
const cancelled = new Set()

/** SIGTERM first so a program can tidy up, SIGKILL if it will not go. */
function stopRun (id) {
  cancelled.add(id)
  const run = runs.get(id)
  if (!run || run.done) return false

  /* The tree, not the process: a run block's interpreter is free to have
     started something of its own, and on Windows what we hold is often a shim
     around the real one. See electron/kill-tree.js. */
  const signal = (sig) => killTree(run.child, sig)
  signal('SIGTERM')
  run.killTimer = setTimeout(() => signal('SIGKILL'), 2000)
  return true
}

ipcMain.handle('run:kill', (_e, id) => stopRun(Number(id)))

/* ------------------------------------------------------------ notebooks

   A notebook's cells run in a kernel rather than as programs, because they are
   meant to share one namespace — see electron/kernel.js for why that is
   borrowed from Jupyter rather than built here. */
function kernelHost () {
  if (kernels) return kernels
  const { KernelHost } = require('./kernel')
  kernels = new KernelHost({
    pathFor: runnerPath,
    onEvent: (event) => {
      const win = kernelOwners.get(event.path)
      if (win) sendTo(win, 'kernel:event', event)
    }
  })
  if (vaultPath) kernels.setRoot(vaultPath)
  return kernels
}

/* Which window is showing each notebook, so a kernel's output goes to the pane
   that asked for it. Keyed by notebook path because that is what a kernel
   belongs to — two windows on the same notebook would share one namespace,
   which is what opening the same notebook twice in Jupyter does too. */
const kernelOwners = new Map()   // notebook path -> BrowserWindow

function ownKernel (notebookPath, event) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) kernelOwners.set(notebookPath, win)
  return win
}

/** Shut down what a window started, when that window goes. A kernel is a
 *  Python process; leaving it running for a pane nobody can see is a leak
 *  measured in hundreds of megabytes. */
function stopKernelsOwnedBy (win) {
  for (const [notebookPath, owner] of [...kernelOwners]) {
    if (owner !== win) continue
    kernelOwners.delete(notebookPath)
    kernels?.shutdown(notebookPath).catch(() => {})
  }
}

ipcMain.handle('kernel:start', async (event, notebookPath, wanted) => {
  if (typeof notebookPath !== 'string' || !notebookPath) throw new Error('No notebook.')
  ownKernel(notebookPath, event)
  // The Jupyter server is spawned with `pathFor`, which is `runnerPath`.
  await ensureLoginPath()
  const kernel = await kernelHost().kernelFor(notebookPath, wanted)
  return { kernel: kernel.displayName, name: kernel.name, state: kernel.state }
})

ipcMain.handle('kernel:execute', async (event, notebookPath, code) => {
  const kernel = kernels?.get(notebookPath)
  if (!kernel) throw new Error('This notebook has no kernel running.')
  const win = ownKernel(notebookPath, event)

  /* The id goes back at once and the verdict follows as an event. The viewer
     cannot attribute a line of output to a cell until it knows which request
     produced it, and output starts arriving the moment the kernel begins. */
  const { msgId, done } = kernel.execute(code)
  const finish = (payload) =>
    sendTo(win, 'kernel:event', { path: notebookPath, kind: 'done', msgId, ...payload })
  done.then(
    (result) => finish({ status: result.status, executionCount: result.executionCount }),
    // A rejected `done` is the kernel dying, restarting or being shut down
    // under a running cell — all of which the cell has to be told about, or it
    // says "Running…" for the rest of the session.
    (err) => finish({ status: 'aborted', error: err?.message || 'The run stopped.' })
  )
  return { msgId }
})

ipcMain.handle('kernel:interrupt', async (_e, notebookPath) => {
  const kernel = kernels?.get(notebookPath)
  return kernel ? kernel.interrupt() : false
})

/* The answer to an `input()` the kernel is blocked on. Nothing is returned but
   whether there was a question to answer: what the kernel does with it comes
   back as ordinary output, the way it does when you type into a terminal. */
ipcMain.handle('kernel:input', async (_e, notebookPath, value) => {
  const kernel = kernels?.get(notebookPath)
  return kernel ? kernel.respondInput(value) : false
})

/* Completion and inspection answer straight back rather than as events: unlike
   a cell, nothing is drawn until the whole reply is in hand. A kernel that is
   not running is not an error worth raising here — the caller is a Tab key. */
ipcMain.handle('kernel:complete', async (_e, notebookPath, code, cursorPos) => {
  const kernel = kernels?.get(notebookPath)
  if (!kernel) return null
  return kernel.complete(code, cursorPos).catch(() => null)
})

ipcMain.handle('kernel:inspect', async (_e, notebookPath, code, cursorPos) => {
  const kernel = kernels?.get(notebookPath)
  if (!kernel) return null
  return kernel.inspect(code, cursorPos).catch(() => null)
})

ipcMain.handle('kernel:restart', async (_e, notebookPath) => {
  const kernel = kernels?.get(notebookPath)
  return kernel ? kernel.restart() : false
})

ipcMain.handle('kernel:shutdown', async (_e, notebookPath) => {
  kernelOwners.delete(notebookPath)
  return kernels ? kernels.shutdown(notebookPath) : false
})

/* The notebook was renamed or moved. Its kernel is filed under the path it had
   — as is the window that owns it — so both are re-keyed here rather than left
   naming a file that is gone. Answered even when nothing was running: the
   renderer calls this for every rename of an `.ipynb`, and "there was no
   kernel" is the ordinary case. */
ipcMain.handle('kernel:rename', async (_e, from, to) => {
  const owner = kernelOwners.get(from)
  if (owner) {
    kernelOwners.delete(from)
    kernelOwners.set(to, owner)
  }
  return kernels ? kernels.rename(from, to) : false
})

ipcMain.handle('kernel:specs', async () => {
  await ensureLoginPath()
  return kernelHost().kernelSpecs()
})

/* For quitting, where there is no later: the SIGKILL escalation timer in
   `stopRun` would never fire, so the groups go outright. */
function killAllRuns () {
  for (const run of runs.values()) killTree(run.child, 'SIGKILL')
}

/* --------------------------------------------------------------- manim
   A ```manim block is a scene, and what a scene is *for* is the video. So it
   renders to a real file in the vault and the reading view shows that instead
   of the code.

   The video is named after a hash of the code, which is the whole caching
   story: the same block always asks for the same file, so a note that has been
   rendered once opens with its videos already there and nothing re-runs. Edit
   the block and it asks for a name that does not exist yet, which is exactly
   when a re-render is wanted. Nothing is written into the .md — the note keeps
   saying what you wrote, and the video sits beside it as an attachment. */

/* Manim and TikZ both render a block to a real file beside the note, and both
   name that file after a hash of what produced it — which is the whole caching
   story, so the three steps it takes are here rather than in each of them. */

/**
 * Where a note's rendered artefacts live, and what one is called.
 *
 * The digest is 10 characters rather than sha1's usual 16 here, and has to
 * stay so: it is baked into every file already rendered into a vault, and
 * lengthening it would silently orphan all of them.
 */
async function artefactTarget (noteName, kind, seed, ext) {
  const folder = path.join(ATTACHMENT_DIR, String(noteName || 'Untitled').replace(/[/\\]/g, '-'))
  const target = safePath(path.join(folder, `${kind}-${sha1(seed, 10)}.${ext}`))
  await assertReal(target)
  return target
}

/** Is this block already rendered? Answered without running anything, so the
 *  reading view can show the result the moment the note opens. */
async function artefactAt (target) {
  if (!vaultPath) return null
  try {
    await fs.access(target)
    return rel(target)
  } catch {
    return null
  }
}

/** The temp directory a render worked in, gone whether it worked or not. */
const discard = (dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})

/** A finished render, moved into the vault. Copied rather than renamed: the
 *  temp dir is often on a different volume, where rename fails outright. */
async function keepArtefact (produced, target) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  /* The app's own write, so the watcher does not report it back as an outside
     change and set off a full vault walk plus a backlink scan for a picture
     Tulip drew itself. Stamped on both sides of the copy: the window has to be
     open when the event is actually generated. */
  noteSelfWrite(target)
  await fs.copyFile(produced, target)
  noteSelfWrite(target)
  // A new file in the vault; the note embeds it as soon as this returns.
  invalidateVaultSnapshot()
}

const MANIM_TIMEOUT_MS = 5 * 60 * 1000

/** Manim CE's quality flags, smallest first. Medium is 720p30. */
const MANIM_QUALITIES = new Set(['l', 'm', 'h', 'p', 'k'])

const manimTarget = (noteName, code, quality) =>
  artefactTarget(noteName, 'manim', `${quality}\n${code}`, 'mp4')

/**
 * The scene to render. Manim asks interactively when a file holds several and
 * none was named, which would hang a run forever with nobody to answer — so one
 * is always chosen here. The fence may name it (```manim MyScene); otherwise
 * the last class in the block wins, which is the one people write last and mean.
 */
function sceneName (code, requested) {
  if (requested && /^[A-Za-z_]\w*$/.test(requested)) return requested
  const found = [...code.matchAll(/^\s*class\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/gm)]
    .filter((m) => /Scene\b/.test(m[2]))
    .map((m) => m[1])
  return found.length ? found[found.length - 1] : null
}

/** The newest .mp4 anywhere under `dir` — manim's own layout is a deep tree
 *  whose shape has changed between releases, so the file is found, not guessed. */
async function newestVideo (dir) {
  let best = null
  const walk = async (at) => {
    let entries
    try { entries = await fs.readdir(at, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const abs = path.join(at, entry.name)
      if (entry.isDirectory()) { await walk(abs); continue }
      if (path.extname(entry.name).toLowerCase() !== '.mp4') continue
      // Manim writes partial clips into a `partial_movie_files` folder and
      // stitches them; the assembled scene is the one outside it.
      if (abs.includes('partial_movie_files')) continue
      const stat = await fs.stat(abs).catch(() => null)
      if (stat && (!best || stat.mtimeMs > best.mtime)) best = { abs, mtime: stat.mtimeMs }
    }
  }
  await walk(dir)
  return best?.abs || null
}

/** Manim on the PATH, else the module under python3 — both are normal installs. */
/** Is manim on the PATH a render will use? */
function systemManim () {
  return new Promise((resolve) => {
    // The same PATH a run gets, so the probe and the render cannot disagree
    // about which manim is installed.
    const probe = spawn('manim', ['--version'], {
      stdio: 'ignore',
      env: { ...process.env, PATH: runnerPath() }
    })
    probe.on('error', () => resolve(false))
    probe.on('close', (code) => resolve(code === 0))
  })
}

/**
 * What to invoke to render a scene.
 *
 * A manim installed on the machine is preferred over one Tulip installed: it
 * is the one the reader chose, and on this machine it is commonly a `uv tool`
 * that works perfectly while `python3 -m manim` — the old fallback — cannot
 * see it at all. Tulip's own copy is for the machine that has no manim, where
 * the alternative is a block that can never render.
 *
 * @param {{id?: number}} [reporting]  a run to stream an install into
 */
async function manimCommand (reporting = {}) {
  const configured = readConfig().manimCommand
  if (configured) return String(configured).split(/\s+/)
  // The probe is the first thing a render does, so it is also where the login
  // shell's PATH has to have arrived.
  await ensureLoginPath()

  const shared = pythonEnvs.sharedDir()
  const mine = await pythonEnvs.tool(shared, 'manim')
  if (mine) return [mine]

  if (await systemManim()) return ['manim']

  if (mayInstallPython()) {
    const { id } = reporting
    if (id) toRun('run:out', { id, stream: 'stdout', text: '\nInstalling manim…\n' })
    const done = await pythonEnvs.install(shared, 'manim', {
      onOutput: (text) => { if (id) toRun('run:out', { id, stream: 'stdout', text }) }
    })
    if (!done.ok && id && done.reason) {
      toRun('run:out', { id, stream: 'stderr', text: `Could not install manim. ${done.reason}\n` })
    }
    const installed = done.ok && await pythonEnvs.tool(shared, 'manim')
    if (installed) return [installed]
  }

  /* Nothing found and nothing installed. The old fallback stands, because on a
     machine where manim is a library in the system interpreter it is right —
     and where it is not, its failure names manim, which is the useful thing to
     put in front of the reader. */
  return ['python3', '-m', 'manim']
}

/* ------------------------------------------------- managing environments

   What settings shows. `list` is a walk of every file under every
   environment, so it is asked for when the panel opens and not on a timer. */

ipcMain.handle('python:envs', async () => {
  /* The notes that still exist, so an environment left behind by one that does
     not can say so. Read here rather than in python-env.js, which deliberately
     knows nothing about the index. */
  /** @type {Set<string>|null} */
  let live = null
  if (vaultPath) {
    await ensureIndex()
    live = new Set(index.keys())
  }
  return pythonEnvs.list(live)
})

ipcMain.handle('python:env-remove', async (_e, dir) => {
  if (typeof dir !== 'string' || !dir) return false
  return pythonEnvs.remove(dir)
})

/** Every environment whose note this vault no longer has. */
ipcMain.handle('python:env-prune', async () => {
  if (!vaultPath) return 0
  await ensureIndex()
  const live = new Set(index.keys())
  const all = await pythonEnvs.list(live)
  let gone = 0
  for (const env of all) {
    if (!env.orphaned) continue
    if (await pythonEnvs.remove(env.dir)) gone++
  }
  return gone
})

ipcMain.handle('manim:lookup', async (_e, noteName, code, scene) => {
  const found = await artefactAt(await manimTarget(noteName, code, manimQuality()))
  return found ? { path: found, scene: sceneName(code, scene) } : null
})

function manimQuality () {
  const q = String(readConfig().manimQuality || 'm').toLowerCase()
  return MANIM_QUALITIES.has(q) ? q : 'm'
}

ipcMain.handle('manim:render', async (event, noteName, code, scene) => {
  if (!vaultPath) throw new Error('Open a vault first — the video is saved into it.')
  if (typeof code !== 'string' || !code.trim()) throw new Error('Nothing to render.')

  const name = sceneName(code, scene)
  if (!name) throw new Error('No Scene class found in this block.')

  const quality = manimQuality()
  const target = await manimTarget(noteName, code, quality)
  const id = ownRun(++nextRunId, event)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-manim-'))

  // Started before the work so the page can show progress and offer a Stop.
  queueMicrotask(() => toRun('run:out', {
    id, stream: 'stdout', text: `Rendering ${name}…\n`
  }))

  const finish = async () => {
    const file = path.join(dir, 'scene.py')
    await fs.writeFile(file, code, 'utf8')

    const [cmd, ...lead] = await manimCommand({ id })
    const result = await startRun(
      id,
      cmd,
      [...lead, 'render', '--media_dir', path.join(dir, 'media'),
        '--format', 'mp4', '--quality', quality, file, name],
      { cwd: dir, timeoutMs: runTimeoutMs('manimTimeout', MANIM_TIMEOUT_MS) }
    )
    // A render is one command, so nothing reads this flag afterwards — but a
    // stopped render would otherwise leave its id in the set for good.
    cancelled.delete(id)

    if (result.error || result.code !== 0) {
      await discard(dir)
      return { ...result, path: null }
    }

    const produced = await newestVideo(path.join(dir, 'media'))
    if (!produced) {
      await discard(dir)
      return { ...result, path: null, error: 'Manim finished but produced no video.' }
    }

    await keepArtefact(produced, target)
    await discard(dir)
    return { ...result, path: rel(target) }
  }

  finish()
    .catch((err) => ({ code: null, ms: 0, error: err.message, path: null }))
    .then((result) => toRun('run:done', { id, ...result }))

  return { id, scene: name, quality }
})

/* ---------------------------------------------------------------- tikz
   A ```tikz block is a picture, and what a picture is *for* is the drawing —
   so it renders to a real file in the vault and both views show that instead
   of the source. The same bargain manim strikes above, with the same caching:
   the file is named after a hash of the code, so a rendered block opens with
   its drawing already there and an edited one asks for a name nothing has
   written yet.

   Cheaper than a scene — a second or two rather than minutes — but far too slow
   to redraw on every keystroke the way mermaid does, and it needs a TeX
   installation, which is exactly why the result is kept. */

const TIKZ_TIMEOUT_MS = 90 * 1000

const tikzTarget = (noteName, code) => artefactTarget(noteName, 'tikz', code, 'svg')

/* Commands LaTeX will only accept before \begin{document}. A block is written
   as a picture, not as a document, so anything of this kind found in one is
   meant for the preamble the block never sees — and is lifted into it below.
   \usetikzlibrary and friends are legal in both places, but they are listed
   here anyway so that a block's libraries load in the order it wrote them,
   alongside the packages they may belong to. */
const PREAMBLE_ONLY =
  /^\s*\\(usepackage|RequirePackage|usetikzlibrary|usepgflibrary|usepgfplotslibrary|pgfplotsset)\b/

/**
 * Splits a block into the lines that belong in the preamble and the lines that
 * are the drawing, keeping the order within each.
 *
 * Line-based on purpose: `\usepackage[options]{name}` is written on one line by
 * everyone, and a scanner that balanced braces across lines would have to
 * understand comments and verbatim to be right rather than nearly right.
 */
function liftPreamble (code) {
  const head = []
  const body = []
  for (const line of code.split('\n')) {
    (PREAMBLE_ONLY.test(line) ? head : body).push(line)
  }
  return { head, body }
}

/**
 * The block, as a document LaTeX will accept.
 *
 * A block that brings its own \documentclass is left alone — someone doing that
 * has a reason. Everything else is a picture, and gets the standard wrapper for
 * one: `standalone` crops the page to the drawing, and pgf is pointed at its
 * dvisvgm backend before TikZ loads, which is what makes the DVI convertible.
 * A handful of the most-used libraries come along.
 *
 * Anything the block asks for arrives *after* those, so `\usepackage{pgfplots}`
 * in a block behaves as it would at the top of a real document: the block can
 * load whatever the TeX installation has, and can configure it, without having
 * to write out a whole document to do it.
 */
function tikzDocument (code) {
  if (/\\documentclass/.test(code)) return code
  const { head, body } = liftPreamble(code)
  return [
    '\\documentclass[border=4pt]{standalone}',
    '\\def\\pgfsysdriver{pgfsys-dvisvgm.def}',
    '\\usepackage{tikz}',
    '\\usetikzlibrary{arrows.meta,positioning,calc,shapes,patterns,decorations.pathreplacing}',
    ...head,
    '\\begin{document}',
    ...body,
    '\\end{document}'
  ].join('\n')
}

/** The two commands a drawing goes through, either as configured or as found. */
function tikzCommands () {
  const configured = readConfig().tikzCommand
  const latex = configured ? String(configured).split(/\s+/) : ['latex']
  return { latex, dvisvgm: ['dvisvgm'] }
}

/**
 * TeX with the doors that can be shut, shut.
 *
 * A picture draws itself when the note is read, which means TeX runs on
 * whatever a note contains before anyone has looked at it — and a note is not
 * always something the reader wrote. Vaults are synced, shared, cloned from a
 * repository, handed over as a folder of somebody's lecture notes. TeX is a
 * full macro language with file and process access, so opening a note was
 * enough to run a command outright on the many installations where
 * `shell_escape` is enabled in `texmf.cnf`.
 *
 * `shell_escape=f`, with `-no-shell-escape` on the command line beside it,
 * closes that: `\write18` is refused, and the flag also overrides a
 * `-shell-escape` that a configured `tikzCommand` carries. Both were tested
 * against a block that tries it; neither lets it through.
 *
 * `openin_any`/`openout_any` are set for the installations that honour them,
 * but they are **not** load-bearing and must not be relied on: measured
 * against MacTeX's `latex`, `openin_any=p` did not prevent `\openin` from
 * reading an absolute path, or a path inside a dot-directory — all three of
 * `a`, `r` and `p` behaved identically. kpathsea reports the value correctly
 * (`kpsewhich --var-value=openin_any` answers `p`), so the setting arrives and
 * the engine simply does not enforce it for reads.
 *
 * What guards reading is therefore in the renderer, not here: a block that
 * asks to open files is not drawn on sight — see `READS_FILES` in src/tikz.js.
 * Pressing Draw still runs it, because at that point a person has asked.
 */
const TEX_SANDBOX_ENV = { openin_any: 'p', openout_any: 'p', shell_escape: 'f' }

/* LaTeX says what went wrong in the middle of a great deal of noise. The lines
   worth showing are the error itself and the line of the document it stopped
   on, which is what a reader needs to find it in the block. */
function texTrouble (log) {
  const lines = log.split('\n')
  const kept = []
  for (let i = 0; i < lines.length && kept.length < 12; i++) {
    if (!/^(!|l\.\d+|<recently read>)/.test(lines[i])) continue
    kept.push(lines[i].trimEnd())
  }
  return kept.join('\n')
}

ipcMain.handle('tikz:lookup', async (_e, noteName, code) => {
  const found = await artefactAt(await tikzTarget(noteName, code))
  return found ? { path: found } : null
})

ipcMain.handle('tikz:render', async (event, noteName, code) => {
  if (!vaultPath) throw new Error('Open a vault first — the drawing is saved into it.')
  if (typeof code !== 'string' || !code.trim()) throw new Error('Nothing to draw.')

  const target = await tikzTarget(noteName, code)
  const id = ownRun(++nextRunId, event)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-tikz-'))
  const timeoutMs = runTimeoutMs('tikzTimeout', TIKZ_TIMEOUT_MS)

  queueMicrotask(() => toRun('run:out', { id, stream: 'stdout', text: 'Drawing…\n' }))

  const finish = async () => {
    await ensureLoginPath()
    await fs.writeFile(path.join(dir, 'figure.tex'), tikzDocument(code), 'utf8')
    const { latex, dvisvgm } = tikzCommands()

    /* Two commands, one run: TeX turns the block into a DVI and dvisvgm turns
       the DVI into the picture. They share an id so that Stop stops whichever
       is going, and so the page sees one piece of work rather than two. */
    const typeset = await startRun(
      id, latex[0],
      [...latex.slice(1), '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'figure.tex'],
      { cwd: dir, timeoutMs, env: TEX_SANDBOX_ENV }
    )
    if (typeset.error || typeset.code !== 0) {
      const log = await fs.readFile(path.join(dir, 'figure.log'), 'utf8').catch(() => '')
      await discard(dir)
      cancelled.delete(id)
      return { ...typeset, path: null, error: typeset.error || texTrouble(log) || null }
    }

    const convert = await startRun(
      id, dvisvgm[0],
      [...dvisvgm.slice(1), '--no-fonts', '--exact-bbox', '--output=figure.svg', 'figure.dvi'],
      { cwd: dir, timeoutMs }
    )
    cancelled.delete(id)
    if (convert.error || convert.code !== 0) {
      await discard(dir)
      return { ...convert, path: null }
    }

    const produced = path.join(dir, 'figure.svg')
    if (!fsSync.existsSync(produced)) {
      await discard(dir)
      return { ...convert, path: null, error: 'TeX finished but produced no drawing.' }
    }

    await keepArtefact(produced, target)
    await discard(dir)
    return { ...convert, path: rel(target) }
  }

  finish()
    .catch((err) => ({ code: null, ms: 0, error: err.message, path: null }))
    .then((result) => toRun('run:done', { id, ...result }))

  return { id }
})

/* --------------------------------------------------------- the copilot */

/* The copilot is a subprocess, not a service — see electron/ai.js. It is
   handed the vault and the login PATH and otherwise left to itself; everything
   it says arrives on one channel. */
/* Prose arrives a token at a time. One IPC message per token is far more
   traffic than a window repainting sixty times a second can use, so runs of
   deltas are joined and sent on a short timer. Anything that is not prose
   flushes what is held first, so nothing is ever reordered around it.

   Held per turn rather than in one string: two conversations can be answered at
   once now, and a single buffer would have interleaved their prose into
   whichever turn happened to flush it. */
const aiText = new Map()   // turn id -> the prose held for it
let aiTimer = null

/* What each turn was seen to touch, and which turns ran alongside another.

   A turn's review card is built by diffing the vault against the copy taken
   before it started, which says exactly what changed and nothing about who
   changed it. With one copilot that was the same question. With one per
   conversation it is not: a turn about `Notes.md` finishing while another is
   still editing `main.cpp` would list — and offer to Reject — the other's work.

   So a turn that shared the app with another is narrowed to the files its own
   tool calls named. That is a smaller claim than the diff: a file rewritten by
   a shell command the agent ran is not among them, and goes unreviewed rather
   than being attributed to whichever turn happened to end first. A turn that
   ran alone keeps the whole diff, which is every turn in ordinary use. */
const aiTouched = new Map()   // turn id -> Set of vault paths its tools named
const aiOverlapped = new Set()   // turns that were not the only one running

function aiTurnTouched (event) {
  const id = turnId(event?.turnId)
  if (!id) return
  for (const value of [event?.path, event?.from]) {
    const seen = String(value || '')
    if (!seen) continue
    if (!aiTouched.has(id)) aiTouched.set(id, new Set())
    aiTouched.get(id).add(seen)
  }
}

function forgetAiTurn (id) {
  aiTouched.delete(id)
  aiOverlapped.delete(id)
}

const aiTurns = new TurnLedger({
  snapshot: snapshotNotes,
  complete: (before, after, id) => {
    const all = changedNotes(before, after)
    const mine = aiTouched.get(id)
    const changes = aiOverlapped.has(id)
      ? all.filter((change) => mine?.has(change.path))
      : all
    forgetAiTurn(id)
    return trust?.record({ source: 'copilot', changes }) || null
  }
})
const aiReviewsSent = new Set()
let aiRenameWork = Promise.resolve()

/** Consume the provider-neutral rename request written by Copilot. */
async function consumeAiRename (event) {
  let requestFile
  try {
    requestFile = await realSafePath(AI_RENAME_REQUEST)
    const request = parseAiRenameRequest(await fs.readFile(requestFile, 'utf8'))
    const source = await realSafeTargetPath(request.path)
    const stat = await fs.stat(source)
    if (!stat.isFile() || !(MD_EXT.has(path.extname(source).toLowerCase()) ||
        isTex(source) || isPdf(source) || isSite(source) || isWhiteboard(source) ||
        isNotebook(source))) {
      throw new Error('Copilot can rename Tulip documents, not folders or app state.')
    }
    const result = await renameDocument(request.path, request.name)
    toCopilot('ai:event', {
      k: 'renamed', id: event.id, name: 'Rename', from: request.path,
      ...result, turnId: event.turnId
    })
  } catch (err) {
    toCopilot('ai:event', {
      k: 'rename-failed',
      message: err?.message || 'The Copilot rename could not be completed.',
      turnId: event.turnId
    })
  } finally {
    if (requestFile) {
      noteSelfWrite(requestFile)
      await fs.unlink(requestFile).catch(() => {})
    }
  }
}

/**
 * Consume the provider-neutral search request written by Copilot: run the
 * vault search the overlay runs, and leave the answer where the agent's own
 * file tool can read it. The request is deleted either way — a request that
 * failed must not run again on the next watcher pass.
 */
async function consumeAiSearch () {
  let requestFile
  const resultsFile = await realSafePath(AI_SEARCH_RESULTS).catch(() => null)
  try {
    requestFile = await realSafePath(AI_SEARCH_REQUEST)
    const request = parseAiSearchRequest(await fs.readFile(requestFile, 'utf8'))
    const found = await searchVault(request.query, request.opts)
    /* Bounded for the reader it has: an agent wants the map, not the vault
       over again. Forty notes, four places each, lines clipped. */
    const body = {
      query: request.query,
      truncated: !!found.truncated || (found.results?.length || 0) > 40,
      unsearched: found.unsearched || 0,
      error: found.error,
      results: (found.results || []).slice(0, 40).map((one) => ({
        path: one.path,
        kind: one.kind,
        hits: (one.hits || []).slice(0, 4).map((hit) => ({
          line: hit.line,
          page: hit.page,
          text: String(hit.text || '').slice(0, 200)
        })),
        total: one.total
      }))
    }
    if (resultsFile) {
      noteSelfWrite(resultsFile)
      await fs.writeFile(resultsFile, JSON.stringify(body, null, 1), 'utf8')
      noteSelfWrite(resultsFile)
    }
  } catch (err) {
    if (resultsFile) {
      noteSelfWrite(resultsFile)
      await fs.writeFile(resultsFile, JSON.stringify({
        error: err?.message || 'The Copilot search could not be completed.'
      }, null, 1), 'utf8').catch(() => {})
      noteSelfWrite(resultsFile)
    }
  } finally {
    if (requestFile) {
      noteSelfWrite(requestFile)
      await fs.unlink(requestFile).catch(() => {})
    }
  }
}

function sendAiReview (id, operation) {
  if (!operation || aiReviewsSent.has(id)) return
  aiReviewsSent.add(id)
  toCopilot('ai:event', { k: 'review', operation, turnId: id })
  /* Duplicate terminal signals are intentionally coalesced, but the ids only
     need to outlive their queued IPC events. Do not retain every turn for the
     lifetime of a long-running app. */
  setTimeout(() => aiReviewsSent.delete(id), 60000).unref?.()
}

/**
 * The after-snapshot of a turn, and the review built out of the difference.
 *
 * The caches are dropped first on purpose: an agent writes through its own
 * tools, so the only thing that knows those files moved is the watcher, and its
 * quiet window may not have elapsed. Forcing the walk is what makes a review
 * card appear for a write that landed a moment ago — which is also why it is
 * not worth doing for a turn that has no baseline to compare against. A stop
 * pressed with nothing running, or a read-only turn that never took one, used
 * to cost a full recursive walk of the vault apiece.
 */
async function finishAiHistory (id) {
  if (!turnId(id) || !aiTurns.has(id)) return null
  indexDirty = true
  invalidateVaultSnapshot()
  return aiTurns.finish(id)
}

function flushAiText () {
  clearTimeout(aiTimer)
  aiTimer = null
  if (!aiText.size) return
  /* All of them, on any flush. Each turn's prose is in the order it arrived and
     goes out as one message; what must never happen is a turn's own text
     crossing its own tool call, and every non-prose event flushes everything
     before it goes. */
  const held = [...aiText]
  aiText.clear()
  for (const [id, text] of held) {
    if (text) toCopilot('ai:event', { k: 'text', text, turnId: id })
  }
}

function aiService () {
  if (aiInstance) return aiInstance
  const service = require('./ai')
  aiInstance = service
  service.attach(
    (event) => {
    /* The hidden request is an implementation detail, not a note the reader
       edited. Suppress its tool/draft rows; once its Write succeeds, replace
       them with the real Tulip rename operation. */
    if (isAiRenameRequest(event?.path)) {
      if (event?.k === 'edited') {
        aiRenameWork = aiRenameWork.then(() => consumeAiRename(event)).catch(() => {})
      } else if (event?.k === 'tool-done' && event.error) {
        toCopilot('ai:event', {
          k: 'rename-failed', message: 'The Copilot could not write its rename request.',
          turnId: event.turnId
        })
      }
      return
    }
    /* The search request rides the same seam: the agent's Write of the hidden
       file is consumed rather than shown, serialized on the same chain as the
       renames so two requests never race each other. */
    if (isAiSearchRequest(event?.path)) {
      if (event?.k === 'edited') {
        aiRenameWork = aiRenameWork.then(() => consumeAiSearch()).catch(() => {})
      }
      return
    }
    if (event?.k === 'text') {
      const id = turnId(event.turnId)
      aiText.set(id, (aiText.get(id) || '') + (event.text || ''))
      if (!aiTimer) aiTimer = setTimeout(flushAiText, 32)
      return
    }
    flushAiText()
    aiTurnTouched(event)
    if (event?.k === 'turn-end' || event?.k === 'error') {
      const id = turnId(event.turnId)
      /* The turn is over, so its search answers are litter: swept on the same
         chain the searches run on, so a request still being answered is not
         raced by its own cleanup — and the next turn cannot read a stale
         answer as a fresh one. */
      aiRenameWork
        .then(() => realSafePath(AI_SEARCH_RESULTS))
        .then((file) => { noteSelfWrite(file); return fs.unlink(file) })
        .catch(() => {})
      /* A provider reports its Write before the request has crossed main's
         rename path. Wait for that small operation or the after-snapshot can
         race it and produce no review card. */
      aiRenameWork.then(() => finishAiHistory(id))
        .then((operation) => {
          sendAiReview(id, operation)
          toCopilot('ai:event', event)
        })
        .catch(() => toCopilot('ai:event', event))
        /* Whatever the turn touched is only of interest while there is a review
           to build out of it. A read-only turn never reaches `complete`, where
           this is otherwise dropped, and a vault read all afternoon would keep
           every path it ever looked at. */
        .finally(() => forgetAiTurn(id))
      return
    }
    toCopilot('ai:event', event)
    },
    () => runnerPath(),
    /* Beside the app's other state rather than in the vault: what models a CLI
       offers is an account property, not something about these notes. */
    path.join(app.getPath('userData'), 'ai-catalogue.json')
  )
  return service
}

ipcMain.handle('ai:start', async (event, opts) => {
  assertCopilotWindow(event)
  const ai = aiService()
  ai.setVault(vaultPath)
  const id = turnId(opts?.turnId)
  if (!id) return { ok: false, error: 'The Copilot turn could not be identified.' }
  /* Which conversation's copilot this is. Sessions are per chat, so the key is
     part of every call that names one — see electron/ai.js. */
  // The CLI is spawned with `runnerPath()`, so the login shell has to be back
  // before it is: a Copilot started against a PATH short of the profile's is a
  // "command not found" for a tool that is installed.
  await ensureLoginPath()
  return ai.start({ ...(opts || {}), key: String(opts?.key || ''), turnId: id })
})
ipcMain.handle('ai:models', async (_e, opts) => {
  await ensureLoginPath()
  return aiService().models({ fresh: !!opts?.fresh })
})
ipcMain.handle('ai:doctor', async () => {
  await ensureLoginPath()
  return aiService().doctor()
})
ipcMain.handle('ai:send', async (event, key, text, context, requestedTurnId) => {
  assertCopilotWindow(event)
  const ai = aiService()
  ai.setVault(vaultPath)
  const chat = String(key || '')
  const id = turnId(requestedTurnId)
  if (!id) return { ok: false, error: 'The Copilot turn could not be identified.' }
  const words = String(text || '')
  const prepared = await preparePdfTurn(words, context || null, id)
  if (prepared.failures.length) {
    const names = prepared.failures.map((failure) => failure.path).join(', ')
    return { ok: false, error: `Tulip could not prepare ${names} for the copilot.` }
  }
  /* Only a turn that can write is worth a baseline. In read mode the CLI runs
     under an agent that has no editing tools at all, so the pair of snapshots a
     review is built from — two walks of the vault, and the whole of the delay
     between pressing send and the first token — could only ever produce an
     empty diff. */
  if (ai.canWrite(chat)) {
    /* Everything already running, and this turn with it: from here none of
       them can claim the whole vault diff as its own. */
    const others = aiTurns.live
    if (others.length) {
      aiOverlapped.add(id)
      for (const other of others) aiOverlapped.add(other)
    }
    await aiTurns.begin(id)
  }
  const result = await ai.send(chat, words, prepared.context, id)
  if (!result?.ok) {
    const operation = await finishAiHistory(id).catch(() => null)
    sendAiReview(id, operation)
  }
  return result
})
/**
 * A turn that finished while the reader was somewhere else.
 *
 * The panel decides whether the turn was long enough to be worth interrupting
 * for; this decides whether there is anybody to interrupt. Both tests are
 * needed and neither can be made where the other is: the renderer knows how
 * long the turn ran, and only main can say whether the window has come back to
 * the front in the moment since the event was sent.
 */
/* The before-copy the renderer's live diff is built against — served from the
   turn's own baseline so the editor's review and the turn-end card cannot
   disagree about what "before" was. See rememberAgentBefore in renderer.js. */
ipcMain.handle('ai:baseline', (_e, turn, relPath) =>
  aiTurns.baseline(turn, String(relPath || '')))

ipcMain.handle('ai:announce', (_e, info) => {
  const win = copilotWindow()
  if (!win || win.isFocused()) return { ok: false }
  if (!Notification.isSupported()) return { ok: false }

  const where = info?.note ? ` about ${info.note}` : ''
  const notice = new Notification({
    title: info?.trouble ? 'The copilot stopped' : 'The copilot has replied',
    // What went wrong is the whole of what the banner has to say; a reply that
    // landed is not quoted, because it is on screen a click away.
    body: String(info?.trouble || `Your answer${where} is waiting.`).slice(0, 200)
  })
  // The banner is gone in a few seconds; the dock goes on saying so until the
  // window is looked at, which is the half of this that survives a coffee.
  notice.on('click', () => {
    if (!win.isDestroyed()) { win.show(); win.focus() }
  })
  notice.show()
  app.dock?.bounce?.('informational')
  return { ok: true }
})

ipcMain.handle('ai:stop', async (event, key, requestedTurnId) => {
  assertCopilotWindow(event)
  const id = turnId(requestedTurnId)
  /* One conversation's copilot, not every one of them: the other notes' turns
     are somebody else's work and go on running. */
  const stopped = aiInstance?.stop(String(key || '')).ok || false
  const operation = await finishAiHistory(id).catch(() => null)
  sendAiReview(id, operation)
  return stopped
})

/* ------------------------------------------------------- note history */

ipcMain.handle('trust:list', () => trust?.list() || [])
ipcMain.handle('trust:operation', (_e, id) => trust?.operation(String(id)) || null)
ipcMain.handle('trust:restore', async (_e, id, onlyPath = null) => {
  const operation = trust?.operation(String(id))
  if (!operation) throw new Error('That history entry is no longer available.')
  const selected = operation.changes.filter((change) =>
    !onlyPath || change.path === String(onlyPath)
  )
  if (!selected.length) throw new Error('That file is not in this history entry.')

  /* Preflight every target before changing any of them. Reject is safe while
     the files still equal what Copilot left behind; after a user or sync edit,
     writing the older snapshots back would erase that newer work. All-or-none
     also avoids half-rejecting a multi-file turn before discovering a conflict
     in the last file. */
  const currentByPath = new Map()
  for (const change of selected) {
    const abs = safeTargetPath(change.path)
    await assertReal(abs)
    try {
      currentByPath.set(change.path, await fs.readFile(abs, 'utf8'))
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
      currentByPath.set(change.path, null)
    }
  }
  const conflicts = restoreConflicts({ ...operation, changes: selected }, currentByPath)
  if (conflicts.length) {
    const names = conflicts.slice(0, 3).join(', ')
    const more = conflicts.length > 3 ? ` and ${conflicts.length - 3} more` : ''
    throw new Error(`Could not reject this turn because ${names}${more} changed afterwards. Your newer edits were left untouched.`)
  }

  const inverse = []
  for (const change of selected) {
    /* Both halves of the guard: a recorded change is never the vault itself,
       and restoring one writes content through the last component. */
    const abs = safeTargetPath(change.path)
    await assertReal(abs)
    const current = currentByPath.get(change.path)
    inverse.push({ path: change.path, before: current, after: change.before })
    if (change.before == null) {
      if (fsSync.existsSync(abs)) {
        noteSelfWrite(abs)
        await shell.trashItem(abs)
      }
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await writeAtomic(abs, change.before)
    }
  }
  indexDirty = true
  invalidateVaultSnapshot()
  await ensureIndex()
  trust.record({ source: 'restore', changes: inverse })
  // Named, like the watcher's own message: these are the files a restore put
  // back, and the renderer decides what that means for the buffer it is holding.
  broadcast('vault:changed', { paths: selected.map((change) => change.path) })
  return { restored: selected.map((change) => change.path) }
})

/* Conversations are kept beside the app's other state rather than in the
   vault: a chat about a note is not part of the note, and a vault synced
   between machines should not carry transcripts around with it. One file per
   vault, named by digest so two vaults with the same folder name stay apart. */
const CHAT_DIR = () => path.join(app.getPath('userData'), 'chats')
const chatFile = () => path.join(CHAT_DIR(), `${sha1(vaultPath || '')}.json`)

/* What the file holds, read once per vault and kept — the same arrangement
   electron/path-store.js uses for its sidecars, and sound for the same reason:
   this process is the only writer, and the one window allowed to hold the panel
   is the only asker.

   Read once matters here. The panel flushes on an 800ms debounce for the length
   of a turn, and the save below re-read and re-parsed the whole file — sixty
   transcripts — synchronously each time, on the event loop that is at that
   moment relaying the turn's own output. Keyed by the file, so switching vaults
   reads the new one rather than merging into the old one's transcripts. */
let chatCache = null
let chatCacheFile = ''

function chatHistoryNow () {
  const file = chatFile()
  if (chatCache && chatCacheFile === file) return chatCache
  let parsed = {}
  try {
    parsed = JSON.parse(fsSync.readFileSync(file, 'utf8')) || {}
  } catch {
    /* No history for this vault yet — the ordinary first-run case — or a file
       `ai:history:load` has already moved aside. */
    parsed = {}
  }
  chatCache = parsed && typeof parsed === 'object' ? parsed : {}
  chatCacheFile = file
  return chatCache
}

ipcMain.handle('ai:history:load', (event) => {
  /* The same fence as `ai:start` and the save half below: transcripts belong
     to the one window allowed to hold the panel, and a window that cannot
     write them has no business reading them either. */
  assertCopilotWindow(event)
  if (!vaultPath) return {}
  const file = chatFile()
  let raw
  try {
    raw = fsSync.readFileSync(file, 'utf8')
  } catch {
    // No history for this vault yet, which is the ordinary first-run case.
    chatCache = {}
    chatCacheFile = file
    return {}
  }
  try {
    const parsed = JSON.parse(raw) || {}
    chatCache = typeof parsed === 'object' ? parsed : {}
    chatCacheFile = file
    return parsed
  } catch (err) {
    /* The file exists and will not parse — truncated by a power cut, or half
       written by a kill. Returning `{}` here used to be the whole story, and
       the next flush then wrote an empty history straight over it: one bad
       byte cost the vault every conversation it had, unrecoverably. The
       damaged file is moved aside instead, so the transcripts are still on
       disk for anyone who wants to pick them out by hand. */
    console.error('chat history unreadable', err)
    try {
      fsSync.renameSync(file, `${file}.corrupt`)
    } catch { /* if it cannot be moved, it will simply be overwritten */ }
    chatCache = {}
    chatCacheFile = file
    return {}
  }
})

ipcMain.handle('ai:history:save', async (event, history) => {
  assertCopilotWindow(event)
  if (!vaultPath) return { ok: false }
  try {
    await fs.mkdir(CHAT_DIR(), { recursive: true })
    const file = chatFile()
    history = mergeChatHistory(chatHistoryNow(), history)
    /* Not fsync'd. The last write of a transcript is the one the window makes
       on its way out, and waiting on the disk there is both the slowest place
       to do it and the likeliest to be cut short — which is what left hundreds
       of half-renamed temp files beside the history. The rename still keeps the
       file whole; only the guarantee about a power cut is given up, over a
       chat log that is already on screen. */
    await writeAtomic(file, JSON.stringify(history), { durable: false })
    /* Held only once it is down. A write that failed leaves the cache
       describing the file that is actually there, so the retry the renderer
       makes merges against the truth rather than against what this attempt
       hoped to write. */
    chatCache = history
    chatCacheFile = file
    return { ok: true }
  } catch (err) {
    console.error('chat history write failed', err)
    /* Thrown rather than reported in the return value. The renderer's recovery
       — put the unsaved flag back up so the next flush tries again, and tell
       the reader — hangs off a rejected promise, and a resolved `{ok: false}`
       never reached it: a full disk silently dropped the session's history and
       the only trace was this console line. */
    throw new Error(err.message || 'the history could not be written')
  }
})

/* -------------------------------------------------------- review state

   The scheduler's side of the study surface. Everything about *when* a card
   comes back is decided in src/srs.js, in the renderer; this only keeps the
   answers. See electron/review-store.js for why it lives in the vault and for
   the wipe that `prune`'s guard exists to prevent.
   ================================================================== */

ipcMain.handle('review:all', async () => {
  if (!vaultPath) return {}
  return review.all()
})

ipcMain.handle('review:record', async (_e, entries) => {
  if (!vaultPath) return { ok: false }
  return review.record(entries)
})

/* A deck to import, picked and read but deliberately not parsed: the CSV
   dialect logic lives in the renderer (src/csv.js) beside the table the rows
   are joining. */
ipcMain.handle('review:pick-csv', async () => {
  if (!vaultPath) throw new Error('Open a vault first.')
  const picked = await dialog.showOpenDialog(focusedWindow(), {
    title: 'Import cards',
    properties: ['openFile'],
    buttonLabel: 'Import',
    filters: [{ name: 'Comma or tab separated', extensions: ['csv', 'tsv', 'txt'] }]
  })
  if (picked.canceled || !picked.filePaths[0]) return null
  const source = picked.filePaths[0]
  const stat = await fs.lstat(source)
  if (!stat.isFile()) throw new Error('That is not a file.')
  if (stat.size > 8 * 1024 * 1024) throw new Error('That file is too large to be a deck.')
  return { name: path.basename(source), text: await fs.readFile(source, 'utf8') }
})

ipcMain.handle('review:unrecord', async (_e, entry) => {
  if (!vaultPath) return { ok: false }
  return review.unrecord(entry)
})

ipcMain.handle('review:prune', async (_e, knownIds) => {
  if (!vaultPath) return { pruned: 0, refused: false }
  return review.prune(knownIds)
})

ipcMain.handle('review:history', async () => {
  if (!vaultPath) return []
  return review.history()
})

/* The dates shown when a language row is focused or hovered. Synchronisation
   happens on file read/write; this call returns no Markdown, only the metadata
   already associated with the note's visible rows. */
ipcMain.handle('language-history:rows', async (_e, notePath) => {
  if (!vaultPath || !isLanguageTable(notePath)) return []
  return languageHistory.rows(notePath)
})

/* ------------------------------------------------------- language decks

   Every vocabulary table in the vault, and the two ways a word gets into one.

   The decks are what makes "review everything due" mean anything: before this,
   a study session could only be built from the note that happened to be on
   screen, so a daily review was a thing you first had to navigate to. The index
   is already holding every note's text, so answering costs a filter rather than
   a walk of the disk.
   ================================================================== */

ipcMain.handle('language:decks', async () => {
  if (!vaultPath) return []
  await ensureIndex()
  const out = []
  for (const [key, entry] of index) {
    if (!isLanguageTable(key)) continue
    out.push({
      path: key,
      name: entry.name,
      // The folder is where the flag and the language's name are, which is what
      // decides the voice; see src/speech.js.
      folder: path.dirname(key),
      text: entry.text
    })
  }
  return out
})

/* ------------------------------------------------------------- drafts

   What was typed but not yet saved, kept somewhere a crash cannot take with it.

   The autosave is quick — 600 ms by default — but "quick" is not "always", and
   the gap is real: a renderer crash, a GPU process kill, a force quit, a power
   cut all land on a note whose last few seconds exist only in the editor's
   memory. Nothing on disk records them, so nothing can offer them back.

   A draft is that record. It is written on its own timer, beside the app's
   state rather than in the vault — an unfinished paragraph is not something to
   sync to other machines, and a stray file next to the note would be picked up
   by the tree, the index and the backlink scan as though it were one. It is
   removed the moment the real save succeeds, so the ordinary state of this
   folder is empty and anything in it at launch is by definition a note whose
   edits never reached disk.
   ================================================================== */

const DRAFT_DIR = () => path.join(app.getPath('userData'), 'drafts', sha1(vaultPath || ''))
const draftFile = (rel) => path.join(DRAFT_DIR(), `${sha1(rel)}.json`)

ipcMain.handle('draft:save', async (_e, rel, text) => {
  if (!vaultPath || typeof rel !== 'string' || typeof text !== 'string') return { ok: false }
  try {
    await fs.mkdir(DRAFT_DIR(), { recursive: true })
    /* Not durable, and deliberately so: this races the very crash it exists
       for, and an fsync per keystroke-pause would cost more than it buys. The
       rename still makes each draft whole-or-absent, which is the guarantee
       that matters — a half-written draft offered back as recovery would be
       worse than none. */
    await writeAtomic(draftFile(rel), JSON.stringify({ path: rel, text, at: Date.now() }), { durable: false })
    return { ok: true }
  } catch (err) {
    console.error('draft write failed', err)
    return { ok: false }
  }
})

ipcMain.handle('draft:clear', async (_e, rel) => {
  if (!vaultPath || typeof rel !== 'string') return { ok: false }
  await fs.unlink(draftFile(rel)).catch(() => {})
  return { ok: true }
})

/**
 * Every draft this vault has, with the file's current text beside it.
 *
 * The comparison is made here rather than in the renderer because it is the
 * whole question: a draft that matches the note on disk is one whose save did
 * land, and offering it back would be asking about nothing. Those are dropped
 * — and deleted — so the renderer only ever hears about real losses.
 */
ipcMain.handle('draft:list', async () => {
  if (!vaultPath) return []
  let names
  try { names = await fs.readdir(DRAFT_DIR()) } catch { return [] }

  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(DRAFT_DIR(), name)
    let draft
    try { draft = JSON.parse(await fs.readFile(file, 'utf8')) } catch { draft = null }
    if (!draft || typeof draft.path !== 'string' || typeof draft.text !== 'string') {
      await fs.unlink(file).catch(() => {})
      continue
    }
    /* The note may have been renamed, deleted or moved out of the vault since.
       `safePath` throws on anything that is not inside it, which is also the
       check that keeps a hand-edited draft from naming a file elsewhere. */
    let disk = null
    try { disk = await fs.readFile(safePath(draft.path), 'utf8') } catch { disk = null }
    if (disk === draft.text) { await fs.unlink(file).catch(() => {}); continue }
    out.push({ path: draft.path, text: draft.text, at: draft.at || 0, disk })
  }
  return out
})

/**
 * Temp files no rename ever claimed.
 *
 * `writeAtomic` cleans up after itself, but it cannot clean up after being
 * killed — and the write most likely to be killed is the one a closing window
 * starts. Anything left over is dead by definition: the name carries the pid
 * and a serial that is never reused, so nothing will come back for it.
 *
 * Three places make them, so all three are swept: the chat directory, the vault
 * itself — `writeAtomic` writes beside the note, so a force-quit during a
 * replace-all across three hundred notes leaves three hundred dotted files in
 * the user's own folders — and the trust store, which renames through
 * `<file>.<pid>.tmp` of its own.
 */
const TEMP_SUFFIX = '.tulip-tmp'
const STALE_TEMP_MS = 60000

async function sweepTemporaryFiles (dir, { suffix = TEMP_SUFFIX, recursive = false } = {}) {
  const names = await fs.readdir(dir, { recursive }).catch(() => [])
  await Promise.all(names
    .filter((name) => name.endsWith(suffix))
    .map(async (name) => {
      const abs = path.join(dir, name)
      /* A write still in flight is not litter. The pid in the name says which
         process started it but not whether that process is still alive, and an
         age answers the question that matters: nothing legitimate sits between
         write and rename for a minute. */
      const stat = await fs.stat(abs).catch(() => null)
      if (!stat || Date.now() - stat.mtimeMs < STALE_TEMP_MS) return
      await fs.unlink(abs).catch(() => {})
    }))
}

ipcMain.handle('zoom:reset', () => applyZoom(DEFAULT_ZOOM))
/* Settings can set it outright rather than nudging: the panel shows the stops
   as a stepper, and it is applyZoom that decides what is in range. */
ipcMain.handle('zoom:set', (_e, factor) => applyZoom(Number(factor) || 1))
ipcMain.handle('zoom:claim', (event, on) => {
  const key = event.sender.id
  if (on) documentZoomClaims.add(key)
  else documentZoomClaims.delete(key)
})
/* The browser's own undo, for the plain text fields — the message box, the
   rename field, a search query. What the `undo` role used to do, asked for
   only when the renderer has decided this is the field's history to walk and
   not the note's or the PDF's. */
ipcMain.handle('edit:undo', (e) => e.sender.undo())
ipcMain.handle('edit:redo', (e) => e.sender.redo())

ipcMain.handle('config:get', () => readConfig())
ipcMain.handle('hotkeys:list', () => hotkeyCatalogue)

ipcMain.handle('config:set', (_e, patch) => {
  /* Not every config key is a preference — see electron/config-keys.js. The
     renderer writes the settable ones; main keeps `vaultPath` and the command
     strings to itself. */
  const { accepted, rejected } = sanitizeConfigPatch(patch)
  if (rejected.length) {
    console.warn(`config:set refused ${rejected.join(', ')} — not settable from the renderer`)
  }
  const next = writeConfig(accepted)
  /* The two settings that move something on disk rather than repaint it.
     Setting them lands nowhere unless the thing that reads them is told. */
  if (Object.prototype.hasOwnProperty.call(accepted, 'historyInVault') && vaultPath) {
    trust?.setVault(vaultPath, next.historyInVault === true)
  }
  // The menu is the thing a hotkey lives in, so a change means a rebuild —
  // cheap, and the only way an accelerator ever moves.
  if (Object.prototype.hasOwnProperty.call(accepted, 'hotkeys')) buildMenu()
  /* A language turned on or off is a different dictionary, which is the same
     event as a word taught or removed: the checker is rebuilt on the next
     question and every held verdict is stale. */
  if (Object.prototype.hasOwnProperty.call(accepted, 'spellLanguages')) {
    speller = null
    forgetSpellVerdicts()
    broadcast('dictionary:changed')
  }
  return next
})

ipcMain.handle('durability:flush', () => flushPendingDurability())

/* ----------------------------------------------------------- lifecycle */

/* Electron's user agent carries `Electron/43` in the middle of an otherwise
   ordinary Chrome string, and Google's hosts treat that as not-a-browser. The
   version string is tidied for these hosts and nothing else is touched, which
   is what lets the thumbnail on a YouTube card load at all — and, in the
   player's own session, the watch page itself.

   What is deliberately *not* here: a forged `Referer`, and a forged cookie
   recording an answer to YouTube's consent banner. Both were tried while
   chasing an inline player, both are lies told to a server on the reader's
   behalf, and neither worked. The player asks the reader instead — see the
   account in src/assets.js. */
const GOOGLE_HOSTS = [
  'https://*.ytimg.com/*',
  'https://*.youtube.com/*',
  'https://*.googlevideo.com/*',
  'https://*.google.com/*'
]

function normaliseGoogleUserAgent (target = session.defaultSession) {
  const ua = app.userAgentFallback.replace(/ (Electron|Tulip)\/[\d.]+/g, '')
  target.webRequest.onBeforeSendHeaders({ urls: GOOGLE_HOSTS }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'User-Agent': ua } })
  })
}

/* Guests in notes: the YouTube player and embedded web pages. Each kind
   keeps a persistent session of its own — named identically in src/assets.js,
   which is what puts a guest in one — so whatever a site stores stays in a
   box a reader can reason about, touching nothing of Tulip's. */
const YOUTUBE_PARTITION = WEB_PARTITIONS.youtube
const WEB_PARTITION = WEB_PARTITIONS.web
const HTML_RUN_PARTITION = WEB_PARTITIONS.htmlrun

/**
 * What a <webview> in a note is allowed to be.
 *
 * The tag exists for exactly three features, so the guard is drawn around them
 * rather than around webviews in general. A guest in the youtube partition may
 * load YouTube and nothing else; one in the web partition may load any http(s)
 * page — that is the feature — but never a local scheme, which is what keeps a
 * hostile note from framing the reader's own files; one in the htmlrun
 * partition is a run ```html block, and may only ever be the data:text/html
 * document the renderer wrote into it — its session is in-memory, so a preview
 * keeps no storage from one run to the next. No guest gets a preload or
 * Node, and a link to anywhere the fence does not cover goes to the reader's
 * own browser.
 *
 * A window the page opens for itself is the exception, and see the account at
 * setWindowOpenHandler for why: signing in is a popup, and a popup sent to
 * another browser signs you in there instead.
 */
const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|google\.com|ytimg\.com|googlevideo\.com|gstatic\.com)$/

/* Plain http means anyone on the same network can read the page the reader is
   reading and rewrite it on the way through, inside a window wearing Tulip's
   chrome. The one place it is still worth having is a server on this machine —
   a local preview, a notebook, a docs build — which no one else can reach and
   which nobody gives a certificate to. So: https anywhere, http on loopback. */
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i

function allowedGuestUrl (url, partition) {
  // A preview guest is exactly the document the renderer wrote into it. Never
  // http(s), and never any other local scheme either.
  if (partition === HTML_RUN_PARTITION) return /^data:text\/html[;,]/i.test(String(url || ''))
  try {
    const u = new URL(url)
    if (u.protocol === 'http:') {
      if (!LOOPBACK.test(u.hostname)) return false
    } else if (u.protocol !== 'https:') return false
    if (partition === YOUTUBE_PARTITION) return YOUTUBE_HOST.test(u.hostname)
    /* Not a fallthrough: a guest whose partition is none of the three named
       ones is not a feature this app has, and gets nothing. */
    return partition === WEB_PARTITION
  } catch {
    return false
  }
}

/**
 * The fence around a guest at the moment it is attached, which is the only
 * moment its first URL and its preferences can still be refused.
 *
 * Per window, not per app: this listener lives on a window's webContents, and
 * on macOS closing the window does not end the process — clicking the Dock
 * icon builds a new one. Registered once at startup, the fence therefore
 * belonged to a window that no longer existed, and every guest attached after
 * a Dock re-open got its preferences unexamined and its initial `src` unchecked
 * (`will-navigate` only ever sees the *second* page a guest visits). The
 * embedded PDF viewer quietly stopped working at the same time, for the same
 * reason — `plugins` is set here.
 */
function fenceWebviewAttach (win) {
  win.webContents.on('will-attach-webview', (event, prefs, params) => {
    // Nothing of Tulip's reaches into the guest.
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    // The guest's own PDF viewer, for web embeds pointing straight at one.
    if (params.partition === WEB_PARTITION) prefs.plugins = true
    if (!allowedGuestUrl(params.src, params.partition)) event.preventDefault()
  })
}

function guardGuests () {
  /* Guests carry the User-Agent of the Chrome they in fact are. Sites vary
     what they serve on the Electron token — YouTube's player among them — and
     a note's guest should get the page a browser would. */
  const ua = app.userAgentFallback.replace(/ (Electron|Tulip)\/[\d.]+/g, '')
  for (const partition of [YOUTUBE_PARTITION, WEB_PARTITION]) {
    session.fromPartition(partition).setUserAgent(ua)
  }

  /* An ```html block runs when the note is read, like a picture draws itself —
     and like a picture, the note it runs for is not always one the reader
     wrote. `allowedGuestUrl` already holds the guest to the one `data:` URL
     the renderer built, but that only governs *navigation*: a script inside
     that document was still free to `fetch` anywhere, which is enough to
     announce that a given note was opened, carry off anything readable in the
     page, and pull down a second stage to run. Nothing legitimate in a preview
     needs the network — the block is its own document, whole in the note — so
     the partition is simply not given one. Requests that never leave the page
     (`data:`, `blob:`, `about:`) are what remains, which is everything a
     self-contained preview is made of.

     With one address added to that list. A ```three block's page is built by
     Tulip rather than by the note, and it needs the three.js runtime — three
     quarters of a megabyte, which is not something to inline into a document
     URL once per block. So the guest may ask for exactly that file, from the
     app's own dist, and the handler below is the only thing on this partition
     that answers: it knows one URL and 404s everything else, so nothing here
     reaches the vault the way `tulip-file://vault/…` does for the app's own
     page. Still no network — the file comes off the disk it was installed to. */
  const guests = session.fromPartition(HTML_RUN_PARTITION)

  /* Read once and held: the runtime is three quarters of a megabyte, a note can
     hold several scenes, and the partition is not persistent — so without this
     every guest is another full read of the same file off disk. The immutable
     cache header is what keeps a second guest from reaching the handler at all;
     the copy here is what makes it cheap when it does. */
  let threeLibrary = null
  const readThreeLibrary = () => (threeLibrary ??= fs.readFile(appAsset('three.js')))

  guests.protocol.handle('tulip-file', async (request) => {
    if (request.url !== GUEST_LIBRARY.three) return new Response('Not found', { status: 404 })
    try {
      return new Response(await readThreeLibrary(), {
        headers: {
          'content-type': 'text/javascript',
          'cache-control': 'public, max-age=31536000, immutable'
        }
      })
    } catch {
      // A dist without the bundle in it: the scene says so rather than hanging.
      threeLibrary = null
      return new Response('Not found', { status: 404 })
    }
  })

  guests.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: !/^(data|blob|about):/i.test(details.url) && details.url !== GUEST_LIBRARY.three
  }))

  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return

    // Sessions are one object per partition, so identity answers which fence
    // this guest lives behind.
    const partition =
      contents.session === session.fromPartition(YOUTUBE_PARTITION) ? YOUTUBE_PARTITION
        : contents.session === session.fromPartition(HTML_RUN_PARTITION) ? HTML_RUN_PARTITION
          : WEB_PARTITION

    // Wherever the reader clicks to, it stays inside the fence or it leaves
    // the app for the browser.
    const confine = (event, url) => {
      if (allowedGuestUrl(url, partition)) return
      event.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
    contents.on('will-navigate', confine)
    contents.on('will-redirect', confine)

    /* A run block has no business opening windows. A target=_blank link goes
       to the reader's own browser and everything else is refused — the sign-in
       account below is about real sites in the other two partitions, and a
       preview popup would be a Tulip-shaped window showing whatever the block
       wrote, with none of a site's reasons to exist. */
    if (partition === HTML_RUN_PARTITION) {
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) shell.openExternal(url)
        return { action: 'deny' }
      })
      return
    }

    /* A window the page opens for itself is allowed, in the guest's own
       session. Denying it is what made "Continue with Google" do nothing: the
       popup went to the reader's own browser, the sign-in succeeded there, and
       the cookie it returned was written into that browser's jar — not into the
       partition the page in Tulip reads from. So the page asked who you were,
       got no answer, and sat where it was.
       Federated sign-in is a popup, always: the provider will not be framed,
       so window.open and postMessage back to the opener is the whole protocol.
       Allowing it is therefore the feature, not a loosening of it — the popup
       lands in the same fence as the guest, which is the one place the
       credential is any use. */
    contents.setWindowOpenHandler(({ url }) => {
      if (!allowedGuestUrl(url, partition)) {
        if (/^https?:/.test(url)) shell.openExternal(url)
        return { action: 'deny' }
      }
      return {
        action: 'allow',
        // It belongs to the page that opened it; nothing should outlast a note.
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          minimizable: false,
          fullscreenable: false,
          webPreferences: {
            // Named rather than left to inheritance: the whole point is which
            // cookie jar this writes to.
            partition,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
          }
        }
      }
    })

    /* The popup says whose page it is, and keeps saying it.
       A window with no address bar, that the page may retitle at will, is a
       phishing surface — and this one is opened by an arbitrary site and asks
       for a password. So the title is the origin, it is reset on every
       navigation, and the page is not allowed to write it. */
    contents.on('did-create-window', (win, { url }) => {
      const origin = (value) => {
        try { return new URL(value).origin } catch { return 'Sign in' }
      }

      const name = (to) => { if (!win.isDestroyed()) win.setTitle(origin(to)) }
      name(url)
      win.webContents.on('page-title-updated', (event) => event.preventDefault())
      win.webContents.on('did-navigate', (_e, to) => name(to))
      win.webContents.on('did-navigate-in-page', (_e, to) => name(to))

      // The same fence as the guest that opened it, and no third surface out
      // of this one: a popup's own popup goes to the reader's browser.
      win.webContents.on('will-navigate', (event, to) => {
        if (!/^https?:/.test(to)) event.preventDefault()
      })
      win.webContents.setWindowOpenHandler(({ url: next }) => {
        if (/^https?:/.test(next)) shell.openExternal(next)
        return { action: 'deny' }
      })
    })

    // A note cannot ask for the camera, the microphone or the reader's place.
    contents.session.setPermissionRequestHandler((_wc, permission, done) => {
      done(permission === 'fullscreen')
    })
  })
}

app.whenReady().then(async () => {
  normaliseGoogleUserAgent()
  trust = new TrustStore(app.getPath('userData'))

  // Whatever the last run was killed in the middle of. Not awaited: nothing
  // launching depends on it, and it is housekeeping either way. The vault's own
  // leftovers are swept when a vault opens, which is the first moment there is
  // one to sweep.
  sweepTemporaryFiles(CHAT_DIR()).catch(() => {})
  sweepTemporaryFiles(path.join(app.getPath('userData'), 'trust'), { suffix: '.tmp' })
    .catch(() => {})

  /**
   * The terms every vault file is served on, set in one place because there
   * are two replies — the whole file, and a range of it — and a policy written
   * twice is a policy that drifts.
   *
   * A vault file is a subresource: an image in a note, a page pdf.js asked
   * for. It is never a document. Should one end up framed or navigated to
   * anyway, `sandbox` denies it script and its own origin, so an .html file
   * that arrived in a folder someone sent you stays a file. `net.fetch`
   * guesses the type from the extension, so a guess that would make a live
   * document is corrected, and nosniff holds everything else to what it says
   * it is.
   */
  function sealVaultReply (headers, abs) {
    headers.set('accept-ranges', 'bytes')
    headers.set('access-control-allow-origin', '*')
    headers.set('content-security-policy', 'sandbox')
    headers.set('x-content-type-options', 'nosniff')
    if (isPdf(abs)) headers.set('content-type', 'application/pdf')
    const type = headers.get('content-type') || ''
    if (/html|xml/i.test(type) && !/svg/i.test(type)) headers.set('content-type', 'text/plain')
    return headers
  }

  /* Attachments are served from here rather than file://. The URL carries a
     vault-relative path and nothing else, so the same guard that governs every
     other filesystem call decides what the page is allowed to load — a note
     containing ../../.ssh/id_rsa gets a 403, not a file. */
  protocol.handle('tulip-file', async (request) => {
    const url = new URL(request.url)
    const wanted = decodeURIComponent(url.pathname).replace(/^\/+/, '')

    /* Two hosts. `vault` is the reader's own files, guarded the way every other
       filesystem call is. `app` is what ships with Tulip — the glyph data,
       character maps and wasm decoders pdf.js loads on demand — served from
       here rather than fetched directly by pdf.js's worker, which cannot fetch
       anything at all from a `file:` origin: the request neither succeeds nor
       fails, and the document renders forever. */
    let abs
    try {
      if (url.host === 'app') {
        abs = appAsset(wanted)
      } else if (url.host === 'tex-preview') {
        const root = await fs.realpath(TEX_PREVIEW_DIR())
        const candidate = path.resolve(root, wanted)
        if (candidate !== root && !candidate.startsWith(root + path.sep)) throw new Error('outside preview cache')
        abs = await fs.realpath(candidate)
        if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('outside preview cache')
      } else {
        abs = await realSafePath(wanted)
      }
    } catch {
      return new Response('Forbidden', { status: 403 })
    }

    try {
      if (url.host !== 'app') {
        const range = request.headers.get('range')
        if (!range && request.method !== 'HEAD') {
          const res = await net.fetch(pathToFileURL(abs).toString())
          const headers = sealVaultReply(new Headers(res.headers), abs)
          return new Response(res.body, { status: res.status, headers })
        }
        const stat = await fs.stat(abs)
        const size = stat.size
        let start = 0
        let end = Math.max(0, size - 1)
        const unsatisfied = () => new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${size}` }
        })

        if (range) {
          const parsed = parseByteRange(range, size)
          if (!parsed) return unsatisfied()
          ;({ start, end } = parsed)
        }

        const status = range ? 206 : 200
        const headers = sealVaultReply(new Headers({
          'content-length': String(size ? end - start + 1 : 0),
          /* The extension's own type, not a blanket octet-stream. This reply
             also carries nosniff, so a video handed back as octet-stream on the
             range request it opens with is a video the page cannot recover —
             the same file plays when it happens to be fetched whole. */
          'content-type': assetMime(abs)
        }), abs)
        if (status === 206) headers.set('content-range', `bytes ${start}-${end}/${size}`)
        if (request.method === 'HEAD' || size === 0) {
          return new Response(null, { status, headers })
        }
        /* A range may be eight megabytes and several PDFs/media elements can
           ask at once. Stream bounded chunks from the file instead of holding
           one full Buffer per request; cancelling the response closes the file
           descriptor through the Web-stream adapter. */
        return new Response(streamFileRange(abs, start, end, request.signal), { status, headers })
      }

      const res = await net.fetch(pathToFileURL(abs).toString())
      // The worker is a different origin from this scheme, so it has to be let in.
      const headers = new Headers(res.headers)
      headers.set('access-control-allow-origin', '*')
      return new Response(res.body, { status: res.status, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  /* The app's own bundle. Everything served here ships inside Tulip — there is
     no reader-supplied path on this scheme at all — so the guard is only
     `appAsset`'s containment, and it is here to catch a mistake rather than an
     attack.

     THE CONTENT TYPE IS STATED, NOT GUESSED, for the one type that must be
     right: Chromium refuses a module script that does not arrive as JavaScript,
     and refusing the entry module is a blank window rather than a slow one. The
     rest of the map is what dist/index.html actually pulls in. Anything not
     named keeps whatever `net.fetch` inferred from the extension — pdf.js's
     cmaps and font files reach the page over `tulip-file://app/` instead, and
     that path has always relied on the guess. */
  const APP_MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.cjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.map': 'application/json'
  }

  protocol.handle('tulip-app', async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app') return new Response('Forbidden', { status: 403 })

    let abs
    try {
      const wanted = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      // A bare origin is the document, so a stray navigation to it lands on the
      // app rather than on a 404 that looks like a broken install.
      abs = appAsset(wanted || 'index.html')
    } catch {
      return new Response('Forbidden', { status: 403 })
    }

    /* Read, not `net.fetch`. The vault handler above goes through the network
       stack because it needs range replies and streaming for files that run to
       hundreds of megabytes. Nothing here is remotely that size — the whole
       eager boot graph is under a megabyte across 28 files — and `net.fetch`
       of a file: URL from inside a protocol handler was MEASURED at 10-13ms a
       request against 1ms for the same file loaded directly, which cost more
       than the code cache saves. That regression is the entire reason this
       comment exists; see bench/boot-bench.mjs.

       ASYNC, and not `readFileSync`, which was tried: a synchronous read blocks
       the very event loop that the other 27 requests are queued on, and
       measured WORSE (180ms of request time against 139ms). What is left is
       not I/O at all — it is the cost of a main-process callback per request
       while main is busy opening a vault. The way to get the rest of the code
       cache's value is fewer requests, not faster ones. */
    try {
      const body = await fs.readFile(abs)
      const headers = new Headers()
      const type = APP_MIME[path.extname(abs).toLowerCase()]
      if (type) headers.set('content-type', type)
      return new Response(body, { status: 200, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  const cfg = readConfig()
  /* One vault, under one key: the folder last connected is the folder Tulip
     opens. `defaultVaultPath` was a second name for it while the settings pane
     offered a separately chosen default; a config still carrying that key is
     promoted once, here, and the key retired. This must happen before
     createWindow: the renderer asks for the current vault as soon as it loads,
     and a window created first can briefly receive `null` and paint the
     landing page over a vault that is in fact open. */
  const savedVault = cfg.vaultPath || cfg.defaultVaultPath
  if (savedVault && fsSync.existsSync(savedVault)) {
    vaultPath = savedVault
    if (cfg.vaultPath !== savedVault || cfg.defaultVaultPath !== undefined) {
      writeConfig({ vaultPath: savedVault, defaultVaultPath: undefined })
    }
    trust.setVault(vaultPath, cfg.historyInVault === true)
    /* And the folder a notebook's kernel is allowed to see, which `openVault`
       sets and this path did not. Without it the Jupyter server takes whatever
       directory the app happened to be launched from — `/`, from the Finder —
       so `read_csv("data.csv")` beside a notebook read someone else's root
       until the reader switched vaults, which on the ordinary launch is never.
       See electron/kernel.js. */
    kernels?.setRoot(vaultPath)
    // Present in the list from the first launch, not only once it is left.
    rememberVault(vaultPath)
    /* And the index this vault was left holding. The launch that most needs it
       is exactly this one — the vault still open from last time — so it is set
       up on the same path as everything else `openVault` would have done. */
    useIndexCacheFor(vaultPath)
    /* The same tidy-up `openVault` does, for the vault that is simply still
       open from last time — which is how the app is started nearly always, and
       so the path the migration actually runs on. */
    migrateAttachments(vaultPath).catch(() => {})
    watchVault()
  }

  const first = createWindow()
  /* After the window is asked for, not before. Building the menu is a
     two-hundred-line template and an accelerator table, and none of it is on
     screen until the reader reaches for it — while `createWindow` is what
     starts the renderer loading, which is the only thing anybody is waiting
     for. Still on this tick, so the menu is in place long before the window
     it belongs to has painted. */
  buildMenu()
  guardGuests()
  if (vaultPath) first.setTitle(path.basename(vaultPath))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  if (watcher) watcher.close()
  killAllRuns()
  kernels?.disposeSync()
  pythonEnvs?.disposeSync()
  aiInstance?.stopAll('SIGKILL')
  trust?.flushSync()
  flushDurabilitySync()
  flushConfig()
})
