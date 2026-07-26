import './styles.css'
import MarkdownIt from 'markdown-it'
import { createEditor, openSearchPanel } from './editor.js'
import { languageChip } from './languages.js'
import { highlightInto } from './highlight.js'
import { mathPlugin } from './math.js'
import { moneyPlugin } from './money.js'
import { THEMES, resolveTheme, isTheme } from './themes.js'
import {
  assetIndex, embedSpec, renderEmbed, parseEmbedSuffix, isAsset
} from './assets.js'
import { attachRunControl } from './runcode.js'
import { attachManim, isManim } from './manim.js'

const api = window.tulip
const $ = (id) => document.getElementById(id)

/* ----------------------------------------------------------------- state */

const state = {
  vault: null,
  tree: [],
  files: [],          // flattened, for the switcher and wikilinks
  assetsKey: '',      // the attachment list as last seen, to skip no-op rebuilds
  resolveAsset: () => null,
  current: null,      // { path, name, dir }
  history: [],        // { path, at, top } — where you have been, and where in it
  historyAt: -1,
  dirty: false,
  view: 'edit',       // 'edit' (live preview) | 'read' (rendered) | 'raw' (source)
  expanded: new Set(),
  picked: new Set(),   // multi-selected file paths in the tree
  pickAnchor: null,    // where a shift-range measures from
  dragging: null,      // paths currently being dragged in the tree
  theme: 'system',
  saveTimer: null,
  overlay: null       // { mode, items, index }
}

const el = {
  app: $('app'),
  tree: $('tree'),
  vaultLabel: $('vault-label'),
  noteCount: $('note-count'),
  crumbs: $('crumbs'),
  stage: $('stage'),
  editorHost: $('editor-host'),
  reading: $('reading'),
  empty: $('empty'),
  openVault: $('btn-open-vault'),
  statusLeft: $('status-left'),
  statusRight: $('status-right'),
  overlay: $('overlay'),
  panelInput: $('panel-input'),
  panelList: $('panel-list'),
  panelFoot: $('panel-foot'),
  toast: $('toast'),
  ctx: $('ctx'),
  viewSwitch: $('view-switch'),
  zoom: $('zoom')
}

const reading = () => state.view === 'read'

/** Resolve an attachment the way the open note would read it. Both views go
 *  through this, so neither can end up resolving against a different folder. */
const resolveHere = (src) => state.resolveAsset(src, state.current?.dir || '')

const NOTE_EXT = /\.(md|markdown|mdown)$/i

/** The `{ path, name, dir }` a note is identified by, from its path alone. */
function noteRef (path) {
  return {
    path,
    name: path.split('/').pop().replace(NOTE_EXT, ''),
    dir: path.split('/').slice(0, -1).join('/')
  }
}

/* -------------------------------------------------------------- markdown */

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: true })

md.use(mathPlugin)
md.use(moneyPlugin)

/**
 * `[[target|suffix]]` at `pos`, optionally behind a `!`. Both bracket rules
 * below run on it so they cannot disagree about what ends a link — the offsets
 * are the only thing that differed between them, and they are the easiest
 * thing to get wrong when only one of the two is edited.
 */
function wikiSpan (src, pos, bang) {
  if (bang && src.charCodeAt(pos) !== 0x21) return null             // !
  const at = pos + (bang ? 1 : 0)
  if (src.charCodeAt(at) !== 0x5B || src.charCodeAt(at + 1) !== 0x5B) return null
  const end = src.indexOf(']]', at + 2)
  if (end === -1) return null
  const inner = src.slice(at + 2, end)
  if (inner.includes('[')) return null

  const bar = inner.indexOf('|')
  return {
    next: end + 2,
    target: (bar === -1 ? inner : inner.slice(0, bar)).trim(),
    suffix: bar === -1 ? '' : inner.slice(bar + 1).trim()
  }
}

/* Embeds are claimed before markdown-it's own image rule gets to the `!`, and
   therefore before the wikilink rule below can read `![[x]]` as a link with a
   stray exclamation mark in front of it. */
md.inline.ruler.before('image', 'wikiembed', (mdState, silent) => {
  const span = wikiSpan(mdState.src, mdState.pos, true)
  if (!span) return false
  if (!silent) {
    const token = mdState.push('wikiembed', '', 0)
    token.meta = span
  }
  mdState.pos = span.next
  return true
})

md.inline.ruler.after('emphasis', 'wikilink', (mdState, silent) => {
  const span = wikiSpan(mdState.src, mdState.pos, false)
  if (!span) return false
  if (!silent) {
    const token = mdState.push('wikilink', '', 0)
    token.content = span.suffix || span.target
    token.meta = { target: span.target }
  }
  mdState.pos = span.next
  return true
})

/* markdown-it has no task lists, which would leave the reading view showing a
   literal "[x]" where the editor shows a checkbox. */
md.core.ruler.after('inline', 'task_lists', (mdState) => {
  const tokens = mdState.tokens
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i].type !== 'inline') continue
    if (tokens[i - 1].type !== 'paragraph_open') continue
    if (tokens[i - 2].type !== 'list_item_open') continue

    const match = /^\[([ xX])\]\s+/.exec(tokens[i].content)
    if (!match) continue

    tokens[i].content = tokens[i].content.slice(match[0].length)
    const first = tokens[i].children[0]
    if (first && first.type === 'text') first.content = first.content.slice(match[0].length)

    // The source line travels with the token so a click can find the exact
    // "[ ]" to flip. Counting checkboxes instead would drift the moment a
    // fenced code block contained something that looked like a task.
    const map = tokens[i - 1].map || tokens[i - 2].map
    const box = new mdState.Token('taskbox', '', 0)
    box.meta = { checked: match[1] !== ' ', line: map ? map[0] : null }
    tokens[i].children.unshift(box)
    tokens[i - 2].attrJoin('class', 'task-item')
    if (box.meta.checked) tokens[i - 2].attrJoin('class', 'is-done')
  }
})

/* Every block carries the line of the file it started on. Switching views has
   to land you in the same place in the note, and a pixel offset cannot say
   where that is — the two views are different scroll containers laying the
   same text out differently. A line number is the one address both understand.
   (markdown-it fills `token.map` for block tokens; inline tokens have none.) */
const renderToken = md.renderer.renderToken.bind(md.renderer)
md.renderer.renderToken = (tokens, i, options) => {
  const token = tokens[i]
  if (token.map && token.nesting !== -1) token.attrSet('data-line', String(token.map[0]))
  return renderToken(tokens, i, options)
}

md.renderer.rules.taskbox = (tokens, i) => {
  const { checked, line } = tokens[i].meta
  // Without a source line there is nothing to write back to, so the box stays
  // inert rather than pretending to work.
  const hook = line === null ? ' disabled' : ` data-line="${line}"`
  return `<input class="task" type="checkbox"${checked ? ' checked' : ''}${hook}> `
}

/* The fence carries its language forward as an attribute; the header and the
   highlighted spans are built from the DOM afterwards, where the language pack
   can be loaded without blocking the render. */
