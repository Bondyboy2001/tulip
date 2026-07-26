'use strict'

const {
  app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme, protocol, net
} = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json')

const IGNORED_DIRS = new Set(['.git', '.obsidian', '.tulip', 'node_modules', '.trash'])
const MD_EXT = new Set(['.md', '.markdown', '.mdown'])

/* Everything a note can embed. Anything outside this set is not offered to the
   renderer as an attachment, so a vault full of unrelated files does not turn
   into a list of things to link to.

   Derived from the same table src/assets.js reads, because the two answers have
   to agree: a format listed here but not there is offered as an attachment and
   then rendered as an unclickable chip, and the reverse is an embed that never
   resolves. Adding a format is one edit, in the JSON. */
const ASSET_EXT = new Set(
  Object.entries(require('./asset-kinds.json'))
    .filter(([kind]) => !kind.startsWith('_'))
    .flatMap(([, exts]) => exts.map((ext) => `.${ext}`))
)

/* Pasted images land in `<vault>/.images/<Note name>/`. Dotted so the folder
   stays out of Finder and out of the sidebar — the pictures belong to the
   notes, not beside them — and one folder per note so the vault's images are
   grouped the way its prose is. */
const ATTACHMENT_DIR = '.images'

/* The renderer reaches attachments through this scheme rather than file://,
   which the page's CSP does not admit. It has to be declared before the app is
   ready, so it sits at module scope. */
protocol.registerSchemesAsPrivileged([{
  scheme: 'tulip-file',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}])

let mainWindow = null
let vaultPath = null
let watcher = null

/* ---------------------------------------------------------------- config */

function readConfig () {
  try {
    return JSON.parse(fsSync.readFileSync(CONFIG_PATH(), 'utf8'))
  } catch {
    return {}
  }
}

function writeConfig (patch) {
  const next = { ...readConfig(), ...patch }
  try {
    fsSync.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true })
    fsSync.writeFileSync(CONFIG_PATH(), JSON.stringify(next, null, 2))
  } catch (err) {
    console.error('config write failed', err)
  }
  return next
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

function rel (abs) {
  return path.relative(vaultPath, abs).split(path.sep).join('/')
}

const stripExt = (p) => p.replace(/\.(md|markdown|mdown)$/i, '')

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
 * Depth-first over every file the vault admits, skipping the ignored dirs.
 *
 * Dot-directories are skipped, with one deliberate exception: the attachments
 * folder is dotted so it stays out of Finder and out of the sidebar, but its
 * contents still have to be findable or no embed would ever resolve.
 */
async function walkVault (dir, onFile) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const hidden = entry.name.startsWith('.') && entry.name !== ATTACHMENT_DIR
    if (hidden || IGNORED_DIRS.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) await walkVault(abs, onFile)
    else await onFile(abs)
  }
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

/**
 * Brings the index back in line with the disk. `indexDirty` is cleared before
 * the walk, not after, so a change that lands mid-walk leaves the flag set and
 * the next caller syncs again rather than trusting a half-stale pass.
 */
