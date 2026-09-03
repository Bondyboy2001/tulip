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
import WEB_PARTITIONS from '../electron/web-partitions.json'
import { renderPdfEmbed } from './pdfembed.js'
import { splitAnchor } from './headings.js'
import { renderTransclusion } from './transclude.js'

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
export function assetKind (path) {
  return KIND_BY_EXT.get(extensionOf(path)) || 'file'
}

/** Whether the vault would offer this name as an attachment at all. */
export const isAsset = (path) => KIND_BY_EXT.has(extensionOf(path))

/** Whether the attachment is a picture — the orphan sweep asks about images
 *  alone, because a stray PDF is a document and a stray PNG is clutter. */
export const isImageAsset = (path) => assetKind(path) === 'image'

/** `1:02:03`, `12:35`, `75`, or `1h2m3s` → seconds. */
function parseMediaTime (value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return null
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  if (/^\d+(?::\d{1,2}){1,2}(?:\.\d+)?$/.test(text)) {
    return text.split(':').reduce((total, part) => total * 60 + Number(part), 0)
  }
  const units = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text)
  if (!units || !units.slice(1).some(Boolean)) return null
  return Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0)
}

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

  /* Keys are composed (NFC) as well as lowercased: an accent is one codepoint
     from a keyboard and two from a file written through the old macOS
     convention, and an embed typed one way must find a file named the other.
     Only the keys — the stored value is the path exactly as the vault spelt
     it, because that is what the file is opened by. */
  const fold = (text) => text.toLowerCase().normalize('NFC')
  for (const path of paths) {
    byPath.set(fold(path), path)
    const name = fold(baseName(path))
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
    const hit = byPath.get(fold(local)) || byPath.get(fold(normalise(wanted)))
    if (hit) return hit

    // Then by bare name anywhere in the vault, so `[[diagram.png]]` works from
    // any note without anyone having to think about folders. Only a name with
    // no path in it earns this — `img/diagram.png` was specific on purpose.
    if (wanted.includes('/')) return null
    const named = byName.get(fold(wanted))
    return named ? named[0] : null
  }
}

/** The URL the page loads an attachment through. Each segment is encoded
 *  separately so the slashes survive and everything else is escaped. */