md.renderer.rules.fence = (tokens, i) => {
  const info = (tokens[i].info || '').trim()
  const lang = info.split(/\s+/)[0]
  // Everything after the language is kept: a manim block names its scene there.
  const rest = info.slice(lang.length).trim()
  // Built as a string rather than from attrs, so it has to carry its own line.
  const line = tokens[i].map ? ` data-line="${tokens[i].map[0]}"` : ''
  // The fence's content keeps its closing newline, which renders as a blank
  // final line inside the box.
  const code = tokens[i].content.replace(/\n$/, '')
  const lines = code.split('\n')
  // The gutter is a sibling of the code, not part of it: re-highlighting
  // replaces the <code> contents wholesale, and numbers inside would go with
  // it. Being a sibling also keeps them still while the code scrolls.
  const numbers = lines.map((_, n) => n + 1).join('\n')

  return `<div class="code-wrap"${line}${lang ? ` data-lang="${escapeAttr(lang)}"` : ''}` +
         `${rest ? ` data-info="${escapeAttr(rest)}"` : ''}>` +
         '<div class="code-body">' +
         `<pre class="code-nums" aria-hidden="true">${numbers}</pre>` +
         `<pre class="code-text"><code>${escapeHtml(code)}</code></pre>` +
         '</div></div>'
}

md.renderer.rules.wikilink = (tokens, i) => {
  const { content, meta } = tokens[i]
  return `<a class="wikilink" data-wikilink="${escapeAttr(meta.target)}">${escapeHtml(content)}</a>`
}

/**
 * Both embed syntaxes emit the same empty stub, which `dressEmbeds` fills in
 * afterwards. The alternative — building the markup here as a string — would
 * be a second copy of `renderEmbed`, and the two would have to be kept looking
 * and behaving identically by hand. This is how fenced code already works (see
 * `dressCodeBlocks`).
 */
function embedSlot (src, alt = '', size = null) {
  return `<span class="embed-slot" data-src="${escapeAttr(src)}" data-alt="${escapeAttr(alt)}"` +
         (size?.width ? ` data-w="${size.width}"` : '') +
         (size?.height ? ` data-h="${size.height}"` : '') +
         '></span>'
}

md.renderer.rules.wikiembed = (tokens, i) => {
  const { target, suffix } = tokens[i].meta
  const { alt, size } = parseEmbedSuffix(suffix)
  return embedSlot(target, alt, size)
}

/* markdown-it's own `![alt](src)`. Its default rule would emit the src
   untouched, which the page's CSP will not load and which would not resolve
   against the note's folder anyway. */
md.renderer.rules.image = (tokens, i) => {
  const token = tokens[i]
  const src = token.attrGet('src') || ''
  const alt = token.content || ''
  // A real URL is left alone — but the CSP admits no remote images, so it is
  // shown as the link it is rather than as a broken picture.
  if (/^https?:/i.test(src)) {
    return `<a class="embed-file" href="${escapeAttr(src)}">${escapeHtml(alt || src)}</a>`
  }
  return embedSlot(src, alt)
}

function escapeHtml (s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
const escapeAttr = escapeHtml

/* ---------------------------------------------------------------- editor */

const editor = createEditor({
  parent: el.editorHost,
  onChange: (text) => {
    state.dirty = true
    renderCrumbs()
    updateStatus(text)
    queueSave()
  },
  onOpenLink: (link) => {
    if (link.type === 'url') api.openExternal(link.target)
    else if (link.type === 'asset') api.file.reveal(link.target)
    else openWikilink(link.target)
  },
  noteNames: () => state.files.map((f) => ({ name: f.name, dir: f.dir })),
  noteTitle: () => state.current?.name || '',
  // Read at decoration time, so opening a different note re-resolves relative
  // embeds against the folder that note is actually in.
  resolveEmbed: resolveHere
})

function queueSave () {
  clearTimeout(state.saveTimer)
  state.saveTimer = setTimeout(saveNow, 600)
}

async function saveNow () {
  clearTimeout(state.saveTimer)
  if (!state.current || !state.dirty) return
  const text = editor.state.doc.toString()
  try {
    await api.file.write(state.current.path, text)
    state.dirty = false
    renderCrumbs()
    setStatusRight('Saved')
  } catch (err) {
    toast(err.message || 'Could not save this note.')
  }
}

/* ------------------------------------------------------------------ tree */

function flatten (nodes, dir = '') {
  const out = []
  for (const node of nodes) {
    if (node.type === 'folder') out.push(...flatten(node.children, node.path))
    else out.push({ ...node, dir })
  }
  return out
}

async function loadTree () {
  // Two independent walks of the same directory tree, so they go together
  // rather than one after the other — this runs on every watcher tick, which
  // means after every autosave.
  const [tree, assets] = await Promise.all([api.vault.tree(), api.vault.assets()])

  state.tree = tree
  state.files = flatten(tree)
  renderTree()
  el.noteCount.textContent =
    `${state.files.length} ${state.files.length === 1 ? 'note' : 'notes'}`
  applyAssets(assets)
}

/**
 * The vault's attachments. Kept apart from the note tree because they are not
 * navigable things — nothing lists them — they exist so an embed can be
 * resolved by whatever name the note happened to use.
 */
function applyAssets (next) {
  // The watcher reloads the tree after every save, so the common case is that
  // nothing about the attachments moved. Rebuilding the index and redrawing
  // both views regardless would re-run every decoration in the note being
  // typed into, once per autosave.
  const key = next.join('\n')
  if (key === state.assetsKey) return
  state.assetsKey = key
  state.resolveAsset = assetIndex(next)

  // A new attachment may have made an embed resolvable that was not before.
  editor.refresh()
  if (reading()) renderReading()
}

/** Re-read just the attachment list — after writing one, where waiting for the
 *  watcher would show the embed as missing for a frame. */
const loadAssets = async () => applyAssets(await api.vault.assets())

function renderTree () {
  el.tree.replaceChildren(buildLevel(state.tree, 0))
}

function buildLevel (nodes, depth) {
  const frag = document.createDocumentFragment()

  for (const node of nodes) {
    const row = document.createElement('div')
    row.className = `row ${node.type === 'folder' ? 'is-folder' : 'is-file'}`
    row.style.paddingLeft = `${7 + depth * 13}px`
    row.dataset.path = node.path
    row.dataset.type = node.type
    row.tabIndex = 0
    row.draggable = true
    wireDrag(row, node)

    const twist = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    twist.setAttribute('viewBox', '0 0 12 12')
    twist.setAttribute('class', 'twist')
    twist.innerHTML = '<path d="M4.5 3 8 6l-3.5 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
    row.append(twist)

    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = node.name
    row.append(label)

    if (node.type === 'folder') {
      const open = state.expanded.has(node.path)
      if (open) row.classList.add('is-open')
      row.addEventListener('click', () => { clearPicked(); toggleFolder(node.path) })
      frag.append(row)

      const kids = document.createElement('div')
      kids.className = `children${open ? ' is-open' : ''}`
      kids.dataset.for = node.path
      kids.append(buildLevel(node.children, depth + 1))
      frag.append(kids)
    } else {
      if (state.current?.path === node.path) row.classList.add('is-active')
      if (state.picked.has(node.path)) row.classList.add('is-picked')
      row.addEventListener('click', (e) => clickFile(node.path, e))
      frag.append(row)
    }

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      showContextMenu(e, node)
    })
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        node.type === 'folder' ? toggleFolder(node.path) : openNote(node.path)
      }
    })
  }

  return frag
}

/* --------------------------------------------------------- multi-select */

/**
 * File paths in the order they are currently on screen. Read from the DOM
 * rather than the tree model because a shift-range should span what the user
 * can actually see — rows inside a collapsed folder are not in between.
 */
function visibleFiles () {
  return [...el.tree.querySelectorAll('.row.is-file')].map((r) => r.dataset.path)
}

function markPicked () {
  for (const row of el.tree.querySelectorAll('.row.is-file')) {
    row.classList.toggle('is-picked', state.picked.has(row.dataset.path))
  }
  const count = state.picked.size
  setStatusRight(count > 1 ? `${count} selected` : '')
}

function clearPicked () {
  if (!state.picked.size) return
  state.picked.clear()
  state.pickAnchor = null
  markPicked()
}

