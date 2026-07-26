/**
 * Attachments: what an embed *says*, and what the page should show for it.
 *
 * This module owns the embed grammar outright. Both renderers read it from
 * here — the reading view through a markdown-it rule, the editor through a
 * CodeMirror widget — for the same reason `math.js` owns the `$` grammar: two
 * scanners that drift make the editing and reading views disagree about what
 * the file says, and the disagreement is invisible until someone writes the
 * one construct they parse differently.
 *
 * A note refers to a file the way a person would — `diagram.png`, or
 * `img/diagram.png`, or just the name of a file sitting three folders away —
 * so resolution walks outward from the note before falling back to the whole
 * vault, and always answers with a vault-relative path. Turning that into a
 * URL is a separate step, because the main process is the only thing allowed
 * to open it.
 */

import KINDS from '../electron/asset-kinds.json'

/* extension -> 'image' | 'video' | 'audio' | 'file', from the shared table. */
const KIND_BY_EXT = new Map(
  Object.entries(KINDS)
    .filter(([kind]) => !kind.startsWith('_'))
    .flatMap(([kind, exts]) => exts.map((ext) => [ext, kind]))
)

const baseName = (path) => path.split('/').pop()

const extensionOf = (path) => {
  const dot = baseName(path).lastIndexOf('.')
  return dot === -1 ? '' : baseName(path).slice(dot + 1).toLowerCase()
}

/** How an attachment wants to be shown. Anything unrecognised is a file. */
function kindOf (path) {
  return KIND_BY_EXT.get(extensionOf(path)) || 'file'
}

/** Whether the vault would offer this name as an attachment at all. */
export const isAsset = (path) => KIND_BY_EXT.has(extensionOf(path))

/* ------------------------------------------------------------- resolution */

/** `a/./b/../c` → `a/c`. Segments that climb past the root are dropped, which
 *  is what keeps a `../../..` in a note from addressing anything at all. */
function normalise (path) {
  const out = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  return out.join('/')
}

/**
 * An index over the vault's attachments, returned as the resolver itself.
 * Rebuilt whenever the file list changes, which is cheap — it is a list of
 * paths, not of contents — and swapping the whole closure is what makes a
 * rebuild atomic for everything holding a reference to it.
 */
export function assetIndex (paths) {
  const byPath = new Map()
  const byName = new Map()

  for (const path of paths) {
    byPath.set(path.toLowerCase(), path)
    const name = baseName(path).toLowerCase()
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push(path)
  }

  /**
   * @param {string} src  what the note wrote
   * @param {string} dir  the folder the note lives in
   * @returns {string|null} a vault-relative path, or null if nothing matches
   */
  return function resolve (src, dir = '') {
    if (!src) return null
    // Anything with a scheme is somebody else's problem — a real URL, a data:
    // blob, or the tulip-file: URL we produced ourselves on a previous pass.
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null

    let wanted = src.trim().replace(/\\/g, '/')
    try { wanted = decodeURI(wanted) } catch { /* leave it as written */ }
    wanted = wanted.replace(/^\/+/, '')
    if (!wanted) return null

    // Relative to the note, then relative to the vault root: the two ways
    // people actually write these.
    const local = normalise(dir ? `${dir}/${wanted}` : wanted)
    const hit = byPath.get(local.toLowerCase()) || byPath.get(normalise(wanted).toLowerCase())
    if (hit) return hit

    // Then by bare name anywhere in the vault, so `[[diagram.png]]` works from
    // any note without anyone having to think about folders. Only a name with
    // no path in it earns this — `img/diagram.png` was specific on purpose.
    if (wanted.includes('/')) return null
    const named = byName.get(wanted.toLowerCase())
    return named ? named[0] : null
  }
}

/** The URL the page loads an attachment through. Each segment is encoded
 *  separately so the slashes survive and everything else is escaped. */
function assetUrl (path) {
  return `tulip-file://vault/${path.split('/').map(encodeURIComponent).join('/')}`
}

/* ---------------------------------------------------------- the grammar */

/* `![[target|suffix]]` — Obsidian's form. The target excludes brackets and the
   pipe so a stray `[[` cannot pair with a later `]]` and swallow the line. */
const WIKI_EMBED = /!\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g

/* `![alt](src "title")` — markdown's own. Narrower than markdown-it's real
   image rule, which also accepts `<...>` targets, reference images and spaces
   in the parens; those render in the reading view and stay as source in the
   editor. Widening this is the fix if that ever matters. */
