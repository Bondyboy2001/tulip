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
const ai = require('./ai')
const { TrustStore } = require('./trust-store')
const { makeStore: makeReviewStore } = require('./review-store')
const { makeStore: makeLanguageHistoryStore } = require('./language-history-store')
const { classifyVaultEvent } = require('./vault-events')
const { narrowsFrom } = require('./search-narrow')
const { parseByteRange, streamFileRange } = require('./range-response')
const { ocrPagesOf, parsePages, relevantPdfContext } = require('./pdf-context')
const { parseFrontmatter, propsOf, propValues } = require('./frontmatter.cjs')
const updates = require('./updates')
const PDF_TEXT_FORMAT = require('./pdf-text-format.json').version
const VAULT_CONTRACT = require('./vault-contract.json')
const WEB_PARTITIONS = require('./web-partitions.json')
/* The one address a guest may fetch, shared with the renderer that writes it
   into the scene's document — see src/threejs.js. */
const GUEST_LIBRARY = require('./guest-library.json')
const IS_MAC = process.platform === 'darwin'
const IS_WINDOWS = process.platform === 'win32'
const EXECUTABLE_EXT = IS_WINDOWS ? '.exe' : ''

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json')

const IGNORED_DIRS = new Set(['.git', '.obsidian', '.tulip', 'node_modules', '.trash'])

/** A literal string, as a pattern that matches only itself. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const MD_EXT = new Set(VAULT_CONTRACT.noteExtensions)

/* The same expression src/vault-paths.js builds for the renderer, from the same
   contract. Both sides strip a note's extension when they turn a path into a
   name, and a link resolves by comparing those names — so the two spellings
   drifting apart is a wikilink that points at a note the tree is showing. */
const NOTE_EXT = new RegExp(
  `(?:\\.language)?\\.(${VAULT_CONTRACT.noteExtensions
    .map((ext) => escapeRe(ext.replace(/^\./, ''))).join('|')})$`,
  'i'
)

/* The other two kinds a vault holds. Only `file:rename` needs them together —
   it strips whatever extension the typed name carries, whichever kind was
   renamed — and stating them as one expression is what keeps that list from
   being the place a newly supported kind is forgotten. */
const DOCUMENT_EXT = new RegExp(
  `(${[VAULT_CONTRACT.pdfExtension, VAULT_CONTRACT.siteExtension]
    .map(escapeRe).join('|')})$`,
  'i'
)
const LANGUAGE_TABLE_SUFFIX = VAULT_CONTRACT.languageTableSuffix
const LANGUAGE_FLAG = new RegExp(VAULT_CONTRACT.languageFlagPattern, 'u')
const LEGACY_LANGUAGE_TABLES = new Set(
  VAULT_CONTRACT.legacyLanguageTableNames.map((name) => name.toLowerCase())
)
const isLanguageTable = (p) => {
  const value = String(p || '')
  if (value.toLowerCase().endsWith(LANGUAGE_TABLE_SUFFIX)) return true
  return LEGACY_LANGUAGE_TABLES.has(path.basename(value).toLowerCase()) &&
    LANGUAGE_FLAG.test(path.basename(path.dirname(value)))
}
const languageTableStem = (p) => {
  const name = path.basename(String(p || ''))
  return name.toLowerCase().endsWith(LANGUAGE_TABLE_SUFFIX)
    ? name.slice(0, -LANGUAGE_TABLE_SUFFIX.length)
    : path.basename(name, path.extname(name))
}
const { vocabulary: LANGUAGE_TABLE_TEMPLATE } = VAULT_CONTRACT.languageTableTemplates
const languageName = (value) => {
  const text = String(value || '')
  const match = LANGUAGE_FLAG.exec(text)
  return { flag: match?.[1] || '', name: match ? text.slice(match[0].length) : text }
}

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
   ready, so it sits at module scope. */
protocol.registerSchemesAsPrivileged([{
  scheme: 'tulip-file',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: true
  }
}])

let mainWindow = null
let vaultPath = null
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

/**
 * `fn` over every item, at most `limit` of them in flight, answered in the
 * order the items came in however the work happens to finish.
 *
 * Bounded rather than a bare `Promise.all`: every use of this is a `readdir`,
 * a `stat`, or a `read`, and a large vault asking the OS for one descriptor per
 * note at the same moment is how a walk turns into EMFILE.
 *
 * The order is not a nicety. The vault scan feeds the attachment list, which is
 * turned into a key and compared against the last one to decide whether
 * anything moved — an order that varied run to run would report a change on
 * every tick and undo the very guard it feeds.
 */
const WALK_LIMIT = 32

async function mapLimit (items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next++
      out[at] = await fn(items[at], at)
    }
  })
  await Promise.all(workers)
  return out
}

/* ------------------------------------------------------------ note index */

/**
 * Every note's text, held in memory. Search used to re-read the whole vault on
 * each keystroke; now the disk is touched only for files whose mtime or size
 * moved since the last sync. The same index is what the link rewriter reads
 * when a rename has to be chased through the rest of the vault.
 */
const index = new Map()   // rel path -> { name, text, mtime, size }

/* A note big enough to be a paste of a log file would cost more to hold than
   the search is worth; it is indexed as empty rather than skipped, so it still
   disappears from the index when it is deleted. */
const MAX_INDEX_BYTES = 4 * 1024 * 1024

let indexDirty = true
let syncing = null

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
  if (!vaultPath) { index.clear(); forgetLinkTables(); return }
  indexDirty = false

  const { notes } = await getVaultSnapshot()

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
  })

  for (const key of [...index.keys()]) if (!seen.has(key)) index.delete(key)

  // Which notes exist may have changed, and that is the whole of what the link
  // tables are built from.
  forgetLinkTables()
}

function ensureIndex () {
  if (!indexDirty && !syncing) return Promise.resolve()
  if (!syncing) {
    syncing = syncIndex().finally(() => { syncing = null })
  }
  return syncing
}

async function snapshotNotes () {
  await ensureIndex()
  return new Map([...index].map(([key, entry]) => [key, entry.text]))
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
        name: identity?.name || stripExt(entry.name),
        flag: identity?.flag || folderIdentity?.flag || '',
        path: rel(abs)
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
    }
    return { files: [abs], evicted: 0, node }
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
      pdfs: files.filter(isPdf).map(rel)
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
    pending.push({ key, abs: path.resolve(vaultPath, key), next })
  }

  /* Concurrently: `writeAtomic` fsyncs both the file and its directory, so a
     folder rename that touches a hundred backlinks was two hundred fsyncs one
     after another with the main process pinned for all of them. The notes are
     different files and the writes do not depend on one another. */
  const touched = await mapLimit(pending, WALK_LIMIT, async ({ key, abs, next }) => {
    try {
      touchIndex(abs, next, await writeAtomic(abs, next))
      return key
    } catch (err) {
      console.error('link rewrite failed', key, err)
      return null
    }
  })
  return touched.filter(Boolean)
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
  await ensureIndex()
  const moves = notesMovedBy(rel(srcAbs), rel(targetAbs), isDir)

  noteSelfWrite(srcAbs)
  noteSelfWrite(targetAbs)
  await fs.rename(srcAbs, targetAbs)
  await carryAnnotations(rel(srcAbs), rel(targetAbs))
  /* A card's identity begins with the path of the note it came from, so a
     rename that did not carry the review state would silently reset every word
     in the table to never-seen — the same loss as throwing the history away,
     and harder to notice, because all the words are still there. */
  await review.relocate(rel(srcAbs), rel(targetAbs)).catch(() => {})
  await languageHistory.relocate(rel(srcAbs), rel(targetAbs)).catch(() => {})
  trust?.relocateCreations(moves)
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
  return [...index.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => ({ from: key, to: `${to}/${key.slice(prefix.length)}` }))
}

