/* ================================================================== guests
   A block that is really a page, and the sandbox it is shown in.

   Two kinds of fence end up here: ```html, whose page the note itself wrote,
   and ```three, whose page Tulip writes around a scene (see threejs.js). What
   they share is everything below — the <webview> guest, the state that keeps
   one block's page the same page in both views, and the two controls the
   editing view puts around it. Only the document differs, so only the document
   is the caller's business: `guestFence` takes it and hands back the three
   shapes a fence has to be, and each module is then its own `isX` and its own
   idea of what the page says.

   The guest is its own process, on an in-memory partition, with no preload and
   no Node; electron/main.js decides at attach time whether it may exist at all,
   and a guest on this partition may only ever be the data: document written
   into it. It has no network — the fence in main.js cancels every request that
   would leave the page — so a document that needs a library carries it or
   fetches it from the app's own dist (which is how the three.js runtime, far
   too big to inline into a URL, reaches the scene: see GUEST_LIBRARY).

   Why a guest rather than the reading view's own sanitiser (rawhtml.js): the
   point of running a block is that its <script> and <style> work, and the app's
   page can never be where they do — its CSP forbids inline script, and a srcdoc
   or blob: frame inherits that CSP wholesale. A browser tab of its own is what
   "run this" means, and a <webview> is one.

   The guest's viewport is set by the stylesheet before the page loads and never
   touched afterwards. It was fitted to the page's own height once, after load —
   and that resize re-laid-out every page that sizes a canvas at load, which is
   most of the pages worth running. A page gets a browser-shaped window and
   adapts to it, exactly as it would anywhere else.
   ================================================================== */

import { el, renderedBlock } from './blocks.js'
import { drawRunFace, painter, runButton } from './runcode.js'
import WEB_PARTITIONS from '../electron/web-partitions.json'

/* Named identically in electron/main.js, which is what puts a guest behind the
   fence that lets it be this block's document and nothing else. */
const HTML_RUN_PARTITION = WEB_PARTITIONS.htmlrun

/* Whether each block's page is up, keyed by the block's own text — the same
   bargain as a run's output. One state can be on screen more than once (the
   same block in both views, or twice in a note), so a click on any of its
   buttons repaints all of its controls; editing the block changes the key, so
   the page closes rather than showing what the old source made. Bounded, like
   the results map, so a long session of edits does not keep a flag for every
   draft — and least-recently-used rather than oldest-first, because the block
   the reader has open is often the one they opened first, and evicting it
   would close a running page under them. */
const previews = new Map()
const MAX_PREVIEWS = 200

function stateFor (key) {
  const found = previews.get(key)
  if (found) {
    previews.delete(key)
    previews.set(key, found)
    return found
  }

  const state = {
    open: false,
    painters: new Set(),
    render () { for (const paint of this.painters) paint() }
  }
  if (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value)
  previews.set(key, state)
  return state
}

/* The document, as the one URL the main process will let this guest be.
   base64 rather than percent-encoding, because btoa is the cheap path and a
   percent-encoded page triples in size; the TextEncoder hop is what keeps
   btoa from throwing on the first non-Latin character in the block. */
