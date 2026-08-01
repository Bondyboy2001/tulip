/* ================================================================ html runs
   An ```html block is a page, and running it shows the page.

   Nothing is spawned. The markup loads into a <webview> guest — its own
   process, an in-memory partition, no preload and no Node — behind the same
   fence the YouTube player and web embeds sit behind: electron/main.js decides
   at attach time whether the guest may exist, and a guest in the htmlrun
   partition may only ever be the data:text/html document written into it.
   Links inside the page go to the reader's own browser.

   Why a guest rather than the reading view's own sanitiser (rawhtml.js): the
   point of running a block is that its <script> and <style> work, and the
   app's page can never be where they do — its CSP forbids inline script, and a
   srcdoc or blob: frame inherits that CSP wholesale. A browser tab of its own
   is what "run this HTML" means, and a <webview> is one.

   Reading view instantiates the page immediately. It can carry script, so it
   still lives inside the dedicated sandboxed guest and partition described
   above; automatic rendering changes when that isolated document is created,
   not what it may access. Editing view keeps the deliberate Run/Close gesture,
   where source is the primary thing on screen.

   The guest's viewport is set by the stylesheet before the page loads and
   never touched afterwards. It was fitted to the page's own height once, after
   load — and that resize re-laid-out every page that sizes a canvas at load,
   which is most of the pages worth running. A page gets a browser-shaped
   window and adapts to it, exactly as it would anywhere else; a longer one
   scrolls inside the guest.
   ================================================================== */

import { el, renderedBlock } from './blocks.js'
import { drawRunFace, painter, runButton } from './runcode.js'
import { languageId } from './languages.js'
import WEB_PARTITIONS from '../electron/web-partitions.json'

/* Named identically in electron/main.js, which is what puts a guest behind
   the fence that lets it be this block's document and nothing else. */
const HTML_RUN_PARTITION = WEB_PARTITIONS.htmlrun

/* Asked of languages.js rather than restated here: that table already knows
   every spelling a fence uses for HTML, and a copy of the list is how `xhtml`
   ends up drawing the chip without offering the preview it implies. */
export function isHtmlRun (lang) {
  return languageId(lang) === 'html'
}

/* Whether each block's page is up, keyed by the block's code — the same
   bargain as a run's output. One state can be on screen more than once (the
   same block in both views, or twice in a note), so a click on any of its
   buttons repaints all of its controls; editing the block changes the key, so
   the page closes rather than showing what the old markup made. Bounded, like
   the results map, so a long session of edits does not keep a flag for every
   draft. */
const previews = new Map()
const MAX_PREVIEWS = 200

function stateFor (code) {
  const key = `html\n${code}`
  let state = previews.get(key)
  if (state) return state

  state = {
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
function toDataUrl (code) {
  const bytes = new TextEncoder().encode(code)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:text/html;charset=utf-8;base64,${btoa(binary)}`
}

function buildGuest (code) {
  const guest = document.createElement('webview')
  guest.className = 'html-run-view'
  /* Set before it is attached, because that is when it is decided whether
     this guest may exist at all — see will-attach-webview in main.js. */
  guest.setAttribute('partition', HTML_RUN_PARTITION)
  guest.setAttribute('src', toDataUrl(code))
  return guest
}

/**
 * Puts the page up or takes it down, into whatever box a view built for it.
 * A repaint that changes nothing leaves the guest alone — rebuilding it would
 * reload the page mid-interaction — and emptying the box is the whole
 * teardown: a <webview> leaving the DOM takes its process with it.
 */
function drawPage (host, state, code) {
  if (!state.open) {
    host.replaceChildren()
    return false
  }
  if (!host.firstChild) host.append(buildGuest(code))
  return true
}

/**
 * The Run/Close button for one block, on runcode's own faces — the triangle
 * to run the page, the square to put it away. The state behind it is keyed
 * by the code, so the same block's button in the editing view and in the
 * reading view drive one page between them.
 */
export function htmlButtonUI (lang, code) {
  const state = stateFor(code)
  const button = runButton()

  const paint = painter(state, button, () => {
    drawRunFace(button, state.open,
      state.open ? 'Close the page' : 'Run this block as a page')
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
 * fence, hidden until the block is run — the code stays on screen above it,
 * because the editing view is where the source is the point.
 *
 * `onDraw` is how the editor hears that the panel changed height.
 */
export function htmlPanelUI (lang, code, className, onDraw) {
  const state = stateFor(code)
  const panel = el('div', className ? `run-out html-run ${className}` : 'run-out html-run')
  panel.setAttribute('role', 'group')
  panel.setAttribute('aria-label', 'HTML page')
  panel.hidden = true
  painter(state, panel, () => {
    panel.hidden = !drawPage(panel, state, code)
    onDraw?.()
  })()
  return panel
}

/**
 * The reading view's form: the sandboxed page is always up. This is
 * deliberately independent of editing view's Run/Close state: closing an
 * editor preview must not turn Reading view back into source.
 *
 * @param {HTMLElement} wrap  the .code-wrap holding the source
 * @param {HTMLElement} head  the .code-head the Run button belongs in
 */
export function attachHtmlRun (wrap, code) {
  const block = renderedBlock(wrap, 'html-page', { stage: false })
  block.figure.prepend(buildGuest(code))
  block.settle(true)
}