const MD_EMBED = /!\[([^[\]]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g

/**
 * The `|` suffix on a wiki embed is a size if it looks like one — `400` or
 * `400x260`, Obsidian's convention — and alt text otherwise, which is what the
 * pipe means in an ordinary wikilink. Both renderers must agree on this or the
 * same note gets a caption in one view and a width in the other.
 */
export function parseEmbedSuffix (suffix) {
  const text = (suffix || '').trim()
  const match = /^(\d+)(?:x(\d+))?$/.exec(text)
  if (!match) return { alt: text, size: null }
  return { alt: '', size: { width: Number(match[1]), height: match[2] ? Number(match[2]) : null } }
}

/**
 * Every embed in a string, in the order they appear.
 *
 * The single scanner both views run on. `from`/`to` are offsets into `text`,
 * which is what the editor needs to place a decoration; the reading view
 * ignores them.
 *
 * @returns {Array<{from:number,to:number,raw:string,src:string,alt:string,size:object|null}>}
 */
export function findEmbeds (text) {
  // Nothing can match without these two characters, and this runs per visible
  // line on every keystroke.
  if (!text.includes('![')) return []

  const found = []
  for (const m of text.matchAll(WIKI_EMBED)) {
    const { alt, size } = parseEmbedSuffix(m[2])
    found.push({ from: m.index, to: m.index + m[0].length, raw: m[0], src: m[1].trim(), alt, size })
  }
  for (const m of text.matchAll(MD_EMBED)) {
    found.push({
      from: m.index,
      to: m.index + m[0].length,
      raw: m[0],
      src: m[2].trim(),
      alt: m[1],
      size: null
    })
  }
  return found.sort((a, b) => a.from - b.from)
}

/* ---------------------------------------------------------- presentation */

/**
 * What to show for one embed, decided once for both views.
 *
 * Separate from `renderEmbed` because resolution needs the vault — which the
 * two views reach differently — while building the element does not. Every
 * *decision* (which kinds get a player, what a missing file says, how a size
 * applies) is made here, so neither view is in a position to disagree.
 */
export function embedSpec (src, { alt = '', size = null, resolve, dir = '' } = {}) {
  const path = resolve ? resolve(src, dir) : null
  if (!path) return { kind: 'missing', path: null, url: null, alt, label: alt || src, width: null, height: null }

  return {
    kind: kindOf(path),
    path,
    url: assetUrl(path),
    alt,
    label: alt || baseName(path),
    width: size?.width || null,
    height: size?.height || null
  }
}

/**
 * The one thing that builds an embed, for both views.
 *
 * The reading view reaches it the way it already reaches code blocks — the
 * markdown-it rule emits an empty stub and a DOM pass fills it in afterwards
 * (see `dressCodeBlocks`) — rather than by growing a second, string-emitting
 * copy of this function that would have to be kept looking identical.
 *
 * @param onReady called once the element knows its own size, if it ever didn't
 */
export function renderEmbed (spec, onReady = () => {}) {
  if (spec.kind === 'missing') {
    const span = document.createElement('span')
    span.className = 'embed-missing'
    span.title = 'Not found in this vault'
    span.textContent = spec.label
    return span
  }

  if (spec.kind === 'image') {
    const img = document.createElement('img')
    img.className = 'embed-img'
    img.src = spec.url
    img.alt = spec.alt || ''
    img.loading = 'lazy'
    if (spec.width) img.width = spec.width
    if (spec.height) img.height = spec.height
    img.addEventListener('load', onReady, { once: true })
    img.addEventListener('error', () => {
      img.replaceWith(renderEmbed({ ...spec, kind: 'missing', label: spec.label }))
      onReady()
    }, { once: true })
    return img
  }

  if (spec.kind === 'video' || spec.kind === 'audio') {
    const media = document.createElement(spec.kind)
    media.className = 'embed-media'
    media.src = spec.url
    media.controls = true
    media.preload = 'metadata'
    if (spec.width) media.width = spec.width
    if (spec.height) media.height = spec.height
    media.addEventListener('loadedmetadata', onReady, { once: true })
    return media
  }

  // Anything else — a PDF, say — gets a name to click rather than a viewer
  // nobody asked for. The click reveals it in Finder.
  const chip = document.createElement('a')
  chip.className = 'embed-file'
  chip.textContent = spec.label
  chip.dataset.asset = spec.path
  return chip
}