export function assetUrl (path) {
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
 * The `|` suffix on a wiki embed is a size if its last segment looks like one —
 * `400`, `400x260`, or `alt|400`, Obsidian's convention — and alt text
 * otherwise, which is what the pipe means in an ordinary wikilink. Both
 * renderers must agree on this or the same note gets a caption in one view and
 * a width in the other.
 */
export function parseEmbedSuffix (suffix, { bareSize = true } = {}) {
  const text = (suffix || '').trim()
  const cut = text.lastIndexOf('|')
  /* Without a pipe there is nothing marking the number as a measurement, and
     only the wiki form can take that as read: its suffix is a field of its own,
     written after the target for no other purpose. Markdown's alt text is a
     caption first — `![2024](revenue.png)` is a chart of a year, not a picture
     two thousand pixels wide. */
  if (cut === -1 && !bareSize) return { alt: text, size: null }
  const tail = cut === -1 ? text : text.slice(cut + 1).trim()
  const match = /^(\d+)(?:x(\d+))?$/.exec(tail)
  if (!match) return { alt: text, size: null }
  return {
    alt: cut === -1 ? '' : text.slice(0, cut).trim(),
    size: { width: Number(match[1]), height: match[2] ? Number(match[2]) : null }
  }
}

/**
 * Every embed in a string, in the order they appear.
 *
 * The single scanner both views run on. `from`/`to` are offsets into `text`,
 * which is what the editor needs to place a decoration; the reading view
 * ignores them. `syntax` says which of the two forms was written; what hangs
 * on that is decided in `remoteSpec` and `specForEmbed` below, not by callers
 * reading it back out of `raw`.
 *
 * @returns {Array<{from:number,to:number,raw:string,src:string,alt:string,size:object|null,syntax:'wiki'|'md'}>}
 */
export function findEmbeds (text) {
  // Nothing can match without these two characters, and this runs per visible
  // line on every keystroke.
  if (!text.includes('![')) return []

  const found = []
  for (const m of text.matchAll(WIKI_EMBED)) {
    const { alt, size } = parseEmbedSuffix(m[2])
    found.push({
      from: m.index,
      to: m.index + m[0].length,
      raw: m[0],
      src: m[1].trim(),
      alt,
      size,
      syntax: 'wiki'
    })
  }
  for (const m of text.matchAll(MD_EMBED)) {
    /* The same suffix rule as the wiki form, read out of the alt text: in
       `![photo|300](cat.jpg)` the tail is a width, not part of the caption.
       Only after a pipe, though — see parseEmbedSuffix. */
    const { alt, size } = parseEmbedSuffix(m[1], { bareSize: false })
    found.push({
      from: m.index,
      to: m.index + m[0].length,
      raw: m[0],
      src: m[2].trim(),
      alt,
      size,
      syntax: 'md'
    })
  }
  return found.sort((a, b) => a.from - b.from)
}

/**
 * The embed rewritten to show at `width` pixels — what drag-resizing writes
 * back into the note, and the inverse of the suffix rule above. Built here so
 * the writer and the parser cannot drift: what this emits, `findEmbeds` reads
 * back to the same size. A null width takes the size off and leaves the rest
 * as written.
 */
export function withEmbedSize (embed, width) {
  const size = width ? String(Math.round(width)) : ''
  if (embed.syntax === 'wiki') {
    const label = [embed.alt, size].filter(Boolean).join('|')
    return `![[${embed.src}${label ? `|${label}` : ''}]]`
  }
  /* The pipe is kept even with nothing before it — `![|300](cat.jpg)` — because
     that is what marks the number as a width in markdown alt text, and a bare
     `![300](…)` would be read back as a caption. Only the alt half is rebuilt:
     the target, and the `"title"` the grammar allows after it, stay exactly as
     the note wrote them. */
  const label = size ? `${embed.alt}|${size}` : embed.alt
  return `![${label}${embed.raw.slice(embed.raw.indexOf(']('))}`
}

/** The smallest a dragged picture may be made. Below this the handle covers
 * what it is resizing, and the picture is no longer identifiable. */
const MIN_EMBED_WIDTH = 48

/**
 * The grip a picture is resized by, wherever it appears. One element and one
 * class so a picture in a table cell and a picture in a paragraph offer the
 * same affordance in the same corner — see `wireEmbedResize` for the gesture
 * behind it.
 */
export function embedResizeGrip () {
  const grip = document.createElement('button')
  grip.type = 'button'
  grip.className = 'tk-embed-grip'
  grip.contentEditable = 'false'
  grip.tabIndex = -1
  grip.setAttribute('aria-label', 'Resize image')
  grip.title = 'Drag to resize · double-click for natural size'
  return grip
}

/**
 * The drag behind a resize handle, in the one place it is written.
 *
 * Everything a handle does that has nothing to do with *what* is being
 * resized: the button and capture bookkeeping, keeping the work paced to the
 * display, cancelling cleanly, and staying out of the selection gestures both
 * surfaces start on mousedown. Three handles are drawn on this — a paragraph
 * picture, a picture in a grid cell, and a table column — and the copies that
 * came before it had already drifted: one dragged on the horizontal axis
 * alone, the other on both; one paced its work to the display and the other
 * wrote a width per pointer event; only one stopped at the edge of the space
 * it had to grow into.
 *
 * `begin` measures the thing being dragged and returns the shape of the
 * gesture — where it starts, what bounds it, and how a pointer movement reads
 * as a number — or null to decline the drag. `paint` shows a value, at most
 * once per frame; `commit` is handed the value the drag landed on, `restore`
 * puts back what was there when nothing was written, and `settle` runs at the
 * end of every gesture either way.
 */
function wireResizeHandle (handle, {
  begin,
  paint,
  commit,
  restore = () => {},
  reset = null,
  settle = () => {}
}) {
  handle.addEventListener('pointerdown', (start) => {
    if (start.button !== 0) return
    start.preventDefault()
    start.stopPropagation()

    const gesture = begin(start)
    if (!gesture) return
    const { from, min = 1, max = Infinity, read } = gesture

    let value = from
    let pending = from
    let frame = 0

    handle.setPointerCapture?.(start.pointerId)

    /* Pointer events arrive faster than the display paints. Painting for every
       one of them — each relaying the element, and everything the layout hangs
       off it — is work that is never shown, and makes a drag feel like it is
       catching up rather than following. Keep only the newest position for
       each animation frame. */
    const draw = () => {
      frame = 0
      value = pending
      paint(value)
    }
    const move = (event) => {
      const delta = read(event.clientX - start.clientX, event.clientY - start.clientY)
      pending = Math.round(Math.min(max, Math.max(min, from + delta)))
      if (!frame) frame = requestAnimationFrame(draw)
    }
    const done = (end) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', done)
      handle.removeEventListener('pointercancel', done)
      // A pointer-up can beat the frame carrying its final position.
      if (frame) {
        cancelAnimationFrame(frame)
        draw()
      }

      // Nothing moved, or the drag was taken away: the note stays as it was.
      if (end?.type !== 'pointercancel' && value !== from) commit(value)
      else restore()
      settle()
    }

    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', done)
    handle.addEventListener('pointercancel', done)
  })

  if (reset) {
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault()
      event.stopPropagation()
      reset()
      settle()
    })
  }

  /* Both surfaces begin a selection gesture on mousedown — the editor a text
     selection, the grid a rectangle of cells. Keep the handle out of both,
     even on engines that synthesize mouse events after pointer ones. */
  handle.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
}

