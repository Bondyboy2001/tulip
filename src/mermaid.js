/* ============================================================== mermaid
   A ```mermaid block is a diagram, so both views draw it instead of showing
   the source — the same bargain the manim blocks strike, and for the same
   reason: what the block is *for* is the picture.

   Unlike manim, nothing is written to disk. A diagram is cheap enough to draw
   on demand (tens of milliseconds against manim's minutes), so there is no
   artefact to cache in the vault and no file beside the note. The results are
   held in memory only, keyed by the source and the palette, which is what
   keeps a note full of diagrams from re-laying-out on every keystroke.
   ================================================================== */

import { WidgetType } from '@codemirror/view'
import { StateEffect } from '@codemirror/state'
import { el, pictureBlock, pictureBlocks } from './blocks.js'
import { DRAWN } from './languages.js'

export function isMermaid (lang) {
  return String(lang || '').trim().toLowerCase() === DRAWN.mermaid
}

/* Mermaid is themed from the page's own custom properties, read at render
   time, so a diagram belongs to the palette the rest of the note is drawn in
   rather than shipping its own lavender-and-beige house style. */
function palette () {
  const css = getComputedStyle(document.documentElement)
  const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback
  return {
    ink: read('--ink', '#1A1815'),
    inkSoft: read('--ink-soft', '#443F39'),
    surface: read('--surface', '#FFFFFF'),
    sunk: read('--sunk', '#F3F0EA'),
    line: read('--line', '#E1DCD4'),
    accent: read('--accent', '#A63A5A'),
    stem: read('--stem', '#4F6B4B'),
    font: read('--font-ui', 'system-ui, sans-serif')
  }
}

/* One theme per palette, so a diagram drawn under Ink is not reused under
   Paper. The name of the current theme is the cheapest thing that changes
   whenever the colours do. */
const themeName = () => document.documentElement.dataset.theme || 'light'

/* Mermaid and its grammar are the better part of a megabyte, and a vault can
   go a long time without a diagram in it — so it is fetched when the first one
   is drawn rather than bundled into what every launch waits on. Loaded inside
   the render queue below, which is already the one place that serialises this. */
let mermaid = null
const loadMermaid = async () => (mermaid ??= (await import('mermaid')).default)

let configuredFor = null

function configure () {
  const key = themeName()
  if (configuredFor === key) return
  configuredFor = key
  const c = palette()

  mermaid.initialize({
    startOnLoad: false,
    // The diagrams come out of the user's own notes, but a note can arrive by
    // drag-and-drop or a sync client — strict keeps the generated markup
    // sanitised and refuses click-handlers written into the source.
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: c.font,
    fontSize: 13,
    flowchart: { curve: 'basis', useMaxWidth: true },
    sequence: { useMaxWidth: true },
    themeVariables: {
      background: 'transparent',
      primaryColor: c.sunk,
      primaryTextColor: c.ink,
      primaryBorderColor: c.line,
      secondaryColor: c.surface,
      tertiaryColor: c.surface,
      lineColor: c.inkSoft,
      textColor: c.ink,
      mainBkg: c.sunk,
      nodeBorder: c.line,
      clusterBkg: 'transparent',
      clusterBorder: c.line,
      titleColor: c.ink,
      edgeLabelBackground: c.surface,
      actorBkg: c.sunk,
      actorBorder: c.line,
      actorTextColor: c.ink,
      signalColor: c.inkSoft,
      signalTextColor: c.ink,
      labelBoxBkgColor: c.sunk,
      labelBoxBorderColor: c.line,
      noteBkgColor: c.surface,
      noteBorderColor: c.accent,
      noteTextColor: c.ink,
      pie1: c.accent,
      pie2: c.stem,
      pie3: c.inkSoft
    }
  })
}

/* Drawn diagrams, keyed by source and palette. Bounded: a vault worked in all
   day should not turn its diagrams into a leak. Failures are kept apart in a
   much smaller map — they exist so retyping the same broken source is not a
   fresh parse every frame, but they must not flush real diagrams out. */
const cache = new Map()
const CACHE_MAX = 120
const errors = new Map()
const ERRORS_MAX = 20

const keyFor = (code) => `${themeName()}\n${code}`
const settled = (key) => cache.get(key) || errors.get(key)

/* Mermaid measures by parking a copy in the document, so two renders running
   at once can read each other's node. They are queued instead. */
let queue = Promise.resolve()
let serial = 0

/* How long a never-seen source has to sit unchanged before it is parsed. */
const DEBOUNCE_MS = 300

/**
 * The SVG for a block, as markup.
 *
 * Never throws: a half-typed diagram is the normal state of an editor, so a
 * failure comes back as `{ error }` and is shown as a line of explanation
 * rather than taking the surrounding render down with it.
 *
 * @returns {Promise<{svg?: string, error?: string}>}
 */