/**
 * Shift extends from the anchor, Cmd/Ctrl toggles one, a plain click selects
 * one and opens it — the conventions from Finder and every file tree people
 * already use.
 */
function clickFile (path, event) {
  const files = visibleFiles()

  if (event.shiftKey && state.pickAnchor) {
    const from = files.indexOf(state.pickAnchor)
    const to = files.indexOf(path)
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from]
      state.picked = new Set(files.slice(lo, hi + 1))
      // The range's far end becomes current without disturbing the anchor,
      // so a second shift-click re-extends from the same place. markPicked
      // runs after, because opening a note resets the status line.
      openNote(path, { keepSelection: true }).then(markPicked)
      markPicked()
      return
    }
  }

  if (event.metaKey || event.ctrlKey) {
    state.picked.has(path) ? state.picked.delete(path) : state.picked.add(path)
    state.pickAnchor = path
    markPicked()
    return
  }

  state.picked = new Set([path])
  state.pickAnchor = path
  markPicked()
  openNote(path, { keepSelection: true })
}

el.tree.addEventListener('mousedown', (e) => {
  if (e.target === el.tree) clearPicked()
})

const carriesFiles = (e) => !!e.dataTransfer?.types?.includes('Files')

/** A drag carrying files from outside the app rather than rows from inside it. */
const fromOutside = (e) => !state.dragging && carriesFiles(e)

el.tree.addEventListener('dragover', (e) => {
  if (fromOutside(e)) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    el.tree.classList.add('is-drop-target')
    return
  }
  if (!state.dragging) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
})

el.tree.addEventListener('dragleave', (e) => {
  if (e.target === el.tree) el.tree.classList.remove('is-drop-target')
})

el.tree.addEventListener('drop', (e) => {
  el.tree.classList.remove('is-drop-target')
  if (fromOutside(e)) {
    e.preventDefault()
    // A drop that missed every row means the vault root.
    importFrom(e, e.target.closest?.('.row.is-folder')?.dataset.path || '')
    return
  }
  if (e.target !== el.tree) return
  e.preventDefault()
  moveInto('')
})

/* ------------------------------------------------------------- dragging */

/**
 * Dragging a row that is part of the multi-selection moves the whole
 * selection; dragging anything else moves just that row. Folders accept drops,
 * and so does the tree's empty space, which means the vault root.
 */
function wireDrag (row, node) {
  row.addEventListener('dragstart', (event) => {
    const paths = node.type === 'file' && state.picked.has(node.path) && state.picked.size > 1
      ? [...state.picked]
      : [node.path]
    state.dragging = paths
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', paths.join('\n'))
    row.classList.add('is-dragging')
  })

  row.addEventListener('dragend', () => {
    state.dragging = null
    row.classList.remove('is-dragging')
    for (const el of document.querySelectorAll('.is-drop-target')) {
      el.classList.remove('is-drop-target')
    }
  })

  if (node.type !== 'folder') return

  row.addEventListener('dragover', (event) => {
    if (fromOutside(event)) {
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
      row.classList.add('is-drop-target')
      return
    }
    if (!state.dragging || !canDropInto(node.path)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    row.classList.add('is-drop-target')
  })
  row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'))
  row.addEventListener('drop', (event) => {
    event.preventDefault()
    event.stopPropagation()
    row.classList.remove('is-drop-target')
    if (fromOutside(event)) { importFrom(event, node.path); return }
    moveInto(node.path)
  })
}

/**
 * Notes dragged in from Finder. The drop target decides where they land, the
 * same as dragging a row already in the tree — a folder takes them, empty
 * space means the vault root.
 */
async function importFrom (event, destDir) {
  if (!state.vault) { pickVault(); return }

  const sources = [...(event.dataTransfer?.files || [])]
    .map((file) => api.pathForFile(file))
    .filter(Boolean)
  if (!sources.length) return

  let result
  try {
    result = await api.file.import(destDir, sources)
  } catch (err) {
    toast(err.message || 'Those files could not be brought in.')
    return
  }

  const { imported, skipped, first } = result
  if (destDir) state.expanded.add(destDir)
  await loadTree()

  if (first) {
    await openNote(first)
    revealInTree(first)
    state.picked = new Set([first])
    markPicked()
  }

  const where = destDir || 'the vault'
  if (!imported) {
    toast(skipped ? 'Only markdown files can be brought in this way.' : 'Nothing to bring in.')
  } else {
    const what = imported === 1 ? 'Added 1 note to' : `Added ${imported} notes to`
    toast(skipped ? `${what} ${where} · ${skipped} skipped` : `${what} ${where}`)
  }
}

/** A folder cannot receive itself, nor anything already sitting in it. */
function canDropInto (destDir) {
  return (state.dragging || []).some((p) => {
    if (p === destDir || destDir.startsWith(p + '/')) return false
    return p.split('/').slice(0, -1).join('/') !== destDir
  })
}

async function moveInto (destDir) {
  const paths = state.dragging || []
  state.dragging = null
  if (!paths.length) return

  const moved = []
  let relinked = 0
  for (const path of paths) {
    if (path === destDir || destDir.startsWith(path + '/')) continue
    try {
      const { path: next, links } = await api.file.move(path, destDir)
      moved.push({ from: path, to: next })
      retraceHistory(path, next)
      relinked += links
    } catch (err) {
      toast(err.message || `“${path}” could not be moved.`)
    }
  }
  if (!moved.length) return

  // The open note may have been one of them; follow it to its new home.
  const followed = moved.find((m) => m.from === state.current?.path)
  if (followed) {
    state.current = noteRef(followed.to)
    renderCrumbs()
    api.config.set({ lastNote: followed.to })
  }

  state.picked = new Set(moved.map((m) => m.to))
  state.pickAnchor = null
  if (destDir) state.expanded.add(destDir)
  await loadTree()
  markPicked()
  const where = destDir || 'the vault root'
  const what = moved.length === 1 ? `Moved to ${where}` : `Moved ${moved.length} notes to ${where}`
  toast(relinked ? `${what} · ${linkNote(relinked)}` : what)
}

/** Wording for however many notes had to be edited to keep their links valid. */
function linkNote (count) {
  return count === 1 ? 'Updated links in 1 note' : `Updated links in ${count} notes`
}

function toggleFolder (path) {
  state.expanded.has(path) ? state.expanded.delete(path) : state.expanded.add(path)
  api.config.set({ expanded: [...state.expanded] })
  renderTree()
}

function revealInTree (path) {
  const parts = path.split('/')
  parts.pop()
  let acc = ''
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part
    state.expanded.add(acc)
  }
  renderTree()
  el.tree.querySelector(`.row[data-path="${cssEscape(path)}"]`)
    ?.scrollIntoView({ block: 'nearest' })
}