/* Paths the app itself has just written, so the watcher can tell an autosave
   echoing back from an edit made outside the app. Without this, every save
   dropped the caches and sent the renderer off on two vault walks that
   discovered nothing. */
const selfWrites = new Map()   // vault-relative path -> Date.now() at the write
const SELF_WRITE_MS = 500

function noteSelfWrite (abs) {
  if (!vaultPath) return
  const p = rel(abs)
  if (p.startsWith('..')) return   // config and chat files live outside the vault
  const now = Date.now()
  for (const [key, at] of selfWrites) if (now - at > SELF_WRITE_MS) selfWrites.delete(key)
  selfWrites.set(p, now)
}

function isSelfWrite (filename) {
  if (!filename) return false   // no name means no way to tell; let it through
  const at = selfWrites.get(filename.split(path.sep).join('/'))
  return at !== undefined && Date.now() - at <= SELF_WRITE_MS
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
       generated, not when the write was asked for. */
    noteSelfWrite(abs)
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
  let sweepPdfs = false
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
        pdfExtension: PDF_EXT,
        siteExtension: SITE_EXT,
        assetExtensions: ASSET_EXT
      })
      if (change.ignore) return
      // Marked immediately, not on the debounce: a search that lands inside the
      // quiet window must still see that something moved.
      if (change.index) indexDirty = true
      if (change.snapshot) invalidateVaultSnapshot()
      if (change.notify && change.path) changed.add(change.path)
      if (change.notify && !change.path) notifyUnknown = true
      if (change.pdf === 'sweep') sweepPdfs = true
      else if (change.pdf) changedPdfs.add(change.pdf)
      clearTimeout(timer)
      timer = setTimeout(() => {
        const paths = [...changed]
        changed = new Set()
        if (paths.length || notifyUnknown) notifyVaultChanged(paths)
        notifyUnknown = false
        const pdfs = [...changedPdfs]
        changedPdfs = new Set()
        if (sweepPdfs) {
          sweepPdfs = false
          sweepPdfText().catch(() => {})
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

/** Tell the renderer the vault may have moved under it. */
function notifyVaultChanged (paths = []) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vault:changed', { paths })
  }
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

async function openVault (dir) {
  vaultPath = dir
  trust?.setVault(dir, readConfig().historyInVault === true)
  /* An explicitly chosen vault is the user's home vault, not merely the
     folder open for this process. Keep the old key during the migration so
     older packaged renderers and configs remain harmlessly compatible. */
  writeConfig({ vaultPath: dir, defaultVaultPath: dir })
  await migrateAttachments(dir).catch(() => {})
  index.clear()
  indexDirty = true
  invalidateVaultSnapshot()
  watchVault()
  // Warmed in the background so the first search does not pay for the walk.
  ensureIndex().catch(() => {})
  // Whatever a killed write left beside a note in this vault. Background work
  // like the two sweeps around it; nothing waits on the tidying.
  sweepTemporaryFiles(dir, { recursive: true }).catch(() => {})
  // Likewise the PDFs, so the copilot can be asked about one that has not
  // been opened. Only documents without a current sidecar cost anything.
  sweepPdfText().catch(() => {})
  if (mainWindow) {
    mainWindow.setTitle(path.basename(dir))
    mainWindow.webContents.send('vault:opened', { path: dir, name: path.basename(dir), sync: syncProviderFor(dir) })
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
let flushReply = null
let flushAsked = null
ipcMain.handle('app:flushed', async () => {
  await flushPendingDurability()
  flushReply?.()
})

function askRendererToFlush (win) {
  /* One request at a time. ⌘⇧W pressed twice, or ⌘Q arriving while a close is
     still waiting, used to overwrite `flushReply` — the renderer sends one
     `app:flushed`, so the first promise was left stranded on its timer and the
     quit stalled the full 1.5 s before closing a second time. */
  if (flushAsked) return flushAsked
  flushAsked = new Promise((resolve) => {
    if (!win || win.webContents.isDestroyed()) return resolve()
    const timer = setTimeout(resolve, 1500)
    flushReply = () => { clearTimeout(timer); resolve() }
    win.webContents.send('app:flush')
  }).finally(() => { flushReply = null; flushAsked = null })
  return flushAsked
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 680,
    minHeight: 460,
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 } }
      : {}),
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

  /* Opened filling the screen. The width and height above stay what they are —
     they are the size the window returns to when it is un-maximised, and a
     restore size equal to the screen would make the green button do nothing. */
  mainWindow.maximize()

  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())

  // External links open in the browser; the vault never navigates away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  /* The window shows dist/index.html and nothing else, ever. Without this, a
     note could carry an <a href="tulip-file://vault/page.html"> and a click
     would swap the app for a document of the vault's choosing — same origin,
     same preload, so `window.tulip` and every filesystem call with it. The
     app never navigates its own top frame (views swap in-page), so refusing
     all of it costs nothing. In-page #anchors don't raise this event. */
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  /* The fence a note's embeds attach behind. Registered here, per window, so
     that a window built by the Dock's `activate` gets one too — see the
     account above `fenceWebviewAttach`. */
  fenceWebviewAttach(mainWindow)

  /* The renderer died — out of memory, or a crash somewhere below JavaScript.
     No handler inside it ran, so the window is now a blank frame holding a
     process that is not there, and ⌘S does nothing for the rest of the session.

     Reloaded rather than reported, because the reload is the recovery: drafts
     are main's, written every 1.2 s and untouched by whatever happened over
     there, and `offerDraftRecovery` on the next boot offers back every note
     whose draft is ahead of its file. So the text survives the crash by the
     same path it survives a power cut — the only thing needed here is to get
     a live renderer in front of it.

     `clean-exit` and `killed` are not crashes: they are what a window being
     closed and an app being quit look like from here. */
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('renderer gone', details)
    if (details.reason === 'clean-exit' || details.reason === 'killed') return
    if (quitting || !mainWindow || mainWindow.isDestroyed()) return
    /* The close handler holds the window open until the renderer answers
       `app:flush`. There is no renderer to answer, so a close attempted now
       would wait out the full 1.5 s timeout — and the reload below is about to
       make the question moot anyway. */
    flushReply?.()
    mainWindow.reload()
  })

  /* A frame that has not returned to its event loop for long enough that the
     window manager has stopped drawing it. Not fatal — a long synchronous scan
     of a large note looks exactly like this and finishes on its own — so
     nothing is done to the window. It is logged because the state is otherwise
     indistinguishable, from a report, from the crash above. */
  mainWindow.on('unresponsive', () => console.error('renderer unresponsive'))
  mainWindow.on('responsive', () => console.error('renderer responsive again'))

  /* Nothing a note started outlives the window that started it. The copilot's
     process is included: it is one CLI per conversation, running with the vault
     as its working directory and holding tools that write notes. Left alive by
     ⌘W it kept editing the vault with no window to show for it, and every
     event it sent was dropped on the floor — including the one that records
     what it changed, so the edits landed with no way to review or undo them. */
  mainWindow.on('closed', () => {
    mainWindow = null
    stopAllRuns()
    try { ai.stop('SIGKILL') } catch { /* nothing running */ }
  })

  // Held open until unsaved edits reach the disk — see askRendererToFlush.
  let flushed = false
  let flushing = false
  mainWindow.on('close', (event) => {
    if (flushed) return
    event.preventDefault()
    // A second close attempt while the first is still waiting is the same
    // close, not another one.
    if (flushing) return
    flushing = true
    askRendererToFlush(mainWindow).then(() => {
      flushed = true
      if (quitting) app.quit()
      else mainWindow?.close()
    })
  })

  // Restore the saved zoom once the page exists, and report it so the status
  // bar agrees with reality from the first frame.
  mainWindow.webContents.on('did-finish-load', () => {
    const saved = readConfig().zoom || DEFAULT_ZOOM
    if (saved !== 1) mainWindow.webContents.setZoomFactor(saved)
    send('zoom', Math.round(saved * 100))
  })

  /* No `zoom-changed` listener: the window is not pinched. Ctrl+scroll and
     trackpad pinch are swallowed in the renderer — over a note because two
     fingers there mean nothing, over a PDF or a website because the document
     resizes itself — so the only sizes the window ever takes are the ones the
     menu, the keys and the settings stepper ask for. */
}

