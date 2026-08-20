// @ts-check
/* ================================================================== svg
   An ```svg block is a picture already — the source *is* the drawing, with
   nothing in between. So both views show the drawing where the code was, and
   the code is a thing you ask for, the same bargain the mermaid, tikz and
   manim blocks strike.

   Closer to mermaid than to tikz: there is no renderer to run and nothing to
   write beside the note. A drawing appears the moment its closing fence does,
   and the only work between the text and the picture is reading it — which is
   also the only thing that can fail, and a half-typed <path is the normal
   state of an editor, so a failure is a line of explanation rather than an
   exception.

   The markup comes out of the user's own notes, but a note can arrive by
   drag-and-drop or a sync client, and an <svg> is a document that can carry
   script, remote references and links. So nothing is assigned as HTML: the
   source is parsed in an inert document, stripped there, and only then adopted
   into the page. See sanitise().
   ================================================================== */

import { WidgetType } from '@codemirror/view'
import { el, pictureBlock, pictureBlocks } from './blocks.js'
import { DRAWN } from './languages.js'

export function isSvg (lang) {
  return String(lang || '').trim().toLowerCase() === DRAWN.svg
}

/* ------------------------------------------------------------ reading it */

/* What an SVG is allowed to be here. Everything else — <script>, <foreignObject>
   and the whole of HTML it would let back in, <use> pointing anywhere but this
   document — is dropped rather than refused, so one stray element does not cost
   you the drawing. */
const BANNED = new Set(['script', 'foreignobject', 'iframe', 'embed', 'object',
                        'audio', 'video', 'set', 'handler', 'listener'])

/* Only these may hold a URL, and only ones pointing inside this document or at
   data: images are kept — a picture in a note should not be a thing that
   phones home when the note is opened. */
const URL_ATTRS = new Set(['href', 'xlink:href', 'src'])

function safeUrl (value) {
  const url = String(value || '').trim()
  if (url.startsWith('#')) return true                    // a def in this same drawing
  return /^data:image\/(png|jpeg|gif|webp|svg\+xml);/i.test(url)
}

/* A url() that does not point inside this document. The fragment form —
   url(#id), quoted or not, spaced or not — is half of what SVG is made of and
   stays; anything else is a fetch waiting to happen. */