const cssEscape = (s) => (window.CSS?.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'))

/* ------------------------------------------------------------- open/save */

async function openNote (path, { focus = true, keepSelection = false, history = true, place = null } = {}) {
  if (state.dirty) await saveNow()

  let text
  try {
    text = await api.file.read(path)
  } catch {
    toast('That note could not be opened. Refreshing the vault.')
    await loadTree()
    return false
  }

  // Before the document is swapped, while the editor still holds the note
  // being left — that is the only moment its caret position can be recorded.
  if (history) pushHistory(path)

  state.current = noteRef(path)
  state.dirty = false

  editor.setDoc(text)
  el.empty.hidden = true
  el.stage.classList.add('has-doc')

  if (place) {
    editor.dispatch({ selection: { anchor: Math.min(place.at, text.length) } })
    editor.scrollDOM.scrollTop = place.top
  }

  renderCrumbs()
  renderTree()
  updateStatus(text)
  setStatusRight('')
  if (reading()) renderReading()
  if (focus && !reading()) editor.focus()

  api.config.set({ lastNote: path })
  return true
}

/* ------------------------------------------------------------ history */

/**
 * Where you have been, and where you were in it.
 *
 * Following a wikilink is the common way to move around a vault, and it is a
 * one-way trip without this — the sidebar can find a note again but not the
 * place in it you were reading. Entries therefore carry a caret offset and a
 * scroll position, recorded at the moment a note is left rather than
 * continuously.
 */
const HISTORY_MAX = 50

/** Record the place in the note currently on screen, if it is the one the
 *  cursor of the history is pointing at. */
function markPlace () {
  const entry = state.history[state.historyAt]
  if (!entry || entry.path !== state.current?.path) return
  entry.at = editor.state.selection.main.head
  entry.top = editor.scrollDOM.scrollTop
}

function pushHistory (path) {
  markPlace()
  if (state.history[state.historyAt]?.path === path) return

  // Opening something new after stepping back drops what was ahead, the way a
  // browser does — the forward stack described a future you did not take.
  state.history.length = state.historyAt + 1
  state.history.push({ path, at: 0, top: 0 })
  if (state.history.length > HISTORY_MAX) state.history.shift()
  state.historyAt = state.history.length - 1
}

async function goHistory (delta) {
  const target = state.historyAt + delta
  if (target < 0 || target >= state.history.length) {
    setStatusRight(delta < 0 ? 'Nothing further back' : 'Nothing further forward')
    return
  }

  markPlace()
  const entry = state.history[target]
  const opened = await openNote(entry.path, { history: false, place: entry })

  if (!opened) {
    // The note is gone. Drop it and keep going the same way, so a deleted note
    // in the middle of the trail does not become a wall.
    state.history.splice(target, 1)
    if (state.historyAt > target) state.historyAt--
    return goHistory(delta)
  }

  state.historyAt = target
  revealInTree(entry.path)
}

/* The side buttons on a mouse mean back and forward everywhere else, and the
   browser default they would otherwise trigger does nothing useful here. */
window.addEventListener('mouseup', (e) => {
  if (e.button !== 3 && e.button !== 4) return
  e.preventDefault()
  goHistory(e.button === 3 ? -1 : 1)
})

/** Keep the trail pointing at notes that moved rather than at where they were. */
function retraceHistory (from, to) {
  for (const entry of state.history) {
    if (entry.path === from) entry.path = to
    else if (entry.path.startsWith(from + '/')) entry.path = to + entry.path.slice(from.length)
  }
}

/**
 * Pull the open note back off disk after something else has written to it.
 * Chasing a rename through the vault can edit the very note being read, but so
 * can an edit in another app or a sync client — this is wired to the file
 * watcher, so the trigger does not have to be one Tulip knows about.
 *
 * Unsaved edits are left alone: whatever is on screen is worth more than a
 * link the user can fix by hand. The cursor is put back where it was, which is
 * close enough given only a link's text changed.
 */
async function reloadCurrent () {
  if (!state.current || state.dirty) return
  let text
  try { text = await api.file.read(state.current.path) } catch { return }
  if (text === editor.state.doc.toString()) return

  const at = Math.min(editor.state.selection.main.head, text.length)
  editor.setDoc(text)
  editor.dispatch({ selection: { anchor: at } })
  state.dirty = false
  updateStatus(text)
  if (reading()) renderReading()
}

function renderCrumbs () {
  if (!state.current) { el.crumbs.replaceChildren(); return }
  const frag = document.createDocumentFragment()

  if (state.current.dir) {
    for (const part of state.current.dir.split('/')) {
      const span = document.createElement('span')
      span.textContent = part
      frag.append(span)
      const sep = document.createElement('span')
      sep.className = 'sep'
      sep.textContent = '/'
      frag.append(sep)
    }
  }

  const here = document.createElement('span')
  here.className = 'here'
  here.textContent = state.current.name
  frag.append(here)

  if (state.dirty) {
    const dot = document.createElement('span')
    dot.className = 'dirty'
    dot.title = 'Unsaved changes'
    frag.append(dot)
  }

  el.crumbs.replaceChildren(frag)
}

function updateStatus (text) {
  const words = (text.trim().match(/[\p{L}\p{N}'’-]+/gu) || []).length
  const chars = text.length
  el.statusLeft.textContent = state.current
    ? `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} · ${chars.toLocaleString()} characters`
    : ''
}

/* Zoom indicator. It states the level on every change, then stands down at
   100% — a permanent "100%" would be noise, but any other level is worth
   knowing about, so that one stays put. */
let zoomTimer = null

function showZoom (percent) {
  if (!el.zoom) return
  el.zoom.textContent = `${percent}%`
  el.zoom.hidden = false
  el.zoom.classList.add('is-flash')

  clearTimeout(zoomTimer)
  zoomTimer = setTimeout(() => {
    el.zoom.classList.remove('is-flash')
    if (percent === 100) el.zoom.hidden = true
  }, 1500)
}

let statusTimer = null
function setStatusRight (msg) {
  el.statusRight.textContent = msg
  clearTimeout(statusTimer)
  if (msg) statusTimer = setTimeout(() => { el.statusRight.textContent = '' }, 1800)
}

/* ------------------------------------------------------------- wikilinks */

async function openWikilink (target) {
  const wanted = target.toLowerCase()
  const hit =
    state.files.find((f) => f.name.toLowerCase() === wanted) ||
    state.files.find((f) => f.path.toLowerCase().replace(NOTE_EXT, '') === wanted)

  if (hit) { await openNote(hit.path); revealInTree(hit.path); return }

  const dir = state.current?.dir || ''
  const path = await api.file.create(dir, target)
  await loadTree()
  await openNote(path)
  revealInTree(path)
  toast(`Created "${target}"`)
}

/* ---------------------------------------------------------- reading view */

/**
 * Frontmatter is not prose and must not be rendered as prose — left alone,
 * markdown-it reads the closing `---` as a setext underline and prints the
 * whole block as a heading. It is blanked rather than cut so every line below
 * keeps the number it has in the file, which is what the task checkboxes and
 * the search jump write back through.
 */
function splitFrontmatter (text) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { body: text, props: [] }
  const blanks = '\n'.repeat(match[0].replace(/[^\n]/g, '').length)
  return { body: blanks + text.slice(match[0].length), props: parseProps(match[1]) }
}

/** Enough YAML for the shape frontmatter actually takes: scalars, inline
 *  `[a, b]` lists, and block lists of `- item`. Anything else is left as text. */
function parseProps (yaml) {
  const props = []
  for (const raw of yaml.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue

    const item = /^\s*-\s+(.*)$/.exec(raw)
    if (item) {
      const last = props[props.length - 1]
      if (last) (last.values ||= []).push(clean(item[1]))
      continue
    }

    const pair = /^([\w .-]+)\s*:\s*(.*)$/.exec(raw)
    if (!pair) continue
    const [, key, rest] = pair
    const value = rest.trim()

    if (!value) { props.push({ key: key.trim(), values: [] }); continue }
    if (/^\[.*\]$/.test(value)) {
      props.push({
        key: key.trim(),
        values: value.slice(1, -1).split(',').map(clean).filter(Boolean)
      })
      continue
    }
    props.push({ key: key.trim(), text: clean(value) })
  }
  return props
}

const clean = (s) => s.trim().replace(/^['"]|['"]$/g, '').trim()

function propertiesBlock (props) {
  const dl = document.createElement('dl')
  dl.className = 'properties'

  for (const prop of props) {
    const dt = document.createElement('dt')
    dt.textContent = prop.key
    const dd = document.createElement('dd')

    if (prop.values) {
      for (const value of prop.values) {
        const pill = document.createElement('span')
        pill.className = 'prop-pill'
        pill.textContent = value
        dd.append(pill)
      }
    } else {
      dd.textContent = prop.text
    }

    dl.append(dt, dd)
  }
  return dl
}

/* Bumped on every render so the async syntax highlighting from a superseded
   render cannot paint over the current page. */
let readingToken = 0

function renderReading () {
  if (!state.current) return
  const token = ++readingToken

  // One column wrapper, so every block shares a left edge. Centring each child
  // independently would stagger narrow blocks (tables) against wide ones.
  const col = document.createElement('div')
  col.className = 'reading-col'

  const title = document.createElement('h1')
  title.className = 'inline-title'
  title.textContent = state.current.name
  col.append(title)

  const { body, props } = splitFrontmatter(editor.state.doc.toString())
  if (props.length) col.append(propertiesBlock(props))

  const rendered = document.createElement('div')
  rendered.className = 'reading-body'
  rendered.innerHTML = md.render(body)
  col.append(rendered)

  for (const table of rendered.querySelectorAll('table')) {
    const wrap = document.createElement('div')
    wrap.className = 'table-wrap'
    table.replaceWith(wrap)
    wrap.append(table)
  }

  el.reading.replaceChildren(col)
  dressEmbeds(rendered)
  dressCodeBlocks(rendered, token)
}

/** Swap every stub the embed rules left behind for the real thing. */
function dressEmbeds (root) {
  for (const slot of root.querySelectorAll('.embed-slot')) {
    const { src, alt, w, h } = slot.dataset
    const size = w || h ? { width: Number(w) || null, height: Number(h) || null } : null
    slot.replaceWith(renderEmbed(embedSpec(src, { alt, size, resolve: resolveHere })))
  }
}

/** Give every fenced block its language tile and, once the parser lands, its
 *  colours. Blocks without a language keep the plain frame. */
function dressCodeBlocks (root, token) {
  for (const wrap of root.querySelectorAll('.code-wrap[data-lang]')) {
    const lang = wrap.dataset.lang
    const chip = languageChip(lang)
    let head = null
    if (chip) {
      head = document.createElement('div')
      head.className = 'code-head'
      head.append(chip)
      wrap.prepend(head)
    }

    const code = wrap.querySelector('code')
    if (!code) continue

    if (head && isManim(lang)) {
      // A scene is shown as the film it renders to, not as the source that
      // describes it — so this block gets the manim treatment instead of a
      // Run control it has no use for.
      attachManim(wrap, head, code.textContent, {
        noteName: state.current?.name || 'Untitled',
        scene: wrap.dataset.info || ''
      })
    } else if (head) {
      // The button goes in the header beside the language mark, and the output
      // box after the frame. Blocks in a language Tulip cannot run are untouched.
      attachRunControl(wrap, head, lang, code.textContent)
    }

    // Manim scenes are Python, and read as Python behind the video.
    highlightInto(code, code.textContent, isManim(lang) ? 'python' : lang).catch(() => {})
    if (token !== readingToken) return
  }
}

/**
 * Where the reader is, as a line of the file.
 *
 * Each view scrolls its own box and lays the same text out differently, so a
 * pixel offset means nothing once you leave. Every block in the reading view
 * carries the line it came from, and the editor can answer for the line at the
 * top of its viewport, which makes the line number the common address.
 */
function viewportLine () {
  if (!state.current) return 1
  if (!reading()) return editor.topLine()

  const top = el.reading.getBoundingClientRect().top
  let line = 1
  for (const node of el.reading.querySelectorAll('[data-line]')) {
    // The first block whose top edge is below the fold ends the search; the one
    // before it is the block being read.
    if (node.getBoundingClientRect().top - top > 2) break
    line = Number(node.dataset.line) + 1        // markdown-it counts from zero
  }
  return line
}

function scrollToLine (line) {
  if (!state.current) return
  if (!reading()) { editor.scrollToLine(line); return }

  let target = null
  for (const node of el.reading.querySelectorAll('[data-line]')) {
    if (Number(node.dataset.line) + 1 > line) break
    target = node
  }
  el.reading.scrollTop = target
    ? el.reading.scrollTop + target.getBoundingClientRect().top -
      el.reading.getBoundingClientRect().top
    : 0
}

/* Called with the current view too — at boot, where it is what marks the
   active button — so it must not shortcut when nothing is changing. */
function setView (view) {
  // Read before anything moves, restore after everything has.
  const line = viewportLine()

  state.view = view
  el.reading.hidden = view !== 'read'
  el.editorHost.hidden = view === 'read'
  el.app.dataset.view = view
  editor.setRaw(view === 'raw')

  for (const btn of el.viewSwitch.querySelectorAll('.view-btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.view === view))
  }

  if (view === 'read') renderReading()
  else if (state.current) editor.focus()

  scrollToLine(line)
  // Pictures and highlighted code settle a frame later and can move the ground
  // under the anchor, so it is placed once more once they have.
  requestAnimationFrame(() => scrollToLine(line))

  api.config.set({ view })
}

/**
 * Reading view is not editable, but a checkbox is a control rather than text.
 * Toggling one swaps a single character in the source, which keeps every line
 * number in the rendered output valid — so the page never has to re-render and
 * the scroll position never jumps.
 */
function toggleTaskAtLine (lineIndex, box) {
  const { doc } = editor.state
  const n = lineIndex + 1
  if (n < 1 || n > doc.lines) return false

  const line = doc.line(n)
  const match = /\[([ xX])\]/.exec(line.text)
  if (!match) return false

  const wasChecked = match[1] !== ' '
  const at = line.from + match.index + 1
  editor.dispatch({ changes: { from: at, to: at + 1, insert: wasChecked ? ' ' : 'x' } })

  box.closest('li')?.classList.toggle('is-done', !wasChecked)
  return true
}

el.reading.addEventListener('click', (e) => {
  const target = e.target
  if (!(target instanceof HTMLElement)) return

  const box = target.closest('input.task')
  if (box) {
    // The native toggle is left to stand — calling preventDefault here would
    // make the browser revert the tick after this handler runs, leaving the box
    // disagreeing with the file. If the write fails, undo it by hand instead.
    if (!toggleTaskAtLine(Number(box.dataset.line), box)) box.checked = !box.checked
    return
  }

  const asset = target.closest('[data-asset]')
  if (asset) { e.preventDefault(); api.file.reveal(asset.dataset.asset); return }

  const wiki = target.closest('[data-wikilink]')
  if (wiki) { e.preventDefault(); openWikilink(wiki.dataset.wikilink); return }
  const anchor = target.closest('a[href]')
  if (anchor && /^https?:/.test(anchor.getAttribute('href'))) {
    e.preventDefault()
    api.openExternal(anchor.getAttribute('href'))
  }
})

/* ------------------------------------------------------------- overlays */

const COMMANDS = [
  { id: 'new-note', title: 'New note', key: '⌘N' },
  { id: 'new-folder', title: 'New folder', key: '⌘⇧N' },
  { id: 'switcher', title: 'Jump to a note', key: '⌘O' },
  { id: 'back', title: 'Back', key: '⌘[' },
  { id: 'forward', title: 'Forward', key: '⌘]' },
  { id: 'search', title: 'Search the vault', key: '⌘⇧F' },
  { id: 'view-edit', title: 'Editing view', key: '⌘1' },
  { id: 'view-read', title: 'Reading view', key: '⌘2' },
  { id: 'view-raw', title: 'Raw view', key: '⌘3' },
  { id: 'sidebar', title: 'Toggle sidebar', key: '⌘\\' },
  { id: 'themes', title: 'Change theme…' },
  { id: 'theme', title: 'Toggle light and dark', key: '⌘⇧L' },
  { id: 'reveal', title: 'Reveal note in Finder' },
  { id: 'open-vault', title: 'Open another vault…', key: '⌘⇧O' }
]

const VAULTLESS = new Set(['commands', 'themes'])

function openOverlay (mode) {
  if (!state.vault && !VAULTLESS.has(mode)) { pickVault(); return }
  state.overlay = { mode, items: [], index: 0 }
  el.overlay.hidden = false
  el.panelInput.value = ''
  el.panelInput.placeholder = {
    switcher: 'Jump to a note…',
    search: 'Search every note…',
    commands: 'Run a command…',
    themes: 'Change the theme…'
  }[mode]
  el.panelFoot.innerHTML = mode === 'themes'
    ? '<span><kbd>↑↓</kbd> preview</span><span><kbd>↵</kbd> keep</span><span><kbd>esc</kbd> cancel</span>'
    : '<span><kbd>↑↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span>'
  runOverlayQuery('')
  el.panelInput.focus()
}

function closeOverlay () {
  clearTimeout(queryTimer)
  // Leaving the theme picker without choosing puts back whatever was on before
  // it opened — a preview is a look, not a decision.
  if (state.overlay?.mode === 'themes') paintTheme(state.theme)
  state.overlay = null
  el.overlay.hidden = true
  if (!reading() && state.current) editor.focus()
}

/** Subsequence match; consecutive hits and word starts score higher. */
function fuzzy (query, text) {
  if (!query) return { score: 0, hits: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const hits = []
  let score = 0
  let ti = 0
  let streak = 0

  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return null
    if (found === ti && ti > 0) streak++
    else streak = 0
    const wordStart = found === 0 || /[\s/_-]/.test(t[found - 1])
    score += 1 + streak * 2 + (wordStart ? 3 : 0)
    hits.push(found)
    ti = found + 1
  }
  score -= (t.length - q.length) * 0.02
  return { score, hits }
}

function markHits (text, hits) {
  const set = new Set(hits)
  const frag = document.createDocumentFragment()
  let buf = ''
  let marking = false

  const flush = () => {
    if (!buf) return
    if (marking) {
      const m = document.createElement('mark')
      m.textContent = buf
      frag.append(m)
    } else frag.append(document.createTextNode(buf))
    buf = ''
  }

  for (let i = 0; i < text.length; i++) {
    const on = set.has(i)
    if (on !== marking) { flush(); marking = on }
    buf += text[i]
  }
  flush()
  return frag
}

let searchToken = 0

async function runOverlayQuery (query) {
  if (!state.overlay) return
  const { mode } = state.overlay

  if (mode === 'switcher' || mode === 'commands' || mode === 'themes') {
    const source = mode === 'switcher'
      ? state.files.map((f) => ({ ...f, label: f.name }))
      : mode === 'themes'
        ? themeItems()
        : COMMANDS.map((c) => ({ ...c, label: c.title }))

    const scored = []
    for (const item of source) {
      const match = query ? fuzzy(query, item.label) : { score: 0, hits: [] }
      if (match) scored.push({ item, ...match })
    }
    // Themes keep their curated order — alphabetising a palette list buys
    // nothing and moves the one you are already using.
    if (mode !== 'themes' || query) {
      scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
    }
    state.overlay.items = scored.slice(0, 60)
    state.overlay.index = 0
    renderOverlayList()
    if (mode === 'themes') syncSelection()
    return
  }

  if (mode === 'search') {
    const token = ++searchToken
    if (query.trim().length < 2) {
      state.overlay.items = []
      state.overlay.index = 0
      renderOverlayList('Type at least two characters.')
      return
    }
    const results = await api.search(query)
    if (token !== searchToken || !state.overlay) return
    state.overlay.items = results.flatMap((r) =>
      r.hits.map((h) => ({ item: { ...r, hit: h, label: r.name }, hits: [] }))
    )
    state.overlay.index = 0
    renderOverlayList(`No note contains “${query}”.`)
  }
}

function renderOverlayList (emptyMessage = 'Nothing matches.') {
  const { items, index, mode } = state.overlay
  el.panelList.replaceChildren()

  if (!items.length) {
    const li = document.createElement('li')
    li.className = 'empty-hint'
    li.textContent = emptyMessage
    el.panelList.append(li)
    return
  }

  items.forEach(({ item, hits }, i) => {
    const li = document.createElement('li')
    li.setAttribute('role', 'option')
    li.setAttribute('aria-selected', String(i === index))
    li.dataset.index = String(i)

    const title = document.createElement('span')
    title.className = 'title'
    title.append(hits.length ? markHits(item.label, hits) : document.createTextNode(item.label))
    li.append(title)

    if (mode === 'search' && item.hit) {
      const snippet = document.createElement('span')
      snippet.className = 'snippet'
      snippet.textContent = item.hit.text
      title.append(snippet)
    }

    const right = document.createElement('span')
    right.className = 'dir'
    if (mode === 'themes') {
      right.append(swatch(item))
    } else {
      right.textContent = mode === 'commands'
        ? (item.key || '')
        : (item.dir || (mode === 'search' ? `line ${item.hit.line}` : ''))
    }
    li.append(right)

    li.addEventListener('mouseenter', () => {
      state.overlay.index = i
      syncSelection()
    })
    li.addEventListener('click', () => chooseOverlayItem(i))
    el.panelList.append(li)
  })
}

function syncSelection () {
  const { index, mode, items } = state.overlay
  for (const li of el.panelList.children) {
    const on = Number(li.dataset.index) === index
    li.setAttribute('aria-selected', String(on))
    if (on) li.scrollIntoView({ block: 'nearest' })
  }
  // The whole window is painted from the same custom properties, so previewing
  // is nothing more than pointing the root at another palette.
  if (mode === 'themes' && items[index]) paintTheme(items[index].item.id)
}

async function chooseOverlayItem (i) {
  const entry = state.overlay?.items[i]
  if (!entry) return
  const { mode } = state.overlay
  const { item } = entry
  closeOverlay()

  if (mode === 'themes') { commitTheme(item.id); return }
  if (mode === 'commands') { runCommand(item.id); return }
  await openNote(item.path)
  revealInTree(item.path)

  if (mode === 'search' && item.hit) {
    const line = editor.state.doc.line(Math.min(item.hit.line, editor.state.doc.lines))
    editor.dispatch({
      selection: { anchor: line.from + (item.hit.col || 0) },
      scrollIntoView: true
    })
    editor.focus()
  }
}

/* Vault search reaches the main process; the other modes are a filter over a
   list already in memory and answer on the keystroke. Even against the index,
   coalescing a burst of typing into one query keeps a long note from being
   scanned six times for prefixes nobody wanted results for. */
let queryTimer = null

function queueOverlayQuery (value) {
  clearTimeout(queryTimer)
  if (state.overlay?.mode !== 'search') { runOverlayQuery(value); return }
  queryTimer = setTimeout(() => runOverlayQuery(value), 90)
}

el.panelInput.addEventListener('input', (e) => queueOverlayQuery(e.target.value))

el.panelInput.addEventListener('keydown', (e) => {
  if (!state.overlay) return
  const count = state.overlay.items.length

  if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
    e.preventDefault()
    if (count) { state.overlay.index = (state.overlay.index + 1) % count; syncSelection() }
  } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
    e.preventDefault()
    if (count) { state.overlay.index = (state.overlay.index - 1 + count) % count; syncSelection() }
  } else if (e.key === 'Enter') {
    e.preventDefault()
    chooseOverlayItem(state.overlay.index)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeOverlay()
  }
})

el.overlay.addEventListener('mousedown', (e) => {
  if (e.target === el.overlay) closeOverlay()
})

/* --------------------------------------------------------- context menu */

function showContextMenu (event, node) {
  const items = []

  /* Right-clicking inside a multi-selection acts on the whole selection, the
     way a file manager does. Right-clicking outside it selects that one row
     first, so the menu never operates on something out of view. */
  const inSelection = node.type === 'file' && state.picked.has(node.path)
  if (node.type === 'file' && !inSelection) {
    state.picked = new Set([node.path])
    state.pickAnchor = node.path
    markPicked()
  }

  if (inSelection && state.picked.size > 1) {
    const paths = [...state.picked]
    items.push({
      label: `Reveal ${paths.length} notes in Finder`,
      run: () => paths.forEach((p) => api.file.reveal(p))
    })
    items.push({ sep: true })
    items.push({
      label: `Move ${paths.length} notes to Trash`,
      danger: true,
      run: () => removeMany(paths)
    })
    renderContextMenu(items, event)
    return
  }

  if (node.type === 'folder') {
    items.push({ label: 'New note here', run: () => createNote(node.path) })
    items.push({ label: 'New folder here', run: () => createFolder(node.path) })
    items.push({ sep: true })
  }
  items.push({ label: 'Rename…', key: '↵', run: () => beginRename(node) })
  items.push({ label: 'Reveal in Finder', run: () => api.file.reveal(node.path) })
  items.push({ sep: true })
  items.push({
    label: node.type === 'folder' ? 'Move folder to Trash' : 'Move note to Trash',
    danger: true,
    run: () => removeNode(node)
  })

  renderContextMenu(items, event)
}

function renderContextMenu (items, event) {
  el.ctx.replaceChildren()
  for (const item of items) {
    if (item.sep) { el.ctx.append(document.createElement('hr')); continue }
    const btn = document.createElement('button')
    btn.textContent = item.label
    if (item.danger) btn.className = 'danger'
    if (item.key) {
      const k = document.createElement('span')
      k.className = 'key'
      k.textContent = item.key
      btn.append(k)
    }
    btn.addEventListener('click', () => { hideContextMenu(); item.run() })
    el.ctx.append(btn)
  }

  el.ctx.hidden = false
  const { innerWidth, innerHeight } = window
  const rect = el.ctx.getBoundingClientRect()
  el.ctx.style.left = `${Math.min(event.clientX, innerWidth - rect.width - 8)}px`
  el.ctx.style.top = `${Math.min(event.clientY, innerHeight - rect.height - 8)}px`
}

/** One confirmation for the whole batch, then one refresh at the end. */
async function removeMany (paths) {
  const label = `Move ${paths.length} notes to the Trash?`
  if (!window.confirm(label)) return

  const failed = []
  for (const path of paths) {
    try {
      await api.file.remove(path)
    } catch {
      failed.push(path)
    }
  }

  if (state.current && paths.includes(state.current.path)) closeCurrentNote()
  clearPicked()
  await loadTree()

  if (failed.length) toast(`${failed.length} of ${paths.length} could not be moved to the Trash.`)
  else toast(`Moved ${paths.length} notes to the Trash`)
}

function hideContextMenu () { el.ctx.hidden = true }
window.addEventListener('mousedown', (e) => {
  if (!el.ctx.hidden && !el.ctx.contains(e.target)) hideContextMenu()
})
window.addEventListener('blur', hideContextMenu)

/* ------------------------------------------------------ create / rename */

async function createNote (dir = '') {
  if (!state.vault) return pickVault()
  const path = await api.file.create(dir, 'Untitled')
  await loadTree()
  await openNote(path)
  revealInTree(path)
  const row = el.tree.querySelector(`.row[data-path="${cssEscape(path)}"]`)
  if (row) beginRename({ type: 'file', path, name: 'Untitled' }, row)
}

async function createFolder (dir = '') {
  if (!state.vault) return pickVault()
  const path = await api.folder.create(dir, 'New folder')
  state.expanded.add(path)
  await loadTree()
  const row = el.tree.querySelector(`.row[data-path="${cssEscape(path)}"]`)
  if (row) beginRename({ type: 'folder', path, name: path.split('/').pop() }, row)
}

function beginRename (node, row) {
  row = row || el.tree.querySelector(`.row[data-path="${cssEscape(node.path)}"]`)
  if (!row) return
  const label = row.querySelector('.label')
  if (!label) return

  const input = document.createElement('input')
  input.className = 'row-input'
  input.value = node.name
  label.replaceWith(input)
  input.focus()
  input.select()

  let done = false
  const finish = async (commit) => {
    if (done) return
    done = true
    const next = input.value.trim()
    if (!commit || !next || next === node.name) { renderTree(); return }
    try {
      const { path, links } = await api.file.rename(node.path, next)
      if (state.current?.path === node.path) {
        state.current = noteRef(path)
        renderCrumbs()
        // The inline title is the note's name, so a rename has to reach both
        // the editor's widget and the rendered page.
        editor.refresh()
        if (reading()) renderReading()
        api.config.set({ lastNote: path })
      }
      await loadTree()
      retraceHistory(node.path, path)
      // Silence when nothing else pointed at it; otherwise say what was
      // changed, because notes the user never opened were just edited.
      if (links) toast(linkNote(links))
    } catch (err) {
      toast(err.message || 'That name is already taken.')
      renderTree()
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true) }
    if (e.key === 'Escape') { e.preventDefault(); finish(false) }
  })
  input.addEventListener('blur', () => finish(true))
}

/** Return the pane to its empty state after the open note goes away. */
function closeCurrentNote () {
  state.current = null
  state.dirty = false
  editor.setDoc('')
  el.stage.classList.remove('has-doc')
  el.empty.hidden = false
  renderCrumbs()
  updateStatus('')
}

async function removeNode (node) {
  const what = node.type === 'folder'
    ? `Move the folder “${node.name}” and everything in it to the Trash?`
    : `Move “${node.name}” to the Trash?`
  if (!window.confirm(what)) return

  try {
    await api.file.remove(node.path)
  } catch (err) {
    toast(err.message || 'That item could not be moved to the Trash.')
    return
  }

  if (state.current && (state.current.path === node.path ||
      state.current.path.startsWith(node.path + '/'))) {
    closeCurrentNote()
  }
  state.picked.delete(node.path)
  await loadTree()
  toast(`Moved “${node.name}” to the Trash`)
}

/* ------------------------------------------------------------- commands */

function runCommand (id) {
  switch (id) {
    case 'new-note': createNote(state.current?.dir || ''); break
    case 'new-folder': createFolder(state.current?.dir || ''); break
    case 'back': goHistory(-1); break
    case 'forward': goHistory(1); break
    case 'switcher': openOverlay('switcher'); break
    case 'search': openOverlay('search'); break
    case 'commands': openOverlay('commands'); break
    case 'reading': setView(reading() ? 'edit' : 'read'); break
    case 'view-edit': setView('edit'); break
    case 'view-read': setView('read'); break
    case 'view-raw': setView('raw'); break
    case 'sidebar': toggleSidebar(); break
    case 'themes': openOverlay('themes'); break
    case 'theme': cycleTheme(); break
    case 'save': saveNow(); break
    case 'find':
      if (!reading()) { editor.focus(); openSearchPanel(editor) }
      break
    case 'reveal':
      if (state.current) api.file.reveal(state.current.path)
      break
    case 'open-vault': pickVault(); break
    case 'settings': toast('Settings are coming in the next pass.'); break
  }
}

function toggleSidebar () {
  const open = el.app.dataset.sidebar === 'open'
  el.app.dataset.sidebar = open ? 'closed' : 'open'
  api.config.set({ sidebar: open ? 'closed' : 'open' })
}

/** Paint only — the chosen theme is left alone, which is what makes a preview
 *  reversible. */
function paintTheme (id) {
  document.documentElement.dataset.theme = resolveTheme(id, window.__systemTheme)
}

function applyTheme (id) {
  state.theme = isTheme(id) ? id : 'system'
  paintTheme(state.theme)
}

async function commitTheme (id) {
  applyTheme(id)
  closeOverlay()
  await api.config.set({ theme: state.theme })
  toast(THEMES.find((t) => t.id === state.theme)?.label || state.theme)
}

/** The current theme leads, so opening the picker changes nothing until you
 *  move. The rest keep the order they are declared in. */
function themeItems () {
  const list = THEMES.map((t) => ({ ...t, label: t.label }))
  const i = list.findIndex((t) => t.id === state.theme)
  if (i > 0) list.unshift(list.splice(i, 1)[0])
  return list
}

function swatch (theme) {
  const wrap = document.createElement('span')
  wrap.className = 'swatch'
  for (const colour of theme.swatch) {
    const dot = document.createElement('i')
    dot.style.setProperty('--dot', colour)
    wrap.append(dot)
  }
  return wrap
}

async function cycleTheme () {
  const next = state.theme === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  await api.config.set({ theme: next })
  toast(next === 'dark' ? 'Ink' : 'Paper')
}

/* ---------------------------------------------------------- attachments */

/**
 * Files pasted or dropped into the editor are written into the vault and
 * referred to by name, so a note stays a plain-text file that happens to point
 * at a picture — nothing is embedded as base64 and nothing lives only in the
 * app. The main process decides where they land; see `asset:write`.
 */
async function attachFiles (files) {
  if (!state.current) { toast('Open a note first.'); return }

  const inserts = []
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const ext = extensionFor(file)
      const { name } = await api.asset.write(state.current.name, ext, bytes)
      inserts.push(`![[${name}]]`)
    } catch (err) {
      toast(err.message || 'That file could not be saved into the vault.')
    }
  }
  if (!inserts.length) return

  // The list has to be refreshed before the text goes in, or the embed renders
  // as missing for the moment between the two.
  await loadAssets()

  const { from, to } = editor.state.selection.main
  const line = editor.state.doc.lineAt(from)
  // An embed is a block-ish thing; dropping one into the middle of a sentence
  // is almost never what was meant, so it starts on its own line.
  const lead = line.from === from || !line.text.trim() ? '' : '\n'
  const insert = `${lead}${inserts.join('\n')}\n`

  editor.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
    userEvent: 'input'
  })
  editor.focus()
  toast(inserts.length === 1 ? 'Image added' : `${inserts.length} images added`)
}