/**
 * Drag-to-resize for one picture, in the one place it is written — the editing
 * view's paragraph images (src/editor.js) and the grid's cell images
 * (src/table.js) share it, and `withEmbedSize` above already guarantees the
 * two write the same Markdown at the end of it.
 *
 * `commit` is handed the new width in pixels, or null for "no size at all";
 * the caller is what knows how to write that into its own corner of the
 * document. `settle` runs once when the drag is over, whether or not anything
 * was written — the moment for a re-measure.
 */
export function wireEmbedResize (grip, {
  image,
  host,
  limit = () => Infinity,
  commit,
  settle = () => {}
}) {
  /* What the picture was wearing before the drag, so a cancelled one can put
     it back — an inline width from an earlier drag, or nothing at all. */
  let was = null

  wireResizeHandle(grip, {
    begin: () => {
      const rect = image.getBoundingClientRect()
      const width = Math.max(1, rect.width)
      const height = Math.max(1, rect.height)
      was = {
        width: image.style.width,
        height: image.style.height,
        sized: host.classList.contains('is-sized')
      }

      /* Sized *before* the class goes on, and at the width it is already
         showing. `.is-sized` is what lifts the cap a picture is drawn under —
         a table image is capped at `min(640px, 70vw)` until then — so putting
         the class on a picture that has no width of its own let a capped
         picture snap out to its natural size the instant the grip was touched,
         before the pointer had moved at all. Writing the measured width first
         means the class lifts a cap that nothing is asking for, and there is
         nothing to see. */
      paintWidth(image, Math.round(width))
      host.classList.add('is-resizing', 'is-sized')

      return {
        from: Math.round(width),
        min: MIN_EMBED_WIDTH,
        // No wider than the space it has: past that a CSS cap holds the
        // picture still while the number keeps growing, a dead-feeling drag.
        max: Math.max(MIN_EMBED_WIDTH, limit()),
        /* The grip sits at a corner, so both axes drive it — as one projection
           onto the picture's own diagonal, not as whichever axis moved
           further. Picking an axis put a step in the middle of the gesture:
           the moment the hand crossed the diagonal the width stopped reading
           `dx` and started reading `dy * ratio`, and on a wide picture that is
           several times as much width for a pointer that moved a pixel. The
           projection agrees with both axes at the corner and everywhere
           between them, so the picture follows the hand instead of flicking
           past it. */
        read: (dx, dy) => (dx * width + dy * height) * width / (width * width + height * height)
      }
    },
    paint: (width) => paintWidth(image, width),
    commit,
    restore: () => {
      image.style.width = was.width
      image.style.height = was.height
      host.classList.toggle('is-sized', was.sized)
    },
    // Double-click takes the size off: the picture back at its natural width.
    reset: () => {
      /* Undressed here rather than by a redraw, because not every caller
         redraws: what a drag put on the picture is what has to come off it. */
      image.style.width = ''
      image.style.height = ''
      host.classList.remove('is-sized')
      commit(null)
    },
    settle: () => {
      host.classList.remove('is-resizing')
      settle()
    }
  })
}