const EXTERNAL_URL = /url\s*\(\s*['"]?\s*(?!#)/i

function scrubAttrs (node) {
  for (const attr of [...node.attributes]) {
    const name = attr.name.toLowerCase()
    // Event handlers are the whole of the scripting surface once <script>
    // is gone: on* on any element, in any namespace.
    if (name.startsWith('on')) { node.removeAttribute(attr.name); continue }
    if (URL_ATTRS.has(name) && !safeUrl(attr.value)) { node.removeAttribute(attr.name); continue }
    // A style may name a gradient or a filter defined in this same drawing —
    // that is half of what inline style is for here — but not fetch one, and
    // not smuggle script in behind a property.
    if (name === 'style' && /expression|javascript:/i.test(attr.value)) {
      node.removeAttribute(attr.name)
      continue
    }
    /* And not just style: fill, filter, mask, clip-path — a dozen presentation
       attributes take url(), and enumerating them is how one gets missed. Any
       attribute whose value reaches outside the document goes. */
    if (EXTERNAL_URL.test(attr.value)) node.removeAttribute(attr.name)
  }
}

function scrub (node) {
  for (const child of [...node.children]) {
    if (BANNED.has(child.localName.toLowerCase())) { child.remove(); continue }

    scrubAttrs(child)

    /* A <style> is a document's worth of CSS in one text node, and @import or
       a remote url() there would reach out the same way an attribute would.
       There is no half-measure worth taking inside a stylesheet, so one that
       does either loses its text rather than its element. */
    if (child.localName.toLowerCase() === 'style' &&
        /@import|url\s*\(\s*['"]?(?!#)/i.test(child.textContent || '')) {
      child.textContent = ''
    }

    scrub(child)
  }
}

/* Every drawing put on the page gets its own set of ids. Two things make that
   necessary: a note can hold two blocks that both call their gradient "g", and
   the same block is on the page twice whenever both views are alive — and a
   `url(#tip)` in a document with two #tips resolves to whichever the browser
   met first, which is how an arrow loses its head in one pane and keeps it in
   the other. */
let serial = 0

function rewriteIds (root) {
  const seen = new Map()
  const prefix = `tulip-svg-${++serial}-`

  for (const node of [root, ...root.querySelectorAll('[id]')]) {
    const id = node.getAttribute('id')
    if (!id) continue
    seen.set(id, prefix + id)
    node.setAttribute('id', prefix + id)
  }
  if (!seen.size) return

  // A reference is `url(#g)` in any of the dozen properties that take one, or a
  // bare `#g` in an href — same rewrite either way, so the ids are matched
  // rather than the properties enumerated.
  const point = (value) => value
    .replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g,
      (whole, quote, id) => (seen.has(id) ? `url(${quote}#${seen.get(id)}${quote})` : whole))

  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase()
      if ((name === 'href' || name === 'xlink:href') && attr.value.startsWith('#')) {
        const target = seen.get(attr.value.slice(1))
        if (target) node.setAttribute(attr.name, `#${target}`)
        continue
      }
      if (attr.value.includes('url(')) node.setAttribute(attr.name, point(attr.value))
    }
    // A stylesheet inside the drawing points at the same ids, by selector as
    // well as by url().
    if (node.localName.toLowerCase() === 'style' && node.textContent) {
      node.textContent = point(node.textContent)
        .replace(/#([\w-]+)/g, (whole, id) => (seen.has(id) ? `#${seen.get(id)}` : whole))
    }
  }
}

/* What the parser says, minus what it says to a browser. Its complaint arrives
   wrapped in a small HTML page — a heading, and an offer to render the document
   up to the first error — and the one line worth keeping is the one naming the
   line and column. */
function complaint (text) {
  const said = String(text || '').trim()
  // Matched inside the text rather than line by line: the heading and the
  // complaint arrive run together, with no newline between them.
  const line = /error on line \d+ at column \d+:[^\n]*/i.exec(said)
  if (line) return line[0].replace(/^error /i, 'Error ')

  const first = said.split('\n').map((l) => l.trim())
    .find((l) => l && !/^this page contains|^below is a rendering/i.test(l))
  return first || 'This is not well-formed SVG.'
}

/**
 * The drawing an ```svg block describes, as a live element.
 *
 * Never throws: `{ error }` comes back instead, and is shown as a line of
 * explanation rather than taking the surrounding render down with it.
 *
 * @returns {{svg?: SVGElement, error?: string}}
 */
function readSvg (code) {
  const source = code.trim()
  if (!source) return { error: 'Nothing to draw.' }

  // Parsed as an image, in a document of its own: nothing here runs, loads or
  // touches the page, whatever the markup says, until it has been through
  // scrub() and been adopted deliberately.
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml')

  const bad = doc.querySelector('parsererror')
  if (bad) return { error: complaint(bad.textContent) }

  const root = doc.documentElement
  if (!root || root.localName.toLowerCase() !== 'svg') {
    return { error: 'An svg block should start with an <svg> element.' }
  }

  // The root's own attributes go through the same mill as everything under it
  // — an on* or a fill="url(https://…)" is no safer for being on the <svg>.
  scrubAttrs(root)
  scrub(root)
  rewriteIds(root)

  /* A drawing that gives a size but no viewBox cannot be scaled to the column,
     and one that gives neither has no size at all — both are worth fixing here
     rather than leaving to look broken. */
  const width = parseFloat(root.getAttribute('width'))
  const height = parseFloat(root.getAttribute('height'))
  if (!root.getAttribute('viewBox') && width > 0 && height > 0) {
    root.setAttribute('viewBox', `0 0 ${width} ${height}`)
  }
  if (!root.getAttribute('viewBox') && !(width > 0)) {
    root.setAttribute('viewBox', '0 0 100 100')
  }

  /* The size it asks for becomes the size it may have, not the size it gets:
     as an attribute a wide drawing would push the column open, and dropped
     altogether a 24px icon would be blown up to fill it. Left as a width the
     stylesheet's max-width can still cut down, a picture is its own size until
     the column is narrower than that. */
  root.removeAttribute('width')
  root.removeAttribute('height')
  if (width > 0) root.style.width = `${width}px`

  return { svg: document.importNode(root, true) }
}

/**
 * Fills a host element with the drawing, or with why there isn't one.
 * Shared by both views so a broken block reads the same in each.
 */
function drawInto (host, code) {
  const { svg, error } = readSvg(code)
  host.replaceChildren()

  if (error) {
    host.classList.add('is-bad')
    host.append(el('pre', 'svg-error', error))
    return false
  }

  host.classList.remove('is-bad')
  host.append(svg)
  return true
}

/* ------------------------------------------------------- reading view */

/**
 * Fits one `svg` block in Reading view.
 *
 * @param {HTMLElement} wrap  the .code-wrap holding the source
 * @param {string} code       the drawing's source
 */
export function attachSvg (wrap, code) {
  const block = pictureBlock(wrap, 'drawing')
  block.settle(drawInto(block.stage, code))
}

/* ------------------------------------------------------- editing view */

/**
 * The same drawing, under the fence you are typing into.
 *
 * A StateField rather than a ViewPlugin: block widgets change line geometry,
 * and a plugin cannot be consulted before the viewport it would change has
 * been measured. Same rule the diagrams and run controls follow.
 */
class DrawingWidget extends WidgetType {
  constructor (code) { super(); this.code = code }

  // Equal while the source is unchanged, so typing elsewhere in the note maps
  // the widget across rather than re-reading every drawing.
  eq (other) { return other.code === this.code }

  toDOM () {
    const host = document.createElement('div')
    host.className = 'cm-drawing'
    // Unlike mermaid there is no wait, so nothing lands after the editor has
    // measured — the widget is its final height before it is ever handed back.
    drawInto(host, this.code)
    return host
  }

  ignoreEvent () { return true }
}

export const svgBlocks = pictureBlocks(isSvg, (code) => new DrawingWidget(code))