/** The MIME type is authoritative — a clipboard image is always called
 *  `image.png` whatever it actually is — and the name is the fallback for the
 *  types the browser has no opinion about. */
function extensionFor (file) {
  const mime = /^(?:image|video|audio)\/([a-z0-9.+-]+)$/i.exec(file.type || '')
  if (mime) return `.${mime[1].toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`
  const named = /\.[a-z0-9]+$/i.exec(file.name || '')
  return named ? named[0].toLowerCase() : '.png'
}

/* What the vault will actually take. Asking assets.js rather than re-listing
   the formats keeps this from drifting out of step with what can be rendered. */
const attachable = (list) => [...list].filter((f) => isAsset(f.name || ''))

el.editorHost.addEventListener('paste', (e) => {
  const files = attachable(e.clipboardData?.files || [])
  if (!files.length) return
  // Only when there is nothing else on the clipboard: copying a region of a
  // web page carries both an image and its HTML, and the text is the useful
  // half of that.
  if ([...(e.clipboardData.types || [])].some((t) => t === 'text/plain')) return
  e.preventDefault()
  e.stopPropagation()
  attachFiles(files)
}, true)

el.editorHost.addEventListener('drop', (e) => {
  const files = attachable(e.dataTransfer?.files || [])
  if (!files.length) return
  e.preventDefault()
  e.stopPropagation()
  attachFiles(files)
}, true)