/* The height stays automatic: the ratio is the picture's own, and a second
   driven dimension is a second reflow per frame. */
function paintWidth (image, width) {
  image.style.width = `${width}px`
  image.style.height = 'auto'
}

/* What an unsized picture in a cell is drawn no wider than — the number the
   stylesheet caps it at, kept here as well because the cell's width hint below
   has to agree with it. */
const CELL_IMAGE_CAP = 640

/**
 * How wide a picture-only cell would *like* to be.
 *
 * The picture itself fills the cell (`.has-image-only` in the stylesheet), so
 * it can no longer say how wide the column should be — and left to itself a
 * stretched picture reports its file's own pixel width as the column's ideal,
 * which is how one 800-pixel screenshot pushed the rest of the table off the
 * side. The number the note asked for (`|140`), or an unsized picture's natural
 * width under the same cap the stylesheet draws it at, is the column's
 * preference; whatever the column then turns out to be — a longer heading, a
 * table stretched to the width of the note — is what the picture fills.
 *
 * A preference and not a floor: a cell width in an auto-laid-out table is a
 * suggestion, so the column still grows for its other rows.
 */
/**
 * A table cell that holds nothing but a picture is the picture: the cell gives
 * up its padding and the picture fills it, edge to edge, whatever the column
 * turns out to be. The editing view decides the same thing under the same class
 * name — see `has-image-only` in src/table.js — and the stylesheet then treats
 * the two alike, which is what keeps the same table looking the same in both
 * views.
 *
 * The cell keeps the picture's asked-for width as a *hint* (`fitImageCell`),
 * because a picture told to fill has no width of its own left to size the
 * column with.
 *
 * Asked after the embeds are built rather than of the stubs, because only the
 * built embed knows whether the attachment turned out to be an image: a PDF or
 * a recording in a cell is furniture that still wants its padding.
 *
 * Reached through the pictures rather than through the cells. A note of any
 * length is mostly cells that hold words — 3,600 of them in a page of forty
 * tables — and asking each of them whether its one child is a picture cost more
 * than every other pass over the page put together, for an answer that is "no"
 * everywhere a picture is not. `root` is always a page just built from
 * `md.render`, so no cell arrives carrying the class or the width a previous
 * answer left: there is nothing to clear where there is no picture.
 */
export function markImageCells (root) {
  for (const image of root.querySelectorAll('img.embed-img')) {
    const cell = image.parentElement
    if (!cell || (cell.tagName !== 'TD' && cell.tagName !== 'TH')) continue
    const kids = [...cell.childNodes].filter(
      (node) => node.nodeType !== Node.TEXT_NODE || node.textContent.trim() !== ''
    )
    if (kids.length !== 1 || kids[0] !== image) continue
    cell.classList.add('has-image-only')
    fitImageCell(cell, image, Number(image.getAttribute('width')) || null)
  }
}

export function fitImageCell (cell, image, asked) {
  if (asked) {
    cell.style.width = `${asked}px`
    return
  }
  const natural = () => {
    cell.style.width = image.naturalWidth
      ? `${Math.min(image.naturalWidth, CELL_IMAGE_CAP, Math.round(window.innerWidth * 0.7))}px`
      : ''
  }
  // A lazily-loaded picture has no natural width to ask for yet, and a cell
  // sized from a zero is a column collapsed to nothing.
  if (image.complete && image.naturalWidth) natural()
  else {
    cell.style.width = ''
    image.addEventListener('load', natural, { once: true })
  }
}

/* ----------------------------------------------------------- the network

   An embed whose target has a scheme resolves to nothing in the vault, and
   until now that made it "missing" — the one answer that is certainly wrong
   for `![](https://…/cat.gif)`. A remote target is shown by what it is, the
   same as a local one, with one exception: a YouTube link is a *player*, not
   a file, and there is no extension to work that out from.
   ================================================================== */