async function syncIndex () {
  if (!vaultPath) { index.clear(); return }
  indexDirty = false

  const seen = new Set()
  await walkVault(vaultPath, async (abs) => {
    if (!MD_EXT.has(path.extname(abs).toLowerCase())) return
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
}

function ensureIndex () {
  if (!indexDirty && !syncing) return Promise.resolve()
  if (!syncing) syncing = syncIndex().finally(() => { syncing = null })
  return syncing
}

/** Record a write we just made, so the next search does not re-read the file. */
function touchIndex (absPath, text) {
  try {
    const stat = fsSync.statSync(absPath)
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

async function readTree (dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const out = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
    const abs = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      const children = await readTree(abs)
      out.push({ type: 'folder', name: entry.name, path: rel(abs), children })
    } else if (MD_EXT.has(path.extname(entry.name).toLowerCase())) {
      out.push({
        type: 'file',
        name: stripExt(entry.name),
        path: rel(abs)
      })
    }
  }

  // Folders first, then files, each alphabetical — a stable order beats mtime
  // ordering here because the sidebar is a map, not a feed.
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })
  return out
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
 * Returns how many notes were edited, for the toast.
 */
async function followMoves (moves) {
  if (!moves.length) return 0

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
    [...new Set(moves.map((m) => path.basename(stripExt(m.from))))]
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|'),
    'i'
  )

  let touched = 0
  for (const [key, entry] of index) {
    if (!mentions.test(entry.text)) continue
    const next = rewriteLinks(entry.text, moves, before, after)
    if (next === entry.text) continue
    const abs = path.resolve(vaultPath, key)
    try {
      await writeAtomic(abs, next)
      touchIndex(abs, next)
      touched++
    } catch (err) {
      console.error('link rewrite failed', key, err)
    }
  }
  return touched
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

  await fs.rename(srcAbs, targetAbs)
  return { path: rel(targetAbs), links: await followMoves(moves) }
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

/**
 * Write through a temporary file in the same directory, then rename over the
 * target. A crash mid-write leaves the previous note intact instead of a
 * truncated one.
 */
async function writeAtomic (abs, content) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.tulip-tmp`)
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, abs)
}

function watchVault () {
  if (watcher) { watcher.close(); watcher = null }
  if (!vaultPath) return

  let timer = null
  try {
    watcher = fsSync.watch(vaultPath, { recursive: true }, () => {
      // Marked immediately, not on the debounce: a search that lands inside the
      // quiet window must still see that something moved.
      indexDirty = true
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('vault:changed')
        }
      }, 180)
    })
  } catch (err) {
    console.error('watch failed', err)
  }
}

async function openVault (dir) {
  vaultPath = dir
  writeConfig({ vaultPath: dir })
  index.clear()
  indexDirty = true
  watchVault()
  // Warmed in the background so the first search does not pay for the walk.
  ensureIndex().catch(() => {})
  if (mainWindow) {
    mainWindow.setTitle(path.basename(dir))
    mainWindow.webContents.send('vault:opened', { path: dir, name: path.basename(dir) })
  }
}

/* --------------------------------------------------------------- the app */

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 680,
    minHeight: 460,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141317' : '#FBFAF8',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())

  // External links open in the browser; the vault never navigates away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Nothing a note started outlives the window that started it.
  mainWindow.on('closed', () => { mainWindow = null; stopAllRuns() })

  // Restore the saved zoom once the page exists, and report it so the status
  // bar agrees with reality from the first frame.
  mainWindow.webContents.on('did-finish-load', () => {
    const saved = readConfig().zoom
    if (saved && saved !== 1) mainWindow.webContents.setZoomFactor(saved)
    send('zoom', Math.round((saved || 1) * 100))
  })

  // Ctrl+scroll and trackpad pinch bypass the menu, so the indicator is told
  // about the resulting factor rather than the keystroke.
  mainWindow.webContents.on('zoom-changed', (_event, direction) => {
    nudgeZoom(direction === 'in' ? 1 : -1)
  })

  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('theme:system', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    }
  })
}

function send (channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

/* ---------------------------------------------------------------- zoom */

/* Browser-style stops rather than Electron's 1.2^level curve, so the reported
   percentage is always a round number someone would recognise. */
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

function zoomFactor () {
  if (!mainWindow || mainWindow.isDestroyed()) return 1
  return mainWindow.webContents.getZoomFactor()
}

function applyZoom (factor) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const clamped = Math.min(3, Math.max(0.5, factor))
  mainWindow.webContents.setZoomFactor(clamped)
  writeConfig({ zoom: clamped })
  send('zoom', Math.round(clamped * 100))
}

function nudgeZoom (direction) {
  const current = zoomFactor()
  let index = ZOOM_STEPS.findIndex((s) => Math.abs(s - current) < 0.005)
  if (index === -1) {
    // Pinch zoom lands between stops; step from whichever stop is nearest.
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
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('menu', 'settings') },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'Cmd+N', click: () => send('menu', 'new-note') },
        { label: 'New Folder', accelerator: 'Cmd+Shift+N', click: () => send('menu', 'new-folder') },
        { type: 'separator' },
        { label: 'Open Vault…', accelerator: 'Cmd+Shift+O', click: () => pickVault() },
        { label: 'Reveal in Finder', click: () => send('menu', 'reveal') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'Cmd+S', click: () => send('menu', 'save') }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Note', accelerator: 'Cmd+F', click: () => send('menu', 'find') },
        { label: 'Search Vault', accelerator: 'Cmd+Shift+F', click: () => send('menu', 'search') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Back', accelerator: 'Cmd+[', click: () => send('menu', 'back') },
        { label: 'Forward', accelerator: 'Cmd+]', click: () => send('menu', 'forward') },
        { type: 'separator' },
        { label: 'Quick Switcher', accelerator: 'Cmd+O', click: () => send('menu', 'switcher') },
        { label: 'Command Palette', accelerator: 'Cmd+P', click: () => send('menu', 'commands') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'Cmd+\\', click: () => send('menu', 'sidebar') },
        { label: 'Reading View', accelerator: 'Cmd+1', click: () => send('menu', 'view-read') },
        { label: 'Editing View', accelerator: 'Cmd+2', click: () => send('menu', 'view-edit') },
        { label: 'Raw View', accelerator: 'Cmd+3', click: () => send('menu', 'view-raw') },
        { label: 'Toggle Reading View', accelerator: 'Cmd+E', click: () => send('menu', 'reading') },
        { label: 'Toggle Theme', accelerator: 'Cmd+Shift+L', click: () => send('menu', 'theme') },
        { label: 'Change Theme…', click: () => send('menu', 'themes') },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => applyZoom(1) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => nudgeZoom(1) },
        // ⌘= is what the key actually produces unshifted; both reach the same place.
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, click: () => nudgeZoom(1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => nudgeZoom(-1) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' }
  ]
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
  await openVault(res.filePaths[0])
  return res.filePaths[0]
}

/* ------------------------------------------------------------------- IPC */

ipcMain.handle('vault:pick', () => pickVault())

ipcMain.handle('vault:current', () => {
  if (!vaultPath) return null
  return { path: vaultPath, name: path.basename(vaultPath) }
})

ipcMain.handle('vault:tree', async () => {
  if (!vaultPath) return []
  return readTree(vaultPath)
})

ipcMain.handle('file:read', async (_e, p) => {
  return fs.readFile(safePath(p), 'utf8')
})

ipcMain.handle('file:write', async (_e, p, content) => {
  const abs = safePath(p)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
  // The text is already here, so the next sync can skip re-reading it. Without
  // this, every autosave would cost the index a read of the note being typed.
  touchIndex(abs, content)
  return true
})

ipcMain.handle('file:create', async (_e, dir, name) => {
  const target = freeName(safePath(dir || ''), name || 'Untitled', '.md')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, '', 'utf8')
  return rel(target)
})

ipcMain.handle('folder:create', async (_e, dir, name) => {
  const target = freeName(safePath(dir || ''), name || 'New folder')
  await fs.mkdir(target, { recursive: true })
  return rel(target)
})

/* Both of these answer with `{ path, links }` — where the thing ended up, and
   how many *other* notes had to be edited to keep pointing at it. */

ipcMain.handle('file:rename', async (_e, p, nextName) => {
  const abs = safePath(p)
  const ext = fsSync.statSync(abs).isDirectory() ? '' : path.extname(abs)
  const clean = nextName.replace(/[/\\]/g, '-').replace(/\.(md|markdown|mdown)$/i, '')
  const target = safePath(path.join(path.dirname(rel(abs)), clean + ext))
  if (target === abs) return { path: rel(abs), links: 0 }
  // Unlike the other routes into the vault, a rename says what it wants to be
  // called — silently landing on "${clean} 2" would ignore that.
  if (fsSync.existsSync(target)) throw new Error(`"${clean}" already exists here.`)

  return relocate(abs, target)
})

ipcMain.handle('file:move', async (_e, from, destDir) => {
  const src = safePath(from)
  const dir = destDir ? safePath(destDir) : path.resolve(vaultPath)

  if (!fsSync.existsSync(dir) || !fsSync.statSync(dir).isDirectory()) {
    throw new Error('That destination is not a folder.')
  }
  // Moving a folder inside itself would detach the subtree from the vault.
  if (src === dir || dir.startsWith(src + path.sep)) {
    throw new Error('A folder cannot be moved into itself.')
  }
  if (path.dirname(src) === dir) return { path: rel(src), links: 0 }

  const ext = path.extname(src)
  return relocate(src, freeName(dir, path.basename(src, ext), ext))
})

ipcMain.handle('file:delete', async (_e, p) => {
  const abs = safePath(p)
  // Goes to the system Trash, not an unlink — deletes should be recoverable.
  await shell.trashItem(abs)
  return true
})

/**
 * Copies notes dragged in from Finder into the vault.
 *
 * Copies rather than moves: what was dropped is somebody else's file until the
 * user says otherwise, and a drag that silently emptied a Finder window would
 * be a bad surprise. A dropped folder comes in with its shape intact, carrying
 * only the notes inside it — the extension filter is what stops this from
 * being a way to read arbitrary files into the vault.
 */
ipcMain.handle('file:import', async (_e, destDir, sources) => {
  const root = safePath(destDir || '')
  await fs.mkdir(root, { recursive: true })

  let imported = 0
  let skipped = 0
  let first = null

  const copyInto = async (source, dir) => {
    let stat
    try { stat = await fs.stat(source) } catch { skipped++; return }

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

    if (!MD_EXT.has(path.extname(source).toLowerCase())) { skipped++; return }
    const ext = path.extname(source)
    const target = freeName(dir, path.basename(source, ext), ext)
    await fs.copyFile(source, target)
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
  return { imported, skipped, first }
})

ipcMain.handle('file:reveal', async (_e, p) => {
  shell.showItemInFolder(safePath(p))
})

ipcMain.handle('shell:open', async (_e, url) => {
  if (/^https?:/.test(url)) await shell.openExternal(url)
})

/**
 * Runs against the in-memory index rather than the disk. The first query after
 * a change pays for a sync — a stat per note plus a read of whatever actually
 * moved — and every query after it is a scan of strings already in memory.
 */
ipcMain.handle('search:vault', async (_e, query) => {
  if (!vaultPath || !query || query.trim().length < 2) return []
  await ensureIndex()

  const needle = query.toLowerCase()
  /* The rejection test runs against every note on every query, so it must not
     allocate: `text.toLowerCase().includes(needle)` would copy the whole vault
     — megabytes — for each keystroke. A case-insensitive regex scans in place. */
  const present = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

  const results = []
  let truncated = false

  for (const [key, entry] of index) {
    if (results.length >= 200) { truncated = true; break }
    if (!present.test(entry.text)) continue

    const lines = entry.text.split('\n')
    const hits = []
    let total = 0
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].toLowerCase().indexOf(needle)
      if (idx === -1) continue
      total++
      if (hits.length < 4) {
        hits.push({ line: i + 1, text: lines[i].trim().slice(0, 220), col: idx })
      }
    }
    if (hits.length) results.push({ path: key, name: entry.name, hits, total })
  }

  // Notes where the phrase turns up repeatedly are more likely to be about it.
  results.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
  if (truncated) results.truncated = true
  return results
})

/** Every attachment the vault holds, for resolving embeds by name. */
ipcMain.handle('vault:assets', async () => {
  if (!vaultPath) return []
  const out = []
  await walkVault(vaultPath, async (abs) => {
    if (ASSET_EXT.has(path.extname(abs).toLowerCase())) out.push(rel(abs))
  })
  return out
})

/**
 * Files a pasted or dropped attachment. The layout is decided here rather than
 * in the renderer, so there is one answer to where an image lives:
 *
 *     <vault>/.images/<Note name>/<Note name>.png
 *     <vault>/.images/<Note name>/<Note name> 2.png
 *
 * The picture is named after the note it was pasted into and sits in that
 * note's own folder, so a vault's images are as navigable as its prose even
 * though the folder itself is hidden. The bytes arrive as a Uint8Array.
 */
ipcMain.handle('asset:write', async (_e, noteName, ext, bytes) => {
  const base = String(noteName || 'Untitled')
  const suffix = /^\.[a-z0-9]+$/i.test(ext || '') ? ext.toLowerCase() : '.png'

  const folder = safePath(path.join(ATTACHMENT_DIR, base.replace(/[/\\]/g, '-')))
  await fs.mkdir(folder, { recursive: true })

  const target = freeName(folder, base, suffix)
  await fs.writeFile(target, Buffer.from(bytes))
  return { path: rel(target), name: path.basename(target) }
})

/* ------------------------------------------------------- running a block
   A fenced block can be executed and its output shown under it. Everything
   here runs in the main process: the renderer has no node access by design and
   asks for a run by name, the same way it asks for a file.

   Output is streamed back and held only by the page that asked for it — it is
   never written into the note, so a run leaves the file on disk untouched. */

/* The word after the fence, mapped to the interpreter that should see it.
   Nothing else is runnable: a `json` or `diff` block is data, and a language
   Tulip merely highlights is not one it can promise to execute. */
const RUNNERS = new Map([
  ['js', 'node'], ['javascript', 'node'], ['node', 'node'],
  ['mjs', 'node'], ['cjs', 'node'],
  ['py', 'python3'], ['python', 'python3'], ['python3', 'python3'],
  ['sh', 'sh'], ['shell', 'sh'], ['bash', 'bash'], ['zsh', 'zsh']
])

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
const FALLBACK_PATHS = [
  '/opt/homebrew/bin', '/opt/homebrew/sbin',   // Homebrew, Apple silicon
  '/usr/local/bin', '/usr/local/sbin',         // Homebrew, Intel — and much else
  '/opt/local/bin',                            // MacPorts
  path.join(os.homedir(), '.local/bin'),
  path.join(os.homedir(), '.cargo/bin')
]

let loginPath = null        // resolved once, at startup

function readLoginPath () {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    // -l runs the profile files, -i because an interactive session is where
    // most people's PATH edits actually take effect. The value is fenced so a
    // chatty profile's banner cannot be mistaken for it.
    const child = spawn(shell, ['-lic', 'printf "\\0%s\\0" "$PATH"'], {
      stdio: ['ignore', 'pipe', 'ignore']
    })

    let out = ''
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => finish(null))
    child.on('close', () => finish(out.split('\0')[1]?.trim() || null))
    // A profile that waits for input would otherwise hang this forever.
    const bail = setTimeout(() => { try { process.kill(-child.pid) } catch {} ; finish(null) }, 4000)
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

/** The extension the interpreter expects. Node needs `.mjs` before it will
 *  accept a top-level `import`, and `.js` before it will accept `require`. */
function scriptName (cmd, code) {
  if (cmd !== 'node') return cmd === 'python3' ? 'block.py' : 'block.sh'
  return /^\s*(import\s|export\s)/m.test(code) ? 'block.mjs' : 'block.js'
}

/**
 * Spawns one command, streams it to the page under `id`, and resolves when it
 * is over. Both the Run control and Manim go through here, so the timeout, the
 * output cap, the process-group kill and the shape of what the renderer hears
 * are written once.
 *
 * @returns {Promise<{code:number|null, signal:string|null, timedOut:boolean, error?:string}>}
 */
function startRun (id, cmd, args, { cwd, timeoutMs, cleanup = null }) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, PATH: runnerPath(), TULIP_VAULT: vaultPath || '' },
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

  const pipe = (stream, name) => {
    stream.setEncoding('utf8')
    stream.on('data', (text) => {
      if (sizes[name] >= MAX_RUN_BYTES) return
      const room = MAX_RUN_BYTES - sizes[name]
      const chunk = text.length > room ? text.slice(0, room) : text
      sizes[name] += chunk.length
      if (chunk.length < text.length) truncated = true
      send('run:out', { id, stream: name, text: chunk })
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
      if (cleanup) fs.rm(cleanup, { recursive: true, force: true }).catch(() => {})
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
ipcMain.handle('run:start', async (_e, lang, code) => {
  const cmd = runnerFor(lang)
  if (!cmd) throw new Error(`Tulip cannot run "${lang}" blocks.`)
  if (typeof code !== 'string') throw new Error('Nothing to run.')

  const id = ++nextRunId
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-run-'))
  const file = path.join(dir, scriptName(cmd, code))
  await fs.writeFile(file, code, 'utf8')

  const timeoutMs = runTimeoutMs('runTimeout', DEFAULT_TIMEOUT_MS)

  // The vault is the working directory, so a snippet's relative paths mean what
  // they mean in the note. Without one, the scratch directory stands in.
  startRun(id, cmd, [file], { cwd: vaultPath || dir, timeoutMs, cleanup: dir })
    .then((result) => send('run:done', { id, ...result }))

  return { id, cmd, timeoutMs }
})

/** SIGTERM first so a program can tidy up, SIGKILL if it will not go. */
function stopRun (id) {
  const run = runs.get(id)
  if (!run || run.done) return false

  const signal = (sig) => {
    try { process.kill(-run.child.pid, sig) } catch { try { run.child.kill(sig) } catch {} }
  }
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

const MANIM_TIMEOUT_MS = 5 * 60 * 1000

/** Manim CE's quality flags, smallest first. Medium is 720p30. */
const MANIM_QUALITIES = new Set(['l', 'm', 'h', 'p', 'k'])

/** Where a note's rendered scenes live, and what one is called. */
function manimTarget (noteName, code, quality) {
  const digest = crypto.createHash('sha1').update(`${quality}\n${code}`).digest('hex').slice(0, 10)
  const folder = path.join(ATTACHMENT_DIR, String(noteName || 'Untitled').replace(/[/\\]/g, '-'))
  return safePath(path.join(folder, `manim-${digest}.mp4`))
}

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
    const probe = spawn('manim', ['--version'], { stdio: 'ignore' })
    probe.on('error', () => resolve(['python3', '-m', 'manim']))
    probe.on('close', (code) => resolve(code === 0 ? ['manim'] : ['python3', '-m', 'manim']))
  })
}

/** Has this block already been rendered? Answered without running anything, so
 *  the reading view can show the video the moment the note opens. */
ipcMain.handle('manim:lookup', async (_e, noteName, code, scene) => {
  if (!vaultPath) return null
  const quality = manimQuality()
  const target = manimTarget(noteName, code, quality)
  try {
    await fs.access(target)
    return { path: rel(target), scene: sceneName(code, scene) }
  } catch {
    return null
  }
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
  const target = manimTarget(noteName, code, quality)
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

    if (result.error || result.code !== 0) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      return { ...result, path: null }
    }

    const produced = await newestVideo(path.join(dir, 'media'))
    if (!produced) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      return { ...result, path: null, error: 'Manim finished but produced no video.' }
    }

    await fs.mkdir(path.dirname(target), { recursive: true })
    // Copied rather than renamed: the temp dir is often on a different volume,
    // where rename fails outright.
    await fs.copyFile(produced, target)
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    return { ...result, path: rel(target) }
  }

  finish()
    .catch((err) => ({ code: null, ms: 0, error: err.message, path: null }))
    .then((result) => send('run:done', { id, ...result }))

  return { id, scene: name, quality }
})

ipcMain.handle('zoom:reset', () => applyZoom(1))
ipcMain.handle('config:get', () => readConfig())
ipcMain.handle('config:set', (_e, patch) => writeConfig(patch))
ipcMain.handle('theme:system', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))

/* ----------------------------------------------------------- lifecycle */

app.whenReady().then(async () => {
  /* Attachments are served from here rather than file://. The URL carries a
     vault-relative path and nothing else, so the same guard that governs every
     other filesystem call decides what the page is allowed to load — a note
     containing ../../.ssh/id_rsa gets a 403, not a file. */
  protocol.handle('tulip-file', async (request) => {
    let abs
    try {
      abs = safePath(decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, ''))
    } catch {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      return await net.fetch(pathToFileURL(abs).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  // Warmed now rather than on the first Run, so clicking Run does not wait on
  // a login shell. A failure here is not fatal — the fallbacks still apply.
  readLoginPath().then((value) => { loginPath = value }).catch(() => {})

  buildMenu()
  createWindow()

  const cfg = readConfig()
  if (cfg.vaultPath && fsSync.existsSync(cfg.vaultPath)) {
    vaultPath = cfg.vaultPath
    watchVault()
    ensureIndex().catch(() => {})
    mainWindow.setTitle(path.basename(vaultPath))
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => { if (watcher) watcher.close(); stopAllRuns() })