/* A file dropped anywhere else would make the window navigate to it, replacing
   the app with the file. There is nothing to drop onto outside the editor and
   the tree, and both of those have already handled it by the time this runs. */
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (e) => { if (carriesFiles(e)) e.preventDefault() })
}

/* ---------------------------------------------------------------- toast */

let toastTimer = null
function toast (message) {
  el.toast.textContent = message
  el.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.toast.hidden = true }, 2600)
}

/* ----------------------------------------------------------------- boot */

async function pickVault () {
  const picked = await api.vault.pick()
  if (picked) {
    state.vault = { path: picked, name: picked.split('/').pop() }
    el.vaultLabel.textContent = state.vault.name
    el.openVault.hidden = true
    await loadTree()
    if (!state.files.length) await createNote('')
  }
}

el.openVault.addEventListener('click', pickVault)
$('vault-name').addEventListener('click', pickVault)
$('btn-new-note').addEventListener('click', () => createNote(state.current?.dir || ''))
$('btn-new-folder').addEventListener('click', () => createFolder(state.current?.dir || ''))
$('btn-search').addEventListener('click', () => openOverlay('search'))
el.viewSwitch.addEventListener('click', (e) => {
  const btn = e.target.closest('.view-btn')
  if (btn) setView(btn.dataset.view)
})