/* The forms people actually paste. An id is eleven characters of [\w-]; the
   rest of the URL is a playlist, a timestamp or tracking, none of which the
   player is given. Matching the id out and rebuilding the URL ourselves —
   rather than framing what the note wrote — is what keeps a hostile link in a
   shared note from framing something that is not YouTube. */
const YOUTUBE = [
  /^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:[^#]*&)?v=([\w-]{11})/i,
  /^https?:\/\/youtu\.be\/([\w-]{11})/i,
  /^https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})/i,
  /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/([\w-]{11})/i,
  /^https?:\/\/(?:www\.)?youtube\.com\/live\/([\w-]{11})/i
]

/** The video a YouTube URL names, or null for anything that is not one. */
function youtubeId (src) {
  const url = String(src || '').trim()
  for (const pattern of YOUTUBE) {
    const found = pattern.exec(url)
    if (found) return found[1]
  }
  return null
}

/**
 * Where a link says to start: `?t=90`, `?t=1m30s`, or `&start=90`. Returned in
 * seconds, because that is the only form the player takes.
 */
function startSeconds (src) {
  const found = /[?&](?:t|start)=([\d.hms:]+)/i.exec(String(src || ''))
  return found ? (parseMediaTime(found[1]) ?? 0) : 0
}

/** A URL's extension, with the query and fragment taken off first — `?v=2` is
 *  not part of the filename, and left on it makes every extension unknown. */