function toDataUrl (page) {
  const bytes = new TextEncoder().encode(page)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:text/html;charset=utf-8;base64,${btoa(binary)}`
}

function buildGuest (page, viewClass) {
  const guest = document.createElement('webview')
  guest.className = viewClass
  /* Set before it is attached, because that is when it is decided whether
     this guest may exist at all — see will-attach-webview in main.js. */
  guest.setAttribute('partition', HTML_RUN_PARTITION)
  guest.setAttribute('src', toDataUrl(page))
  return guest
}

/* ---------------------------------------------------- mounting on sight */

/* Every guest is a process, and a scene's is a process holding a GPU context
   and rendering a frame sixty times a second for as long as the note is open;
   a page of them would all be doing that while the reader is still at the first
   paragraph. So a guest waits until its block comes near the viewport.

   One observer for all of them rather than one each: an observer holds its
   targets, and a note whose blocks are never scrolled to would otherwise leave
   one behind per block. Entries leave on sight, and the sweep below drops the
   ones belonging to a note that has since been re-rendered — nothing else ever
   tells us they are gone. */
const waiting = new Map()

const watcher = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const [node] of waiting) {
      if (!node.isConnected) { waiting.delete(node); watcher.unobserve(node) }
    }
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const mount = waiting.get(entry.target)
      waiting.delete(entry.target)
      watcher.unobserve(entry.target)
      mount?.()
    }
  }, { rootMargin: '200px' })
  : null

function onSight (node, mount) {
  if (!watcher) { mount(); return }
  waiting.set(node, mount)
  watcher.observe(node)
}

/* --------------------------------------------------------- one fence */

/**
 * Everything a page-shaped fence is, given what its page says.
 *
 * @param {object} spec
 * @param {string} spec.tag     the kind's own word: its state keys are prefixed
 *   with it, and its three class names are built from it
 * @param {string} spec.label   what a screen reader calls the result
 * @param {{run: string, close: string}} spec.tips  the Run button's two titles
 * @param {(code: string) => string} spec.page  the document, built on demand —
 *   never before the guest is really wanted, because for a scene this reads the
 *   page's own colours and builds a document of some kilobytes
 * @returns {{buttonUI: Function, panelUI: Function, attach: Function}}
 */
export function guestFence ({ tag, label, tips, page }) {
  const panelClass = `${tag}-run`
  const viewClass = `${tag}-run-view`
  const figureClass = `${tag}-page`
  const keyFor = (code) => `${tag}\n${code}`

  /**
   * The Run/Close button for one block, on runcode's own faces — the triangle
   * to run the page, the square to put it away. The state behind it is keyed by
   * the block, so the same block's button in the editing view and in the
   * reading view drive one page between them.
   */
  function buttonUI (_lang, code) {
    const state = stateFor(keyFor(code))
    const button = runButton()

    const paint = painter(state, button, () => {
      drawRunFace(button, state.open, state.open ? tips.close : tips.run)
    })

    button.addEventListener('click', () => {
      state.open = !state.open
      state.render()
    })
    paint()
    return button
  }

  /**
   * The editing view's form: the page in the run output's compartment under the
   * fence, hidden until the block is run — the source stays on screen above it,
   * because the editing view is where the source is the point.
   *
   * `onDraw` is how the editor hears that the panel changed height.
   */
  function panelUI (_lang, code, className, onDraw) {
    const state = stateFor(keyFor(code))
    const panel = el('div', `run-out ${panelClass} ${className}`)
    panel.setAttribute('role', 'group')
    panel.setAttribute('aria-label', label)
    panel.hidden = true

    painter(state, panel, () => {
      /* A repaint that changes nothing leaves the guest alone — rebuilding it
         would reload the page mid-interaction — and emptying the box is the
         whole teardown: a <webview> leaving the DOM takes its process with it.
         The document is built here and only here, so a repaint of a closed
         panel costs nothing. */
      if (!state.open) panel.replaceChildren()
      else if (!panel.firstChild) panel.append(buildGuest(page(code), viewClass))
      panel.hidden = !state.open
      onDraw?.()
    })()
    return panel
  }

  /**
   * The reading view's form: the sandboxed page is always up. This is
   * deliberately independent of the editing view's Run/Close state — closing an
   * editor preview must not turn Reading view back into source.
   *
   * Up, but not until it is in sight — see `onSight`. The block's box is laid
   * out empty in the meantime, by a placeholder wearing the guest's own class
   * so it takes exactly the space the guest will and nothing jumps when it
   * arrives. Never taken down again: scrolling past a scene and back must not
   * restart it.
   *
   * @param {HTMLElement} wrap  the .code-wrap holding the source
   */
  function attach (wrap, code) {
    const block = renderedBlock(wrap, figureClass, { stage: false })
    const slot = el('div', viewClass)
    block.figure.prepend(slot)
    block.settle(true)

    onSight(slot, () => {
      if (slot.isConnected) slot.replaceWith(buildGuest(page(code), viewClass))
    })
  }

  return { buttonUI, panelUI, attach }
}
