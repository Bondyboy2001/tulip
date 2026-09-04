'use strict'

const {
  app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme, protocol, net, session,
  clipboard, utilityProcess, Notification, screen
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
const { makeKernelDomain } = require('./ipc-kernel')
const { makeDraftDomain } = require('./ipc-drafts')
const { makeReviewDomain } = require('./ipc-review')
const { makeSpellDomain } = require('./ipc-spell')
const { makePdfDomain } = require('./ipc-pdf')
const { makeCreateDomain } = require('./ipc-create')
const { makeRenderDomain } = require('./ipc-render')
const { makeMetadataDomain } = require('./ipc-metadata')
const { makeFilesDomain } = require('./ipc-files')
const { makeVaultWriteDomain } = require('./ipc-vault-write')
const { makeVaultInfoDomain } = require('./ipc-vault-info')
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
  entryProps, nameHas, passesFilters, scanKind
} = require('./vault-scan')
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
const { makePathStore, relocateAll, resetAll } = require('./path-store')
/* Where a `python` block's interpreter comes from, and what happens when the
   import it needs is not installed — see electron/python-env.js. */
const { makePythonEnvs, missingPackage, hasInlineDeps } = require('./python-env')
const { writeAtomicSync, syncDirectory } = require('./atomic-store')
const { BACKUP_EXTENSION, backupVault, restoreVault } = require('./vault-backup')
const {
  parseFrontmatter, propsOf, propValues, tagsFromProps, writeListProp
} = require('./frontmatter.cjs')
const { whiteboardText } = require('./whiteboard-data')
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
    if ((fsSync.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > CRASH_LOG_MAX) {
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

/* `__pycache__` earns its place the way node_modules did: a vault whose notes
   run Python blocks grows one beside every script, each write to it is a
   watcher event, and nothing in it is anyone's document. Dot-directories like
   `.venv` need no entry — everything dot-led is already hidden. A folder a
   reader might genuinely keep work in (`dist`, `build`) is deliberately NOT
   here: hiding a real folder because of its name is worse than re-indexing. */
const IGNORED_DIRS = new Set(['.git', '.obsidian', '.tulip', 'node_modules', '__pycache__', '.trash'])

/* The vault's kinds, extensions and name rules are one projection of the
   contract, defined once in electron/vault-kinds.js — the walk, the watcher,
   the tree, search and the create handlers (electron/ipc-create.js) all ask
   the same module, so a kind added to the JSON arrives everywhere at once.
   The reasoning for each kind moved with it; what is here are the names. */
const {
  escapeRe, MD_EXT, NOTE_EXT, TEXT_DOCUMENT_EXT,
  ATTACHMENT_DIR,
  PDF_TEXT_SUFFIX,
  TEX_EXT, isTex, isLanguageTable,
  languageTableStem, languageName, languageTableLabel,
  PDF_EXT, isPdf, SITE_EXT, isSite, WHITEBOARD_EXT, isWhiteboard,
  NOTEBOOK_EXT, isNotebook, DOCX_EXT, isDocx, isFlashcard,
  CODE_EXT, isCode, DATA_EXT, isData
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
    .flatMap(([, exts]) => /** @type {string[]} */ (exts).map((ext) => `.${ext}`))
)

/* Which viewer a file of no particular kind wants, by extension alone. The
   same four words src/assets.js uses for an embed — a picture is a picture
   whether a note points at it or the tree does — and `file` for everything
   with nothing to show, which the renderer describes rather than draws. */
const ASSET_KIND_BY_EXT = new Map(
  Object.entries(ASSET_KINDS)
    .filter(([kind]) => !kind.startsWith('_'))
    .flatMap(([kind, exts]) => /** @type {string[]} */ (exts).map((ext) => [`.${ext}`, kind]))
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
/** @type {Electron.BrowserWindow | null} */
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

/**
 * To one named window, if it is still there to hear it. Null arrives when the
 * window a handler resolved has gone between the call and the send — the
 * guard is the point, so the type says what the body already knew.
 * @param {Electron.BrowserWindow | null} win
 * @param {string} channel
 * @param {unknown} [payload]
 */
function sendTo (win, channel, payload) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

/** @type {string | null} */
let vaultPath = null
/** @type {typeof import('./ai') | null} */
let aiInstance = null

/* The kernels, their handlers and their window ownership live in
   electron/ipc-kernel.js. Main keeps only the two hooks a kernel's lifetime
   hangs from — the vault changing under it, and a window going away. */
const kernelDomain = makeKernelDomain({
  sendTo,
  executionTrusted,
  ensureLoginPath,
  runnerPath,
  getVaultPath: () => vaultPath
})

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

/* One glyph a reader hung on a row of the file tree: a tick for "read", a
   cone for "still working on this", whatever the emoji means to the person who
   picked it. It says nothing about the file's contents, so it does not belong
   inside the file — and it has to survive a rename, which is exactly what a
   path store does.

   Graphemes, not code points: a flag is two code points and a waving hand with
   a skin tone is three, and counting the wrong unit would refuse the icons
   people actually reach for. Whitespace is refused outright — an invisible
   mark is a row that looks unmarked and sorts as marked. */
const cleanFileMark = (value) => {
  const mark = String(value || '').trim()
  if (!mark || /\s/.test(mark)) return null
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null
  const glyphs = segmenter ? [...segmenter.segment(mark)].length : [...mark].length
  // Two, so a pair like "‼️" or a flag plus a tick still fits, and a pasted
  // sentence does not.
  if (glyphs > 2) return null
  return mark
}

/* Which row wears which mark. No index to invalidate: nothing is searched by
   these, they are only drawn. */
const fileMarks = makePathStore({
  name: 'file-marks',
  vault: () => vaultPath,
  clean: cleanFileMark
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
/** @type {import('node:fs').FSWatcher | null} */
let watcher = null
/** @type {InstanceType<typeof TrustStore> | null} */
let trust = null

/* The scheduler's memory. Reads `vaultPath` through a function rather than
   being rebuilt on every vault switch: the store keys everything on the vault
   it was asked about, and re-reads when that changes. */
const reviewDomain = makeReviewDomain({
  getVaultPath: () => vaultPath,
  focusedWindow
})
const { review } = reviewDomain
/* When a language row first became complete and when it last changed. Kept in
   the same hidden vault state area as review history, not in visible columns. */
const languageHistory = makeLanguageHistoryStore({ vault: () => vaultPath || '' })

/* ---------------------------------------------------------------- config */

/* Held in memory after the first read — main is the only writer, so the file
   cannot change underneath it. Persistence is debounced (a pinch zoom is a
   burst of writes) and goes through `writeAtomic`, so a crash mid-write cannot
   leave a half-written config behind. */
/** @type {Record<string, any> | null} */
let config = null
/** @type {ReturnType<typeof setTimeout> | null} */
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
  return /** @type {Record<string, any>} */ (config)
}

function writeConfig (patch) {
  config = { ...readConfig(), ...patch }
  clearTimeout(/** @type {any} */ (configTimer))
  configTimer = setTimeout(persistConfig, 300)
  return config
}

/* Execution consent belongs to the absolute vault path. A copied vault must
   ask again, while a vault reopened from the same folder keeps its answer. */
function executionTrusted () {
  return Boolean(vaultPath && Array.isArray(readConfig().trustedVaults) &&
    readConfig().trustedVaults.includes(vaultPath))
}

function trustExecutionForVault () {
  if (!vaultPath) return false
  const before = Array.isArray(readConfig().trustedVaults) ? readConfig().trustedVaults : []
  writeConfig({ trustedVaults: [...new Set([...before, vaultPath])] })
  return true
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
    writeAtomicSync(CONFIG_PATH(), JSON.stringify(config, null, 2))
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
  if (abs === path.resolve(/** @type {string} */ (vaultPath))) throw new Error('That is the vault itself.')
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
/** @type {{ of: (string | null), real: (string | null) }} */
let realRoot = { of: null, real: null }

async function vaultRealRoot () {
  const root = path.resolve(/** @type {string} */ (vaultPath))
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
    : path.relative(/** @type {string} */ (vaultPath), abs).split(path.sep).join('/')
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
 *
 * Async, with one `stat` per candidate rather than a blocking existence probe:
 * the old form called `existsSync` in a loop on the create/move/import path,
 * pinning the event loop once per colliding name. A miss answers from the
 * rejection, which is the `exists` this never had.
 */
async function freeName (dir, base, ext = '') {
  const clean = base.replace(/[/\\]/g, '-').replace(/^\.+/, '') || 'Untitled'
  let target = path.join(dir, `${clean}${ext}`)
  let n = 1
  while (await fs.stat(target).then(() => true).catch(() => false)) {
    target = path.join(dir, `${clean} ${++n}${ext}`)
  }
  return target
}

/**
 * Pasted attachments always carry an explicit zero-based suffix. Besides
 * making their order obvious in Finder, this keeps a later paste predictable:
 * `saved-0.png`, `saved-1.png`, and upward, independent of the clipboard's
 * generic `image.png` name. Notes and folders retain `freeName`'s friendlier
 * unsuffixed-first convention.
 *
 * Async for the same reason `freeName` is: one `stat` per candidate, off the
 * blocking path.
 */
async function freeAttachmentName (dir, base, ext) {
  const clean = base.replace(/[/\\]/g, '-').replace(/^\.+/, '') || 'Untitled'
  let n = 0
  let target = path.join(dir, `${clean}-${n}${ext}`)
  while (await fs.stat(target).then(() => true).catch(() => false)) {
    target = path.join(dir, `${clean}-${++n}${ext}`)
  }
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
/* Source files, data files and notebooks — the vault's own text that is not
   prose. They were the one kind of document the vault opened, edited and
   versioned but could not FIND: a function name, a column heading or a line of
   analysis was only searchable while its file happened to be open. Held on the
   same terms as everything above — text only, validated by mtime and size, a
   file too large kept with empty text so a search can say it went unread. For
   a notebook the text is the cells' sources, never the outputs: a plot is a
   megabyte of base64 that no one is searching for. */
const documentIndex = new Map()   // rel path -> { name, text, kind, mtime, size }

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
  /* Every kind the targeted sync below has a table for, plus the two it
     deliberately holds nothing for. A TeX document or a PDF is not in any
     index table — its words live in the editor's snapshot cache and in the
     extraction sidecars, not here — so there is nothing to re-read for one;
     what matters is that saving one does not cost a stat of every note in the
     vault. Naming them here sends them down the targeted path, which stats the
     one file and returns, instead of falling through to a full walk. A kind
     missing from this list is not "skipped" — it is a full walk of the vault
     on every save of that file, which is what every `.py` and `.csv` autosave
     cost while only notes, whiteboards and Word documents were named here. */
  const known = ext && (MD_EXT.has(ext) || ext === WHITEBOARD_EXT ||
    ext === DOCX_EXT || ext === TEX_EXT || ext === PDF_EXT || isIndexedDocumentExt(ext))
  if (known) indexDirtyPaths.add(relPath)
  else indexDirty = true
}
/** @type {Promise<void> | null} */
let syncing = null

/* The same index, on disk, so a launch does not start from nothing — see
   index-cache.js for what is and is not trusted about it. Rebuilt when the
   vault changes; null until there is a vault to have one for. */
/** @type {ReturnType<typeof makeIndexCache> | null} */
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
    documentIndex.clear()
    indexDirtyPaths.clear()
    vaultInfoDomain.forgetTables()
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
      const abs = path.join(/** @type {string} */ (vaultPath), ...key.split('/'))
      const ext = path.posix.extname(key).toLowerCase()
      /* Placed by kind, and only into a table whose kind it is. The old form
         ended in an unconditional else, which quietly filed anything the vault
         does not index — a `.zip` named by a directory-rename event, say —
         into the last table on the list, as an entry shaped like a note. A
         kind with no table has nothing to sync and is simply done. */
      const table = MD_EXT.has(ext)
        ? index
        : ext === WHITEBOARD_EXT
          ? whiteboardIndex
          : ext === DOCX_EXT
            ? docxIndex
            : isIndexedDocumentExt(ext)
                ? documentIndex
                : null
      /* TeX documents and PDFs are named by `markIndexDirty` but held in no
         table here — their words live in the snapshot cache and the extraction
         sidecars instead. One `stat` confirms the file is what it was, and
         there is nothing to re-read and nothing to clean when it is gone, so
         neither case hands over to the full walk. Only a directory wearing one
         of these extensions — which is a rename whose new name may hold any
         number of indexed files — falls back. */
      if (ext === TEX_EXT || ext === PDF_EXT) {
        const stat = await fs.stat(abs).catch(() => null)
        if (stat && !stat.isFile()) fallBack = true
        return
      }
      if (!table) {
        /* Nothing indexed answers to this name — unless the name is a folder,
           which arrives extension-less from a rename and may hold any number
           of files that are. Only the disk can say which, and a folder (or a
           name already gone, which a renamed folder's old name is) hands over
           to the full walk. */
        const stat = await fs.stat(abs).catch(() => null)
        if (!stat || !stat.isFile()) fallBack = true
        return
      }
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
        vaultInfoDomain.forgetTables()
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

  const { notes, whiteboards = [], docx = [], sources = [] } = await getVaultSnapshot()

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

  /* Source files, data files and notebooks, on the same terms as everything
     above: stat first, read only what moved, and hold a too-large file with
     empty text so a search reports it unread rather than leaving it out. */
  const seenDocuments = new Set()
  await mapLimit(sources, WALK_LIMIT, async (abs) => {
    const key = rel(abs)
    seenDocuments.add(key)
    let stat
    try { stat = await fs.stat(abs) } catch { return }
    const cached = documentIndex.get(key)
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return
    documentIndex.set(key, await documentEntryFor(abs, stat))
    changed = true
  })
  for (const key of [...documentIndex.keys()]) {
    if (!seenDocuments.has(key)) { documentIndex.delete(key); changed = true }
  }

  // Which notes exist may have changed, and that is the whole of what the link
  // tables are built from.
  vaultInfoDomain.forgetTables()

  if (changed) saveIndexCache()
}

/**
 * A notebook's searchable text: the sources of its cells, in order, and none of
 * its outputs. The file is mostly output — one plot is a megabyte of base64 —
 * and indexing it whole would make the index carry pictures in the name of
 * finding prose. A file that does not parse indexes as empty rather than
 * failing the walk; it is still a document, just one with nothing to say yet.
 */
function notebookIndexText (source) {
  try {
    const cells = JSON.parse(source)?.cells
    if (!Array.isArray(cells)) return ''
    return cells
      .map((cell) => Array.isArray(cell?.source) ? cell.source.join('') : String(cell?.source || ''))
      .filter(Boolean)
      .join('\n')
  } catch {
    return ''
  }
}

/** The kind word a source-side document answers a search under. */
const documentKindOf = (p) =>
  isNotebook(p) ? 'notebook' : isSite(p) ? 'site' : isData(p) ? 'data' : 'code'

/** One document-index entry, from a stat and (when small enough) the bytes. */
async function documentEntryFor (abs, stat) {
  let text = ''
  if (stat.size <= MAX_INDEX_BYTES) {
    const source = await fs.readFile(abs, 'utf8').catch(() => '')
    text = isNotebook(abs) ? notebookIndexText(source) : source
  }
  return {
    /* With the extension, exactly as the tree names it: `solve.py` and
       `solve.c` in one folder are two files, and a result list that said
       "solve" twice would be the tree's old bug in a new place. */
    name: path.basename(abs),
    text,
    mtime: stat.mtimeMs,
    size: stat.size,
    kind: documentKindOf(abs)
  }
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
  if (isIndexedDocumentExt(ext)) {
    return documentEntryFor(abs, stat)
  }
  let text = ''
  if (stat.size <= MAX_INDEX_BYTES) {
    try { text = await fs.readFile(abs, 'utf8') } catch { return null }
  }
  return { ...base, text }
}

/* ⚠️ WHAT THIS COSTS, AND WHY IT IS STILL WORTH IT. `index` holds every note's
   full text in main-process memory: measured, about a megabyte of heap per
   megabyte of prose, so a ten-thousand-note vault of ordinary notes is around
   64MB resident for the life of the session. That is the price of answering a
   search from memory rather than from the disk, and of `links:to`, the tag
   inventory, the alias table and the copilot's snapshots all reading the same
   copy.

   The obvious next move is to put the index in a utility process, which would
   take it off main's heap and out of main's GC pauses. It has not been done:
   every one of those readers would become asynchronous, and each is a place
   where a stale answer is invisible — a note quietly missing from a result
   list that still looks complete. The stall that made it urgent is gone
   (electron/vault-scan.js yields), so what is left is a memory number rather
   than something anybody feels.

   Out to disk, coalesced, so the next launch starts from here. Not awaited:
   the index in memory is already correct and every caller is waiting on that,
   not on the copy. A vault too big to cache whole gets its largest notes
   dropped from the copy — worth a line in the log, because the symptom (a
   slow first search, every launch) points nowhere. */
function saveIndexCache () {
  const saved = indexCache?.save(index)
  if (saved?.dropped) console.warn(`index cache over budget: ${saved.dropped} largest notes left out`)
  else if (saved?.skipped) console.warn('index cache skipped: vault too large to cache at all')
}

/** @returns {Promise<void>} */
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
/** @type {{ at: number, notes: Map<any, any> } | null} */
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
  for (const document of read) if (document) snapshot.set(.../** @type {[any, any]} */ (document))
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
 * long as anyone is typing, and one per note during a replace-all. The fallback
 * `stat` for a caller without a stamp is async for the same reason.
 */
async function touchIndex (absPath, text, stamp) {
  try {
    const stat = stamp || await fs.stat(absPath)
    indexGeneration++
    documentsChanged()
    // A note this index has not seen before is a key the link tables lack.
    if (!index.has(rel(absPath))) vaultInfoDomain.forgetTables()
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
async function touchDocxIndex (absPath, blocks, stamp) {
  try {
    const { docxText } = require('./docx')
    const stat = stamp || await fs.stat(absPath)
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

async function touchWhiteboardIndex (absPath, source, stamp, extractedText = null) {
  try {
    const stat = stamp || await fs.stat(absPath)
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

/** The same courtesy for a source file, a table or a notebook the app itself
 *  just saved: search finds what was typed a moment ago rather than waiting
 *  for the next walk. The text is already in the caller's hand, so nothing is
 *  read back. */
async function touchDocumentIndex (absPath, text, stamp) {
  try {
    const stat = stamp || await fs.stat(absPath)
    indexGeneration++
    documentIndex.set(rel(absPath), {
      name: path.basename(absPath),
      text: stat.size <= MAX_INDEX_BYTES
        ? (isNotebook(absPath) ? notebookIndexText(text) : String(text ?? ''))
        : '',
      mtime: stat.mtimeMs,
      size: stat.size,
      kind: documentKindOf(absPath)
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
/** @type {Promise<any> | null} */
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
    /* A symlink is a name for something that lives elsewhere, and elsewhere is
       exactly where this app must not follow: every open, write and delete
       resolves through the real-path guards and would refuse it anyway. Listed,
       it was a row that could only ever error — a symlinked folder showed up as
       a *file* (readdir reports the link, not what it points at) that nothing
       could open. Hidden, it is simply not the vault's, like `.git`. */
    if (entry.isSymbolicLink()) return false
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

    /** @type {{ type: string, kind: string, name: string, flag?: string, path: string } | null} */
    let node = null
    if (includeInTree && MD_EXT.has(path.extname(entry.name).toLowerCase())) {
      const language = isLanguageTable(abs)
      const flashcards = isFlashcard(abs)
      const identity = language ? languageName(languageTableStem(entry.name)) : null
      const folderIdentity = language ? languageName(path.basename(dir)) : null
      node = {
        type: 'file',
        kind: flashcards ? 'flashcards' : language ? 'language' : 'note',
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
      documents: files.filter(isReviewedDocument),
      /* The subset of `documents` the search index reads: the kinds whose text
         is worth holding. Whiteboards have an index of their own already. A
         site file is here despite being two lines long, because those two
         lines are the page's title and its address — which is the whole of
         what anybody would search for a bookmark by. */
      sources: files.filter((abs) =>
        isCode(abs) || isData(abs) || isNotebook(abs) || isSite(abs)),
      /* Everything the walk kept, as vault-relative paths. The buckets above
         are each a filter of this list for one consumer; the rename path wants
         the list itself, because a link can name any file the tree shows and
         "which files could this `[[Name]]` have meant" is a question about all
         of them at once. */
      files: files.map(rel)
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

/**
 * The extensions the tree hides, and therefore the ones a wikilink is written
 * without.
 *
 * A `.md` is not the only kind named this way. The tree labels a paper, a
 * board, a notebook and a Word document by their stem too — the icon beside
 * the row is what says which kind it is — so `[[Report]]` is how a reader
 * writes a link to `Report.docx`, and `[[Report.docx]]` resolves as well
 * because the renderer accepts both. Source and data files are the exception
 * and keep their extension in the label, since `solve.py` and `solve.c` in one
 * folder would otherwise be two rows both reading "solve".
 *
 * Stated here because a rename has to know it. The link rewriter used to strip
 * only note extensions, which is why renaming a PDF left every `[[book]]` in
 * the vault pointing at a file that no longer existed, and said "0 links" while
 * it did so.
 */
const LINK_STEM_EXT = new Set([
  ...VAULT_CONTRACT.noteExtensions,
  TEX_EXT, PDF_EXT, SITE_EXT, WHITEBOARD_EXT, NOTEBOOK_EXT, DOCX_EXT
])

/** A path with the extension a link would leave off taken off — and nothing
 *  taken off a path whose kind wears its extension in the tree. */
function stripLinkExt (p) {
  const ext = path.extname(p).toLowerCase()
  return LINK_STEM_EXT.has(ext) ? p.slice(0, p.length - ext.length) : p
}

/**
 * How the renderer reads a link target, so the two agree on what resolves.
 *
 * Both spellings of a document arrive here as the same string: `[[Report]]` and
 * `[[Report.docx]]` are one link, written twice. So do both spellings of an
 * accent. A `é` is either one codepoint or two, macOS filesystems have
 * historically preferred the two-codepoint form while every keyboard produces
 * the one-codepoint form, and a vault touched by a sync client ends up holding
 * some of each — so `Café.md` on disk and `[[Café]]` in a note could be two
 * different strings that no comparison would ever match, and the link simply
 * did not resolve.
 *
 * Composed here rather than in `rel`, deliberately. This is a comparison key
 * and never a path anything is opened by: normalising the paths themselves
 * would hand Linux, whose filesystems store exactly the bytes they were given,
 * a name for a file that does not exist.
 */
function normaliseTarget (raw) {
  return stripLinkExt(raw.trim().replace(/\\/g, '/')).replace(/\/+$/, '').normalize('NFC')
}

/** The extension a link left implicit, so a rewrite can put back the spelling
 *  the reader actually used rather than quietly shortening it. */
function linkExtOf (raw) {
  const head = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const ext = path.extname(head).toLowerCase()
  return LINK_STEM_EXT.has(ext) ? head.slice(head.length - ext.length) : ''
}

/** Files sharing a link name, counted over a set of vault paths. Composed for
 *  the same reason `normaliseTarget` is — this counts the names links are
 *  compared against, so it has to spell them the way that comparison will. */
function basenameCounts (paths) {
  const counts = new Map()
  for (const p of paths) {
    const base = path.basename(stripLinkExt(p)).toLowerCase().normalize('NFC')
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

/**
 * The moves, arranged so one link can find its own without walking the list.
 *
 * A folder rename now carries every file underneath it — pictures and papers
 * as well as notes — so a big folder is hundreds of moves, and the old loop
 * asked every one of them about every link in every note that mentioned any of
 * them. Two maps answer the same question directly: a fully qualified link
 * looks up its path, a bare one looks up its name.
 */
function moveLookup (moves) {
  const byPath = new Map()
  const byName = new Map()
  for (const move of moves) {
    const from = normaliseTarget(move.from).toLowerCase()
    if (!byPath.has(from)) byPath.set(from, move)
    const base = path.basename(from)
    const same = byName.get(base)
    if (same) same.push(move)
    else byName.set(base, [move])
  }
  return { byPath, byName }
}

function rewriteLinks (text, moves, before, after, lookup = moveLookup(moves)) {
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
    /* `[[book.pdf]]` and `[[book]]` are the same link and both normalise to
       the same string, but they are not the same *writing*. The extension the
       reader typed goes back on the end, so a rename edits the target and
       leaves the spelling alone. */
    const wore = linkExtOf(head)

    /* The exact path first, then the bare name — the same order `retarget`
       tested in, and the order that matters: a link that names a whole path
       means that file even when something else shares its name. */
    const wanted = link.toLowerCase()
    const candidates = []
    const exact = lookup.byPath.get(wanted)
    if (exact) candidates.push(exact)
    if (!link.includes('/')) candidates.push(...(lookup.byName.get(wanted) || []))
    if (!candidates.length) return whole

    for (const move of candidates) {
      const next = retarget(link, move, before, after)
      if (next !== null) {
        /* Only when the new target is of a kind that hides its extension too:
           renaming `book.pdf` to `notes.csv` cannot leave the link reading
           `[[notes.pdf]]`. */
        const suffix = wore && LINK_STEM_EXT.has(path.extname(move.to).toLowerCase())
          ? path.extname(move.to)
          : ''
        return `[[${next}${suffix}${frag}${alias}]]`
      }
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
  invalidateVaultSnapshot()
  await ensureIndex()
  /* Every file a link could name, not only the notes.

     The ambiguity rule below turns on whether a bare `[[Name]]` had exactly one
     possible target before the move. Counted over the index alone, a vault
     holding both `Report.md` and `Report.docx` looked unambiguous, and renaming
     the note redirected links that had always meant the document.

     Two details here are load-bearing. The snapshot is invalidated first, so
     the walk describes the vault as it stands after the rename — the nudge
     below reconstructs the before-counts from these, and reconstructing them
     from a stale walk double-counts the very name that moved. And the notes
     come from the index alone, with the snapshot contributing only the other
     kinds: a note is in both lists, and counted twice it reads as its own
     twin, which silences every bare link to it. */
  const snapshot = await getVaultSnapshot()
  const linkable = [
    ...index.keys(),
    ...(snapshot.files || []).filter((key) => !MD_EXT.has(path.extname(key).toLowerCase()))
  ]
  const after = basenameCounts(linkable)

  const before = new Map(after)
  const nudge = (key, by) => before.set(key, (before.get(key) || 0) + by)
  for (const { from, to } of moves) {
    nudge(path.basename(stripLinkExt(from)).toLowerCase().normalize('NFC'), +1)
    nudge(path.basename(stripLinkExt(to)).toLowerCase().normalize('NFC'), -1)
  }

  /* Only notes that mention one of the moved names can possibly change. A
     `[[` test would keep almost every note in a vault that uses wikilinks; this
     rejects the ones that never named the thing, which is nearly all of them.

     Both spellings of every name, because this is the one place the comparison
     is against raw note text rather than a composed key: a file whose name is
     stored decomposed would otherwise never match the composed `[[Café]]` a
     reader typed, and the note would be skipped before `rewriteLinks` — which
     does compose both sides — ever saw it. */
  const spellings = new Set()
  for (const move of moves) {
    const base = path.basename(stripLinkExt(move.from))
    spellings.add(base.normalize('NFC'))
    spellings.add(base.normalize('NFD'))
  }
  const mentions = new RegExp([...spellings].map(escapeRe).join('|'), 'i')

  /* Decided first, written second. The rewrite itself is synchronous string
     work over the index, and doing it in its own pass keeps `touchIndex` from
     writing into the map this loop is walking. */
  const lookup = moveLookup(moves)
  const pending = []
  for (const [key, entry] of index) {
    if (!mentions.test(entry.text)) continue
    const next = rewriteLinks(entry.text, moves, before, after, lookup)
    if (next === entry.text) continue
    pending.push({ key, abs: path.resolve(/** @type {string} */ (vaultPath), key), next, previous: entry.text })
  }

  /* Concurrently: `writeAtomic` fsyncs both the file and its directory, so a
     folder rename that touches a hundred backlinks was two hundred fsyncs one
     after another with the main process pinned for all of them. The notes are
     different files and the writes do not depend on one another. */
  const touched = await mapLimit(pending, WALK_LIMIT, async ({ key, abs, next, previous }) => {
    try {
      await touchIndex(abs, next, await writeAtomic(abs, next))
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
  const isDir = (await fs.stat(srcAbs)).isDirectory()
  const fromPath = rel(srcAbs)
  const toPath = rel(targetAbs)
  await ensureIndex()
  const moves = await filesMovedBy(rel(srcAbs), rel(targetAbs), isDir)

  noteSelfWrite(srcAbs)
  noteSelfWrite(targetAbs)
  await fs.rename(srcAbs, targetAbs)
  /* Re-keyed rather than given up and asked for again: the window editing the
     document still is, and a release would announce the document free the one
     moment it is not. Left behind, the old key is a claim on a path that may
     be filled again later — and then a window would be locked out of a file
     nobody has open. */
  relocateClaims(srcAbs, targetAbs, isDir)
  /* Everything filed against a path rather than inside the file — tags, the
     table's column widths, and whatever is registered next — moves with it. */
  await relocateAll(fromPath, toPath, isDir)
  /* A python environment cannot be carried to a new path — see `relocate` in
     electron/python-env.js — so the notes that moved give theirs up and build
     again on their next run. A folder move is every note under it. */
  /* Notes only, as before this list grew. A folder move now carries every
     picture and paper under it so their links can be chased, and asking the
     environment store about a `.png` would be several hundred pointless
     lookups per folder rename. */
  await Promise.all(
    (isDir
      ? moves.filter(({ from }) => MD_EXT.has(path.extname(from).toLowerCase()))
      : [{ from: fromPath, to: toPath }])
      .map(({ from, to }) => pythonEnvs.relocate(from, to))
  )
  await carryAnnotations(rel(srcAbs), rel(targetAbs))
  await carryAttachments(rel(srcAbs), rel(targetAbs))
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
 * The files a move carries with it: the file itself, or — when a folder moves —
 * everything underneath it that a link could have named. Must be read *before*
 * the move happens, while those paths still exist.
 *
 * Notes were once the whole of this list, on the reasoning that only a note is
 * in the link index. That confused two different things. The index is a map of
 * which notes *contain* links; what this function answers is which files a link
 * can *point at*, and the tree has always let a reader write `[[book]]` for a
 * paper, `[[Report]]` for a Word document and `![[diagram.png]]` for a picture.
 * Renaming any of those rewrote nothing and reported "0 links", leaving the
 * link dangling with an explicit reassurance that it had not been.
 */
async function filesMovedBy (from, to, isDir) {
  if (!isDir) return isSnapshotFile(from) ? [{ from, to }] : []
  const prefix = from + '/'
  /* The index for the notes and the snapshot for everything else, joined and
     de-duplicated: a note appears in both, and rewriting a link twice would
     apply the second move to the result of the first. */
  const snapshot = await getVaultSnapshot()
  const under = new Set([
    ...notesUnder(from, true),
    ...(snapshot.files || []).filter((key) => key.startsWith(prefix))
  ])
  return [...under].map((key) => ({ from: key, to: `${to}/${key.slice(prefix.length)}` }))
}

/**
 * The `.md` paths a single path stands for: itself, or — for a folder — every
 * note beneath it. Read from the index, so like `filesMovedBy` it must be
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

/**
 * @param {string} abs
 * @param {{ mtimeMs: number, size: number } | null} [stamp]
 */
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
/** @type {ReturnType<typeof setTimeout> | null} */
let durabilityTimer = null
/** @type {Promise<void> | null} */
let durabilityFlushing = null
const DURABILITY_INTERVAL_MS = 30000

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
  clearTimeout(/** @type {any} */ (durabilityTimer))
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
  clearTimeout(/** @type {any} */ (durabilityTimer))
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
  /** @type {{ mtimeMs: number, size: number } | null} */
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
  clearTimeout(/** @type {any} */ (watchRetryTimer))
  watchRetryTimer = null
  if (watcher) { watcher.close(); watcher = null }
  if (!vaultPath) return

  /** @type {ReturnType<typeof setTimeout> | null} */
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
        docxExtension: DOCX_EXT,
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
      clearTimeout(/** @type {any} */ (timer))
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
/** @type {ReturnType<typeof setTimeout> | null} */
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

/* ------------------------------------------------ tags, into the notes
   A tag put on a Markdown note used to be filed in `.tulip/file-tags.json`,
   beside the vault rather than inside the note. That made a tag the one piece
   of a note's meaning that did not travel with it: a vault carried to another
   app — or read by anything but Tulip — arrived with the `#tags` typed into
   the prose intact and the ones set in the Info pane simply gone.

   Now a Markdown note's tags live in its own head, as `tags:`, which is what
   every other app that reads a vault expects. The sidecar keeps only the kinds
   with nowhere to put them: a PDF, a Word document, a whiteboard.

   This is the one-time move. It runs on vault open, writes only notes that
   actually have a sidecar entry, and merges rather than replaces — a note that
   already declares `tags:` keeps what it declared and gains what was filed
   against it. Each note is written through the ordinary atomic write, so a
   failure part-way leaves whole notes on either side of it and the entries it
   has not reached still in the sidecar to be moved next time. */
async function migrateNoteTags () {
  if (!vaultPath) return
  const assigned = await fileTags.all().catch(() => null)
  if (!assigned) return
  const moving = Object.keys(assigned)
    .filter((key) => MD_EXT.has(path.extname(key).toLowerCase()))
    .filter((key) => (cleanFileTags(assigned[key]) || []).length)
  if (!moving.length) return

  let moved = 0
  for (const key of moving) {
    const abs = path.join(vaultPath, key)
    let text
    try { text = await fs.readFile(abs, 'utf8') } catch { continue }
    const sidecar = cleanFileTags(assigned[key]) || []
    const head = tagsFromProps(propsOf(parseFrontmatter(text)))
    const union = [...new Set([...head, ...sidecar])]
    /* Written even when the head already says all of it, because the point of
       the write is to be able to clear the sidecar entry afterwards — and
       `writeListProp` hands back the same string when nothing moves, so a note
       that needs no change is not rewritten. */
    const updated = writeListProp(text, 'tags', union)
    try {
      if (updated !== text) { await writeAtomic(abs, updated); moved++ }
      await fileTags.set(key, [])
    } catch {
      // Left in the sidecar, to be tried again on the next open.
      continue
    }
  }
  if (moved) console.log(`tags: moved ${moved} note${moved === 1 ? '' : 's'} into their own heads`)
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
  kernelDomain.moveRoot(dir)
  // The next read of each is of the new vault's own file.
  resetAll()
  /* And nothing is being edited in it yet. Every window drops the document
     it was showing when it hears `vault:opened` below, but the release each
     sends is resolved against this vault — the path it names is not here —
     so the claims of the vault being left have to be dropped by hand, or
     they would lock its documents on the way back. */
  editClaims.clear()
  // Environments are keyed by vault, so none of what is remembered about which
  // ones exist describes this one.
  pythonEnvs.reset()
  rememberVault(dir)
  /* Version history lives in the app's data folder rather than in the vault's
     own .tulip folder, so the vault stays a folder of plain files and nothing
     extra travels with the notes through Git or a sync client. */
  trust?.setVault(dir, false)
  /* The vault open is remembered under `vaultPath`; the pinned default under
     `defaultVaultPath` is left alone, so a temporary switch to another folder
     does not move where the next launch opens. Clearing or changing the
     default happens only from Settings → Vault. */
  writeConfig({ vaultPath: dir })
  await migrateAttachments(dir).catch(() => {})
  await migrateNoteTags().catch(() => {})
  index.clear()
  whiteboardIndex.clear()
  docxIndex.clear()
  documentIndex.clear()
  documentSnapshotCache.clear()
  vaultInfoDomain.forgetTables()
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
    url: String(latest?.html_url || ''),
    /* Release notes for the update dialog, truncated so a long changelog does
       not become a long dialog. Plain text: the dialog renders detail as-is. */
    notes: String(latest?.body || '').slice(0, 2000)
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
  /* The Windows PATH expansion beside it, for the same reason: the first Run
     awaits it, but starting it here means it has usually already landed. */
  ensureFallbackPaths()
  if (!runCachePruned) {
    runCachePruned = true
    pruneRunCache().catch(() => {})
  }
})

ipcMain.handle('app:flushed', async (event, result = {}) => {
  await flushPendingDurability()
  const waiting = flushWaits.get(event.sender.id)
  if (result?.ok === false) waiting?.fail?.()
  else waiting?.reply()
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
    const done = (result = { failed: false }) => { clearTimeout(timer); resolve(result) }
    entry.reply = () => done({ failed: false })
    entry.fail = () => done({ failed: true })
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

/**
 * Where the primary window was when the app last quit — see `rememberBounds`.
 *
 * Only offered back when enough of the rectangle still lies on some display
 * to take hold of: a window last seen on a monitor that is no longer plugged
 * in would otherwise open off the edge of the screen, with no title bar to
 * drag it back by. Enough, not all of it — a window snapped to half the screen
 * reports itself a pixel wider than the half, and macOS itself is happy to
 * show a window that hangs over an edge. The default size then applies, and
 * the first window fills the screen as it always did. A maximised window is remembered as such rather than by the
 * screen-sized rectangle it wore: restored as bounds, the green button would
 * do nothing the next morning.
 *
 * @returns {{bounds: {x: number, y: number, width: number, height: number}|null, maximized: boolean}}
 */
function rememberedWindow () {
  const saved = readConfig().window
  if (!saved || typeof saved !== 'object') return { bounds: null, maximized: false }
  const { x, y, width, height } = saved
  const finite = [x, y, width, height].every((n) => Number.isFinite(n))
  const fits = finite && screen.getAllDisplays().some(({ workArea: a }) => {
    const across = Math.min(x + width, a.x + a.width) - Math.max(x, a.x)
    // The title bar is the top of the window: it has to be on the display,
    // with room under it, or the window cannot be moved at all.
    const barOn = y >= a.y - 4 && y <= a.y + a.height - 100
    return across >= 200 && barOn
  })
  return {
    bounds: fits ? { x, y, width, height } : null,
    maximized: saved.maximized === true
  }
}

/** Writes the primary window's place down, debounced with the rest of the config. */
function rememberBounds (win) {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
  const maximized = win.isMaximized()
  // The rectangle underneath a maximised window is the one it un-maximises
  // to — `getNormalBounds` reports that rather than the screen.
  writeConfig({ window: { ...win.getNormalBounds(), maximized } })
}

function cascadeFrom (win) {
  if (!win || win.isDestroyed()) return {}
  const [x, y] = win.getPosition()
  const [width, height] = win.getSize()
  return { x: x + CASCADE, y: y + CASCADE, width, height }
}

/* A zoom or resize can leave Chromium's macOS surface waiting for a paint even
   though its renderer and accessibility tree are both still live. Coalesce a
   burst into one full repaint; doing this on every drag frame would make the
   cure more expensive than the layout it follows. */
const repaintTimers = new WeakMap()
function scheduleWindowRepaint (win) {
  if (!win || win.isDestroyed()) return
  clearTimeout(repaintTimers.get(win))
  repaintTimers.set(win, setTimeout(() => {
    repaintTimers.delete(win)
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.invalidate()
  }, 60))
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
  /* The first window opens where the last session left it — see
     `rememberedWindow` — and fills the screen when there is nothing to go back
     to; a second one is sized and placed from the window it was opened out of,
     so it lands somewhere the reader is already looking. */
  const parent = windows.size ? focusedWindow() : null
  const remembered = windows.size ? { bounds: null, maximized: false } : rememberedWindow()
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 680,
    minHeight: 460,
    ...(remembered.bounds || {}),
    ...cascadeFrom(parent),
    .../** @type {Electron.BrowserWindowConstructorOptions} */ (windowChrome()),
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

  /* The native menu follows the frontmost window. Its renderer reports the
     active document separately, so focus only has to rebuild from that saved
     fact — no round trip during a menu-bar click. */
  win.on('focus', () => buildMenu())

  /* Chromium normally repaints as a native resize settles. At a large page
     zoom it can miss that final paint and show only the window background.
     macOS's green-button "zoom window" transition can arrive as
     maximize/unmaximize rather than an ordinary resize, so cover both the
     live and completed forms of the native change. */
  for (const event of /** @type {Array<'resize' | 'resized' | 'maximize' | 'unmaximize'>} */ (['resize', 'resized', 'maximize', 'unmaximize'])) {
    win.on(/** @type {any} */ (event), () => scheduleWindowRepaint(win))
  }

  // Claimed by `window:role` during boot, and gone once it has been read.
  if (open) pendingOpens.set(win.webContents.id, open)
  /* The first window to exist is the primary one for as long as it does. It is
     not handed on when that window closes: the strip a later window is holding
     was never the session's, and promoting it would write it over the session
     that is on disk — a window opened for one look at one note would become
     what the next launch comes back to. */
  if (!primaryWindow) primaryWindow = win
  const primary = primaryWindow === win

  /* A first window with no remembered place opens filling the screen, and one
     remembered maximised comes back that way. The width and height above stay
     what they are — they are the size it returns to when it is un-maximised,
     and a restore size equal to the screen would make the green button do
     nothing. A second window keeps the size it was cascaded at: it was opened
     to be looked at beside something, which a maximise would undo. */
  if (primary && (!remembered.bounds || remembered.maximized)) win.maximize()

  /* The primary window's place is kept, so the next launch opens where this
     one was left. The live events rather than `resized` and `moved`: those
     only follow a resize made by hand, and a window sized by a script or by
     the system — a display coming or going — would be remembered wrong. A drag
     delivers one per frame, and the config write behind them is debounced. */
  if (primary) {
    for (const event of /** @type {Array<'resize' | 'move' | 'maximize' | 'unmaximize'>} */ (['resize', 'move', 'maximize', 'unmaximize'])) {
      win.on(/** @type {any} */ (event), () => rememberBounds(win))
    }
  }

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
  /** @type {ReturnType<typeof setTimeout> | null} */
  let revealBackstop = null
  const reveal = () => {
    if (shown || win.isDestroyed()) return
    shown = true
    clearTimeout(/** @type {any} */ (revealBackstop))
    win.show()
    /* A window opened while another one has the screen has to come forward as
       well as appear, or the reader's ⌘⌥N looks like it did nothing. */
    if (!primary) win.focus()
  }
  reveals.set(win.webContents.id, reveal)
  win.once('ready-to-show', () => { revealBackstop = setTimeout(reveal, 4000) })
  win.webContents.on('render-process-gone', reveal)
  win.webContents.on('did-fail-load', reveal)
  win.on('closed', () => clearTimeout(/** @type {any} */ (revealBackstop)))

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
    clearTimeout(repaintTimers.get(win))
    repaintTimers.delete(win)
    windows.delete(win)
    reveals.delete(contentsId)
    documentZoomClaims.delete(contentsId)
    menuDocumentKinds.delete(contentsId)
    searchGenerations.delete(contentsId)
    releaseClaimsOwnedBy(contentsId)
    stopRunsOwnedBy(win)
    kernelDomain.stopOwnedBy(win)
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
    askRendererToFlush(win).then((result) => {
      if (result?.failed) {
        /* Keep the window open when the renderer explicitly could not save. A
           draft or a retry is safer than closing over unsaved work. */
        flushing = false
        return
      }
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
    scheduleWindowRepaint(win)
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

/* A document opened from Finder arrives before `ready` on a cold launch and
   while the app is running thereafter. Keep the path until the vault and
   windows are ready to receive it; macOS otherwise launches Tulip successfully
   and silently drops the file it was launched for. */
const finderOpens = []
let finderOpensReady = false
/** @type {Promise<void> | null} */
let drainingFinderOpens = null

const finderDocument = (filePath) =>
  typeof filePath === 'string' && FINDER_DOCUMENT_EXT.has(path.extname(filePath).toLowerCase())

app.on('open-file', (event, filePath) => {
  if (!finderDocument(filePath)) return
  event.preventDefault()
  finderOpens.push(filePath)
  if (finderOpensReady) drainFinderOpens()
})

/* The one synchronous-looking launch question, asked with `stat` rather than
   the two blocking calls this used to make. Async like every other filesystem
   question now: the launch path already awaits the vault open that follows. */
async function launchFinderDocument () {
  while (finderOpens.length) {
    const wanted = finderOpens.shift()
    try {
      const real = await fs.realpath(wanted)
      if ((await fs.stat(real)).isFile()) return real
    } catch { /* Finder may have handed over a file that disappeared. */ }
  }
  return null
}

async function openFinderDocument (wanted) {
  if (!finderDocument(wanted)) return
  const real = await fs.realpath(wanted)
  if (!(await fs.stat(real)).isFile()) return

  const relative = vaultPath ? path.relative(vaultPath, real) : ''
  const insideVault = vaultPath && relative && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)

  if (!insideVault) {
    await flushAllWindows()
    await openVault(path.dirname(real))
  }
  createWindow({ open: insideVault ? relative : path.basename(real) })
  app.focus({ steal: true })
}

function drainFinderOpens () {
  if (drainingFinderOpens) return drainingFinderOpens
  drainingFinderOpens = (async () => {
    while (finderOpens.length) {
      const wanted = finderOpens.shift()
      try { await openFinderDocument(wanted) } catch (err) { logCrash('open-file', err) }
    }
  })().finally(() => { drainingFinderOpens = null })
  return drainingFinderOpens
}

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
/** @type {{ path: string, from: number } | null} */
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

/* ==================================================== one editor per document

   Two windows editing one note is a case Tulip settles: the buffers are merged
   against the version both sides last agreed on, and where they both rewrote
   the same lines the reader is asked. Two windows editing a Word document, a
   notebook, a whiteboard or a grid is a case it cannot settle — there is no
   three-way merge of a zip of XML or of a run of cell outputs — and the bargain
   those four fall back on is the older one: the buffer wins, and the disk's
   version is copied aside.

   That bargain does not converge when both sides keep taking it. Each window
   saves on its own clock, finds the file is no longer the one it read, copies
   the other's version aside and writes its own over it — once per autosave, for
   as long as both are open. What it leaves behind is a conflict copy a second,
   and for whichever side lost the last round, no copy at all: its work is
   simply gone.

   So the second window does not get a buffer. One of those four kinds is
   claimed by the window editing it, and a second window opens it read-only
   until it is given up — by the holder closing it, or by the reader asking for
   it here, which puts the holder's edits on disk before this window reads the
   file. Notes are not claimed: they have a merge, and taking two windows away
   from a note would be taking away something that works. */

/** realpath → the id of the `webContents` editing it. Keyed by id rather than
 *  by window for the same reason the tab drag above is: an id can be compared
 *  without holding a reference to a window that may already have closed. */
const editClaims = new Map()

/** The path a claim is filed under: resolved, so that two windows reaching one
 *  file by different names cannot both believe they hold it. */
async function claimKey (p) {
  if (typeof p !== 'string' || !p || p.length > 1024) return null
  try {
    return await realSafePath(p)
  } catch {
    return null
  }
}

/** The window editing `abs`, or null — dropping the claim where the window
 *  that held it has gone. A window that closes without saying so must not
 *  leave a document nobody can edit. */
function claimHolder (abs) {
  const id = editClaims.get(abs)
  if (id === undefined) return null
  const win = liveWindows().find((w) => w.webContents.id === id)
  if (!win) { editClaims.delete(abs); return null }
  return win
}

/** A document nobody is editing any more. The windows showing it read-only are
 *  told, so that closing the window that had it hands it back rather than
 *  leaving every other window locked out of a file nobody holds. */
function announceFree (abs) {
  broadcast('document:free', rel(abs))
}

/** The claims on a file that has just moved, moved with it — a folder taking
 *  everything claimed underneath it. Called from `relocate`, which is the one
 *  road every rename and move goes down. */
function relocateClaims (srcAbs, targetAbs, isDir) {
  for (const [abs, owner] of [...editClaims]) {
    let next = null
    if (abs === srcAbs) next = targetAbs
    else if (isDir && abs.startsWith(srcAbs + path.sep)) next = targetAbs + abs.slice(srcAbs.length)
    if (!next) continue
    editClaims.delete(abs)
    editClaims.set(next, owner)
    /* The holder is told, or it would go on giving up the old name: a rename
       is a self-write, so no `vault:changed` reaches it, and a release filed
       under the name it knew would match nothing — the re-keyed claim then
       outlived the document, and locked every other window out of it. */
    const holder = liveWindows().find((w) => w.webContents.id === owner)
    if (holder) sendTo(holder, 'document:relocated', { from: rel(abs), to: rel(next) })
  }
}

/** Everything a closing window was editing, given up. */
function releaseClaimsOwnedBy (id) {
  for (const [abs, owner] of editClaims) {
    if (owner !== id) continue
    editClaims.delete(abs)
    announceFree(abs)
  }
}

/**
 * This window would like to edit the document. Answers whether it may.
 *
 * `taken` rather than an error: a second window opening a document somebody
 * else is editing is an ordinary thing to do, and what it gets is the document
 * to read.
 */
ipcMain.handle('document:claim', async (event, p) => {
  const abs = await claimKey(p)
  if (!abs) return { ok: false }
  const holder = claimHolder(abs)
  if (holder && holder.webContents.id !== event.sender.id) return { ok: false, taken: true }
  editClaims.set(abs, event.sender.id)
  return { ok: true }
})

/** Given up — the document was closed, or the window moved off it. */
ipcMain.handle('document:release', async (event, p) => {
  const abs = await claimKey(p)
  if (abs && editClaims.get(abs) === event.sender.id) {
    editClaims.delete(abs)
    announceFree(abs)
  }
  return { ok: true }
})

/**
 * Taken over: this window edits it from now on, and the one that held it drops
 * to reading.
 *
 * The holder's edits reach the disk BEFORE this window is told it may read the
 * file again — the same ordering a tab carried between windows keeps, and for
 * the same reason. Without it the taking window would open the version from
 * before whatever was last typed, and then write that back.
 */
ipcMain.handle('document:take', async (event, p) => {
  const abs = await claimKey(p)
  if (!abs) return { ok: false }
  /* A loop rather than one look, because the holder can change while its
     flush is awaited: two readers pressing “Edit here” together both waited
     on the same window, and both were answered yes with neither told — two
     buffers over one file that cannot be merged. Bounded, so that windows
     trading a document between them cannot hold this open for ever. */
  for (let round = 0; round < 8; round++) {
    const holder = claimHolder(abs)
    if (!holder || holder.webContents.id === event.sender.id) break
    await askRendererToFlush(holder)
    // Somebody else took it out from under this one while the flush ran; that
    // window has already been told, and the new holder is dealt with next time
    // round.
    if (editClaims.get(abs) !== holder.webContents.id) continue
    /* Cleared before the telling, so a second taker waiting on the same window
       finds the document free rather than flushing one that has given it up. */
    editClaims.delete(abs)
    sendTo(holder, 'document:yielded', p)
  }
  /* Set after the flush, not before: until the holder's work is on disk this
     window has no business believing the document is its. */
  editClaims.set(abs, event.sender.id)
  return { ok: true }
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

/* The application menu is process-wide on macOS, while the document on screen
   belongs to one window. Keep the active kind per window so focusing a second
   window also gives it the right contextual sections. */
const menuDocumentKinds = new Map()
const menuDocumentKind = () => {
  const win = focusedWindow()
  return win ? menuDocumentKinds.get(win.webContents.id) || '' : ''
}

/* Zoom is per window — it is the size of the text in front of you, and a
   second window opened to read something beside the first has every reason to
   be at a different one. What is written to the config is the last size asked
   for anywhere, which is what a new window starts at. */
const zoomWork = new WeakMap()
const pendingZooms = new WeakMap()
function zoomFactor () {
  const win = focusedWindow()
  if (!win) return 1
  return pendingZooms.get(win) || win.webContents.getZoomFactor()
}

/* A native zoom swaps the size of Chromium's macOS surface before its first
   paint at that size. The preload gives it a fully painted CSS-equivalent
   frame first, so the native swap has something to show instead of revealing
   the window background along the right edge. Two animation frames are enough
   to commit that staging paint; the timeout keeps a renderer on its way out
   from ever holding a menu command open. */
let zoomStageId = 0
const zoomStageWaits = new Map()

function stageZoom (win, ratio) {
  return /** @type {Promise<void>} */ (new Promise((resolve) => {
    const id = ++zoomStageId
    const timer = setTimeout(() => {
      zoomStageWaits.delete(id)
      resolve()
    }, 75)
    zoomStageWaits.set(id, () => {
      clearTimeout(timer)
      zoomStageWaits.delete(id)
      resolve()
    })
    sendTo(win, 'zoom:stage', { id, ratio })
  }))
}

ipcMain.on('zoom:staged', (_event, id) => zoomStageWaits.get(Number(id))?.())

async function commitZoom (win, clamped) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  const current = win.webContents.getZoomFactor()
  if (Math.abs(current - clamped) > 0.005) await stageZoom(win, clamped / current)
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.setZoomFactor(clamped)
  sendTo(win, 'zoom:unstage')
  scheduleWindowRepaint(win)
  writeConfig({ zoom: clamped })
  sendTo(win, 'zoom', Math.round(clamped * 100))
}

function applyZoom (factor) {
  const win = focusedWindow()
  if (!win) return
  const clamped = Math.min(/** @type {number} */ (ZOOM_STEPS.at(-1)), Math.max(ZOOM_STEPS[0], factor))
  pendingZooms.set(win, clamped)
  const work = (zoomWork.get(win) || Promise.resolve())
    .catch(() => {})
    .then(() => commitZoom(win, clamped))
  zoomWork.set(win, work)
  return work.finally(() => {
    if (zoomWork.get(win) === work) {
      zoomWork.delete(win)
      pendingZooms.delete(win)
    }
  })
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
  const notebookActive = menuDocumentKind() === 'notebook'
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
        { label: 'Back up Vault…', command: 'backup-vault', click: () => toFocused('menu', 'backup-vault') },
        { label: 'Restore Vault…', command: 'restore-vault', click: () => toFocused('menu', 'restore-vault') },
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
        { label: 'Export Notebook as Script…', visible: notebookActive, command: 'export-notebook-script', click: () => toFocused('menu', 'export-notebook-script') },
        { label: 'Export Notebook as HTML…', visible: notebookActive, command: 'export-notebook-html', click: () => toFocused('menu', 'export-notebook-html') }
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
      visible: notebookActive,
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
  Menu.setApplicationMenu(Menu.buildFromTemplate(/** @type {any} */ (template)))
}

async function pickVault () {
  const res = await dialog.showOpenDialog(/** @type {any} */ (focusedWindow()), {
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

/* Choosing the default vault without switching to it. A native dialog, so the
   folder is the reader's own choice by definition; it is added to the recent
   list on the way past, which is what makes it subsequently settable through
   `config:set` — the value check there only accepts the open vault or a recent
   one. Returns the picked folder, or null when nothing was chosen. */
ipcMain.handle('vault:pick-default', async () => {
  const res = await dialog.showOpenDialog(/** @type {any} */ (focusedWindow()), {
    title: 'Choose Default Vault',
    message: 'Tulip opens this folder on every launch.',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Choose as Default'
  })
  if (res.canceled || !res.filePaths[0]) return null
  rememberVault(res.filePaths[0])
  return res.filePaths[0]
})

/* ------------------------------------------------------------ vault backup
   Backups are ordinary folders with a manifest and SHA-256 entries. That keeps
   the result inspectable and portable without adding an archive dependency. */
async function backupCurrentVault (event) {
  if (!vaultPath) return { ok: false, error: 'Open a vault before backing it up.' }
  const flushed = await flushAllWindows()
  if (flushed.some((result) => result?.failed)) {
    return { ok: false, error: 'The vault could not be saved before the backup.' }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const suggested = `${path.basename(vaultPath)}-${stamp}${BACKUP_EXTENSION}`
  const picked = await dialog.showSaveDialog(/** @type {any} */ (windowOf(event)), {
    title: 'Back up vault',
    defaultPath: path.join(app.getPath('documents'), suggested),
    filters: [{ name: 'Tulip backup folder', extensions: [BACKUP_EXTENSION.slice(1)] }]
  })
  if (picked.canceled || !picked.filePath) return { canceled: true }

  const target = picked.filePath.toLowerCase().endsWith(BACKUP_EXTENSION)
    ? picked.filePath
    : `${picked.filePath}${BACKUP_EXTENSION}`
  try {
    const manifest = await backupVault(vaultPath, target)
    return { ok: true, path: target, files: manifest.files.length }
  } catch (error) {
    return { ok: false, error: error?.message || 'The vault backup could not be created.' }
  }
}

async function restoreBackup (event) {
  const flushed = await flushAllWindows()
  if (flushed.some((result) => result?.failed)) {
    return { ok: false, error: 'The vault could not be saved before restoring.' }
  }

  const picked = await dialog.showOpenDialog(/** @type {any} */ (windowOf(event)), {
    title: 'Choose a Tulip backup folder',
    properties: ['openDirectory']
  })
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
  const source = picked.filePaths[0]

  let manifest
  try {
    const { verifyBackup } = require('./vault-backup')
    manifest = await verifyBackup(source)
  } catch (error) {
    return { ok: false, error: error?.message || 'That folder is not a valid Tulip backup.' }
  }

  const destination = await dialog.showOpenDialog(/** @type {any} */ (windowOf(event)), {
    title: 'Choose where to restore the vault',
    properties: ['openDirectory', 'createDirectory']
  })
  if (destination.canceled || !destination.filePaths[0]) return { canceled: true }

  const parent = destination.filePaths[0]
  const name = path.basename(String(manifest.sourceName || 'Vault')) || 'Vault'
  let target = path.join(parent, `${name} Restored`)
  for (let number = 2; fsSync.existsSync(target); number++) {
    target = path.join(parent, `${name} Restored ${number}`)
  }

  try {
    await restoreVault(source, target)
    await openVault(target)
    return { ok: true, path: target, files: manifest.files.length }
  } catch (error) {
    return { ok: false, error: error?.message || 'The backup could not be restored.' }
  }
}

ipcMain.handle('vault:backup', backupCurrentVault)
ipcMain.handle('vault:restore', restoreBackup)

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

/**
 * How much of a file the app will pull into a window in one piece.
 *
 * Every read below hands the whole file to the renderer as a single string, and
 * every one of those strings is then parsed, highlighted or laid out on the
 * main thread. There is no size at which that becomes a good idea, but there is
 * a size at which it stops being survivable: a stray gigabyte log file opened
 * from the tree used to lock the window until the process was killed, with no
 * message and nothing to cancel. Refusing is not a limitation of the format —
 * it is the difference between "this file is too big to open here" and a beach
 * ball.
 */
/* The read-and-inspect file handlers — file:read, file:read-encoded,
   file:info, file:probe, file:open-default, file:reveal, file:conflict-copy —
   live in electron/ipc-files.js, with the read-with-stamp discipline and the
   conflict-copy episodes. The open-size ceiling stays here: the docx read
   below refuses through the same `tooBig`. */
const MAX_OPEN_BYTES = 64 * 1024 * 1024

const tooBig = (abs, size) => Object.assign(
  new Error(`“${path.basename(abs)}” is ${Math.round(size / (1024 * 1024))} MB, which is too large to open here.`),
  { code: 'TULIP_TOO_LARGE', size, limit: MAX_OPEN_BYTES }
)

/* Registered here, where the ceiling the reads honour is defined. `indexDirty`
   and the trust store are main's, so they cross as accessors. The dirty mark
   takes the conflict copy's path, so the next sync stats that file rather than
   walking the vault. */
makeFilesDomain({
  realSafePath,
  rel,
  languageHistory,
  getTrust: () => trust,
  noteSelfWrite: /** @type {any} */ (noteSelfWrite),
  markIndexDirty,
  invalidateVaultSnapshot: () => invalidateVaultSnapshot(),
  freeName,
  maxOpenBytes: MAX_OPEN_BYTES,
  tooBig
}).register()

/**
 * A file whose encoding the app did not choose.
 *
/* The encoding sniff's byte count moved with file:probe into
   electron/ipc-files.js. */

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
    /* A `.docx` is a zip, and it is inflated whole — the pictures with it —
       before a single paragraph can be drawn. The ceiling is the same one every
       other read in this file answers to, and it is here for the same reason:
       a file too big to draw should say so rather than take the window with
       it. */
    if (stat.size > MAX_OPEN_BYTES) throw tooBig(abs, stat.size)
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
    const { readDocxFiles, writeDocx, isStaleDocxError } = require('./docx')
    let made, files
    try {
      ({ buffer: made, files } = writeDocx(await fs.readFile(abs), edit))
    } catch (err) {
      if (!isStaleDocxError(err)) throw err
      /* The file is not the one the page was read from. Without `force` the
         renderer is told so and decides — it puts the disk's version aside
         first, then asks again with `force`, and the page is spliced into the
         bytes it was read from rather than the stranger's. */
      const original = edit?.force ? docxOriginals.get(abs) : null
      if (!original) return { ok: false, stale: true, error: err.message }
      ;({ buffer: made, files } = writeDocx(original, edit))
    }
    /* Balanced durability: the write lands now and is checkpointed to the
       disk's platters on a timer, on hide and on quit — fast everywhere,
       including networked volumes. */
    await writeAtomic(abs, made, { durable: false })
    rememberDocxOriginal(abs, made)
    documentsChanged()
    const stat = await fs.stat(abs).catch(() => null)
    /* From the parts the writer just built rather than from the bytes it
       zipped them into: reading those back was a second inflate and checksum
       of every picture in the file, on the main thread, per autosave. */
    const document = readDocxFiles(files)
    /* Search should find what was typed a moment ago rather than waiting for
       the next walk of the vault — the same courtesy `touchIndex` does a note
       on every autosave. */
    await touchDocxIndex(abs, document.blocks, stat)
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

/** A file handed to whatever the desktop opens it with — this handler, like
    the rest of the read-and-inspect family, lives in electron/ipc-files.js. */

/**
 * Every note's text, in one message — a page of it.
 *
 * For the sweeps that have to read all of them and resolve what they find with
 * the renderer's own scanners — the orphaned-image search is the one — which
 * cannot run here. Asking note by note was a round trip, a `realSafePath` and a
 * `readFile` each, thousands of times over, for text the index is already
 * holding in memory on this side.
 *
 * Paged rather than whole: the unpaged form handed every note's full text to
 * the renderer as a single message, so one sweep over a large vault was tens
 * of megabytes across IPC. `offset`/`limit` page through the index in key
 * order; `total` says how many pages there are. No arguments answers the
 * first page (`limit` 200) with its total, which is also what callers written
 * against the old whole-vault array should treat as "ask again with an
 * offset" rather than as the vault.
 *
 * A note too large to index (see MAX_INDEX_BYTES) is read from disk rather than
 * returned empty: a sweep that quietly skips a note is a sweep that calls a
 * picture orphaned on the strength of not having looked at the note that uses
 * it — and the dialog on the other end of this offers to delete them.
 */
const VAULT_NOTES_DEFAULT_LIMIT = 200
const VAULT_NOTES_MAX_LIMIT = 1000
ipcMain.handle('vault:notes', async (_e, opts = null) => {
  const page = { notes: [], total: 0, offset: 0, limit: VAULT_NOTES_DEFAULT_LIMIT }
  if (!vaultPath) return page
  await ensureIndex()
  const total = index.size
  const offset = Math.max(0, Math.floor(Number(opts?.offset) || 0))
  const asked = opts?.limit == null ? VAULT_NOTES_DEFAULT_LIMIT : Math.floor(Number(opts.limit) || 0)
  const limit = Math.min(VAULT_NOTES_MAX_LIMIT, Math.max(1, asked || VAULT_NOTES_DEFAULT_LIMIT))
  const keys = [...index.keys()].slice(offset, offset + limit)
  const notes = await mapLimit(keys, WALK_LIMIT, async (key) => {
    const entry = index.get(key)
    if (!entry) return null
    if (entry.size <= MAX_INDEX_BYTES) return { path: key, text: entry.text }
    const text = await fs.readFile(path.resolve(/** @type {string} */ (vaultPath), key), 'utf8').catch(() => '')
    return { path: key, text }
  })
  return { notes: notes.filter(Boolean), total, offset, limit }
})

/* pdf.js gets its guarded document URL from the `pdf:source` handler, which
   lives in electron/ipc-pdf.js beside the rest of the PDF handlers; the
   protocol answering the URL's range requests is registered below, where the
   session is. */

/* The conflict-copy handler and its episode bookkeeping live in
   electron/ipc-files.js, with the reasoning for sharing one copy per
   disagreement. */

/* The write-and-restructure core — file:write, file:rename, file:move,
   file:delete, file:import — lives in electron/ipc-vault-write.js, together
   with renameDocument, which the copilot's rename consumption also drives.
   The machinery these gestures share with the watcher and the index sync —
   the relocate chain, the index touchers, the path guards, the atomic write —
   stays here and crosses as the context below. */
const vaultWriteDomain = makeVaultWriteDomain({
  realSafePath,
  realSafeTargetPath,
  rel,
  getVaultPath: () => vaultPath,
  freeName,
  noteSelfWrite: /** @type {any} */ (noteSelfWrite),
  markIndexDirty,
  invalidateVaultSnapshot: () => invalidateVaultSnapshot(),
  getTrust: () => trust,
  languageHistory,
  review,
  relocate,
  notesUnder,
  trashAttachments,
  isSnapshotFile,
  documentsChanged,
  touchIndex,
  touchDocumentIndex,
  touchWhiteboardIndex,
  getIndex: () => index,
  ensureIndex,
  getPythonEnvs: () => pythonEnvs,
  assertReal,
  annotationFile: (p) => annotationFile(p),
  writeAtomic,
  readConfig,
  maxVersionedBytes: MAX_VERSIONED_BYTES,
  maxIndexBytes: MAX_INDEX_BYTES,
  ignoredDirs: IGNORED_DIRS
})
vaultWriteDomain.register()
/* The eight "new …" handlers live in electron/ipc-create.js, with the name
   rules they share and the reasoning for each kind's empty file. `indexDirty`
   and the trust store are main's, so they cross as the accessors below. */
makeCreateDomain({
  freeName,
  realSafePath,
  noteSelfWrite: /** @type {any} */ (noteSelfWrite),
  rel,
  getTrust: () => trust,
  markIndexDirty,
  invalidateVaultSnapshot: () => invalidateVaultSnapshot()
}).register()


/* The per-file metadata handlers live in electron/ipc-metadata.js; the stores
   themselves stay here, where the index and the search filters read them. */
makeMetadataDomain({
  realSafePath,
  rel,
  getVaultPath: () => vaultPath,
  fileTags,
  fileMarks,
  tableWidths
}).register()

/**

ipcMain.handle('shell:open', async (_e, url) => {
  if (/^(?:https?|mailto):/i.test(url)) await shell.openExternal(url)
})

/* Where the TeX preview's compiled PDFs are cached, under userData. Served by
   the protocol handler below and written by the render domain's compiler. */
const TEX_PREVIEW_DIR = () => path.join(app.getPath('userData'), 'tex-preview')

/* Electron's clipboard rather than the page's. `navigator.clipboard.writeText`
   refuses outright — "Document is not focused" — whenever the window is not the
   focused one, which is exactly the state a page is in while a native context
   menu is up, and it can only be found out about after the copy silently did
   not happen. This one has no such condition. */
ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text ?? ''))
  return true
})

/* ------------------------------------------------------------ spelling

   The checkers, the verdict memo and their handlers live in
   electron/ipc-spell.js, with the reasoning for the memo and the chunked
   pass. Main keeps the one hook that is main's own: the native context menu
   over an underlined word teaches it through the same `teachWord`. */
const spellDomain = makeSpellDomain({
  broadcast,
  appAsset,
  readConfig
})
const { teachWord } = spellDomain
spellDomain.register()

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

/**
 * @param {string} term
 * @param {{ regex?: any, caseSensitive?: any, word?: any }} options
 */
function termRegex (term, { regex, caseSensitive, word }) {
  if (regex && (NESTED_QUANTIFIER.test(term) || overlappingAlternation(term))) {
    /** @type {Error & { sayWhy?: boolean }} */
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
  const compiled = { find: new RegExp(source, `g${flags}`), has: new RegExp(source, flags) }
  /* A literal term answered without the regex engine. The source above is the
     escaped term with only a case flag, so for ASCII text a lowercased
     `includes` is the same answer — and the vault scan asks it once per note
     per keystroke for the title ranking (see `nameHas` in vault-scan.js).
     Non-ASCII keeps the regex, whose `i` folding and `toLowerCase` do not
     always agree; word and regex modes keep it too, for the boundaries and
     the pattern. */
  if (!regex && !word && /^[\x00-\x7F]*$/.test(term)) {
    if (caseSensitive) compiled.literal = term
    else compiled.literalFold = term.toLowerCase()
  }
  return compiled
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
  /** @type {{ tag: string[], path: string[], file: string[], prop: Array<{ key: string, value: (string | null) }>, type: string[] }} */
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

/* The per-note tests and the per-vault loop both live in electron/vault-scan.js
   — pure, measurable, and the one place that decides what a search sees.

   The tag inventory and the unlinked-mentions scan (electron/ipc-vault-info.js)
   walk notes with the same `HASHTAG` expression, imported there — one
   expression for "this is a tag" is the only way the three can agree.
   `tag:book` answers for `#book/fiction` too, so a filter names a branch of
   the tag tree rather than one leaf of it. */

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
/**
 * @param {any} q
 * @param {Set<string> | null} [only]
 */
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
            const named = q.terms.filter((term) => nameHas(term, name.toLowerCase(), name)).length
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

/* Bumped by every search the box asks for, per window. A scan compares the
   number it took on the way in against the one standing now, and stops the
   moment they differ.

   Per window because two windows on one vault each have a search box, and one
   counter between them would let a reader typing in the second empty the panel
   in the first — the scan there would stand aside for a query that was never
   going to be painted into it. Keyed by the webContents id; a window that has
   gone leaves one number behind, which is the whole of what it costs. */
const searchGenerations = new Map()

const nextSearchGeneration = (channel) => {
  const next = (searchGenerations.get(channel) || 0) + 1
  searchGenerations.set(channel, next)
  return next
}

/** A named function rather than an inline handler because the search now has
   two callers: the overlay, and the Copilot's request file — see
   `consumeAiSearch`.
   *
   * @param {any} raw
   * @param {any} [opts]
   * @param {{ channel?: (number | null) }} [progress]
   */
async function searchVault (raw, opts = {}, { channel = null } = {}) {
  /* Which search this is, claimed before anything else can happen.
   *
   * A reader typing a seven-letter word asks seven times, and only the last of
   * them is an answer anybody will see — so the six before it stand aside as
   * soon as the next one starts, rather than scanning the vault to the end for
   * a result that is already stale. The renderer keeps a token of its own and
   * ignores an old reply; this is the other half of that, and the half that
   * saves the work.
   *
   * Taken synchronously, on the first line, for the same reason the renderer's
   * is: it decides *which search is newer*, and that has to be settled by the
   * order the calls arrived in. Claimed after an await, two searches racing
   * through `ensureIndex` could take their numbers in either order, and the
   * one that stood aside would be whichever the event loop happened to resume
   * second.
   *
   * Only the search box works this way, and only against itself: `channel` is
   * the window that asked. The copilot asks for one search whose answer it is
   * waiting for, and it must neither cancel a reader's typing nor be cancelled
   * by it — it passes no channel, takes no number, and never stands aside. */
  const mine = channel === null ? -1 : nextSearchGeneration(channel)
  const stop = () => channel !== null && mine !== searchGenerations.get(channel)

  // One shape, whichever way this answers.
  const nothing = { results: [], truncated: false, unsearched: 0, unsearchedPaths: [] }
  /* One shape for an abandoned search. Never recorded and never painted: the
     renderer's own token has already moved on, and `lastSearch` must not learn
     anything from a scan that did not see the whole vault. */
  const abandoned = { ...nothing, cancelled: true }

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

  /* The index may have been built by the await above, during which a newer
     query arrived — the whole point of standing aside is to do it before the
     expensive part, not after. */
  if (stop()) return abandoned

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
  const documentsLooking = narrowed
    ? (lastSearch.documentKeys || [])
        .map((key) => [key, documentIndex.get(key)]).filter(([, entry]) => entry)
    : documentIndex

  // What this answer will be narrowed from next, gathered as it is built.
  const keys = []
  const whiteboardKeys = []
  const docxKeys = []
  const documentKeys = []

  /* The four kinds, one after another rather than all at once: they share the
     one result list and the one budget of time, and a scan that stood aside
     halfway through the third has still done nothing wrong — the caller
     discards the whole answer. Each pass yields to the event loop every
     SLICE_MS (4 ms) and re-checks the window's generation every
     NOTES_PER_CLOCK_READ (64) notes — see electron/vault-scan.js — so the
     scan stays on the main process without stalling it, and stays cancellable
     per window without a worker to coordinate. */
  const scans = [
    {
      entries: looking,
      into: keys,
      limit: MAX_INDEX_BYTES,
      rankHeadings: true,
      kindOf: () => 'note',
      factsFor: (key) => ({ kind: 'note', fileTags: assignedTags[key] || [] })
    },
    /* Whiteboards are indexed from text elements only. Their JSON may contain
       megabytes of pasted-image data, which is neither useful search text nor a
       string the search path should scan on every keystroke. */
    {
      entries: whiteboardsLooking,
      into: whiteboardKeys,
      limit: MAX_WHITEBOARD_INDEX_BYTES,
      kindOf: () => 'whiteboard',
      factsFor: (key, entry) => ({ kind: entry.kind, fileTags: assignedTags[key] || [] })
    },
    /* Word documents, indexed from the text electron/docx.js reads out of the
       zip — never the zip itself, which is compressed bytes and a stylesheet.
       Everything else is a note's rules: the same filters, the same scoring,
       the same report when one was too large to read. */
    {
      entries: docxLooking,
      into: docxKeys,
      limit: MAX_DOCX_INDEX_BYTES,
      kindOf: () => 'docx',
      factsFor: (key, entry) => ({ kind: entry.kind, fileTags: assignedTags[key] || [] })
    },
    /* Source files, data files and notebooks — the vault's own text that is not
       prose, held in `documentIndex` on the same terms as the tables above. The
       name keeps its extension because the tree shows it that way, and a term in
       it scores the way a title does: `solve.py` typed into search almost always
       means the file called that. */
    {
      entries: documentsLooking,
      into: documentKeys,
      limit: MAX_INDEX_BYTES,
      kindOf: (entry) => entry.kind,
      factsFor: (key, entry) => ({ kind: entry.kind, fileTags: assignedTags[key] || [] })
    }
  ]

  for (const scan of scans) {
    const found = await scanKind({
      entries: scan.entries,
      query: q,
      narrowed,
      kindOf: scan.kindOf,
      factsFor: scan.factsFor,
      limit: scan.limit,
      rankHeadings: scan.rankHeadings,
      stop
    })
    if (found.stopped) return abandoned
    scan.into.push(...found.keys)
    results.push(...found.results)
    for (const skipped of found.unsearched) {
      unsearched++
      // Twenty is all a reader will open; the count keeps the whole truth.
      if (unsearchedPaths.length < 20) unsearchedPaths.push(skipped)
    }
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
     make finding it require no special grammar. Skipped outright when nothing
     carries a tag — the common vault — rather than walking every result built
     so far to learn the loop would do nothing. */
  const taggedPaths = Object.entries(assignedTags)
  const hasTags = taggedPaths.some(([, tags]) => Array.isArray(tags) && tags.length > 0)
  if (hasTags) {
  const already = new Set(results.map((result) => result.path))
  for (const [taggedPath, tags] of taggedPaths) {
    if (already.has(taggedPath)) continue
    const normalized = cleanFileTags(tags) || []
    if (q.filters.tag.length && !q.filters.tag.every((wanted) =>
      normalized.some((tag) => tag === wanted || tag.startsWith(`${wanted}/`)))) continue
    if (q.filters.path.length && !q.filters.path.every((part) => taggedPath.toLowerCase().includes(part))) continue
    const name = path.basename(taggedPath, path.extname(taggedPath))
    if (q.filters.file.length && !q.filters.file.every((part) => name.toLowerCase().includes(part))) continue
    if (q.filters.type.length) continue
    const label = normalized.join(' ')
    /* The label is already lowercase (see `cleanFileTags`), so it is its own
       folded form for the literal fast path. */
    if (q.terms.length && !q.terms.every((term) => nameHas(term, label, label))) continue
    if (!q.terms.length && !q.filters.tag.length) continue
    const kind = isPdf(taggedPath) ? 'pdf' : isWhiteboard(taggedPath) ? 'whiteboard' : 'note'
    results.push({
      path: taggedPath, name, kind,
      hits: [{ line: 1, col: 0, page: 1, text: normalized.map((tag) => `#${tag}`).join(' ') }],
      total: 0, score: 12
    })
  }
  }

  lastSearch = {
    generation: indexGeneration,
    words: q.words,
    filters: q.filters,
    opts: { regex: !!opts.regex, word: !!opts.word, caseSensitive: !!opts.caseSensitive },
    keys,
    whiteboardKeys,
    docxKeys,
    documentKeys,
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

/* The window that asked is what a scan stands aside for — see
   `searchGenerations`. Without one (nothing in the app, but the IPC harness
   calls handlers directly) the search simply runs to the end, which is the
   safe direction: an answer nobody cancelled is still a correct answer. */
ipcMain.handle('search:vault', (event, raw, opts = {}) =>
  searchVault(raw, opts, { channel: event?.sender?.id ?? null }))

/* The tag inventory lives in electron/ipc-vault-info.js, beside the
   backlinks answer — both are cached against the index generation. */

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
      await touchIndex(abs, next, await writeAtomic(abs, next))
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

/* The link-resolution table (every note's basename and full path) and the
   backlinks answer live in electron/ipc-vault-info.js, which main asks to
   forget wherever the index gains or loses a key. The alias table below
   stays: it is main's, read on the rename path. */
const vaultInfoDomain = makeVaultInfoDomain({
  getVaultPath: () => vaultPath,
  ensureIndex,
  getIndex: () => index,
  getIndexGeneration: () => indexGeneration,
  fileTags: /** @type {any} */ (fileTags),
  cleanFileTags: /** @type {any} */ (cleanFileTags),
  stripExt,
  linkTarget,
  mergeSpans,
  wordBefore: WORD_BEFORE,
  wordAfter: WORD_AFTER,
  codeOrLink: CODE_OR_LINK
})
vaultInfoDomain.register()

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
/** @type {Map<any, any> | null} */
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


/* The backlinks answer and its caches live in electron/ipc-vault-info.js. */


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

/* How large a pasted file may be. The bytes arrive as one message and are held
   as one Buffer, so without a ceiling a single paste is an unbounded IPC
   transfer followed by an unbounded write. The ceiling is the same one every
   open in this file answers to: a file too large to open here is too large to
   paste here, and it says so rather than taking the window with it. */
const ASSET_MAX_BYTES = MAX_OPEN_BYTES

const assetTooBig = (name, size) => Object.assign(
  new Error(`“${name}” is ${Math.round(size / (1024 * 1024))} MB, which is too large to attach here (limit ${Math.round(ASSET_MAX_BYTES / (1024 * 1024))} MB).`),
  { code: 'TULIP_TOO_LARGE', size, limit: ASSET_MAX_BYTES }
)

ipcMain.handle('asset:write', async (_e, noteName, ext, bytes) => {
  const base = String(noteName || 'Untitled')
  const suffix = pastedExtension(ext)
  const byteLength = bytes?.byteLength ?? bytes?.length ?? 0
  if (byteLength > ASSET_MAX_BYTES) throw assetTooBig(`${base}${suffix}`, byteLength)

  const folder = await realSafePath(path.join(ATTACHMENT_DIR, base.replace(/[/\\]/g, '-')))
  await fs.mkdir(folder, { recursive: true })

  const target = await freeAttachmentName(folder, base, suffix)
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
  /* The whole file at once, like `asset:write` above — and the same ceiling,
     for the same reason. */
  if (buffer.length > ASSET_MAX_BYTES) throw assetTooBig(`pasted image${suffix}`, buffer.length)

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
    const target = await freeName(folder, parsed.name, parsed.ext)
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

/* The sidecar path above is shared with the index machinery (a deletion
   removes the sidecar; the pdf text facts read it), so it stays here and the
   handlers below take it through the context. */
makePdfDomain({
  realSafePath,
  rel,
  isPdf,
  assertReal,
  writeAtomic,
  annotationFile,
  forgetPdfSearchFacts,
  ensurePdfText,
  windowOf
}).register()

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

/* ------------------------------------------------------- vault export/import

   Whole-vault Markdown export: every `.md` note copied to a chosen folder,
   preserving relative paths. Derived state (`.tulip`, `.trash`, `.git`) does
   not travel. Import is the reverse: `.md` files from a folder copied into
   the vault without overwriting. */

ipcMain.handle('vault:export-all', async (event, to) => {
  const win = windowOf(event)
  if (!vaultPath) return { ok: false, error: 'Open a vault first.' }
  let dir = typeof to === 'string' && to ? to : null
  if (!dir) {
    if (!win) return { ok: false, error: 'There is no window to export from.' }
    const chosen = await dialog.showOpenDialog(win, {
      title: 'Export vault as Markdown',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (chosen.canceled || !chosen.filePaths?.[0]) return { ok: false, canceled: true }
    dir = chosen.filePaths[0]
  }
  try {
    const SKIP = new Set(['.git', '.obsidian', '.tulip', 'node_modules', '__pycache__', '.trash'])
    let copied = 0
    const walk = async (from, prefix = '') => {
      const entries = await fs.readdir(from, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        if (SKIP.has(entry.name)) continue
        const abs = path.join(from, entry.name)
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          await walk(abs, rel)
        } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
          const target = path.join(dir, ...rel.split('/'))
          if (!target.startsWith(path.resolve(dir) + path.sep)) continue
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.copyFile(abs, target)
          copied++
        }
      }
    }
    await walk(vaultPath)
    return { ok: true, path: dir, copied }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('vault:import-folder', async (event, from) => {
  const win = windowOf(event)
  if (!vaultPath) return { ok: false, error: 'Open a vault first.' }
  let dir = typeof from === 'string' && from ? from : null
  if (!dir) {
    if (!win) return { ok: false, error: 'There is no window to import from.' }
    const chosen = await dialog.showOpenDialog(win, {
      title: 'Import Markdown folder',
      properties: ['openDirectory']
    })
    if (chosen.canceled || !chosen.filePaths?.[0]) return { ok: false, canceled: true }
    dir = chosen.filePaths[0]
  }
  try {
    let copied = 0
    let skipped = 0
    const walk = async (srcDir, prefix = '') => {
      const entries = await fs.readdir(srcDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const abs = path.join(srcDir, entry.name)
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          await walk(abs, rel)
        } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
          const target = path.join(/** @type {string} */ (vaultPath), ...rel.split('/'))
          if (!target.startsWith(path.resolve(/** @type {string} */ (vaultPath)) + path.sep)) { skipped++; continue }
          try {
            await fs.stat(target)
            skipped++ // never overwrite
          } catch {
            await fs.mkdir(path.dirname(target), { recursive: true })
            await fs.copyFile(abs, target)
            copied++
          }
        }
      }
    }
    await walk(path.resolve(dir))
    return { ok: true, copied, skipped }
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
    const chosen = await dialog.showSaveDialog(/** @type {any} */ (windowOf(event)), {
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
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null
    const finish = (err, result) => {
      if (settled) return
      settled = true
      clearTimeout(/** @type {any} */ (timer))
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
/** @type {Promise<any> | null} */
let pdfTextRunning = null
const pdfTextWaiting = []
const pdfTextQueued = new Map()

function pumpPdfText () {
  if (pdfTextRunning || !pdfTextWaiting.length) return
  let at = pdfTextWaiting.findIndex((record) => record.urgent)
  if (at < 0) at = 0
  const record = pdfTextWaiting.splice(at, 1)[0]
  const running = /** @type {Promise<any>} */ (record.start())
  pdfTextRunning = running
  running.then(() => {
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
 *
 * @param {string} relPath
 * @param {{ onWork?: () => void }} [options]
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
const SWEEP_QUIET_MS = 10_000
const lastSweep = new Map() // vault-relative prefix -> when it was last swept
async function sweepPdfText (prefixes = ['']) {
  if (!vaultPath) return
  /* Not twice in ten seconds for the same folder. A sweep is a stat of every
     PDF under the prefix, and a directory being renamed, unpacked or synced
     raises a run of these; the second and later add nothing the first did not
     find, and a PDF that does change reaches `ensurePdfText` by its own event
     or on demand when it is opened. */
  const now = Date.now()
  prefixes = prefixes.filter((p) => !(lastSweep.has(p) && now - lastSweep.get(p) < SWEEP_QUIET_MS))
  if (!prefixes.length) return
  for (const p of prefixes) lastSweep.set(p, now)
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
  ...MD_EXT, TEX_EXT, SITE_EXT, ...CODE_EXT, ...DATA_EXT
])

async function inlineAttachments (context, totalBytes = INLINE_ATTACHMENT_BYTES * 8) {
  const paths = (context?.attachments || [])
    .map((file) => String(file || ''))
    .filter((file) => INLINE_ATTACHMENT_EXT.has(path.extname(file).toLowerCase()))
  if (!paths.length) return []

  const read = await Promise.all(paths.map(async (file) => {
    try {
      const abs = await realSafeTargetPath(file)
      const stat = await fs.stat(abs)
      if (!stat.isFile() || stat.size > INLINE_ATTACHMENT_BYTES) return null
      return { path: file, text: await fs.readFile(abs, 'utf8'), bytes: stat.size }
    } catch { return null }
  }))
  let used = 0
  const selected = []
  for (const entry of read) {
    if (!entry || used + entry.bytes > totalBytes) continue
    used += entry.bytes
    selected.push({ path: entry.path, text: entry.text })
  }
  return selected
}

/**
 * @param {string} question
 * @param {any} context
 * @param {string | null} [turnId]
 */
async function preparePdfTurn (question, context, turnId = null) {
  const budget = context?.contextBudget || {}
  const inlined = await inlineAttachments(context, Number(budget.attachments) || undefined)
  context = { ...(context || {}) }
  delete context.contextBudget
  if (inlined.length) context.attachmentTexts = inlined

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
      const { pages, ocrPages, mtimeMs, size } = await pdfPagesOf(result.sidecar)
      return {
        path: pdfPath,
        textPath: result.textPath,
        pages,
        openPage: context?.kind === 'pdf' && context.note === pdfPath ? context.page : 0,
        ocrPages: result.ocrPages || ocrPages,
        revision: `${mtimeMs}:${size}`
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
      pdfDocuments: documents.map((document) => ({
        path: document.path,
        textPath: document.textPath,
        pages: document.pages.length,
        ocrPages: document.ocrPages
      })),
      pdfContext: relevantPdfContext(question, /** @type {any} */ (documents), {
        maxChars: Number(budget.pdf) || undefined
      })
    }
  }
}

/**
 * Keeps a PDF's highlights attached to it through a rename, a move, or a
 * delete. Called for notes too, which simply have no sidecar to find — the
 * check is cheaper than deciding which of the two moved, and a folder move
 * carries a whole mirrored subtree in one rename either way.
 */
/**
 * The folder a file's pasted attachments live in.
 *
 * `asset:write` files them under `.attachments/<the name the tree shows>/`, and
 * the tree shows a note, a paper or a Word document by its stem while showing
 * a script by its full filename. That rule is `stripLinkExt`, which is stated
 * once and read here so the two cannot drift — a folder computed by a different
 * rule is a folder nothing ever finds again.
 */
const attachmentFolderName = (relPath) =>
  path.basename(stripLinkExt(String(relPath || ''))).replace(/[/\\]/g, '-')

const attachmentFolderFor = (relPath) => {
  const name = attachmentFolderName(relPath)
  return name ? path.join(/** @type {string} */ (vaultPath), ATTACHMENT_DIR, name) : ''
}

/** Whether anything else in the vault would file its attachments in the same
 *  folder. Two notes called "Trip" in different folders share one, which is a
 *  limitation of naming them by name — but it means the folder belongs to
 *  neither of them alone, and neither may take it away. */
async function attachmentFolderShared (relPath, folderName) {
  const snapshot = await getVaultSnapshot()
  const mine = String(relPath || '').toLowerCase()
  const wanted = folderName.toLowerCase()
  return (snapshot.files || []).some((key) =>
    key.toLowerCase() !== mine && attachmentFolderName(key).toLowerCase() === wanted)
}

/**
 * A file's pasted pictures, following it to its new name.
 *
 * The folder is keyed by name, so only a change of *name* moves it — a note
 * dragged into another folder keeps both its name and its pictures where they
 * were. What is inside is not renamed with it: a note writes `![[Trip-0.png]]`,
 * a bare name that `assetIndex` resolves anywhere in the vault, so the pictures
 * go on resolving from wherever they now sit. Renaming them as well would edit
 * the note's text for no gain and every chance of getting it wrong.
 *
 * Refused rather than merged when the destination already exists: two notes'
 * pictures in one folder cannot be told apart again, and the reader is far
 * better served by a rename that left the old folder alone than by one that
 * quietly mixed two sets of images together.
 */
async function carryAttachments (fromRel, toRel) {
  if (!vaultPath) return
  const oldName = attachmentFolderName(fromRel)
  const newName = attachmentFolderName(toRel)
  if (!oldName || !newName || oldName === newName) return

  const from = attachmentFolderFor(fromRel)
  const to = attachmentFolderFor(toRel)
  if (!from || !to) return
  /* One `stat` per end rather than two blocking existence probes. */
  if (!await fs.stat(from).then(() => true).catch(() => false)) return
  if (await fs.stat(to).then(() => true).catch(() => false)) return
  if (await attachmentFolderShared(fromRel, oldName)) return

  try {
    /* Both ends, before either is touched — the same guard `carryAnnotations`
       takes, and for the same reason: a symlinked `.attachments` in a synced
       vault would otherwise let a rename inside the vault move a directory that
       lives outside it. */
    await assertReal(from)
    await assertReal(to)
    noteSelfWrite(from)
    noteSelfWrite(to)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.rename(from, to)
  } catch { /* pictures are not worth failing the rename over */ }
}

/**
 * And into the Trash with the file, when nothing else claims them.
 *
 * A deleted note used to leave its pictures behind for good: hidden, unnamed
 * by anything, and counted by the orphan sweep as clutter the reader had to be
 * nagged about. They go to the system Trash rather than being unlinked, so a
 * note restored from there can have its images restored beside it.
 */
async function trashAttachments (relPath) {
  if (!vaultPath) return
  const name = attachmentFolderName(relPath)
  if (!name) return
  const folder = attachmentFolderFor(relPath)
  if (!folder || !await fs.stat(folder).then(() => true).catch(() => false)) return
  if (await attachmentFolderShared(relPath, name)) return
  try {
    await assertReal(folder)
    noteSelfWrite(folder)
    await shell.trashItem(folder)
  } catch { /* not worth a dialog */ }
}

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
    if (!await fs.stat(src).then(() => true).catch(() => false)) continue
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

/* Async, like every other filesystem question on the run path: the old form
   made a blocking `mkdir` on every cache lookup, which is every Run of a
   compiled block. */
async function runCacheDir () {
  const dir = path.join(app.getPath('userData'), 'run-cache')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function pruneRunCache () {
  // Resolved once: runCacheDir mkdirs on every call, and this loops over the
  // whole cache.
  const dir = await runCacheDir()
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

async function claimExecutionSlot (kind) {
  let slots = executionSlots.get(kind)
  if (!slots) executionSlots.set(kind, (slots = []))
  let slot = slots.find((candidate) => !candidate.busy)
  if (!slot) {
    slot = {
      /* `.exe` on Windows: CreateProcess will start an extensionless file by
         full path, but MinGW's linker and the shell that follows it will
         not, and the run ended with no exit code at all. */
      path: path.join(await runCacheDir(), `${EXEC_SLOT_PREFIX}${kind}-${slots.length}${process.platform === 'win32' ? '.exe' : ''}`),
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

async function compiledPlan (kind, binary, buildSteps) {
  const slot = await claimExecutionSlot(kind)
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

/** Opt-in: a pasted note can name any PyPI package, so installing on a
 *  traceback is off until the reader turns it on in Settings. */
const mayInstallPython = () => readConfig().autoInstallPythonDeps === true

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
  const binaryFor = async (code) => path.join(await runCacheDir(), `${prefix}-${sha1(`${seed}\n${code}`)}`)
  const build = (source, output) => [...compile(source, output), BUILD]
  const compiled = { slot: prefix, warmCode, build }

  runner(id, {
    file,
    /* Compiled languages are where the heavy numeric blocks live — a ray
       tracer in a note is C++, not zsh — so they share go and julia's longer
       clock rather than the shell one-liners' ten seconds. */
    timeout: 60_000,
    compiled,
    /* Async existence probes rather than blocking ones: `cached` is asked on
       every Run of a compiled block, and `steps` on every one that misses. A
       hit still refreshes the mtime, so the prune keeps recently-used binaries
       rather than recently-built ones. */
    cached: async (code) => fs.stat(await binaryFor(code)).then(() => true).catch(() => false),
    steps: async (source, _dir, code) => {
      const binary = await binaryFor(code)
      if (await fs.stat(binary).then(() => true).catch(() => false)) {
        // A hit is a use; the prune keeps recently-used, not recently-built.
        try { await fs.utimes(binary, new Date(), new Date()) } catch {}
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
const windowsBaseRoots = () => {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const programs = process.env.ProgramFiles || 'C:\\Program Files'
  const systemDrive = process.env.SystemDrive || 'C:'
  return [
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
}

const WINDOWS_ROOTS = async () => {
  /* Two of those are parents rather than bin directories: a Python install is
     `…\Python\Python312\` and a TeX Live one is `…\texlive\2025\bin\windows`.
     Expanding them used to be a few blocking `readdirSync`s on the first Run;
     now one async listing per parent, awaited before the spawn that needs it. */
  const expanded = []
  for (const dir of windowsBaseRoots()) {
    expanded.push(dir)
    if (!dir.includes('Python') && !dir.includes('texlive')) continue
    let children = []
    try { children = (await fs.readdir(dir)).sort() } catch { continue }
    for (const child of children) {
      const at = path.join(dir, child)
      if (dir.includes('texlive')) expanded.push(path.join(at, 'bin', 'windows'))
      else expanded.push(at, path.join(at, 'Scripts'))
    }
  }
  return expanded
}

/* Worked out on the first Run, not at `require` time. On Windows the list is
   `WINDOWS_ROOTS()`, which is several directory listings of Program Files —
   reads nothing needs until someone runs a code block, so they happen then,
   asynchronously, rather than while anything is being painted. */
/** @type {string[] | null} */
let windowsRootsExpanded = null
/** @type {Promise<any> | null} */
let windowsRootsLoading = null

/* The expanded list, waited for by the async run paths before they spawn.
 *
 * @returns {Promise<void>}
 */
function ensureFallbackPaths () {
  if (process.platform !== 'win32' || windowsRootsExpanded) return Promise.resolve()
  if (!windowsRootsLoading) {
    windowsRootsLoading = WINDOWS_ROOTS()
      .then((paths) => { windowsRootsExpanded = paths })
      .catch(() => {})
      .finally(() => { windowsRootsLoading = null })
  }
  return windowsRootsLoading
}

function fallbackPaths () {
  if (process.platform !== 'win32') return POSIX_FALLBACK_PATHS
  /* The base roots until the expansion above lands: everything but the
     versioned Python and TeX Live children, which join the PATH as soon as
     the first `ensureFallbackPaths` resolves. */
  return windowsRootsExpanded || windowsBaseRoots()
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

/** @type {string | null} */
let loginPath = null        // resolved once, on the first paint
/** @type {Promise<any> | null} */
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
 *
 * @returns {Promise<void>}
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
    /** @type {ReturnType<typeof setTimeout> | null} */
    let bail = null
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(/** @type {any} */ (bail))
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
    .flatMap((part) => /** @type {string} */ (part).split(path.delimiter))
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

/** The temp directory a render or a run worked in, gone whether it worked or
 *  not. The run system owns the shape; the render domain borrows it. */
const discard = (dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})

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

  const run = { child, done: false, timer: /** @type {any} */ (null), killTimer: /** @type {any} */ (null), timedOut: false }
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
        error: /** @type {any} */ (err).code === 'ENOENT'
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
    const slot = await claimExecutionSlot(spec.compiled.slot)

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
/* A Run button per block with no ceiling is a fork bomb: each spawns its own
   interpreter. Cap concurrent runs; extras fail fast with a clear message. */
const MAX_PARALLEL_RUNS = 4

ipcMain.handle('run:warm', (_e, lang) => warmRunner(lang))

ipcMain.handle('run:trusted', () => executionTrusted())
ipcMain.handle('run:trust', async () => {
  /* Defense-in-depth: the renderer already asks via `mayRunCode`, but a
     compromised renderer could call `run.trust` directly. Main confirms with
     a native dialog that renderer JS cannot dismiss. */
  if (executionTrusted()) return true
  if (!vaultPath) return false
  const win = BrowserWindow.getFocusedWindow() || null
  const { response } = await dialog.showMessageBox(/** @type {any} */ (win), {
    type: 'warning',
    buttons: ['Trust this vault', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Allow code to run?',
    message: `Allow code to run in “${path.basename(vaultPath)}”?`,
    detail: 'Notes in this vault may run programs with access to the vault and your network. Only trust files you wrote or reviewed.'
  }).catch(() => ({ response: 1 }))
  if (response !== 0) return false
  return trustExecutionForVault()
})

ipcMain.handle('run:start', async (event, lang, code, noteRel) => {
  const spec = runnerFor(lang)
  if (!spec) throw new Error(`Tulip cannot run "${lang}" blocks.`)
  if (typeof code !== 'string') throw new Error('Nothing to run.')
  if (!executionTrusted()) {
    /** @type {Error & { code?: string }} */
    const error = new Error('This vault is not trusted for code execution.')
    error.code = 'TULIP_UNTRUSTED_VAULT'
    throw error
  }
  if (runsInFlight >= MAX_PARALLEL_RUNS) {
    /** @type {Error & { code?: string }} */
    const error = new Error(`Too many runs at once (max ${MAX_PARALLEL_RUNS}). Stop one and try again.`)
    error.code = 'TULIP_TOO_MANY_RUNS'
    throw error
  }

  /* If its control already started a compiler warmup, let that finish before
     compiling a new block. A cache hit skips the wait: it has no need for a
     warm compiler, and can claim another slot if the warmup still owns one. */
  if (spec.compiled && !(await spec.cached(code))) {
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
  await ensureFallbackPaths()
  const note = typeof noteRel === 'string' && noteRel ? noteRel : null
  const ready = spec.prepare ? await spec.prepare(note, code).catch(() => null) : null

  const plan = executionPlan(await spec.steps(file, dir, code, ready))
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
  const spawned = steps.find(([, , opts = /** @type {{ fs?: any }} */ ({})]) => !opts.fs)
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
  const run = runs.get(id)
  /* Only a run that is going: `cancelled` is emptied by the run that reads
     it, and a Stop pressed after the run had finished left an entry nothing
     would ever take away. */
  if (!run || run.done) return false
  cancelled.add(id)

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

   The kernel handlers live in electron/ipc-kernel.js — host, handlers and the
   window-ownership map are one state machine, so they moved together, and
   they register here at the point their handlers were written, leaving the
   IPC surface untouched. */
kernelDomain.register()

/* For quitting, where there is no later: the SIGKILL escalation timer in
   `stopRun` would never fire, so the groups go outright. */
function killAllRuns () {
  for (const run of runs.values()) killTree(run.child, 'SIGKILL')
}

/* --------------------------------------------------------------- manim
   A ```manim block is a scene, and what a scene is *for* is the video. The
   render domain — manim, tikz and the TeX preview, which share the artefact
   cache and the run machinery — lives in electron/ipc-render.js. */

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

/* The render handlers register here, where the run ids they borrow live
   beside them; main keeps the run machinery itself. */
const renderDomain = makeRenderDomain({
  safePath,
  realSafePath,
  sha1,
  assertReal,
  rel,
  noteSelfWrite: /** @type {any} */ (noteSelfWrite),
  invalidateVaultSnapshot,
  getVaultPath: () => vaultPath,
  readConfig,
  ensureLoginPath,
  ensureFallbackPaths,
  runnerPath,
  pythonEnvs,
  mayInstallPython,
  toRun,
  ownRun,
  startRun: /** @type {any} */ (startRun),
  runTimeoutMs,
  nextRunId: () => ++nextRunId,
  cancelled,
  discard,
  texPreviewDir: TEX_PREVIEW_DIR
})
renderDomain.register()

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
/** @type {ReturnType<typeof setTimeout> | null} */
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
    // Turn-scoped when the agent names its turn: a leftover file from a crash
    // must not rename as the next turn, and a stale one must not run at all.
    const { isStaleRequest: isStaleRename } = require('./copilot-rename')
    if (isStaleRename?.(request)) throw new Error('The Copilot rename request expired.')
    if (request.turnId && event?.turnId && request.turnId !== event.turnId) {
      throw new Error('The Copilot rename request belongs to another turn.')
    }
    const source = await realSafeTargetPath(request.path)
    const stat = await fs.stat(source)
    if (!stat.isFile() || !(MD_EXT.has(path.extname(source).toLowerCase()) ||
        isTex(source) || isPdf(source) || isSite(source) || isWhiteboard(source) ||
        isNotebook(source))) {
      throw new Error('Copilot can rename Tulip documents, not folders or app state.')
    }
    const result = await vaultWriteDomain.renameDocument(request.path, request.name)
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
 *
 * @param {any} [event]
 */
async function consumeAiSearch (event = null) {
  let requestFile
  const resultsFile = await realSafePath(AI_SEARCH_RESULTS).catch(() => null)
  try {
    requestFile = await realSafePath(AI_SEARCH_REQUEST)
    const request = parseAiSearchRequest(await fs.readFile(requestFile, 'utf8'))
    const { isStaleRequest: isStaleSearch } = require('./copilot-search')
    if (isStaleSearch?.(request)) throw new Error('The Copilot search request expired.')
    if (request.turnId && event?.turnId && request.turnId !== event.turnId) {
      throw new Error('The Copilot search request belongs to another turn.')
    }
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
  clearTimeout(/** @type {any} */ (aiTimer))
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
  service.setTrusted(() => executionTrusted())
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
        aiRenameWork = aiRenameWork.then(() => consumeAiSearch(event)).catch(() => {})
      }
      return
    }
    if (event?.k === 'progress') {
      // stderr heartbeat from a long tool call: forward without disturbing the
      // text coalescing below, which only non-prose events flush.
      toCopilot('ai:event', event)
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
  await ensureFallbackPaths()
  return ai.start({ ...(opts || {}), key: String(opts?.key || ''), turnId: id })
})
ipcMain.handle('ai:models', async (_e, opts) => {
  await ensureLoginPath()
  await ensureFallbackPaths()
  return aiService().models({ fresh: !!opts?.fresh })
})
ipcMain.handle('ai:doctor', async () => {
  await ensureLoginPath()
  await ensureFallbackPaths()
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
  trust?.record({ source: 'restore', changes: inverse })
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
/** @type {Record<string, any> | null} */
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

/* The handlers live in electron/ipc-review.js, beside the store itself —
   main's other callers of the store (a rename's relocate, a delete's remove)
   take the same instance from the same module. */
reviewDomain.register()

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

/* ---------------------------------------------------------------- drafts

   The draft store and its handlers live in electron/ipc-drafts.js; main holds
   none of the state — the drafts directory is a function of the vault and of
   userData, both of which the module reaches through the context below. */
makeDraftDomain({
  getVaultPath: () => vaultPath,
  sha1,
  writeAtomic,
  safePath
}).register()

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
  /* A walk of its own rather than `readdir({ recursive })`, which cannot be
     told to stay out of anything: a vault's `node_modules` or `.git` is most
     of the vault by file count and never holds a write of ours. */
  const names = []
  const walk = async (at) => {
    const entries = await fs.readdir(path.join(dir, at), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const name = at ? path.join(at, entry.name) : entry.name
      if (entry.isDirectory()) {
        if (recursive && !IGNORED_DIRS.has(entry.name)) await walk(name)
      } else if (entry.name.endsWith(suffix)) {
        names.push(name)
      }
    }
  }
  await walk('')
  await Promise.all(names
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
ipcMain.on('menu:context', (event, kind) => {
  const key = event.sender.id
  const next = String(kind || '')
  if (menuDocumentKinds.get(key) === next) return
  menuDocumentKinds.set(key, next)
  if (windowOf(event) === focusedWindow()) buildMenu()
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
     strings to itself. `defaultVaultPath` is settable but value-checked below:
     only the open vault or a recent one that still exists may be pinned, so a
     renderer naming an arbitrary folder cannot turn the next launch into a
     read of it. */
  const { accepted, rejected } = sanitizeConfigPatch(patch)
  if (Object.prototype.hasOwnProperty.call(accepted, 'defaultVaultPath')) {
    const wanted = /** @type {any} */ (accepted).defaultVaultPath
    if (wanted !== undefined) {
      const known = Array.isArray(readConfig().recentVaults) ? readConfig().recentVaults : []
      let ok = typeof wanted === 'string' && !!wanted &&
        (wanted === vaultPath || known.includes(wanted))
      if (ok) {
        try {
          ok = fsSync.existsSync(wanted) && fsSync.statSync(wanted).isDirectory()
        } catch { ok = false }
      }
      if (!ok) {
        delete /** @type {any} */ (accepted).defaultVaultPath
        rejected.push('defaultVaultPath')
        console.warn('config:set refused defaultVaultPath — not the open vault or a recent one that exists')
      }
    }
  }
  if (rejected.length) {
    console.warn(`config:set refused ${rejected.join(', ')} — not settable from the renderer`)
  }
  const next = writeConfig(accepted)
  // The menu is the thing a hotkey lives in, so a change means a rebuild —
  // cheap, and the only way an accelerator ever moves.
  if (Object.prototype.hasOwnProperty.call(accepted, 'hotkeys')) buildMenu()
  /* A language turned on or off is a different dictionary, which is the same
     event as a word taught or removed: the checker is rebuilt on the next
     question and every held verdict is stale. */
  if (Object.prototype.hasOwnProperty.call(accepted, 'spellLanguages')) {
    spellDomain.forgetChecker()
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

/* Where a page's downloads land: a folder in the vault, made when the first
   one arrives.

   Clicking a PDF or a `.zip` inside a website tab used to do nothing at all —
   nothing was listening for `will-download`, so Chromium started a download
   into a session with no destination and dropped it. Silently, which reads as
   a broken page rather than as a missing feature.

   Into the vault rather than the desktop's Downloads folder, because that is
   what makes it Tulip's version of the gesture: the paper you just downloaded
   is in the tree beside the notes about it, findable by the same search, a
   moment after it arrives. And into one known folder rather than beside the
   `.website` file, because a download is not always something you meant to
   keep — one predictable place is one place to tidy. */
const DOWNLOAD_DIR = 'Downloads'

/** A download's progress, said to every window: the tab that started it may
 *  not be the tab in front by the time it finishes. */
function watchDownloads (partition) {
  session.fromPartition(partition).on('will-download', async (event, item) => {
    if (!vaultPath) {
      // Nowhere to put it. Cancelled rather than left to fail deep inside
      // Chromium with nothing said.
      item.cancel()
      return
    }
    const dir = path.join(vaultPath, DOWNLOAD_DIR)
    try { await fs.mkdir(dir, { recursive: true }) } catch { item.cancel(); return }

    const asked = item.getFilename() || 'download'
    const ext = path.extname(asked)
    /* Awaited: the collision search is a `stat` per candidate now. The save
       path lands a tick later than it used to, which Chromium tolerates — the
       download does not start writing until the handler returns, and this
       handler is async either way once the directory creation is. */
    const target = await freeName(dir, path.basename(asked, ext), ext).catch(() => null)
    if (!target) { item.cancel(); return }
    // No dialog: a download the reader asked for by clicking a link is not a
    // question, and the answer to "where" is already decided.
    item.setSavePath(target)

    const name = path.basename(target)
    const total = item.getTotalBytes()
    broadcast('web:download', { state: 'started', name, received: 0, total })

    /* Chromium fires `updated` on every chunk. A window redrawing its status
       line at that rate is the one way to make a download feel slower than it
       is, so what goes over the wire is at most one message every quarter
       second. */
    let said = 0
    item.on('updated', (_e, state) => {
      if (state !== 'progressing') return
      const now = Date.now()
      if (now - said < 250) return
      said = now
      broadcast('web:download', {
        state: 'progress', name, received: item.getReceivedBytes(), total: item.getTotalBytes()
      })
    })

    item.once('done', (_e, state) => {
      if (state === 'completed') {
        // The tree has a new row in it, and the index a new document.
        invalidateVaultSnapshot()
        /* Named, so a downloaded note syncs by name rather than by walking the
           vault; a kind the index holds nothing for still falls back. */
        markIndexDirty(rel(target))
        broadcast('web:download', {
          state: 'done', name, path: rel(target), received: item.getReceivedBytes(), total
        })
        return
      }
      broadcast('web:download', {
        state: state === 'cancelled' ? 'cancelled' : 'failed', name
      })
    })
  })
}

function guardGuests () {
  /* Guests carry the User-Agent of the Chrome they in fact are. Sites vary
     what they serve on the Electron token — YouTube's player among them — and
     a note's guest should get the page a browser would. */
  const ua = app.userAgentFallback.replace(/ (Electron|Tulip)\/[\d.]+/g, '')
  for (const partition of [YOUTUBE_PARTITION, WEB_PARTITION]) {
    session.fromPartition(partition).setUserAgent(ua)
    // A real page may offer a file, and a file offered has to land somewhere.
    watchDownloads(partition)
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
  /** @type {Promise<any> | null} */
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
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (!allowedGuestUrl(url, partition)) {
        if (/^https?:/.test(url)) shell.openExternal(url)
        return { action: 'deny' }
      }
      /* Two different gestures arrive here, and they used to get one answer.
         `new-window` is `window.open` with a feature string — the sign-in
         protocol above, a small chromeless window the page will talk to and
         then close. Everything else is a link the reader clicked that happens
         to carry `target=_blank`: a footnote, a reference, a docs page. Sizing
         *that* like a sign-in popup gave every ordinary link on the web a
         520-pixel window that could not be minimised, which is not what any
         page meant by "open this somewhere else". */
      const signIn = disposition === 'new-window'
      return {
        action: 'allow',
        // It belongs to the page that opened it; nothing should outlast a note.
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          width: signIn ? 520 : 1000,
          height: signIn ? 680 : 760,
          minimizable: !signIn,
          fullscreenable: !signIn,
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

    /* Right-clicking inside a page.
     *
     * The window's own context menu (see the `context-menu` handler beside
     * createWindow) is on the *window's* webContents, and a guest is not that
     * — so a right-click on a real web page reached nothing at all: no copy,
     * no back, no way to take a link out to a real browser. Chromium's default
     * menu is not available to an embedder, so the menu is built here, from
     * the same `params` the page's own menu would have been built from.
     *
     * A run block's preview is left out: it has no history to walk, no links
     * that mean anything outside the note, and it is not a page the reader is
     * reading. */
    if (partition !== HTML_RUN_PARTITION) contents.on('context-menu', (_event, params) => {
      const items = []
      const add = (label, click, enabled = true) => items.push({ label, click, enabled })

      if (params.linkURL && /^https?:/.test(params.linkURL)) {
        add('Copy Link', () => clipboard.writeText(params.linkURL))
        add('Open Link in Browser', () => shell.openExternal(params.linkURL))
        items.push({ type: 'separator' })
      }
      if (params.mediaType === 'image' && /^https?:/.test(params.srcURL || '')) {
        add('Copy Image Address', () => clipboard.writeText(params.srcURL))
        items.push({ type: 'separator' })
      }
      if (params.selectionText) {
        add('Copy', () => contents.copy())
        items.push({ type: 'separator' })
      }
      /* Editable fields get the three a text field needs. Cut and paste are
         withheld where the field will not take them, rather than offered and
         then ignored. */
      if (params.isEditable) {
        add('Cut', () => contents.cut(), params.editFlags.canCut)
        add('Paste', () => contents.paste(), params.editFlags.canPaste)
        add('Select All', () => contents.selectAll())
        items.push({ type: 'separator' })
      }

      add('Back', () => contents.navigationHistory.goBack(), contents.navigationHistory.canGoBack())
      add('Forward', () => contents.navigationHistory.goForward(), contents.navigationHistory.canGoForward())
      add('Reload', () => contents.reload())
      items.push({ type: 'separator' })
      add('Copy Page Address', () => clipboard.writeText(contents.getURL()))
      add('Open Page in Browser', () => shell.openExternal(contents.getURL()),
        /^https?:/.test(contents.getURL()))

      /* No window named: a guest's contents do not belong to a window as far as
         `fromWebContents` is concerned, and Electron pops the menu over the
         focused window — which is the window the right-click was in. */
      Menu.buildFromTemplate(items).popup()
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
        return new Response(/** @type {any} */ (streamFileRange(abs, start, end, request.signal)), { status, headers })
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
  const launchOpen = await launchFinderDocument()
  /* The pinned default wins over the last-open vault: closing the app and
     reopening it always returns to Settings → Vault, and a temporary switch to
     another folder does not move it. A default that has gone away (an unmounted
     drive, a folder since deleted) is skipped in favour of the last vault, and
     a launch opened from Finder still honours the file that was asked for.
     This must happen before createWindow: the renderer asks for the current
     vault as soon as it loads, and a window created first can briefly receive
     `null` and paint the landing page over a vault that is in fact open. */
  const pinned = typeof cfg.defaultVaultPath === 'string' && cfg.defaultVaultPath &&
    fsSync.existsSync(cfg.defaultVaultPath) ? cfg.defaultVaultPath : null
  const savedVault = launchOpen ? path.dirname(launchOpen) : (pinned || cfg.vaultPath)
  if (savedVault && fsSync.existsSync(savedVault)) {
    vaultPath = savedVault
    if (cfg.vaultPath !== savedVault) {
      writeConfig({ vaultPath: savedVault })
    }
    trust.setVault(vaultPath, false)
    /* The folder a notebook's kernel is allowed to see is read from `vaultPath`
       when the kernel host is first made — see `kernelHost` — so nothing here
       has to tell it. */
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
    /* Not awaited, and deliberately: after its first run there is nothing left
       to move, so every launch but one would be paying a whole-vault pass at
       the moment the window is being asked for. */
    migrateNoteTags().catch(() => {})
    /* And the litter a killed write left beside a note — swept on a switch of
       vault below, and until now never on the launch that simply reopens the
       one from last time, which is the launch after the force-quit that made
       the litter. */
    sweepTemporaryFiles(vaultPath, { recursive: true }).catch(() => {})
    watchVault()
  }

  const first = createWindow({ open: launchOpen ? path.basename(launchOpen) : null })
  /* After the window is asked for, not before. Building the menu is a
     two-hundred-line template and an accelerator table, and none of it is on
     screen until the reader reaches for it — while `createWindow` is what
     starts the renderer loading, which is the only thing anybody is waiting
     for. Still on this tick, so the menu is in place long before the window
     it belongs to has painted. */
  buildMenu()
  guardGuests()
  finderOpensReady = true
  drainFinderOpens()
  if (vaultPath) first.setTitle(path.basename(vaultPath))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* The second `before-quit` — the one after the index cache has had its say.
   Electron does not wait on promises here, so holding the door for the flush
   needs `preventDefault` and an explicit second `app.quit()`. */
let quitAfterFlush = false

app.on('before-quit', (event) => {
  quitting = true
  if (watcher) watcher.close()
  const cache = /** @type {any} */ (indexCache)
  /* A cache write waiting out its quiet period would otherwise be lost with
     the process — a slower first search next launch, nothing worse, but a
     write that can start now may as well land. Awaited with a ceiling rather
     than fired blindly: the old form called `flush()` and quit around it, so
     the write it started usually died with the process still holding it. Two
     seconds is generous for one JSON write and bounded for a disk that has
     gone away. */
  if (cache && !quitAfterFlush) {
    quitAfterFlush = true
    event.preventDefault()
    const ceiling = new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      timer.unref?.()
    })
    Promise.race([cache.flush().catch(() => {}), ceiling]).finally(() => {
      // The windows are already on their way out; quitting again re-enters
      // below with the flag set and finishes synchronously.
      app.quit()
    })
    return
  }
  killAllRuns()
  kernelDomain.disposeSync()
  pythonEnvs?.disposeSync()
  aiInstance?.stopAll('SIGKILL')
  trust?.flushSync()
  flushDurabilitySync()
  flushConfig()
})