const remoteExtension = (url) => extensionOf(url.split(/[?#]/)[0])

/**
 * What to show for a target that lives on the network, or null if the target
 * is not one — in which case the caller's "missing" answer stands.
 */
function remoteSpec (src, { alt, size, writtenAsImage }) {
  const url = String(src || '').trim()
  if (!/^https?:\/\//i.test(url)) return null

  const base = {
    path: null,
    alt,
    label: alt || url,
    width: size?.width || null,
    height: size?.height || null
  }

  const id = youtubeId(url)
  if (id) {
    const start = startSeconds(url)
    return {
      ...base,
      kind: 'youtube',
      videoId: id,
      start,
      url,
      label: alt || 'YouTube video'
    }
  }

  /* A remote picture or recording is shown by the tag that plays it. Anything
     else on the web — a page, a remote PDF — is *shown*, in a guest frame,
     rather than reduced to a link; the guest's own viewer decides what the
     bytes are. `label` defaults to the site rather than the whole URL, which
     is what the frame's header shows.

     The extension is only a guess, though, and half the web serves pictures
     without one: `img.shields.io/github/stars/…?style=flat` is a badge, and
     framing it as a page turned a README's row of them into three full-width
     guests. So a target the note itself called a picture — `writtenAsImage`,
     which markdown's `![](…)` and a raw `<img src>` both are — is one even
     when the URL will not say. `![[…]]`, the way a note asks for a web embed
     on purpose, keeps the frame. */
    const kind = KIND_BY_EXT.get(remoteExtension(url)) ||
    (writtenAsImage ? 'image' : 'web')
  if (kind === 'image' || kind === 'video' || kind === 'audio') {
    return { ...base, kind, url }
  }
  let site = url
  try { site = new URL(url).hostname.replace(/^www\./, '') } catch { /* shown whole */ }
  return { ...base, kind: 'web', url, label: alt || site }
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
export function embedSpec (src, {
  alt = '', size = null, resolve, resolveNote = null, dir = '', writtenAsImage = false
} = {}) {
  /* An embed with no target at all — `![[ ]]`, the slash key's placeholder —
     is not a missing file, it is a choice still to be made. Named rather than
     left a blank, so a note that never finished the gesture says so quietly
     in both views instead of hiding an invisible gap. */
  if (!String(src || '').trim()) {
    return {
      kind: 'missing', path: null, url: null, alt,
      label: alt || 'Embed', width: null, height: null, page: null, start: null
    }
  }

  /* `Sample.pdf#page=3` — the fragment is an instruction to the viewer, not
     part of the name, so it comes off before the vault is asked. Only for a
     local target: a URL keeps its fragment, which belongs to the site. */
  let target = String(src || '')
  let page = null
  let start = null
  if (!/^https?:\/\//i.test(target)) {
    const hash = target.indexOf('#')
    if (hash !== -1) {
      const fragment = target.slice(hash + 1).trim()
      const found = /^page=(\d+)$/i.exec(fragment)
      const timed = /^t=(.+)$/i.exec(fragment)
      if (found) page = Number(found[1])
      else if (timed) start = parseMediaTime(timed[1])
      if (found || (timed && start !== null)) target = target.slice(0, hash)
    }
  }

  const path = resolve ? resolve(target, dir) : null
  if (!path) {
    // Nothing in the vault answers to this. Before calling it missing, ask
    // whether it was ever meant to be in the vault.
    const remote = remoteSpec(src, { alt, size, writtenAsImage })
    if (remote) return remote

    /* Not an attachment and not a URL — the last thing `![[…]]` can name is
       another note, and naming one is a transclusion: the note itself stands
       where the embed was written, `#Heading` narrowing it to one section.
       Only the wiki form: `![](Some Note)` is markdown's image syntax, and an
       image whose file is gone should say "missing", not unfold into prose. */
    if (resolveNote && !writtenAsImage) {
      const { name, anchor } = splitAnchor(String(src || ''))
      const note = name ? resolveNote(name) : null
      if (note) {
        return {
          kind: 'note',
          path: note,
          url: null,
          anchor,
          alt,
          label: alt || name,
          width: null,
          height: null,
          page: null
        }
      }
    }
    return {
      kind: 'missing', path: null, url: null, alt, label: alt || src,
      width: null, height: null, page: null, start: null
    }
  }

  return {
    kind: assetKind(path),
    path,
    url: assetUrl(path),
    alt,
    label: alt || baseName(path),
    width: size?.width || null,
    height: size?.height || null,
    page,
    start
  }
}

/**
 * The spec for a record `findEmbeds` returned — which is what both views
 * actually hold, and the form the reading view rebuilds from its stub.
 *
 * Here rather than at the call sites so that what `syntax` *means* is stated
 * once, in the module that defines the word. A view that had to translate it
 * itself would be a view that could translate it differently.
 */
export function specForEmbed (embed, opts = {}) {
  return embedSpec(embed.src, {
    alt: embed.alt,
    size: embed.size,
    writtenAsImage: embed.syntax === 'md',
    ...opts
  })
}

/* ----------------------------------------------------- guests in a note

   YouTube players and embedded web pages are <webview> guests: separate
   processes, separate sessions, nothing of Tulip's reachable from inside.
   electron/main.js draws the fence — which partitions may attach, where each
   may navigate, what happens to popups — so everything here is presentation.

   YouTube gets youtube.com's own /embed/ player. One thing matters and is
   easy to lose: the /embed/ page refuses to play — error 153, "video player
   configuration error" — unless the request carries an ordinary https
   Referer. The app's own origins (file://, tulip-file://) do not produce
   one, so the guest is given a nominal referrer for the app itself via the
   `httpreferrer` attribute. That is the entire trick. (A *YouTube* URL as
   the referrer is refused too, as error 152 — it has to read as some other
   site embedding the video, which is what is actually happening.)
   ================================================================== */

/** The watch URL for a spec, which is both what the player loads and what
 *  ⌘-click hands to the browser. Built from the id we parsed out, never from
 *  the string the note wrote. */
const watchUrl = (spec) =>
  `https://www.youtube.com/watch?v=${spec.videoId}${spec.start ? `&t=${spec.start}` : ''}`

/* What the /embed/ page loads instead of erroring over a missing Referer: a
   nominal https origin standing for the app. Sent only to YouTube — the
   webview attribute scopes it to that guest — never to embedded sites. */
const EMBED_REFERRER = 'https://tulip.app/'

/* Each kind of guest keeps its own persistent session, named here and policed
   in electron/main.js: a guest in the youtube partition may only be YouTube,
   one in the web partition may be any http(s) page, and nothing else may
   attach at all. */
const YOUTUBE_PARTITION = WEB_PARTITIONS.youtube
const WEB_PARTITION = WEB_PARTITIONS.web

function youtubeEmbed (spec, onReady) {
  /* An <a> still, so it reads as a link, carries the URL in its status and
     answers ⌘-click the way every other link in a note does. The click that
     plays it is the plain one. */
  const card = document.createElement('a')
  card.className = 'embed-yt'
  card.href = watchUrl(spec)
  card.title = `Play here — ⌘-click to open on YouTube\n${card.href}`

  const poster = document.createElement('img')
  poster.className = 'embed-yt-poster'
  poster.src = `https://i.ytimg.com/vi/${spec.videoId}/hqdefault.jpg`
  poster.alt = spec.alt || ''
  poster.loading = 'lazy'
  poster.addEventListener('load', onReady, { once: true })
  // No thumbnail is not a broken card — the play button still works.
  poster.addEventListener('error', () => { poster.remove(); onReady() }, { once: true })

  const play = document.createElement('span')
  play.className = 'embed-yt-play'
  play.setAttribute('aria-hidden', 'true')

  const label = document.createElement('span')
  label.className = 'embed-yt-label'
  label.textContent = spec.alt || 'Watch on YouTube'

  card.append(poster, play, label)
  if (spec.width) card.style.width = `${spec.width}px`
  if (spec.height) {
    card.style.aspectRatio = 'auto'
    card.style.height = `${spec.height}px`
  }

  card.addEventListener('click', (event) => {
    // ⌘-click keeps its usual meaning: this one goes to the browser.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    event.stopPropagation()
    card.replaceWith(youtubePlayer(spec, onReady))
  })

  return card
}

/**
 * The player the card turns into: youtube.com's own embedded player, in a
 * guest of its own, already playing. The privacy-enhanced host, because the
 * reader asked for a video and consented to nothing else.
 */
function youtubePlayer (spec, onReady) {
  const frame = document.createElement('div')
  frame.className = 'embed-yt embed-yt-live'
  if (spec.width) frame.style.width = `${spec.width}px`
  if (spec.height) {
    frame.style.aspectRatio = 'auto'
    frame.style.height = `${spec.height}px`
  }

  const view = document.createElement('webview')
  view.className = 'embed-view'
  view.setAttribute('partition', YOUTUBE_PARTITION)
  view.setAttribute('httpreferrer', EMBED_REFERRER)
  const start = spec.start ? `&start=${spec.start}` : ''
  view.setAttribute('src',
    `https://www.youtube-nocookie.com/embed/${spec.videoId}?autoplay=1&playsinline=1${start}`)

  /* The thumbnail holds the frame, with the play button swapped for a
     spinner, until the player has genuinely loaded — so pressing play changes
     one glyph and nothing else moves or goes black. */
  const cover = document.createElement('span')
  cover.className = 'embed-cover'
  const poster = document.createElement('img')
  poster.className = 'embed-yt-poster'
  poster.src = `https://i.ytimg.com/vi/${spec.videoId}/hqdefault.jpg`
  poster.alt = ''
  const spinner = document.createElement('span')
  spinner.className = 'embed-spin'
  spinner.setAttribute('aria-hidden', 'true')
  cover.append(poster, spinner)

  view.addEventListener('did-finish-load', () => {
    cover.classList.add('is-done')
    // Removed rather than left transparent: it sits over the controls.
    setTimeout(() => cover.remove(), 260)
    onReady()
  }, { once: true })

  view.addEventListener('did-fail-load', (e) => {
    // A load that never arrives should say so rather than sit black forever.
    if (e.errorCode === -3) return // aborted by a redirect; not a failure
    frame.replaceWith(youtubeEmbed(spec, onReady))
  })

  frame.append(view, cover)
  return frame
}

/* -------------------------------------------------------------- the web */

/**
 * A web page standing in a note: a framed guest with a slim header naming the
 * site (the address sits in its tooltip).
 */
function webEmbed (spec, onReady) {
  const box = document.createElement('figure')
  box.className = 'embed-web'
  if (spec.width) box.style.width = `${spec.width}px`

  const head = document.createElement('div')
  head.className = 'embed-web-head'

  const site = document.createElement('span')
  site.className = 'embed-web-site'
  site.textContent = spec.label
  site.title = spec.url

  head.append(site)

  const view = document.createElement('webview')
  view.className = 'embed-view embed-web-view'
  view.setAttribute('partition', WEB_PARTITION)
  // The guest's own PDF viewer, for embeds that point straight at a document.
  view.setAttribute('plugins', '')
  view.setAttribute('src', spec.url)
  if (spec.height) view.style.height = `${spec.height}px`

  view.addEventListener('did-finish-load', onReady, { once: true })
  view.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3 || !e.isMainFrame) return
    /* The page would not load. Say so in the frame rather than leaving white,
       and keep the header so the site is still named. */
    const note = document.createElement('div')
    note.className = 'embed-web-fail'
    note.textContent = `Couldn\u2019t load this page (${e.errorDescription || e.errorCode})`
    if (spec.height) note.style.height = `${spec.height}px`
    view.replaceWith(note)
    onReady()
  })

  box.append(head, view)
  return box
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
    if (spec.path) img.dataset.vaultImage = spec.path
    img.loading = 'lazy'
    /* Off the thread the note is being rendered on. Lazy already keeps the
       pictures below the fold from being decoded at all; this keeps the ones
       above it from being decoded synchronously, which on a note full of
       photographs is the difference between the text appearing and the whole
       page waiting for the images. */
    img.decoding = 'async'
    if (spec.width) img.width = spec.width
    if (spec.height) img.height = spec.height
    img.addEventListener('load', onReady, { once: true })
    /* A pasted image is often still being written when the embed first asks
       for it, and a "missing" chip for a file half a second from existing is
       wrong in the way that sticks. One more look before saying so. */
    let retried = false
    img.addEventListener('error', () => {
      if (!retried) {
        retried = true
        // Removed and re-set: some engines treat assigning the same src as
        // already answered, and a retry that does not fetch is not a retry.
        setTimeout(() => {
          img.removeAttribute('src')
          img.src = spec.url
        }, 500)
        return
      }
      img.replaceWith(renderEmbed({ ...spec, kind: 'missing', label: spec.label }))
      onReady()
    })
    return img
  }

  if (spec.kind === 'youtube') return youtubeEmbed(spec, onReady)

  if (spec.kind === 'web') return webEmbed(spec, onReady)

  // Another note, standing in this one. The frame and its fragment live in
  // src/transclude.js, which knows how to render a note the reading view's way
  // without adopting its line addresses or its run controls.
  if (spec.kind === 'note') return renderTransclusion(spec, onReady)

  /* The chip is handed down rather than imported over there: assets.js is what
     decides what an embed looks like, and pdfembed.js reaching back for it
     would make the two modules import each other. */
  if (spec.kind === 'pdf') return renderPdfEmbed(spec, onReady, fileChip)

  if (spec.kind === 'video' || spec.kind === 'audio') {
    const media = document.createElement(spec.kind)
    media.className = 'embed-media'
    media.src = spec.url
    media.controls = true
    media.preload = 'metadata'
    if (spec.width) media.width = spec.width
    if (spec.height) media.height = spec.height
    media.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(spec.start)) {
        media.currentTime = Math.min(Math.max(0, spec.start), media.duration || spec.start)
      }
      onReady()
    }, { once: true })
    return media
  }

  // Anything else gets a name to click rather than a viewer that would show
  // nothing. The click reveals it in Finder.
  return fileChip(spec)
}

/**
 * A file's name, to click.
 *
 * What an embed degrades to when there is nothing to show — the kind the vault
 * has no viewer for, and the PDF that turned out to be unreadable. The inline
 * viewer is handed this rather than building its own, so a change to how a file
 * reads in a note reaches both.
 */
export function fileChip (spec) {
  const chip = document.createElement('a')
  chip.className = 'embed-file'
  chip.textContent = spec.label
  chip.dataset.asset = spec.path
  return chip
}

/**
 * Tears down every embed under `root` that holds resources — for now that is
 * the inline PDFs, whose documents own a worker each. The editor calls this
 * per widget as CodeMirror discards it; the reading view calls it over the
 * whole page before rendering a fresh one. Guests need nothing: a <webview>
 * leaving the DOM takes its process with it.
 */
export function destroyEmbeds (root) {
  if (!root) return
  if (typeof root.embedDestroy === 'function') root.embedDestroy()
  for (const el of root.querySelectorAll?.('.embed-pdf') || []) el.embedDestroy?.()
}