api.on('menu', runCommand)
api.on('zoom', showZoom)
el.zoom?.addEventListener('click', () => api.resetZoom())
api.on('vault:changed', async () => {
  await loadTree()
  // Something moved on disk. If it was the open note — a link rewrite, an edit
  // in another app, a sync client — the buffer is now stale, and at the next
  // autosave the stale buffer would win.
  await reloadCurrent()
})
api.on('vault:opened', async (vault) => {
  state.vault = vault
  el.vaultLabel.textContent = vault.name
  el.openVault.hidden = true
  await loadTree()
})
api.on('theme:system', (theme) => {
  window.__systemTheme = theme
  if (state.theme === 'system') applyTheme('system')
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.overlay.hidden) closeOverlay()
  if ((e.metaKey || e.ctrlKey) && e.key === 'p' && !e.shiftKey) {
    e.preventDefault()
    openOverlay('commands')
  }
})

window.addEventListener('beforeunload', () => { if (state.dirty) saveNow() })
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow() })

// Handle for the DevTools console and the scripts/drive.mjs test harness.
window.__tulip = {
  state, editor, api, openNote, runCommand, openOverlay, showZoom,
  viewportLine, scrollToLine, goHistory
}

;(async function boot () {
  window.__systemTheme = await api.systemTheme()
  const cfg = await api.config.get()

  applyTheme(cfg.theme || 'system')
  el.app.dataset.sidebar = cfg.sidebar || 'open'
  state.expanded = new Set(cfg.expanded || [])

  const vault = await api.vault.current()
  if (!vault) {
    el.vaultLabel.textContent = 'No vault'
    return
  }

  state.vault = vault
  el.vaultLabel.textContent = vault.name
  el.openVault.hidden = true
  await loadTree()

  if (cfg.lastNote && state.files.some((f) => f.path === cfg.lastNote)) {
    await openNote(cfg.lastNote, { focus: false })
    revealInTree(cfg.lastNote)
  }

  // Always run this, including for the default 'edit' view — setView is what
  // marks the active button, so skipping it left all three looking inactive.
  setView(cfg.view || 'edit')
})()