function send (channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
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
let documentOwnsZoom = false

function zoomFactor () {
  if (!mainWindow || mainWindow.isDestroyed()) return 1
  return mainWindow.webContents.getZoomFactor()
}

function applyZoom (factor) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const clamped = Math.min(ZOOM_STEPS.at(-1), Math.max(ZOOM_STEPS[0], factor))
  mainWindow.webContents.setZoomFactor(clamped)
  writeConfig({ zoom: clamped })
  send('zoom', Math.round(clamped * 100))
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
  if (documentOwnsZoom) {
    send('menu', direction === 0 ? 'zoom-reset' : direction > 0 ? 'zoom-in' : 'zoom-out')
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

function buildMenu () {
  const template = [
    {
      label: 'Tulip',
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => updates.check({ manual: true }) },
        { type: 'separator' },
        /* Which vault is open is a fact about the app rather than about a file
           in it, so it is asked for here rather than under File — where it sat
           among New Note and Save, and where nobody looking to switch vaults
           thought to look. */
        { label: 'Open Vault…', accelerator: 'CmdOrCtrl+Shift+O', click: () => pickVault() },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('menu', 'settings') },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: () => send('menu', 'new-note') },
        { label: 'New Website', click: () => send('menu', 'new-website') },
        { label: 'New Language', click: () => send('menu', 'new-language') },
        { label: 'New Folder', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('menu', 'new-folder') },
        { type: 'separator' },
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => send('menu', 'new-tab') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('menu', 'close-tab') },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('menu', 'reopen-tab') },
        { type: 'separator' },
        { label: IS_MAC ? 'Reveal in Finder' : 'Show in File Explorer', click: () => send('menu', 'reveal') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu', 'save') },
        { label: 'Export as PDF…', click: () => send('menu', 'export-pdf') }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        /* Sent to the renderer rather than left as roles, because what ⌘Z
           means depends on what is on screen: a note undoes an edit, a PDF
           undoes a highlight, and a plain text field wants the browser's own
           history — which the renderer asks for back through `edit:undo`. */
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('menu', 'undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('menu', 'redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Note', accelerator: 'CmdOrCtrl+F', click: () => send('menu', 'find') },
        { label: 'Search Vault', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('menu', 'search') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => send('menu', 'back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => send('menu', 'forward') },
        { type: 'separator' },
        { label: 'Previous Tab', accelerator: 'Alt+CmdOrCtrl+Left', click: () => send('menu', 'prev-tab') },
        { label: 'Next Tab', accelerator: 'Alt+CmdOrCtrl+Right', click: () => send('menu', 'next-tab') },
        { type: 'separator' },
        { label: 'Quick Switcher', accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'switcher') },
        { label: 'Jump to Heading', click: () => send('menu', 'headings') },
        { label: 'Command Palette', accelerator: 'CmdOrCtrl+P', click: () => send('menu', 'commands') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('menu', 'sidebar') },
        // The old key still works. A menu item carries one accelerator, so the
        // second one needs a twin of its own, kept out of the menu.
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', visible: false, click: () => send('menu', 'sidebar') },
        { label: 'Toggle Outline', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('menu', 'outline') },
        { label: 'Toggle Backlinks', accelerator: 'CmdOrCtrl+Shift+K', click: () => send('menu', 'links') },
        { label: 'Toggle Info', accelerator: 'CmdOrCtrl+Shift+I', click: () => send('menu', 'info') },
        { label: 'Toggle Copilot', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('menu', 'copilot') },
        { label: 'Reading View', accelerator: 'CmdOrCtrl+1', click: () => send('menu', 'view-read') },
        { label: 'Editing View', accelerator: 'CmdOrCtrl+2', click: () => send('menu', 'view-edit') },
        { label: 'Raw View', accelerator: 'CmdOrCtrl+3', click: () => send('menu', 'view-raw') },
        { label: 'Toggle Reading View', accelerator: 'CmdOrCtrl+E', click: () => send('menu', 'reading') },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('menu', 'theme') },
        { label: 'Change Theme…', click: () => send('menu', 'themes') },
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
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]
  if (!IS_MAC) {
    // Windows has no application menu. Keep vault and settings commands under
    // File, and put Exit there where Windows users expect it.
    const appMenu = template[0]
    const fileMenu = template[1]
    const commands = appMenu.submenu.filter((item) =>
      item.label === 'Open Vault…' || item.label === 'Settings…'
    )
    fileMenu.submenu.unshift(...commands, { type: 'separator' })
    /* Checking for updates goes to the bottom rather than up with those two:
       it belongs beside Exit, among the things that are about the application
       rather than about the note, which is where the app menu had it on
       macOS and where Windows puts it in the absence of a Help menu. */
    const check = appMenu.submenu.find((item) => item.label === 'Check for Updates…')
    fileMenu.submenu.push({ type: 'separator' }, check, { role: 'quit' })
    template.shift()
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function pickVault () {
  const res = await dialog.showOpenDialog(mainWindow, {
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
  await askRendererToFlush(mainWindow)
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
    const created = MD_EXT.has(path.extname(abs).toLowerCase())
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

ipcMain.handle('file:write', async (_e, p, content) => {
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
  const isNote = MD_EXT.has(path.extname(abs).toLowerCase())
  /* The note as it stood before this write, read first: the snapshot has to be
     the same text the write is about to replace, and reading after would hand
     the history store the text being written. Read even when the file is new,
     so the note's first save is recorded as the thing it replaced — nothing. */
  const [before, oldStat] = isNote
    ? await Promise.all([
        fs.readFile(abs, 'utf8').catch(() => null),
        fs.stat(abs).catch(() => null)
      ])
    : [null, null]
  /* Capture the old inode's birthtime before the atomic rename replaces it.
     Info can then keep saying when the note was created rather than when its
     newest crash-safe save landed. */
  if (oldStat) trust?.creationTime(rel(abs), oldStat.birthtimeMs)
  const stamp = await writeAtomic(abs, content, {
    durable: readConfig().durability === 'full'
  })
  /* A copy of what the save replaced, so any version of the note can be put
     back from History. Only notes: the store is for writing, and a website
     file holds an address rather than prose. */
  if (isNote && String(before ?? '') !== String(content)) {
    trust?.record({ source: 'save', changes: [{ path: rel(abs), before, after: String(content) }] })
  }
  /* The text is already here, so the next sync can skip re-reading it. Without
     this, every autosave would cost the index a read of the note being typed.

     Notes only. The index is what vault search and the link tables are built
     from, and a website file put into it would answer a search for the site's
     own name with a row that is not a note — until the next walk of the vault
     quietly dropped it again, which is the worse half of the bug. */
  if (isNote) touchIndex(abs, content, stamp)
  if (isLanguageTable(abs)) {
    await languageHistory.sync(rel(abs), content).catch((err) => {
      console.error('language history sync failed', err)
    })
  }
  return true
})

ipcMain.handle('file:create', async (_e, dir, name) => {
  const target = freeName(
    await realSafePath(dir || ''),
    name || 'Untitled',
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

/* A language is one portable Markdown table of words the reader has learned.
   Nothing else is created with it: an alphabet, a table of sounds or a page of
   grammar are all the reader's own content, and seeding them would be guessing
   at what this language needs said about it. */
ipcMain.handle('language:create', async (_e, dir, name) => {
  const folder = freeName(await realSafePath(dir || ''), name || 'New language')
  noteSelfWrite(folder)
  await fs.mkdir(folder, { recursive: true })

  const vocabulary = path.join(folder, `Vocabulary${LANGUAGE_TABLE_SUFFIX}`)
  noteSelfWrite(vocabulary)
  await fs.writeFile(vocabulary, LANGUAGE_TABLE_TEMPLATE, 'utf8')
  trust?.creationTime(rel(vocabulary), Date.now())

  indexDirty = true
  invalidateVaultSnapshot()
  return { folder: rel(folder), vocabulary: rel(vocabulary) }
})

/* An ordinary note that starts as an empty Markdown table.
   Deliberately a plain `.md` and not a `.language.md`: this is a table for
   anything — the alphabet, a set of verb endings, a packing list — so it gets
   the ordinary grid, where the header row is typed like any other cell and
   columns can be added, removed and moved. A language deck's header is its
   schema and locked for that reason, which is exactly what is not wanted here.

   Three columns and three rows, and the same shape the editor's own "insert
   table" makes, so a table created from the tree and one created inside a note
   are the same thing. Every cell of it, the header included, is typed over. */
const TABLE_TEMPLATE = [
  '| Column 1 | Column 2 | Column 3 |',
  '| --- | --- | --- |',
  '| | | |',
  '| | | |',
  '| | | |',
  ''
].join('\n')

ipcMain.handle('table:create', async (_e, dir, name) => {
  const target = freeName(await realSafePath(dir || ''), name || 'Untitled', '.md')
  await fs.mkdir(path.dirname(target), { recursive: true })
  noteSelfWrite(target)
  await fs.writeFile(target, TABLE_TEMPLATE, 'utf8')
  trust?.creationTime(rel(target), Date.now())
  indexDirty = true
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
   how many *other* notes had to be edited to keep pointing at it. */

ipcMain.handle('file:rename', async (_e, p, nextName) => {
  const abs = await realSafeTargetPath(p)
  const language = isLanguageTable(abs)
  const ext = fsSync.statSync(abs).isDirectory()
    ? ''
    : (language ? LANGUAGE_TABLE_SUFFIX : path.extname(abs))
  /* The extension is the file's, not the name's: the tree shows a document
     without one, so a name typed back with `.pdf` or `.md` on it would other-
     wise be filed as `Paper.pdf.pdf`. */
  let clean = nextName.replace(/[/\\]/g, '-')
    .replace(NOTE_EXT, '')
    .replace(DOCUMENT_EXT, '')
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
})

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

  const ext = isLanguageTable(src) ? LANGUAGE_TABLE_SUFFIX : path.extname(src)
  const result = await relocate(src, freeName(dir, path.basename(src, ext), ext))
  indexDirty = true
  invalidateVaultSnapshot()
  return result
})

ipcMain.handle('file:delete', async (_e, p) => {
  const abs = await realSafeTargetPath(p)
  // Goes to the system Trash, not an unlink — deletes should be recoverable.
  noteSelfWrite(abs)
  await shell.trashItem(abs)
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

/**
 * Copies notes and PDFs dragged in from Finder into the vault.
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

    /* Notes and PDFs, because those are the two things the vault opens. The
       filter is what stops a drag from being a way to read arbitrary files in. */
    if (!MD_EXT.has(path.extname(source).toLowerCase()) && !isPdf(source)) { skipped++; return }
    const ext = path.extname(source)
    const target = freeName(dir, path.basename(source, ext), ext)
    noteSelfWrite(target)
    await fs.copyFile(source, target)
    if (MD_EXT.has(path.extname(target).toLowerCase())) {
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
function termRegex (term, { regex, caseSensitive, word }) {
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
  } catch {
    // The only way to get here is a half-typed pattern in regex mode.
    return { error: 'Not a valid pattern.', terms: [], filters, usable: false }
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
function passesFilters (key, entry, filters) {
  if (filters.type.length && !filters.type.every((kind) => kind === entry.kind)) return false
  if (filters.path.length) {
    const where = key.toLowerCase()
    if (!filters.path.every((p) => where.includes(p))) return false
  }
  if (filters.file.length) {
    const named = entry.name.toLowerCase()
    if (!filters.file.every((f) => named.includes(f))) return false
  }
  if (filters.tag.length) {
    if (!filters.tag.every((t) => hasTag(entry.text, t))) return false
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

async function pdfMarksForSearch (pdfPath) {
  try {
    const file = annotationFile(pdfPath)
    await assertReal(file)
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    return Array.isArray(parsed?.highlights) ? parsed.highlights : []
  } catch { return [] }
}

/** Search the local page-text and highlight sidecars that the PDF reader and
 * Copilot already share. Missing sidecars are reported, never generated in the
 * keystroke path; the background PDF sweep is responsible for preparation. */
async function searchPdfDocuments (q) {
  const { pdfs } = await getVaultSnapshot()
  const results = []
  const unsearchedPaths = []

  await Promise.all(pdfs.map(async (pdfPath) => {
    const name = path.basename(pdfPath)
    const base = { name, text: '', kind: 'pdf', props: [] }
    const wantsPdf = !q.filters.type.length || q.filters.type.includes('pdf')
    const wantsHighlights = !q.filters.type.length || q.filters.type.includes('highlight')
    const pathPasses = (kind) => passesFilters(pdfPath, { ...base, kind }, q.filters)

    if (wantsPdf && pathPasses('pdf')) {
      if (!q.terms.length) {
        results.push({
          path: pdfPath, name, kind: 'pdf',
          hits: [{ page: 1, text: 'PDF document', source: 'pdf' }], total: 0, score: 0
        })
      } else if (await pdfTextIsCurrent(pdfPath)) {
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
            const named = q.terms.filter((term) => term.has.test(name)).length
            results.push({ path: pdfPath, name, kind: 'pdf', hits, total, score: total + named * 8 })
          }
        } catch { unsearchedPaths.push(pdfPath) }
      } else unsearchedPaths.push(pdfPath)
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
      if (hits.length) results.push({
        path: pdfPath, name, kind: 'highlight', hits, total,
        score: total + 6
      })
    }
  }))

  return { results, unsearchedPaths: [...new Set(unsearchedPaths)] }
}

/* Past this many matches of one term in one note, the exact number stops being
   information — it is a ranking input, and the handful of hits shown were
   settled long before. */
const SPOT_CAP = 500

/* How many positions are worth keeping across a whole note. The caller shows
   at most a few lines; the rest of a note's matches are counted, not
   remembered. Holding all 500 meant allocating an array that size for every
   matching note on every keystroke, to throw away all but the first few.

   Shared out between the terms rather than taken first-come: one common word
   would otherwise spend the whole budget and leave the rarer word — the one
   that says why this note matched — with no line to show for it. */
const SPOTS_KEPT = 24
const SPOTS_MIN_PER_TERM = 4

/**
 * Where the terms land in one note, and how often — or null if any term is
 * absent. Positions only; the lines they fall on are read afterwards, for the
 * handful that are actually shown.
 */
function findSpots (text, terms) {
  /* Presence first, for every term, before any of them is scanned in full. A
     note has to hold all of them, so the one that is absent should stop the
     work rather than come after it — a common first word would otherwise be
     walked end to end only for a rare second word to discard the note. */
  for (const term of terms) if (!term.has.test(text)) return null

  const budget = Math.max(SPOTS_MIN_PER_TERM, Math.floor(SPOTS_KEPT / terms.length))
  const spots = []
  let total = 0

  for (const { find } of terms) {
    let found = 0
    find.lastIndex = 0
    for (let m = find.exec(text); m; m = find.exec(text)) {
      found++
      if (found <= budget) spots.push(m.index)
      // A pattern that can match nothing — `x*` — would otherwise spin here.
      if (m[0] === '') find.lastIndex++
      if (found >= SPOT_CAP) break
    }
    total += found
  }

  // The caller reads them in order, and with more than one term they arrive
  // interleaved by term rather than by position.
  if (terms.length > 1) spots.sort((a, b) => a - b)
  return { spots, total }
}

const HEADING_LINE = /^ {0,3}#{1,6}\s/

/**
 * The first few matches, as the lines they fall on.
 *
 * A line is shown once however many times the term appears on it, which is
 * what the readout has always meant — and `heading` is recorded here because
 * this is the one pass that has the line in hand, and ranking wants it.
 *
 * `spots` must be in ascending order, which buys the two things below: the
 * line number is counted forward from the last one worked out rather than from
 * the top of the note for each hit, and "a line already shown" is the previous
 * hit's line rather than a set of every line so far.
 */
function hitLines (text, spots, max = 4) {
  const out = []
  let shown = -1
  let scanned = 0     // how far the line count has been carried
  let atLine = 1

  for (const at of spots) {
    const from = text.lastIndexOf('\n', at - 1) + 1
    if (from === shown) continue
    shown = from

    for (let i = text.indexOf('\n', scanned); i !== -1 && i < from; i = text.indexOf('\n', i + 1)) atLine++
    scanned = from

    let to = text.indexOf('\n', at)
    if (to === -1) to = text.length
    const line = text.slice(from, to)
    out.push({
      line: atLine,
      text: line.trim().slice(0, 220),
      col: at - from,
      heading: HEADING_LINE.test(line)
    })
    if (out.length >= max) break
  }
  return out
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
let lastSearch = null

ipcMain.handle('search:vault', async (_e, raw, opts = {}) => {
  // One shape, whichever way this answers.
  const nothing = { results: [], truncated: false, unsearched: 0, unsearchedPaths: [] }
  if (!vaultPath) return nothing
  const q = compileQuery(raw, opts)
  if (q.error) return { ...nothing, error: q.error }
  if (!q.usable) return nothing
  await ensureIndex()

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

  // What this answer will be narrowed from next, gathered as it is built.
  const keys = []

  for (const [key, entry] of looking) {
    entry.kind = 'note'
    if (!narrowed && !passesFilters(key, entry, q.filters)) continue

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

  const pdfAnswer = await searchPdfDocuments(q)
  results.push(...pdfAnswer.results)
  for (const pdfPath of pdfAnswer.unsearchedPaths) {
    unsearched++
    if (unsearchedPaths.length < 20) unsearchedPaths.push(pdfPath)
  }

  lastSearch = {
    generation: indexGeneration,
    words: q.words,
    filters: q.filters,
    opts: { regex: !!opts.regex, word: !!opts.word, caseSensitive: !!opts.caseSensitive },
    keys
  }

  /* Sorted before the cap, not after. Ranking the first 200 notes the index
     happened to hold is not ranking the vault — on a query that matches widely
     the best note could be absent altogether, which is the opposite of what the
     ordering is for. */
  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

  const truncated = results.length > 200

  /* Answered as an object rather than a bare array with a property hung off
     it: a custom property on an array does not survive the structured clone
     the IPC boundary performs, so the flag arrived as undefined every time and
     the cap was silent. */
  return { results: truncated ? results.slice(0, 200) : results, truncated, unsearched, unsearchedPaths }
})

/**
 * Every tag in the vault and how many notes carry it — the inventory the
 * editor's `#` completion offers and the search overlay lists. One count per
 * note rather than per occurrence: a note that says `#book` five times is one
 * book-note, not five.
 *
 * Not cached. A full scan costs what one search keystroke costs — the texts
 * are already in memory — and the callers debounce; a cache would only be a
 * third place the truth could go stale.
 */
ipcMain.handle('tags:vault', async () => {
  if (!vaultPath) return []
  await ensureIndex()

  const counts = new Map()
  for (const entry of index.values()) {
    if (!entry.text) continue
    const seenHere = new Set()
    HASHTAG.lastIndex = 0
    for (let m = HASHTAG.exec(entry.text); m; m = HASHTAG.exec(entry.text)) {
      const tag = m[2].toLowerCase()
      if (seenHere.has(tag)) continue
      seenHere.add(tag)
      counts.set(tag, (counts.get(tag) || 0) + 1)
    }
  }

  return [...counts]
    .map(([tag, notes]) => ({ tag, notes }))
    .sort((a, b) => b.notes - a.notes || a.tag.localeCompare(b.tag))
})

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
  const pending = []
  for (const [key, entry] of index) {
    if (!passesFilters(key, entry, q.filters)) continue
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

    pending.push({ key, abs: path.resolve(vaultPath, key), next, n })
  }

  /* Concurrently, for the same reason the link rewriter is: a replace across
     three hundred notes was six hundred sequential fsyncs. */
  const done = await mapLimit(pending, WALK_LIMIT, async ({ key, abs, next, n }) => {
    try {
      touchIndex(abs, next, await writeAtomic(abs, next))
      return { key, n }
    } catch (err) {
      console.error('replace failed', key, err)
      return null
    }
  })

  const rewritten = done.filter(Boolean).map((r) => r.key)
  const hits = done.filter(Boolean).reduce((sum, r) => sum + r.n, 0)
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
  // A name first, then a path — the order the renderer resolves them in.
  return nearestNamed(byBase.get(wanted) || [], fromKey) || byPath.get(wanted) || null
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

ipcMain.handle('links:to', async (_e, notePath) => {
  const none = { linked: [], unlinked: [], outgoing: [] }
  if (!vaultPath || !notePath) return none
  await ensureIndex()

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
})

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
ipcMain.handle('ai:attach', async (_e, ext, bytes) => {
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
  const picked = await dialog.showOpenDialog(mainWindow, {
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
  return true
})

/* --------------------------------------------------------- pdf export

   The open note as a PDF file. All the deciding happened in the renderer,
   which re-rendered the note in the paper palette before invoking; this side
   asks where the file goes, prints the window, and writes the bytes.

   `to` skips the save dialog: the scripted probes cannot click it, and a
   probe is how an export is verified. Nobody else hands a path. */

ipcMain.handle('pdf:export', async (_e, name, to) => {
  if (!mainWindow) return { ok: false, error: 'There is no window to print from.' }

  const safe = String(name || 'note').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 120) || 'note'
  let filePath = typeof to === 'string' && to.endsWith('.pdf') ? to : null
  if (!filePath) {
    const chosen = await dialog.showSaveDialog(mainWindow, {
      title: 'Export as PDF',
      defaultPath: path.join(app.getPath('documents'), `${safe}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true }
    filePath = chosen.filePath
  }

  try {
    const bytes = await mainWindow.webContents.printToPDF({
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

/* ---------------------------------------------------------- pdf text

   A PDF's words, in a file beside its highlights: `Papers/thesis.pdf` reads out
   into `.annotations/Papers/thesis.pdf.txt`, one marked section per page.

   For the copilot. Of the three CLIs it can be, only Claude's own tool hands
   a PDF to the model as a document — codex and opencode read files as text and
   answer "I can't read PDFs directly", which is the same paper being readable
   or not depending on a dropdown. Extracting it once here makes the answer the
   same for all three, and cheaper for the one that could already do it: text is
   a fraction of the tokens the pages cost as images.

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
      const ocr = IS_MAC && fsSync.existsSync(appAsset('pdf-ocr'))
        ? appAsset('pdf-ocr')
        : null
      child.postMessage({
        pdf,
        name: path.basename(relPath),
        extractor: appAsset('pdf-text.cjs'),
        ocr,
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
const PDF_PAGES_CACHED = 8

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
  const running = pdfTextQueued.get(relPath)
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

  pdfTextQueued.set(relPath, record)
  pdfTextWaiting.push(record)
  record.job.finally(() => {
    if (pdfTextQueued.get(relPath) === record) pdfTextQueued.delete(relPath)
  }).catch(() => {})
  pumpPdfText()

  return record.job
}

/**
 * Every PDF in the vault, read out if it has not been already.
 *
 * On open and after every change, because the copilot may be asked about a
 * document the reader has never opened — a paper dropped into the folder this
 * morning is a fair question to ask about this afternoon. The walk costs a stat
 * per PDF; only a document without a current sidecar costs anything more.
 */
async function sweepPdfText () {
  if (!vaultPath) return
  const { pdfs } = await getVaultSnapshot()
  for (const pdf of pdfs) ensurePdfText(pdf)
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

async function preparePdfTurn (question, context) {
  const paths = turnPdfs(context)
  if (!paths.length) return { context: context || null, failures: [] }

  /* Said once however many documents a turn carries, and only if one of them
     actually has to be read — see `ensurePdfText`, which is where that is
     known. Two PDFs both needing extraction are one wait, not two phases. */
  let announced = false
  const onWork = () => {
    if (announced) return
    announced = true
    send('ai:event', { k: 'preparing-pdf' })
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
      // The pages are for ranking here; what crosses to the agent is the path
      // to the file they came out of, which it can read for itself.
      pdfDocuments: documents.map(({ pages: _pages, ...document }) => document),
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
      path: path.join(runCacheDir(), `${EXEC_SLOT_PREFIX}${kind}-${slots.length}${EXECUTABLE_EXT}`),
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
      [null, [binary, slot.path], { ...STAGE, operation: 'copy' }],
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

/* stdout is a pipe, so Python otherwise block-buffers it and a long-running
   block can look silent until it exits. `-u` makes each print available to the
   streaming panel immediately; the renderer coalesces the resulting chunks. */
runner('python', {
  file: 'block.py',
  steps: (f) => [[IS_WINDOWS ? 'python' : 'python3', ['-u', f]]]
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
  const binaryFor = (code) => path.join(
    runCacheDir(),
    `${prefix}-${sha1(`${seed}\n${code}`)}${EXECUTABLE_EXT}`
  )
  const build = (source, output) => [...compile(source, output), BUILD]
  const compiled = { slot: prefix, warmCode, build }

  runner(id, {
    file,
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
        [null, [`${binary}.tmp`, binary], { ...BUILD, operation: 'move' }]
      ])
    }
  })
}

/* rustc defaults to edition 2015 when called bare. Pinning 2021 keeps modern
   snippets modern; warning about unused practice-code helpers is just noise. */
compiledRunner('rust', {
  file: 'main.rs',
  prefix: 'rs',
  seed: '2021',
  warmCode: 'fn main() {}\n',
  compile: (source, output) => [
    'rustc', ['--edition', '2021', '-A', 'dead_code', '-o', output, source]
  ]
})

/* `c++` follows the platform compiler; pin the standard so its default age
   does not decide whether a note's structured bindings or lambdas compile. */
compiledRunner('cpp', {
  file: 'main.cpp',
  prefix: 'cpp',
  seed: 'c++20',
  warmCode: 'int main() { return 0; }\n',
  compile: (source, output) => ['c++', ['-std=c++20', '-o', output, source]]
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
 */
const FALLBACK_PATHS = IS_WINDOWS ? [] : [
  '/opt/homebrew/bin', '/opt/homebrew/sbin',   // Homebrew, Apple silicon
  '/usr/local/bin', '/usr/local/sbin',         // Homebrew, Intel — and much else
  '/opt/local/bin',                            // MacPorts
  path.join(os.homedir(), '.local/bin'),
  path.join(os.homedir(), '.cargo/bin'),
  path.join(os.homedir(), '.elan/bin'),           // Lean, via elan
  '/Library/TeX/texbin'                           // MacTeX, for ```tikz
]

let loginPath = null        // resolved once, at startup

function readLoginPath () {
  if (IS_WINDOWS) return Promise.resolve(process.env.PATH || '')
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
    child.on('error', () => finish(null))
    child.on('close', () => finish(out.split('\0')[1]?.trim() || null))

    // A profile that waits for input would otherwise hang this forever. The
    // whole group goes, so a pipeline the profile started goes with it.
    bail = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
      finish(null)
    }, 4000)
    bail.unref?.()
  })
}

/** Longest-first, de-duplicated, in preference order. */
function runnerPath () {
  const seen = new Set()
  return [loginPath, process.env.PATH, ...FALLBACK_PATHS]
    .filter(Boolean)
    .flatMap((part) => part.split(path.delimiter))
    .filter((dir) => dir && !seen.has(dir) && seen.add(dir))
    .join(path.delimiter)
}

/* Enough output to be worth reading, capped so a runaway `yes` cannot grow the
   main process without bound. Each stream gets its own budget. */
const MAX_RUN_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

const runs = new Map()   // id -> { child, timer, dir, done }
let nextRunId = 0

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
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const run = { child, done: false, timer: null, killTimer: null, timedOut: false }
  runs.set(id, run)

  const started = Date.now()
  const sizes = { stdout: 0, stderr: 0 }
  let truncated = false

  const pipe = (stream, name) => {
    stream.setEncoding('utf8')
    stream.on('data', (text) => {
      if (sizes[name] >= MAX_RUN_BYTES) return
      const room = MAX_RUN_BYTES - sizes[name]
      const chunk = text.length > room ? text.slice(0, room) : text
      sizes[name] += chunk.length
      if (chunk.length < text.length) truncated = true
      if (!quiet) send('run:out', { id, stream: name, text: chunk })
    })
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
      resolve({ ms: Date.now() - started, truncated, ...payload })
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
async function runSequence (id, steps, { cwd, timeoutMs, cleanup, quiet = false }) {
  let left = timeoutMs        // the program's remaining budget
  let ms = 0                  // wall clock across every step, build included
  let buildMs = 0
  let result = null

  for (const [cmd, args, opts = {}] of steps) {
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

    if (opts.operation) {
      const started = Date.now()
      try {
        if (opts.operation === 'copy') await fs.copyFile(args[0], args[1])
        else if (opts.operation === 'move') await fs.rename(args[0], args[1])
        else throw new Error(`Unknown file operation: ${opts.operation}`)
        result = { code: 0, signal: null, timedOut: false, ms: Date.now() - started }
      } catch (err) {
        result = { code: null, error: err.message, ms: Date.now() - started }
      }
    } else {
      result = await startRun(id, cmd, args, {
        cwd,
        timeoutMs: opts.build ? BUILD_TIMEOUT_MS : left,
        quiet
      })
    }

    ms += result.ms
    if (opts.build) {
      if (opts.report !== false) buildMs += result.ms
    } else {
      left -= result.ms
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
    const binary = path.join(dir, `program${EXECUTABLE_EXT}`)
    const slot = claimExecutionSlot(spec.compiled.slot)

    try {
      await fs.writeFile(source, spec.compiled.warmCode, 'utf8')
      const result = await runSequence(id, [
        spec.compiled.build(source, binary),
        [null, [binary, slot.path], { ...STAGE, operation: 'copy' }],
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

ipcMain.handle('run:warm', (_e, lang) => warmRunner(lang))

ipcMain.handle('run:start', async (_e, lang, code) => {
  const spec = runnerFor(lang)
  if (!spec) throw new Error(`Tulip cannot run "${lang}" blocks.`)
  if (typeof code !== 'string') throw new Error('Nothing to run.')

  /* If its control already started a compiler warmup, let that finish before
     compiling a new block. A cache hit skips the wait: it has no need for a
     warm compiler, and can claim another slot if the warmup still owns one. */
  if (spec.compiled && !spec.cached(code)) {
    await warmRunner(lang).catch(() => {})
  }

  const id = ++nextRunId
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-run-'))
  const file = path.join(dir, typeof spec.file === 'function' ? spec.file(code) : spec.file)
  await fs.writeFile(file, code, 'utf8')

  const plan = executionPlan(spec.steps(file, dir, code))
  const steps = plan.steps
  // A language that spends its first seconds starting itself up says so; the
  // `runTimeout` setting still overrides whatever it asked for.
  const timeoutMs = runTimeoutMs('runTimeout', spec.timeout || DEFAULT_TIMEOUT_MS)

  // The vault is the working directory, so a snippet's relative paths mean what
  // they mean in the note. Without one, the scratch directory stands in.
  runSequence(id, steps, { cwd: vaultPath || dir, timeoutMs, cleanup: dir })
    .then((result) => send('run:done', { id, ...result }))
    /* A failure before `run:done` is sent leaves the block on screen saying
       "Running…" for the rest of the session — and unrunnable, since the
       renderer keeps the state keyed by its code and Stop cannot find an id
       that was never registered. An invalid working directory (the vault
       unmounted, or renamed while the app was open) is enough to reach here.
       The failure is reported as the run's own, which is what it is. */
    .catch((err) => {
      console.error('run failed', err)
      send('run:done', {
        id,
        code: null,
        error: err?.message || 'This block could not be run.'
      })
      discard(dir)
    })
    .finally(() => plan.release?.())

  return { id, cmd: steps[0][0], timeoutMs }
})

/* Runs the page has asked to stop. Kept separately from `runs` because a
   sequence is only *in* `runs` while one of its steps is actually running. */
const cancelled = new Set()

/** Stop a process and its descendants on the host platform. */
function signalProcessTree (child, signal) {
  if (!child?.pid) return
  if (IS_WINDOWS) {
    const args = ['/pid', String(child.pid), '/t']
    if (signal === 'SIGKILL') args.push('/f')
    try {
      const killer = spawn('taskkill.exe', args, {
        stdio: 'ignore', windowsHide: true, detached: true
      })
      killer.unref()
    } catch {
      try { child.kill() } catch { /* already gone */ }
    }
    return
  }
  try { process.kill(-child.pid, signal) } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

/** SIGTERM first so a program can tidy up, SIGKILL if it will not go. */
function stopRun (id) {
  cancelled.add(id)
  const run = runs.get(id)
  if (!run || run.done) return false

  const signal = (sig) => signalProcessTree(run.child, sig)
  signal('SIGTERM')
  run.killTimer = setTimeout(() => signal('SIGKILL'), 2000)
  return true
}

ipcMain.handle('run:kill', (_e, id) => stopRun(Number(id)))

/* A run belongs to the page that started it; nothing should outlive the window
   or the app. */
function stopAllRuns () {
  for (const id of [...runs.keys()]) stopRun(id)
}

/* For quitting, where there is no later: the SIGKILL escalation timer in
   `stopRun` would never fire, so the groups go outright. */
function killAllRuns () {
  for (const run of runs.values()) {
    signalProcessTree(run.child, 'SIGKILL')
  }
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
async function manimCommand () {
  const configured = readConfig().manimCommand
  if (configured) return String(configured).split(/\s+/)
  return new Promise((resolve) => {
    // The same PATH a run gets, so the probe and the render cannot disagree
    // about which manim is installed.
    const probe = spawn('manim', ['--version'], {
      stdio: 'ignore',
      env: { ...process.env, PATH: runnerPath() }
    })
    probe.on('error', () => resolve(['python3', '-m', 'manim']))
    probe.on('close', (code) => resolve(code === 0 ? ['manim'] : ['python3', '-m', 'manim']))
  })
}

ipcMain.handle('manim:lookup', async (_e, noteName, code, scene) => {
  const found = await artefactAt(await manimTarget(noteName, code, manimQuality()))
  return found ? { path: found, scene: sceneName(code, scene) } : null
})

function manimQuality () {
  const q = String(readConfig().manimQuality || 'm').toLowerCase()
  return MANIM_QUALITIES.has(q) ? q : 'm'
}

ipcMain.handle('manim:render', async (_e, noteName, code, scene) => {
  if (!vaultPath) throw new Error('Open a vault first — the video is saved into it.')
  if (typeof code !== 'string' || !code.trim()) throw new Error('Nothing to render.')

  const name = sceneName(code, scene)
  if (!name) throw new Error('No Scene class found in this block.')

  const quality = manimQuality()
  const target = await manimTarget(noteName, code, quality)
  const id = ++nextRunId
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-manim-'))

  // Started before the work so the page can show progress and offer a Stop.
  queueMicrotask(() => send('run:out', {
    id, stream: 'stdout', text: `Rendering ${name}…\n`
  }))

  const finish = async () => {
    const file = path.join(dir, 'scene.py')
    await fs.writeFile(file, code, 'utf8')

    const [cmd, ...lead] = await manimCommand()
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
    .then((result) => send('run:done', { id, ...result }))

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

ipcMain.handle('tikz:render', async (_e, noteName, code) => {
  if (!vaultPath) throw new Error('Open a vault first — the drawing is saved into it.')
  if (typeof code !== 'string' || !code.trim()) throw new Error('Nothing to draw.')

  const target = await tikzTarget(noteName, code)
  const id = ++nextRunId
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-tikz-'))
  const timeoutMs = runTimeoutMs('tikzTimeout', TIKZ_TIMEOUT_MS)

  queueMicrotask(() => send('run:out', { id, stream: 'stdout', text: 'Drawing…\n' }))

  const finish = async () => {
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
    .then((result) => send('run:done', { id, ...result }))

  return { id }
})

/* --------------------------------------------------------- the copilot */

/* The copilot is a subprocess, not a service — see electron/ai.js. It is
   handed the vault and the login PATH and otherwise left to itself; everything
   it says arrives on one channel. */
/* Prose arrives a token at a time. One IPC message per token is far more
   traffic than a window repainting sixty times a second can use, so runs of
   deltas are joined and sent on a short timer. Anything that is not prose
   flushes what is held first, so nothing is ever reordered around it. */
let aiText = ''
let aiTimer = null
let aiBaseline = null

async function finishAiHistory () {
  if (!aiBaseline) return null
  const before = aiBaseline
  aiBaseline = null
  indexDirty = true
  invalidateVaultSnapshot()
  const after = await snapshotNotes()
  const changes = changedNotes(before, after)
  const operation = trust?.record({ source: 'copilot', changes }) || null
  return operation
}

function flushAiText () {
  clearTimeout(aiTimer)
  aiTimer = null
  if (!aiText) return
  const text = aiText
  aiText = ''
  send('ai:event', { k: 'text', text })
}

ai.attach(
  (event) => {
    if (event?.k === 'text') {
      aiText += event.text || ''
      if (!aiTimer) aiTimer = setTimeout(flushAiText, 32)
      return
    }
    flushAiText()
    if (event?.k === 'turn-end') {
      finishAiHistory()
        .then((operation) => {
          if (operation) send('ai:event', { k: 'review', operation })
          send('ai:event', event)
        })
        .catch(() => send('ai:event', event))
      return
    }
    send('ai:event', event)
  },
  () => runnerPath()
)

ipcMain.handle('ai:start', (_e, opts) => {
  ai.setVault(vaultPath)
  return ai.start(opts || {})
})
ipcMain.handle('ai:models', (_e, opts) => ai.models({ fresh: !!opts?.fresh }))
ipcMain.handle('ai:send', async (_e, text, context) => {
  ai.setVault(vaultPath)
  const words = String(text || '')
  const prepared = await preparePdfTurn(words, context || null)
  if (prepared.failures.length) {
    const names = prepared.failures.map((failure) => failure.path).join(', ')
    return { ok: false, error: `Tulip could not prepare ${names} for the copilot.` }
  }
  aiBaseline = await snapshotNotes()
  const result = await ai.send(words, prepared.context)
  if (!result?.ok) {
    const operation = await finishAiHistory().catch(() => null)
    if (operation) send('ai:event', { k: 'review', operation })
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
ipcMain.handle('ai:announce', (_e, info) => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return { ok: false }
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
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus() }
  })
  notice.show()
  app.dock?.bounce?.('informational')
  return { ok: true }
})

ipcMain.handle('ai:stop', async () => {
  const stopped = ai.stop()
  const operation = await finishAiHistory().catch(() => null)
  if (operation) send('ai:event', { k: 'review', operation })
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

  const inverse = []
  for (const change of selected) {
    /* Both halves of the guard: a recorded change is never the vault itself,
       and restoring one writes content through the last component. */
    const abs = safeTargetPath(change.path)
    await assertReal(abs)
    const current = await fs.readFile(abs, 'utf8').catch(() => null)
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
  send('vault:changed', { paths: selected.map((change) => change.path) })
  return { restored: selected.map((change) => change.path) }
})

/* Conversations are kept beside the app's other state rather than in the
   vault: a chat about a note is not part of the note, and a vault synced
   between machines should not carry transcripts around with it. One file per
   vault, named by digest so two vaults with the same folder name stay apart. */
const CHAT_DIR = () => path.join(app.getPath('userData'), 'chats')
const chatFile = () => path.join(CHAT_DIR(), `${sha1(vaultPath || '')}.json`)

ipcMain.handle('ai:history:load', () => {
  if (!vaultPath) return {}
  const file = chatFile()
  let raw
  try {
    raw = fsSync.readFileSync(file, 'utf8')
  } catch {
    // No history for this vault yet, which is the ordinary first-run case.
    return {}
  }
  try {
    return JSON.parse(raw)
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
    return {}
  }
})

ipcMain.handle('ai:history:save', async (_e, history) => {
  if (!vaultPath) return { ok: false }
  try {
    await fs.mkdir(CHAT_DIR(), { recursive: true })
    /* Not fsync'd. The last write of a transcript is the one the window makes
       on its way out, and waiting on the disk there is both the slowest place
       to do it and the likeliest to be cut short — which is what left hundreds
       of half-renamed temp files beside the history. The rename still keeps the
       file whole; only the guarantee about a power cut is given up, over a
       chat log that is already on screen. */
    await writeAtomic(chatFile(), JSON.stringify(history), { durable: false })
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
ipcMain.handle('zoom:claim', (_e, on) => { documentOwnsZoom = !!on })
/* The browser's own undo, for the plain text fields — the message box, the
   rename field, a search query. What the `undo` role used to do, asked for
   only when the renderer has decided this is the field's history to walk and
   not the note's or the PDF's. */
ipcMain.handle('edit:undo', (e) => e.sender.undo())
ipcMain.handle('edit:redo', (e) => e.sender.redo())

ipcMain.handle('config:get', () => readConfig())
ipcMain.handle('config:set', (_e, patch) => {
  const next = writeConfig(patch)
  /* The two settings that move something on disk rather than repaint it.
     Setting them lands nowhere unless the thing that reads them is told. */
  if (Object.prototype.hasOwnProperty.call(patch, 'historyInVault') && vaultPath) {
    trust?.setVault(vaultPath, next.historyInVault === true)
  }
  return next
})

ipcMain.handle('durability:flush', () => flushPendingDurability())
ipcMain.handle('theme:system', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))

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

function allowedGuestUrl (url, partition) {
  // A preview guest is exactly the document the renderer wrote into it. Never
  // http(s), and never any other local scheme either.
  if (partition === HTML_RUN_PARTITION) return /^data:text\/html[;,]/i.test(String(url || ''))
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    if (partition === YOUTUBE_PARTITION) return YOUTUBE_HOST.test(u.hostname)
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

  /* Once for the app, not once per window. On macOS closing the last window
     does not quit, and reopening from the Dock builds another — so registering
     this inside createWindow left a listener behind on every cycle, each one
     sending the same message to the same window. */
  nativeTheme.on('updated', () => {
    send('theme:system', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  })

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
      abs = url.host === 'app' ? appAsset(wanted) : await realSafePath(wanted)
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

  // Warmed now rather than on the first Run, so clicking Run does not wait on
  // a login shell. A failure here is not fatal — the fallbacks still apply.
  readLoginPath().then((value) => { loginPath = value }).catch(() => {})
  pruneRunCache().catch(() => {})

  buildMenu()
  createWindow()
  guardGuests()

  // Ten seconds after launch and every six hours thereafter — see updates.js
  // for why it waits and what turns it off.
  updates.watch()

  const cfg = readConfig()
  /* `vaultPath` was the persisted home before default vaults had their own
     name. Prefer the explicit setting, and promote an existing old config on
     its first launch after the upgrade. */
  const savedVault = cfg.defaultVaultPath || cfg.vaultPath
  if (savedVault && fsSync.existsSync(savedVault)) {
    vaultPath = savedVault
    if (cfg.defaultVaultPath !== savedVault) {
      writeConfig({ defaultVaultPath: savedVault, vaultPath: savedVault })
    }
    trust.setVault(vaultPath, cfg.historyInVault === true)
    /* The same tidy-up `openVault` does, for the vault that is simply still
       open from last time — which is how the app is started nearly always, and
       so the path the migration actually runs on. */
    migrateAttachments(vaultPath).catch(() => {})
    watchVault()
    ensureIndex().catch(() => {})
    sweepPdfText().catch(() => {})
    mainWindow.setTitle(path.basename(vaultPath))
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* A helper process Chromium runs beside the renderer — the GPU process, a
   utility process, a <webview>'s own renderer — has died. Chromium restarts
   most of these by itself, and the app carries on, so there is nothing to do
   about it here.

   Logged all the same, because these deaths are what the *next* report will be
   about and nothing else records them: a GPU process that keeps dying is a
   window that keeps going blank or losing its canvases, and a note holding a
   three.js scene or a heavy PDF is the likeliest thing to have caused it. */
app.on('child-process-gone', (_event, details) => {
  console.error('child process gone', details)
})

app.on('before-quit', () => {
  quitting = true
  if (watcher) watcher.close()
  killAllRuns()
  ai.stop('SIGKILL')
  trust?.flushSync()
  flushConfig()
})