function renderDiagram (code) {
  const hit = settled(keyFor(code))
  if (hit) return Promise.resolve(hit)

  queue = queue.then(async () => {
    /* The key is taken here, not when the job was queued: the palette can move
       while a job waits its turn, and a key read early would file a dark
       render under the light theme's name. Inside the job the key and the
       palette configure() reads cannot disagree. */
    const key = keyFor(code)
    const again = settled(key)
    if (again) return again

    let result
    try {
      await loadMermaid()
      configure()
      const { svg } = await mermaid.render(`tulip-mermaid-${++serial}`, code)
      result = { svg }
    } catch (err) {
      result = { error: String(err?.message || err).split('\n').slice(0, 6).join('\n') }
    }

    const store = result.error ? errors : cache
    const max = result.error ? ERRORS_MAX : CACHE_MAX
    store.set(key, result)
    if (store.size > max) store.delete(store.keys().next().value)
    return result
  })

  return queue
}

/* Dispatched when the palette moves. Nothing in the document has changed, so
   no ordinary update would tell the field to redraw — and a diagram left in
   the old theme's colours on a repainted page is the one thing that would
   give the whole arrangement away. */
export const refreshDiagrams = StateEffect.define()

/**
 * Fills a host element with the diagram, or with why there isn't one.
 * Shared by both views so a broken diagram reads the same in each.
 *
 * @returns {Promise<boolean>} whether there is a diagram to look at
 */
async function drawInto (host, code) {
  /* A source never seen before is, most of the time, a source still being
     typed — and every keystroke in a fence makes a new widget. So an unknown
     source waits a beat, and if the keystroke after it has already replaced
     this host, nothing is parsed at all: only the version that survives the
     pause pays for a layout, and the half-typed drafts never enter the cache.
     A source already drawn (or already refused) still lands immediately. */
  if (!settled(keyFor(code))) {
    await new Promise((resolve) => { setTimeout(resolve, DEBOUNCE_MS) })
    if (!host.isConnected) return false
  }

  const { svg, error } = await renderDiagram(code)
  if (!host.isConnected) return false
  host.replaceChildren()

  if (error) {
    host.classList.add('is-bad')
    host.append(el('pre', 'mermaid-error', error))
    return false
  }

  host.classList.remove('is-bad')
  // Parsed rather than assigned: mermaid has already sanitised the markup, and
  // a range keeps the <svg> a real element with its viewBox intact.
  const range = document.createRange()
  range.selectNodeContents(host)
  host.append(range.createContextualFragment(svg))
  return true
}

/* ------------------------------------------------------- reading view */

/**
 * Fits one `mermaid` block in Reading view.
 *
 * @param {HTMLElement} wrap  the .code-wrap holding the source
 * @param {string} code       the diagram's source
 */
export function attachMermaid (wrap, code) {
  const block = pictureBlock(wrap, 'diagram')
  drawInto(block.stage, code).then((drew) => {
    if (wrap.isConnected) block.settle(drew)
  })
}

/* ------------------------------------------------------- editing view */

/**
 * The same diagram, under the fence you are typing into.
 *
 * A StateField rather than a ViewPlugin: block widgets change line geometry,
 * and a plugin cannot be consulted before the viewport it would change has
 * been measured. Same rule the run controls and the title widget follow.
 */
class DiagramWidget extends WidgetType {
  constructor (code, theme) { super(); this.code = code; this.theme = theme }

  // Equal while the source and the palette are unchanged, so typing elsewhere
  // in the note maps the widget across rather than redrawing every diagram.
  eq (other) { return other.code === this.code && other.theme === this.theme }

  toDOM (view) {
    const host = document.createElement('div')
    host.className = 'cm-diagram'
    // Held at the last size until the new drawing lands, so the page does not
    // jump on every keystroke inside the block.
    //
    // The drawing arrives after the editor has measured the widget, and a
    // height it does not know about puts every line below the diagram out of
    // step with where it is drawn — so it is asked to measure again once the
    // picture is in. Same rule the embeds follow.
    drawInto(host, this.code)
      .then(() => view.requestMeasure())
      .catch(() => {})
    return host
  }

  ignoreEvent () { return true }
}

export const mermaidBlocks = pictureBlocks(
  isMermaid,
  (code) => new DiagramWidget(code, themeName()),
  // The palette moving changes nothing in the document, so no ordinary update
  // would tell the field to redraw — and a diagram left in the old theme's
  // colours on a repainted page is the one thing that would give the whole
  // arrangement away.
  { also: (tr) => tr.effects.some((e) => e.is(refreshDiagrams)) }
)
