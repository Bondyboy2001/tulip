/* ================================================================= dom
   The three things everything here builds pages out of: an element, an icon,
   and the escaper that lets note text be written into an HTML string.

   They lived in src/blocks.js, which is about what a fenced block becomes and
   the CodeMirror StateField boilerplate behind that. Fifteen modules imported
   them from there — the copilot panel, the find bar, the sidebar's file icons,
   the language chips, the keyboard, the callouts — none of which has anything
   to do with fences, and several of which have no business loading CodeMirror
   at all. src/headings.js is the case that made it plain: it is text scanning
   with one button in it, and rather than take that dependency it hand-wrote a
   copy of the very SVG `svgIcon` exists to own.

   Nothing here knows about the editor, the vault or the app's state, which is
   what makes it safe for any module to reach for.
   ================================================================== */

/** An element, with its class and its text — the shape all of this is built from. */
export function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Every icon this module has already built, by the description it was built
 * from. Setting `innerHTML` on an SVG runs the HTML parser, which is by far
 * the most expensive thing here — and the app draws the *same* handful of
 * shapes over and over: two buttons on each of a long note's fenced blocks,
 * a brand mark on each of them, a twist and a file kind on each sidebar row.
 * Parsed once each, then cloned, which copies already-built nodes.
 *
 * Sound because the arguments are the whole of what an icon is: two calls with
 * the same description would have produced identical elements. Every caller
 * appends what it gets and none of them mutates it, so a clone is not merely
 * equivalent — it is the same element they would have received.
 *
 * Bounded without needing to be: `markup` is a constant in this repo at every
 * call site. The one route that looks like note text — a fence naming an
 * unknown language — stops at `logoSvg`, which answers `null` for anything
 * outside its own fixed table before it ever reaches here. Keep it that way: a
 * caller that passed note text as `markup` would be a cache with no bound.
 */
const iconTemplates = new Map()

/**
 * An inline icon.
 *
 * Six places drew one before this, and each spelled out the namespace, the
 * viewBox, the aria-hidden and — for the outlined ones — the same five stroke
 * attributes. `stroke` asks for the outlined preset at a given width; `fill`
 * for the solid one.
 */
export function svgIcon (markup, {
  viewBox = '0 0 16 16',
  className = '',
  size = null,
  stroke = null,
  fill = null
} = {}) {
  const key = viewBox + '|' + className + '|' + size + '|' + stroke + '|' + fill + '|' + markup
  const cached = iconTemplates.get(key)
  if (cached) return cached.cloneNode(true)

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  if (className) svg.setAttribute('class', className)
  if (size != null) {
    svg.setAttribute('width', String(size))
    svg.setAttribute('height', String(size))
  }
  if (stroke != null) {
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', String(stroke))
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
  } else if (fill) {
    svg.setAttribute('fill', fill)
  }
  svg.innerHTML = markup
  iconTemplates.set(key, svg)
  return svg.cloneNode(true)
}

/* The five characters that stop note text being read as markup. Here rather
   than beside either of the two modules that write untrusted text into an HTML
   string, because a second copy of an escaper is a copy that gets fixed once. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Note text, safe to put in either an element body or a quoted attribute. */
export function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPES[c])
}
