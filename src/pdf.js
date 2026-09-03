/**
 * Reading a PDF, and marking it up.
 *
 * The vault's second kind of document. A note is text the editor owns outright;
 * a PDF is a fixed page nobody can edit, so everything here is about reading it
 * — laying the pages out, drawing them only where they can be seen, and keeping
 * the reader's highlights attached to the words rather than to the pixels.
 *
 * pdf.js does the parsing, in a worker. What this module adds is the part a
 * viewer library leaves to you: what a page *is* on screen (a canvas, a layer of
 * selectable text over it, and a layer of highlights under that), where a
 * highlight lives when the zoom changes, and how a selection becomes something
 * the copilot can be asked about.
 *
 * Highlights are stored as fractions of the page, never as pixels: `x: 0.12` is
 * twelve per cent across the page and stays there at any zoom, on any screen,
 * in a window of any width. The text under each one is stored beside its
 * rectangles — it is what the highlight list shows, what the copilot is given,
 * and the only part still legible if the geometry is ever wrong.
 */

/* The same stops the window's zoom and the View menu walk. A reader who sizes
   a page and then sizes the window expects the two to land together. */
import { ZOOM_STEPS, pinchFactor } from './zoom.js'
import { searchablePage, itemAtOffset, foldCase } from './pdf-search.js'
import { firstPageEndingAfter } from './pdf-window.js'
import { MARK_COLORS } from './pdf-colors.js'

/* pdf.js is the largest thing the app can load and most sessions never open a
   document, so it is fetched the first time one is opened rather than sitting
   in the bundle everything waits on. Every use of it is downstream of `open`,
   which awaits this — by the time a page renders or a text layer is built, the
   module is here. */
let pdfjsLib = /** @type {any} */ (null)

export async function loadPdfjs () {
  if (!pdfjsLib) {
    pdfjsLib = await import('pdfjs-dist/build/pdf.mjs')
    /* The worker is built beside the bundle by build.mjs. A relative URL
       resolves against the page, which is the only origin allowed to serve it
       one. Set here rather than at module scope because there is no module to
       set it on until now. */
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.js'
  }
  return pdfjsLib
}

/* Everything pdf.js loads on demand: glyphs for standard fonts a document names
   without embedding, character maps for CJK text, an ICC profile for CMYK, and
   the wasm image decoders. Copied into dist/pdfjs by the build. */
/* Served over the app's own scheme rather than as a path beside the bundle:
   pdf.js's worker is what fetches these, and a worker on a `file:` origin
   cannot fetch anything — see the protocol handler in electron/main.js. */
const dataUrl = (dir) => `tulip-file://app/pdfjs/${dir}/`

export const PDF_DATA = {
  standardFontDataUrl: dataUrl('standard_fonts'),
  cMapUrl: dataUrl('cmaps'),
  cMapPacked: true,
  iccUrl: dataUrl('iccs'),
  wasmUrl: dataUrl('wasm'),
  /* Fetched by the worker itself, from the app's own scheme. Handing the data
     over from the page instead — pdf.js's other mode — makes the worker wait on
     a reply from a transport that a document switch may already have taken
     away, which is one of the ways a document goes quiet for good. */
  useWorkerFetch: true
}

/** The pens. Named rather than given as colour values, so the palette is one
 *  edit in the stylesheet and a stored highlight keeps meaning what it said.
 *  Exported because the toolbar draws the same palette the popups do, and two
 *  lists of colours would be two lists to keep in step. */
const COLOR_IDS = new Set(MARK_COLORS.map((c) => c.id))
const DEFAULT_COLOR = 'yellow'

/* How far outside the viewport a page is still drawn. A page and a bit either
   way: enough that scrolling never reaches an empty page, small enough that a
   400-page document holds only a handful of canvases at once. */
/* The smallest a fit-to-width page is allowed to become: about a third of the
   page, which is still legible on a retina screen. */
const MIN_FIT = 0.35

const RENDER_MARGIN = 1.2

/* A canvas costs width × height × 4 bytes, so pages far from the fold give
   theirs back. Kept generously wider than the render margin — a reader
   scrolling up and down over the same three pages should not repaint. */
const KEEP_MARGIN = 3

/* The most a single page's bitmap may cost. Browsers refuse canvases past a
   size of their own choosing and answer with a blank one rather than an error,
   so the ceiling is ours to keep. Sixteen megapixels is an A4 page at 300% on a
   retina screen — past that the render is downscaled and CSS stretches it. */
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024

/* Drawn at the screen's own resolution and scaled down by CSS, or the text is
   soft on every display made in the last decade. Capped, because past three the
   bitmap costs more than the sharpness is worth. */
const MAX_DPR = 3

/* How many table-of-contents entries are worth listing. A real one is a few
   hundred at the very most; past this the document is using the outline as a
   database and no reader is scrolling it. It used to be four hundred and the
   entries beyond it were dropped without a word, which is the kind of silence
   that reads as a bug in the sidebar — so the ceiling is far higher now and
   reaching it is said out loud through `onError`. */
const MAX_OUTLINE = 5000

/* How wide a thumbnail is drawn, in CSS pixels. Wide enough that a figure or a
   chapter opening is recognisable at a glance, narrow enough that the whole
   rail costs less than one page of the document it is beside. */
const THUMB_WIDTH = 116

/* ------------------------------------------------------------ pure maths

   The parts of the viewer that are arithmetic rather than DOM, kept out here
   where they can be read — and tested — without a browser. Everything below
   takes numbers and returns numbers; nothing here touches pdf.js or the page.
   ================================================================== */

/**
 * A quarter turn, as a number of degrees pdf.js will accept.
 *
 * `rotation` in a viewport must be a whole multiple of ninety, and pdf.js
 * throws rather than rounding, so every route that turns the document — the
 * toolbar, a remembered turn read back from a previous session, a keystroke —
 * comes through here first.
 */
export const quarter = (deg) => ((Math.round(Number(deg) / 90) * 90) % 360 + 360) % 360

/**
 * The reader's place in the document, as a page and a fraction down it.
 *
 * A zoom used to be anchored on `scrollTop / scrollHeight` — the same fraction
 * of the whole document before and after. That is only the same place when
 * every page is the same height, and until a page has been visited its wrapper
 * is sized from page one's; a book with a fold-out plate, an appendix of
 * landscape tables, or simply pages that have not been reached yet therefore
 * drifted by whole pages while the reader zoomed. The page they are looking at
 * is the thing to hold still, so that is what is measured.
 */
export function placeIn (scrollTop, { top, height }) {
  return { into: height > 0 ? (scrollTop - top) / height : 0 }
}

/** And the scroll position that puts them back there at the new size. */
export function placeAt (place, { top, height }) {
  return Math.max(0, Math.round(top + (place?.into || 0) * height))
}

/**
 * Where a phrase sits along the line it was found on, in the page's own
 * coordinates.
 *
 * A hit is known to the text item it falls in, and an item is a run of glyphs
 * with one position and one width — so the words inside it are found by
 * proportion: an item forty characters wide that the hit starts ten characters
 * into starts a quarter of the way along it. That is an approximation, because
 * a proportional font's characters are not all one width, but it is an
 * approximation of a few glyphs rather than of the whole line, which is what
 * the full-width band it replaces was.
 *
 * A phrase running from one item into the next — which is most phrases, since a
 * PDF often emits one item per word — ends at the last item it touches, as long
 * as that item is on the same line. When it is not, the match has run over a
 * line break and the honest answer is the rest of the first line.
 *
 * @param items   the page's text items, each `{ at, span, x, w, y }`
 * @param at      where the hit starts, as an offset into the page's text
 * @param length  how long the hit is
 * @returns {{x:number,y:number,w:number}|null}  in PDF user space, or null when
 *          the item carries no geometry to answer from
 */
export function hitExtent (items, at, length) {
  const first = itemAtOffset(items, at)
  if (!first || typeof first.x !== 'number' || typeof first.w !== 'number') return null

  const along = (item, offset) => {
    if (!(item.span > 0)) return item.x
    const into = Math.max(0, Math.min(item.span, offset - item.at))
    return item.x + (item.w * into) / item.span
  }

  const from = along(first, at)
  const last = itemAtOffset(items, at + Math.max(1, length) - 1) || first
  const to = last === first || (last.y === first.y && typeof last.x === 'number')
    ? Math.max(from, along(last, at + length))
    : first.x + first.w

  return { x: from, y: first.y, w: Math.max(0, to - from) }
}

/**
 * A document's bookmarks, flattened into rows with their depth.
 *
 * Separated from the worker round-trips that used to be woven through it: this
 * is the whole of the tree-walking, and it answers immediately. What each entry
 * *points at* is resolved afterwards — see `contents` — because that was the
 * slow half, and doing it inline meant the toolbar had no page count until four
 * hundred serial round-trips had been made.
 *
 * @returns {{entries:Array, truncated:boolean}}
 */
export function flattenOutline (tree, max = MAX_OUTLINE) {
  const entries = []
  let truncated = false

  const walk = (items, level) => {
    for (const item of items) {
      if (entries.length >= max) { truncated = true; return }
      entries.push({
        title: item.title?.trim() || 'Untitled',
        level,
        /* Not known yet, and deliberately not zero: a page number of zero would
           read as a real answer to `markOutlinePlace`, which lights up the last
           entry at or before the page being read. Null says "ask me later". */
        page: null,
        /* Kept as the document wrote it: it names a point on the page, and the
           page number alone throws away the half of that answer the reader can
           see. Resolved in the background, and again at the click. */
        dest: item.dest ?? null
      })
      if (item.items?.length) walk(item.items, level + 1)
    }
  }
  walk(Array.isArray(tree) ? tree : [], 1)
  return { entries, truncated }
}

/**
 * One page, drawn to a canvas of its own at `scale`.
 *
 * Shared with the embedded viewer (src/pdfembed.js), which had its own copy and
 * had dropped the pixel budget from it — so a large-format page embedded in a
 * note asked the browser for a bitmap it refuses to allocate, and the embed
 * came back blank with no error to explain it.
 *
 * @param settle  wraps the render's promise, for a caller that wants a timeout
 *                on it; the tab does, an embed does not
 * @param turn    a quarter-turn the reader has asked for, on top of whatever
 *                rotation the page itself carries. pdf.js's `rotation` is
 *                absolute — it replaces the page's own — so the two are added
 *                here rather than handed over as one; a caller that passes
 *                nothing gets exactly the page as its publisher set it.
 */
export async function renderPageToCanvas (proxy, scale, { settle = (p) => p, turn = 0 } = {}) {
  const viewport = proxy.getViewport({ scale, rotation: proxy.rotate + turn })
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
  /* Never beyond what a canvas can hold: a retina screen at 300% would
     otherwise ask for a bitmap the browser refuses to allocate, and answers
     with a blank one rather than an error. Past the ceiling the render is
     downscaled and CSS stretches it. */
  const area = viewport.width * viewport.height * dpr * dpr
  const ratio = area > MAX_CANVAS_PIXELS ? dpr * Math.sqrt(MAX_CANVAS_PIXELS / area) : dpr

  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width * ratio)
  canvas.height = Math.floor(viewport.height * ratio)

  await settle(proxy.render({
    canvasContext: canvas.getContext('2d', { alpha: false }),
    viewport,
    transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0]
  }).promise)

  return { canvas, viewport }
}

/* How long a single page may take before it is treated as never coming. Well
   past what a dense page costs even on a slow machine, because the price of
   being wrong is re-parsing a document the reader is in the middle of. */
const RENDER_TIMEOUT = 12000

/* How long after a gesture's last frame the document is taken to have stopped
   moving, and so is worth rasterising sharply again. Shared by the two gestures
   that change the scale continuously — a pinch and a panel edge being dragged —
   because it is answering the same question for both: has the reader finished?
   Long enough not to fire mid-gesture between two unhurried mouse moves, short
   enough that letting go and getting a sharp page reads as one action. */
const SETTLE_MS = 140

/* Plays a one-shot animation again on an element that is already wearing it.
   Removing the class and adding it back in the same task is not enough — the
   browser coalesces the two and nothing happens — so the layout read in between
   is what makes it a restart rather than a no-op. */
const restart = (node, className) => {
  node.classList.remove(className)
  void node.offsetWidth
  node.classList.add(className)
}

const uid = () => `h${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

/* The records the viewer keeps, named for the checker. They are shapes the
   code already had — writing them down is what lets a typo in a property name
   be a build failure instead of a page that quietly never draws. */
/**
 * @typedef {{width:number, height:number}} Unit
 * @typedef {{n:number, wrap:HTMLDivElement, canvas:HTMLCanvasElement,
 *   marks:HTMLDivElement, text:HTMLDivElement, links:HTMLDivElement,
 *   unit:Unit|null, proxy:any, drawn:number, layer:any, hasText:boolean,
 *   hasLinks:boolean, failed:number, gen:number}} PageBox
 * @typedef {{page:number, x:number, y:number, w:number, h:number}} MarkRect
 * @typedef {{id:string, color:string, text:string, rects:MarkRect[], at:string}} Mark
 * @typedef {{page:number, at:number, length:number, y:number, x?:number, w?:number}} Hit
 * @typedef {{title:string, level:number, page:number|null, dest:any}} OutlineEntry
 * @typedef {{label:string, undo:()=>void, redo:()=>void}} HistoryEntry
 * @typedef {{n:number, el:HTMLButtonElement, canvas:HTMLCanvasElement,
 *   drawn:boolean, near:boolean, gen:number}} ThumbRow
 */

/**
 * @param {object} o
 * @param {HTMLElement} o.host    the scrolling element the pages go in
 * @param {any} o.api             the preload bridge
 * @param {(info:object)=>void} o.onDoc     told once a document is open, and
 *        again when its table of contents is ready — which is later, because
 *        resolving a textbook's outline is hundreds of worker round-trips and
 *        the pages do not wait for them
 * @param {(page:number)=>void} o.onPage    told which page is being read
 * @param {()=>void} o.onMarks              told when the highlight set changes
 * @param {()=>void} o.onZoom               told when the viewer zooms itself
 * @param {()=>void} o.onStuck              the document stopped answering
 * @param {(quote:object)=>void} o.onAsk    the reader wants the copilot
 * @param {()=>void} o.onTool               told when the tool or the pen changes
 * @param {(message:string)=>void} o.onError  something failed that the reader
 *                                            would otherwise learn from a lost
 *                                            highlight much later
 * @param {boolean} o.selectionMenu  whether selecting text offers PDF actions
 */
export function mountPdf ({
  host, api,
  onDoc = () => {}, onPage = () => {}, onMarks = () => {}, onZoom = () => {},
  onStuck = () => {}, onAsk = () => {}, onTool = () => {}, onError = () => {},
  selectionMenu = true
}) {
  const state = {
    path: '',
    doc: /** @type {any} */ (null),
    /* The loading task the document came out of, kept because it is the only
       thing that can take the document away again: a document proxy has no
       `destroy` of its own, and destroying the task takes the document, its
       worker and the buffer with it. Same reasoning as src/pdf-text.js. */
    loading: /** @type {any} */ (null),
    pages: /** @type {PageBox[]} */ ([]),   // one entry per page, in order
    scale: 1,           // what pages are currently drawn at
    /* How the page is sized: one of the three fits, or a number from
       ZOOM_STEPS. 'fit' is fit-to-width and is the resting state; 'page' fits
       the whole sheet in the window, which is how you read a slide deck or
       check a layout; 'height' fits its height and lets a wide page run off
       the side, which is how you read a two-column paper one column at a time. */
    zoom: /** @type {'fit'|'page'|'height'|number} */ ('fit'),
    base: /** @type {Unit|null} */ (null),  // page 1's unscaled size, the layout's yardstick
    /* A quarter turn the reader has asked for, on top of whatever rotation the
       pages already carry — for the scanned book bound sideways, and for the
       landscape plate in the middle of a portrait one. Kept per document in
       `turns` below, because it is a fact about that file rather than a mood. */
    turn: 0,
    /* The table of contents, once it is known. Held here as well as handed to
       the host because `goToOutline` may be given an entry whose destination
       has not been resolved yet, and because the outline arrives after the
       document does. */
    outline: /** @type {OutlineEntry[]} */ ([]),
    marks: /** @type {Mark[]} */ ([]),
    at: 1,              // the page being read
    /* What a selection means. With the arrow, selecting text offers to do
       something with it; with the highlighter, selecting text *is* the doing —
       the mark is drawn the moment the mouse comes up, in the pen below.
       Neither is reset when a document closes: a reader who picked up the
       highlighter picked it up for the afternoon, not for one file. */
    tool: 'select',     // 'select' or 'mark'
    pen: DEFAULT_COLOR,
    /* Every change to the highlights, and how to take it back. Kept per
       document — a stack that outlived the file it described would offer to
       undo a highlight into a PDF that no longer has it. */
    past: /** @type {HistoryEntry[]} */ ([]),
    future: /** @type {HistoryEntry[]} */ ([]),
    /* The last thing selected, kept after the selection itself is gone: asking
       the copilot means clicking into the message box, which clears it. */
    quote: /** @type {{text:string, page:number}|null} */ (null),
    /* A highlight the reader jumped to before its page had been drawn: the id
       waits here for `paintMarks` to put the mark on screen, and the flash
       fires then. Cleared once fired, or when they navigate somewhere else. */
    flashing: /** @type {string|null} */ (null),
    /* Bumped on every open. An await that resolves after the reader has moved
       on belongs to a document that is no longer on screen, and every one of
       them checks this before touching the DOM. */
    epoch: 0,
    saveTimer: /** @type {any} */ (null),
    /* Rendering is strictly serial. `queue` is the pages worth drawing, nearest
       the fold first, and `drawing` is the one in flight — the two together are
       the whole scheduler. */
    queue: /** @type {PageBox[]} */ ([]),
    /* The thumbnails worth drawing, behind the pages. The same one-at-a-time
       discipline covers both — a thumbnail is a render of the same document,
       and two renders in flight is the thing that wedges pdf.js — so the rail
       is filled from `pump` rather than from a queue of its own. */
    thumbQueue: /** @type {ThumbRow[]} */ ([]),
    drawing: /** @type {PageBox|ThumbRow|null} */ (null),
    inFlight: /** @type {Promise<void>|null} */ (null),  // that render's promise, so a close can wait on it
    stuck: false,       // a render went quiet; the document needs parsing again
    recovering: false,
    recoveries: 0,
    /* The last set of hits `find` reported, so `markHit` can recognise the one
       it is being pointed at and box the words rather than the whole line. */
    hits: /** @type {Hit[]} */ ([])
  }

  /* What each document was last turned to, by path. Remembered the way the
     zoom is — for as long as the app is open, rather than in a file — so that
     flipping between a sideways scan and a note and back does not mean turning
     it again, while nothing is written to the vault over a way of looking. */
  const turns = new Map()

  /* The night toggle, on the other hand, is a reader's preference rather than
     a fact about one file, so it outlives the session. Deliberately off by
     default: a PDF is a picture of a page, inverting it is a lie about what the
     document says, and the app's own TeX output is white-on-black under it. */
  const NIGHT_KEY = 'tulip.pdf.night'
  const THUMBS_KEY = 'tulip.pdf.thumbs'
  const remembered = (key) => {
    try { return localStorage.getItem(key) === '1' } catch { return false }
  }
  const remember = (key, on) => {
    try { localStorage.setItem(key, on ? '1' : '0') } catch { /* private mode */ }
  }

  /* The pages live in a sheet of their own inside the scroller, so the popups
     can be positioned against the scroller without the page flow moving them. */
  const sheet = document.createElement('div')
  sheet.className = 'pdf-sheet'
  host.replaceChildren(sheet)
  // Only pages in this bounded set need eviction checks. Walking every wrapper
  // on every scroll defeats the canvas window on long documents.
  const drawnPages = new Set()

  /* ---------------------------------------------------------- the thumbnails

     A rail of small pages down the left edge, for the reader who navigates a
     document by what it looks like — the page with the big figure, the one
     where the columns give way to a table — rather than by number or by
     heading. Off by default and remembered once switched on, because it costs
     screen and it costs renders, and a reader who wants it wants it always.

     The anchor is a zero-size sticky element at the top of the scroller: it
     takes no room in the page flow, and sticking keeps the rail pinned while
     the document scrolls under it. The rail's height cannot be a percentage —
     inside a zero-height box every percentage is zero — so the resize observer
     below writes the scroller's own height into a variable the stylesheet
     reads. */
  const thumbsBox = document.createElement('div')
  thumbsBox.className = 'pdf-thumbs'
  thumbsBox.hidden = true
  const rail = document.createElement('div')
  rail.className = 'pdf-thumbs-rail'
  thumbsBox.append(rail)
  host.prepend(thumbsBox)

  /* One row per page: `{ n, el, canvas, drawn, near, gen }`. `near` is kept by
     the observer below, so deciding what to draw never has to measure the rail
     row by row — which is the same layout-thrash trap the page window solved
     with arithmetic, solved here with the observer the pages could not use
     (the pages' pass also has to *evict*, and here the observer's exits are
     exactly the evictions). */
  let thumbRows = /** @type {ThumbRow[]} */ ([])
  let thumbsOn = remembered(THUMBS_KEY)

  const thumbWatcher = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const row = thumbRows[Number(entry.target.getAttribute('data-page')) - 1]
      if (!row) continue
      row.near = entry.isIntersecting
      /* A thumbnail scrolled well out of the rail gives its bitmap back, like
         a page scrolled out of the window: a nine-hundred-page rail fully
         rendered is a quarter of a gigabyte of canvases nobody is looking at. */
      if (!row.near && row.drawn) {
        row.gen++
        row.canvas.width = row.canvas.height = 0
        row.drawn = false
        row.el.classList.remove('is-drawn')
      }
    }
    queueThumbs()
  }, { root: rail, rootMargin: '360px 0px' })

  /** The rows near the rail's own fold that still need drawing, into the
   *  low-priority half of the render queue. */
  function queueThumbs () {
    if (!thumbsOn || !state.doc) return
    state.thumbQueue = thumbRows.filter((row) => row.near && !row.drawn)
    pump()
  }

  /** Fresh rows for a newly opened document — or for the toggle arriving after
   *  one is already open. */
  function buildThumbs () {
    thumbWatcher.disconnect()
    thumbRows = []
    rail.replaceChildren()
    host.classList.toggle('has-thumbs', thumbsOn && !!state.doc)
    thumbsBox.hidden = !thumbsOn || !state.doc
    if (thumbsBox.hidden) { state.thumbQueue = []; return }

    const ratio = state.base ? state.base.height / state.base.width : Math.SQRT2
    const frag = document.createDocumentFragment()
    for (let n = 1; n <= state.pages.length; n++) {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'pdf-thumb'
      el.dataset.page = String(n)
      el.title = `Page ${n}`

      const canvas = document.createElement('canvas')
      canvas.className = 'pdf-thumb-canvas'
      /* Sized from page one's shape until drawn, like the pages themselves,
         so the rail's scroll bar means the same thing before and after. */
      canvas.style.width = `${THUMB_WIDTH}px`
      canvas.style.height = `${Math.round(THUMB_WIDTH * ratio)}px`

      const number = document.createElement('span')
      number.className = 'pdf-thumb-number'
      number.textContent = String(n)

      el.append(canvas, number)
      el.addEventListener('click', () => goToPage(n))
      frag.append(el)
      thumbRows.push({ n, el, canvas, drawn: false, near: false, gen: 0 })
      thumbWatcher.observe(el)
    }
    rail.append(frag)
    paintThumbPlace()
  }

  /** The rail saying which page is being read, and keeping it in sight. */
  function paintThumbPlace () {
    if (thumbsBox.hidden) return
    for (const row of thumbRows) row.el.classList.toggle('is-here', row.n === state.at)
    thumbRows[state.at - 1]?.el.scrollIntoView({ block: 'nearest' })
  }

  /**
   * One thumbnail's bitmap. Only ever called by `pump`, after the pages
   * themselves — a thumbnail is a render of the same document, and two renders
   * in flight on one document is the thing that wedges pdf.js, so the rail
   * shares the pages' serial queue rather than running one of its own.
   */
  async function drawThumb (row) {
    const epoch = state.epoch
    const gen = ++row.gen
    const stale = () => epoch !== state.epoch || gen !== row.gen || !thumbsOn

    try {
      const page = state.pages[row.n - 1]
      if (!page) return
      if (!page.proxy) page.proxy = await watch(state.doc.getPage(row.n))
      if (stale()) return
      if (!page.unit) { page.unit = unitOf(page.proxy); size(page) }

      const scale = THUMB_WIDTH / page.unit.width
      const { canvas, viewport } = await renderPageToCanvas(page.proxy, scale, { settle: watch, turn: state.turn })
      if (stale()) { canvas.width = canvas.height = 0; return }

      canvas.className = 'pdf-thumb-canvas'
      canvas.style.width = `${Math.round(viewport.width)}px`
      canvas.style.height = `${Math.round(viewport.height)}px`
      const old = row.canvas
      old.replaceWith(canvas)
      // Freed by hand, not left to GC — same reasoning as the pages' swap.
      old.width = old.height = 0
      row.canvas = canvas
      row.drawn = true
      row.el.classList.add('is-drawn')
    } catch (err) {
      if (err === STUCK) { state.stuck = true; return }
      /* A page whose thumbnail will not draw is left blank; the rail is an
         index, and a hole in it costs nothing the page itself has not already
         said by failing. Marked drawn so it is not retried on every scroll. */
      if (!stale()) row.drawn = true
    }
  }

  /* Whether the pages are shown inverted for reading in the dark. A reader's
     preference rather than a fact about one file, so it is remembered across
     documents and sessions — and off by default, deliberately: a PDF is a
     picture of a page, and the TeX preview's output in particular is designed
     against white. */
  let nightOn = remembered(NIGHT_KEY)
  host.classList.toggle('is-night', nightOn)

  /* ------------------------------------------------------------- geometry */

  /* The three ways of sizing a page against the window, as opposed to the
     numbered stops. Named as a set because four places have to ask "is the
     document following the window?" and each of them used to spell out a
     comparison against the one mode that existed. */
  const FITS = new Set(/** @type {any[]} */ (['fit', 'page', 'height']))

  /** A page's size at scale 1, as the reader is currently looking at it — which
   *  is the page's own viewport turned by however far they have turned it. */
  const unitOf = (proxy) => {
    const view = proxy.getViewport({ scale: 1, rotation: proxy.rotate + state.turn })
    return { width: view.width, height: view.height }
  }

  /** The same size after a further quarter turn, without asking the worker: a
   *  turn of ninety or two hundred and seventy swaps the two, and anything else
   *  leaves them alone. Used when the reader turns a document that is already
   *  laid out, so the wrappers take their new shape on the same frame. */
  const swap = (unit, by) => (by % 180 === 0
    ? { width: unit.width, height: unit.height }
    : { width: unit.height, height: unit.width })

  /**
   * Fit is edge-to-edge: the sheet gives up its gutter so the page meets the
   * window on both sides, which is what the stylesheet's `is-fit` does. Set
   * before any scale is worked out, because `scaleFor` reads that gutter back.
   */
  function markFit () {
    /* Edge-to-edge belongs to fit-to-width alone. The other two fits leave the
       page smaller than the window in one direction or the other, so the
       gutter, the drop shadow and the number in the margin all still have
       somewhere to be — taking them away would put a fitted page in a corner
       of an empty grey field. */
    host.classList.toggle('is-fit', state.zoom === 'fit')
    host.dataset.fit = FITS.has(state.zoom) ? String(state.zoom) : ''
  }

  /** The scale a page is drawn at: one of the three fits, or the chosen step. */
  function scaleFor () {
    if (!state.base) return 1
    if (!FITS.has(state.zoom)) return /** @type {number} */ (state.zoom)
    // The gutter around the page is the stylesheet's, read back rather than
    // duplicated here, so the page cannot be drawn wider than its own margin.
    const style = getComputedStyle(sheet)
    const sides = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    const ends = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    /* Floored to a whole pixel: the page's width is rounded when it is laid
       out, and a fit that came to a fraction over the window would round up
       into a scroll bar the reader never asked for. */
    const wide = Math.floor(host.clientWidth - sides) / state.base.width
    /* Fitting the height means the whole sheet has to sit between the two pages
       either side of it, so the gap counts against the room as well —
       otherwise "fit the page" leaves a sliver of the next one showing, which
       is exactly the thing the mode exists to avoid. */
    const gap = parseFloat(style.rowGap) || 0
    const tall = Math.floor(host.clientHeight - ends - gap) / state.base.height
    const room = state.zoom === 'fit' ? wide
      : state.zoom === 'height' ? tall
        : Math.min(wide, tall)
    /* Floored: with the sidebar, the outline and the copilot all open there
       may be two hundred pixels left, and a page shrunk to fit that is not a
       page anyone can read. Below the floor the sheet scrolls sideways instead. */
    return Math.max(MIN_FIT, Math.min(4, room))
  }

  /** A page's box on screen, which is also the frame highlights are placed in. */
  const pageBox = (page) => page.wrap.getBoundingClientRect()

  /* --------------------------------------------------------------- layout */

  /**
   * One wrapper per page, sized before anything is drawn.
   *
   * Sized from page 1, because asking the worker for all 400 pages just to know
   * how tall the document is would stall the first paint. A page that turns out
   * to be a different shape corrects its own wrapper when it renders, which is
   * the moment its true size is first known.
   */
  function layOut (attach = false) {
    const frag = attach ? document.createDocumentFragment() : null

    for (const page of state.pages) {
      size(page)
      if (frag) frag.append(page.wrap)
    }
    if (frag) sheet.append(frag)
  }

  /**
   * A page's box, and its canvas, at the current scale.
   *
   * The canvas keeps whatever it has drawn and is stretched to the new size by
   * CSS, so a zoom is visible on the same frame it is asked for — the sharp
   * bitmap follows a moment later, from the render queue. The text layer needs
   * nothing: pdf.js positions its spans in per cent and sizes them from
   * `--total-scale-factor`, so it is already correct at any scale.
   */
  function size (page) {
    const unit = page.unit || state.base
    const width = Math.round(unit.width * state.scale)
    const height = Math.round(unit.height * state.scale)

    page.wrap.style.width = `${width}px`
    page.wrap.style.height = `${height}px`
    page.wrap.style.setProperty('--total-scale-factor', String(state.scale))
    page.canvas.style.width = `${width}px`
    page.canvas.style.height = `${height}px`
  }

  /** Fresh wrappers for a newly opened document. */
  function build (count) {
    state.pages = []
    drawnPages.clear()
    sheet.replaceChildren()

    for (let n = 1; n <= count; n++) {
      const wrap = document.createElement('div')
      wrap.className = 'pdf-page'
      wrap.dataset.page = String(n)
      /* pdf.js positions text spans in units of these, and rounds page
         dimensions to whole device pixels through the round() stops. */
      wrap.style.setProperty('--scale-round-x', '1px')
      wrap.style.setProperty('--scale-round-y', '1px')

      const canvas = document.createElement('canvas')
      canvas.className = 'pdf-canvas'

      const marks = document.createElement('div')
      marks.className = 'pdf-marks'

      const text = document.createElement('div')
      text.className = 'textLayer'

      /* Above the text rather than under it, which is the order pdf.js's own
         viewer uses and the only order in which a link can be clicked: the
         text layer covers the words, and the words are what a link is drawn
         over. The cost is that a run of text inside a link cannot be selected,
         which is the same trade every PDF viewer makes. */
      const links = document.createElement('div')
      links.className = 'pdf-links'

      const number = document.createElement('span')
      number.className = 'pdf-page-number'
      number.textContent = String(n)

      wrap.append(canvas, marks, text, links, number)
      state.pages.push({
        n, wrap, canvas, marks, text, links,
        unit: null,      // the page's size at scale 1, once it is known
        proxy: null,
        drawn: 0,        // the scale the canvas holds, 0 when it holds nothing
        layer: null,     // the text layer, held so its stream can be closed
        hasText: false,  // whether the text layer is built; it needs no rebuild
        hasLinks: false, // and whether its annotations have been placed
        failed: 0,       // a scale this page could not be drawn at
        /* Bumped whenever a draw of this page is abandoned. A cancelled render
           settles a moment after the one replacing it has already started, and
           without a generation to check it against, the loser of that race gets
           to write the winner's state — which is how a zoom used to leave a
           page drawn at one scale and selectable at another. */
        gen: 0
      })
    }
    layOut(true)
  }

  /* -------------------------------------------------------------- drawing */

  /**
   * Draws a page's canvas and lays its selectable text over it.
   *
   * Only ever called by the queue, and only ever one at a time — see `pump`.
   * A render in flight is also never cancelled: pdf.js does not recover from
   * `RenderTask.cancel()`, and a document it has been cancelled on renders
   * nothing ever again, on any page or canvas, with promises that simply never
   * settle. A zoom that lands mid-render therefore lets that render finish,
   * ignores its result — the generation it started in has passed — and draws
   * again afterwards.
   *
   * Everything is checked against that generation. The question is never "has
   * this finished" but "is this still the draw anyone is waiting for".
   */
  async function draw (page) {
    const epoch = state.epoch
    const scale = state.scale
    const gen = ++page.gen
    const stale = () => epoch !== state.epoch || gen !== page.gen

    try {
      // Watched like the render below: fetching the page is the first thing a
      // wedged worker stops answering, and unwatched it would hang `draw` —
      // and with it the whole queue — forever, with no recovery to follow.
      if (!page.proxy) page.proxy = await watch(state.doc.getPage(page.n))
      if (stale()) return

      /* The page's true size, learnt here and kept: the layout was working from
         page 1's until now, and a document whose pages differ — a fold-out plate
         in the middle of a book — corrects itself as those pages are reached. */
      if (!page.unit) {
        page.unit = unitOf(page.proxy)
        size(page)
      }

      // `watch` is the per-page timeout: a render that never comes back would
      // otherwise leave the reader on a page that stays blank forever.
      const { canvas, viewport } = await renderPageToCanvas(page.proxy, scale, { settle: watch, turn: state.turn })
      if (stale()) return

      /* Drawn off-screen and swapped in, so the page never shows a half-painted
         canvas or a blank one: what is on screen goes on being the old bitmap,
         stretched, until the moment there is a better one. */
      canvas.className = 'pdf-canvas'
      const old = page.canvas
      old.replaceWith(canvas)
      page.canvas = canvas
      /* And the bitmap behind it given up by hand, exactly as `undraw` does.
         Dropping the last reference to a canvas is not the same as freeing it:
         Chromium reclaims the backing store when it next gets round to it, and
         a fast scroll at three hundred per cent on a retina screen replaces
         sixteen megapixels a page faster than that happens. Sized to nothing
         first, the memory is gone before the next page asks for its own. */
      old.width = old.height = 0
      page.drawn = scale
      drawnPages.add(page)
      state.recoveries = 0
      size(page)
      page.wrap.classList.add('is-drawn')

      await layText(page, viewport, stale)
      if (stale()) return
      paintMarks(page)
      await layLinks(page, viewport, stale)
    } catch (err) {
      if (err === STUCK) { state.stuck = true; return }
      /* A page that will not render. Marked against the scale it failed at, so
         it is not attempted again on every scroll — but a zoom is a new attempt,
         which is the one thing that ever fixes a page pdf.js choked on. */
      if (!stale()) page.failed = scale
    }
  }

  /**
   * A render that never answers.
   *
   * pdf.js in this app has a way of going quiet: a document whose worker has
   * been left in a bad state stops settling its render promises altogether —
   * no error, no result, and every later page waits behind it. Nothing can be
   * asked of the document at that point, so the only way back is to throw it
   * away and parse it again, which `recover` does.
   */
  const STUCK = Symbol('stuck')

  function watch (promise) {
    let timer = /** @type {any} */ (null)
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(STUCK), RENDER_TIMEOUT) })
    ])
  }

  /**
   * Parses the document again, in place.
   *
   * The reader keeps their page, their zoom and their highlights: only the
   * pdf.js side of it is rebuilt. Bounded, because a document that goes quiet
   * twice in a row is not one more attempt away from working.
   */
  async function recover () {
    state.stuck = false
    if (state.recovering || !state.doc) return
    if (state.recoveries >= 2) { onStuck(); return }

    state.recovering = true
    state.recoveries++
    const path = state.path
    const place = { page: state.at, top: host.scrollTop }
    const zoom = state.zoom
    try {
      await close()
      state.zoom = zoom
      await open(path, place)
    } catch {
      onStuck()
    } finally {
      state.recovering = false
    }
  }

  /**
   * The layer that makes a picture of words selectable.
   *
   * Built once per page and then left alone through every zoom: pdf.js places
   * each span in per cent of the page and sizes it from `--total-scale-factor`,
   * so the layer a page was given at one scale is already right at the next.
   */
  async function layText (page, viewport, stale) {
    if (page.hasText) return
    dropText(page)
    try {
      const layer = new pdfjsLib.TextLayer({
        textContentSource: page.proxy.streamTextContent({ includeMarkedContent: true }),
        container: page.text,
        viewport
      })
      page.layer = layer
      await watch(layer.render())
      if (stale()) return
      page.hasText = true
    } catch (err) {
      // STUCK is the watchdog's, and means the worker — not this layer — has
      // gone quiet. It goes up to `draw`, whose catch turns it into a recovery.
      if (err === STUCK) throw err
      page.hasText = false
    }
  }

  /**
   * Lets go of a page's text layer, and of the stream feeding it.
   *
   * The stream is the part that matters. A text layer abandoned without being
   * cancelled leaves a reader open on the worker's side, and a worker with an
   * abandoned reader stops answering — not for that page, for the whole
   * document. Every route that clears a text layer comes through here.
   */
  function dropText (page) {
    page.layer?.cancel()
    page.layer = null
    page.text.replaceChildren()
    page.hasText = false
  }

  /* ------------------------------------------------------------- the links

     A PDF is not only a picture of a page: it carries its own cross-references
     — the entry in a table of contents, the "see section 4.2", the citation
     that points at a URL — and until now none of them were clickable, because
     the only thing over the canvas was the text layer. A reader following a
     reference had to read the number off the page and type it into the page
     box, which is the sort of thing that makes a document feel like a picture
     of a document.

     pdf.js ships an AnnotationLayer that would do this, and it is not used
     here. It wants a `linkService` with a dozen methods, an annotation storage,
     a scripting host and a stylesheet of its own — all of which exist to
     support form fields, popups and embedded JavaScript that this app has no
     intention of running. What is actually wanted is the link rectangles, and
     `getAnnotations` hands those over directly.

     Placed in fractions of the page, like the highlights and for the same
     reason: a zoom then needs no redraw, and a turn is already in the viewport
     the fractions were worked out through. */

  /** One annotation's rectangle as fractions of the page, or null if it is
   *  degenerate. The two corners are converted separately and then sorted,
   *  because a PDF rectangle names opposite corners in either order and the
   *  page's own rotation may have swapped them again. */
  function boxOf (rect, viewport) {
    if (!Array.isArray(rect) || rect.length < 4) return null
    const a = viewport.convertToViewportPoint(rect[0], rect[1])
    const b = viewport.convertToViewportPoint(rect[2], rect[3])
    const left = Math.min(a[0], b[0])
    const top = Math.min(a[1], b[1])
    const width = Math.abs(b[0] - a[0])
    const height = Math.abs(b[1] - a[1])
    if (width < 1 || height < 1) return null
    return {
      x: clamp01(left / viewport.width),
      y: clamp01(top / viewport.height),
      w: clamp01(width / viewport.width),
      h: clamp01(height / viewport.height)
    }
  }

  /* Only the schemes a document has any business sending a reader to. A PDF is
     a file from outside the vault, and `file:` — or anything more exotic — in
     an annotation is a request to open something on this machine that nobody
     asked to open. */
  const SAFE_LINK = /^(?:https?|mailto):/i

  async function layLinks (page, viewport, stale) {
    if (page.hasLinks) return
    let annotations
    try {
      annotations = await watch(page.proxy.getAnnotations({ intent: 'display' }))
    } catch (err) {
      // STUCK is the worker having gone quiet, which is `draw`'s to recover
      // from; anything else is a page whose annotations cannot be read, and a
      // page without links is still a page.
      if (err === STUCK) throw err
      return
    }
    if (stale()) return

    const frag = document.createDocumentFragment()
    for (const data of annotations) {
      if (data?.subtype !== 'Link') continue
      const url = typeof data.url === 'string' && SAFE_LINK.test(data.url) ? data.url : ''
      const dest = data.dest ?? null
      if (!url && !dest) continue
      const box = boxOf(data.rect, viewport)
      if (!box) continue

      const link = document.createElement('a')
      link.className = `pdf-link${url ? ' is-away' : ''}`
      link.style.left = `${box.x * 100}%`
      link.style.top = `${box.y * 100}%`
      link.style.width = `${box.w * 100}%`
      link.style.height = `${box.h * 100}%`
      /* The address is on the element as well as in the handler, so hovering a
         citation says where it goes and the browser's own focus ring and tab
         order come for free. A destination inside the document has no address
         to show, so it says which page instead — resolved lazily, at the hover,
         for the same reason the outline's are. */
      if (url) {
        link.href = url
        link.title = url
        link.rel = 'noreferrer'
      } else {
        link.href = '#'
        link.title = 'Go to this reference'
      }
      link.addEventListener('click', (event) => {
        /* Always: this is a page inside the app, and letting a click navigate
           the window away from it — even to a URL main would intercept — is
           not something to leave to a guard further down. */
        event.preventDefault()
        if (url) api.openExternal?.(url)
        else goToDest(dest)
      })
      frag.append(link)
    }
    page.links.replaceChildren(frag)
    page.hasLinks = true
  }

  /** Lets go of a page's links. Cheap, and unlike the text layer there is
   *  nothing on the worker's side waiting on them. */
  function dropLinks (page) {
    page.links.replaceChildren()
    page.hasLinks = false
  }

  /** Gives back the canvas of a page nobody is near. */
  function undraw (page) {
    // Left alone while it is drawing: resizing the canvas under a live render
    // would be the same mistake as cancelling it. The refresh that follows will
    // find the page far away and free it then.
    if (page === state.drawing) return
    drawnPages.delete(page)
    page.gen++
    if (page.drawn) {
      page.canvas.width = page.canvas.height = 0
      page.drawn = 0
      size(page)
    }
    dropText(page)
    dropLinks(page)
    page.wrap.classList.remove('is-drawn')
    /* `proxy.cleanup()` belongs here and is deliberately not called: pdf.js
       throws its page caches away from under whatever is still settling, and a
       document cleaned up while a text stream was closing is one of the ways it
       goes quiet. The canvas — which is the memory that matters — is freed
       above, and the rest goes with the document. */
  }

  /**
   * Which pages are worth drawing, from where the reader is.
   *
   * Runs on scroll, on zoom, and on resize — everything that can change what is
   * visible — rather than through an IntersectionObserver per page, because the
   * same pass also has to decide which pages to *stop* holding, and that is one
   * comparison against the same numbers.
   */
  function refresh () {
    if (!state.doc) return
    const top = host.scrollTop
    const height = host.clientHeight
    const middle = top + height / 2
    const near = { from: top - height * RENDER_MARGIN, to: top + height * (1 + RENDER_MARGIN) }
    const keep = { from: top - height * KEEP_MARGIN, to: top + height * (1 + KEEP_MARGIN) }

    let reading = state.at
    let bestOverlap = 0
    const wanted = []

    /* Wrapper positions are ordered. Find the first page whose bottom reaches
       the render band, then read geometry only until that band ends. Mixed page
       sizes remain correct because the binary search uses each wrapper's real
       measured bottom rather than an estimated page height. */
    const lo = firstPageEndingAfter(state.pages.length, near.from, (index) => {
      const wrap = state.pages[index].wrap
      return { from: wrap.offsetTop, to: wrap.offsetTop + wrap.offsetHeight }
    })

    for (let at = lo; at < state.pages.length; at++) {
      const page = state.pages[at]
      const from = page.wrap.offsetTop
      if (from >= near.to) break
      const to = from + page.wrap.offsetHeight

      if (to > near.from && from < near.to) {
        if (page.drawn !== state.scale && page.failed !== state.scale) {
          // Sorted below by how far the page is from the middle of the screen,
          // so the reader always gets what they are looking at first.
          wanted.push({ page, distance: Math.abs((from + to) / 2 - middle) })
        }
      }
      /* The page being read is the one showing most of itself, not the first
         one intersecting the fold — on a two-page-wide fold those differ, and
         the wrong answer makes the page number flicker while scrolling. */
      const overlap = Math.min(to, top + height) - Math.max(from, top)
      if (overlap > bestOverlap) { bestOverlap = overlap; reading = page.n }
    }

    // At most the keep-window's pages, rather than every page in the document.
    for (const page of [...drawnPages]) {
      /* eslint-disable tulip/no-layout-thrash -- `drawnPages` is the keep
         window, which is a small fixed number of pages either side of the one
         being read; a 900-page PDF has the same handful drawn as a 3-page one.
         That bound is the whole reason this set exists. */
      const from = page.wrap.offsetTop
      const to = from + page.wrap.offsetHeight
      /* eslint-enable tulip/no-layout-thrash */
      if (to < keep.from || from > keep.to) undraw(page)
    }

    wanted.sort((a, b) => a.distance - b.distance)
    state.queue = wanted.map((w) => w.page)
    pump()

    if (reading !== state.at) {
      state.at = reading
      onPage(reading)
      paintThumbPlace()
    }
  }

  /**
   * Draws the queue, one page at a time.
   *
   * Strictly one: two renders in flight on the same document is what wedges
   * pdf.js under this app's configuration — the second never settles, and after
   * that neither does anything else. Serial is also the right reading order,
   * since the queue is sorted by distance from the fold, and it keeps a fast
   * scroll from starting forty renders nobody will wait for.
   */
  async function pump () {
    if (state.drawing || !state.doc) return
    /* Nothing is rasterised mid-gesture — mid-pinch, and equally mid-drag of a
       panel edge. Every frame of either is a different scale, so a render
       started for one is stale before it finishes — and pdf.js renders on this
       thread, so the frames the gesture needs go into drawing pages the reader
       has already zoomed or squeezed past. */
    if (settling()) return
    /* The pages first, always: the rail is an index to the document, and an
       index must never be drawn at the expense of the thing it indexes. A
       thumbnail is only taken up when no page near the fold wants anything. */
    const page = state.queue.shift()
    if (!page) {
      const row = state.thumbQueue.shift()
      if (!row) return
      if (row.drawn || !row.near) { pump(); return }
      state.drawing = row
      state.inFlight = drawThumb(row)
      try {
        await state.inFlight
      } finally {
        state.drawing = null
        state.inFlight = null
      }
      if (state.stuck) { recover(); return }
      queueRefresh()
      return
    }
    if (page.drawn === state.scale || page.failed === state.scale) { pump(); return }

    state.drawing = page
    state.inFlight = draw(page)
    try {
      await state.inFlight
    } finally {
      state.drawing = null
      state.inFlight = null
    }
    if (state.stuck) { recover(); return }
    /* Asked again rather than walking the queue we had: the reader may have
       scrolled or zoomed while that page was drawing, and the queue is a
       statement about where they were, not about what is left. */
    queueRefresh()
  }

  /* One decision point, asked for on a frame boundary. Scrolling, zooming and
     each finished render all want the same question answered — what should be
     drawn now — and asking it once per frame is enough. */
  let refreshTick = /** @type {any} */ (null)
  function queueRefresh () {
    if (refreshTick) return
    refreshTick = requestAnimationFrame(() => { refreshTick = null; refresh() })
  }

  host.addEventListener('scroll', queueRefresh, { passive: true })

  /**
   * Fit-to-width is a promise about the window, so it is kept as the window
   * changes — a resize, and also the sidebar or a side panel being dragged,
   * which change the room the pages have without any window event at all.
   *
   * Two separate rates, for the same reason a pinch has two (see the wheel
   * listener below, whose settle this shares).
   *
   * The *fit* is answered once per frame: it is CSS, the drawn bitmaps are
   * stretched to the new width, and the pages must track the edge being dragged
   * or the drag reads as the panel sliding over a document that is ignoring it.
   *
   * The *rasterising* is held back until the edge stops moving. It was not, and
   * that is what made a drag with a PDF open feel like wading. Every frame threw
   * away every page's bitmap and started a fresh render on this thread, which
   * the next frame then abandoned mid-flight — so the whole of it was work whose
   * result was never once shown, competing with the pointer for the same thread.
   * Now the sharp pages come in one time, at the width the reader let go at.
   */
  /* The one thing a continuous gesture must not do is rasterise, and there are
   * two such gestures — a pinch and a panel edge being dragged. They were a
   * flag and a timer each, with `pump` guarding on the pair and `close`
   * resetting both; the two copies had already drifted apart, `close` stopping
   * one timer and leaving the other running.
   *
   * So there is one timer, and "a gesture is happening" is a question about it
   * rather than a second fact kept alongside it. Whichever gesture moved last
   * owns the settle, which is also the right answer when they overlap: a pinch
   * during a drag should push the sharp pages out to the end of both, not to
   * the end of whichever timer happened to be started first. */
  let settleTimer = /** @type {any} */ (null)
  const settling = () => settleTimer !== null

  /** Called on every frame of a gesture. Rasterising waits for the quiet. */
  function hold () {
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => { settleTimer = null; refresh() }, SETTLE_MS)
  }

  /** The gesture is over and nothing is owed — for a document being closed,
   *  where the refresh a settle ends with would be about the next one. */
  function release () {
    clearTimeout(settleTimer)
    settleTimer = null
  }

  let fitTick = /** @type {any} */ (null)
  const observer = new ResizeObserver(() => {
    /* The thumbnail rail's height. It cannot be a percentage — the rail hangs
       off a zero-height sticky anchor, inside which every percentage is zero —
       so the scroller's own height is written where the stylesheet can read
       it. Set before the fit checks below, because the rail needs it whether
       or not the zoom is following the window. */
    host.style.setProperty('--pdf-thumbs-h', `${host.clientHeight}px`)
    if (!state.doc || !FITS.has(state.zoom) || fitTick) return
    fitTick = requestAnimationFrame(() => {
      fitTick = null
      const next = scaleFor()
      // A hair either way is not worth repainting every page over.
      if (Math.abs(next - state.scale) <= 0.004) return
      hold()
      rescale()
    })
  })
  observer.observe(host)

  /**
   * Pinch, and ⌘-scroll, zoom the document rather than the app.
   *
   * A trackpad pinch arrives as a wheel event with ctrlKey set. Nothing else in
   * the app zooms on that — a pinch over a note is swallowed and ignored — so a
   * document is the one place the gesture still means something.
   */
  /* A pinch arrives as a stream of wheel events — one per frame of the gesture,
     often several — and answering each one with a full zoom is what made the
     gesture feel like it was being dragged through treacle. Two things are
     separated here so it does not:

     the *layout* of a zoom is cheap (the drawn bitmaps are stretched by CSS —
     see `size`), so it happens once per animation frame no matter how many
     events land in one, with the events in between accumulating into the size
     the frame will use;

     the *rasterising* is not cheap, and every frame of a pinch asks for a scale
     the next frame will replace — so it is held back until the fingers stop
     (`pump` refuses while a settle is pending), and the sharp pages come in once,
     at the size the reader actually let go at. */
  let pinchFrame = /** @type {any} */ (null)
  let pinchTo = /** @type {number|null} */ (null)

  host.addEventListener('wheel', (event) => {
    if (!state.doc || !(event.ctrlKey || event.metaKey)) return
    event.preventDefault()

    /* Continuous rather than stepped: a pinch is a continuous gesture, and
       snapping it to the stops the buttons use makes it feel broken. The
       gesture's feel comes from zoom.js, so any other document reader added
       later answers a reader's fingers the same way. */
    const current = pinchTo ?? (FITS.has(state.zoom) ? state.scale : /** @type {number} */ (state.zoom))
    pinchTo = Math.round(current * pinchFactor(event.deltaY) * 1000) / 1000

    if (!pinchFrame) {
      pinchFrame = requestAnimationFrame(() => {
        pinchFrame = null
        setZoom(pinchTo)
        /* Dropped once applied, so the next event reads the size that actually
           took — a pinch held past the last stop would otherwise go on
           accumulating a number the document had already refused, and unpinching
           would do nothing until the phantom zoom had been wound back. */
        pinchTo = null
        onZoom()
      })
    }

    hold()
  }, { passive: false })

  /**
   * Redraws the document at the current zoom, holding the reader's place.
   *
   * The place is the *page* being read and how far down it the window sits, not
   * a fraction of the whole document. It was the latter, and that is only the
   * same place before and after when every page is the same height — which is
   * exactly what cannot be assumed here, because a wrapper is sized from page
   * one's dimensions until the page it stands for has actually been visited.
   * So a book with a fold-out plate, an appendix of landscape tables, or simply
   * four hundred pages nobody has scrolled to yet drifted by whole pages while
   * the reader zoomed: the ratio was faithful to a document height that was
   * itself an estimate, and the estimate changed as pages were drawn.
   *
   * @param relayer  whether the text and links have to be built again as well —
   *                 true for a turn, which changes what shape the page is, and
   *                 false for a zoom, which does not: pdf.js positions text
   *                 spans in per cent, so a layer built at one scale is already
   *                 right at the next.
   */
  function rescale ({ relayer = false } = {}) {
    const anchor = state.pages[state.at - 1] || null
    const place = anchor
      ? placeIn(host.scrollTop, { top: anchor.wrap.offsetTop, height: anchor.wrap.offsetHeight })
      : null
    const before = host.scrollHeight - host.clientHeight
    const ratio = before > 0 ? host.scrollTop / before : 0

    state.scale = scaleFor()
    for (const page of state.pages) {
      // Abandons whatever was in flight rather than cancelling it: its result is
      // for the old size and must not be mistaken for this one — see `draw`.
      page.gen++
      page.drawn = 0
      page.failed = 0
      if (!relayer) continue
      /* A turn is the one change a stretched bitmap cannot stand in for: a
         landscape canvas pulled into a portrait box is not a rough version of
         the answer, it is a different picture. So the page goes back to being a
         blank sheet of the right shape until it has been drawn again. */
      page.canvas.width = page.canvas.height = 0
      page.wrap.classList.remove('is-drawn')
      dropText(page)
      dropLinks(page)
    }
    // Every page resized on this frame; the bitmaps catch up from the queue.
    layOut()

    host.scrollTop = place
      ? placeAt(place, { top: anchor.wrap.offsetTop, height: anchor.wrap.offsetHeight })
      /* Nothing open, or nothing measured — the old whole-document ratio, which
         is the best a viewer with no page to hold on to can do. */
      : Math.round(ratio * Math.max(0, host.scrollHeight - host.clientHeight))
    refresh()
  }

  /* ----------------------------------------------------------- highlights */

  /** Every mark on one page, as `{ mark, rect }` pairs in that page's frame. */
  function marksOn (n) {
    const out = []
    for (const mark of state.marks) {
      for (const rect of mark.rects) if (rect.page === n) out.push({ mark, rect })
    }
    return out
  }

  /** The same, for every page at once: one pass over the marks rather than
   *  one per page. Pages with nothing on them are absent. */
  function marksByPage () {
    const byPage = new Map()
    for (const mark of state.marks) {
      for (const rect of mark.rects) {
        let list = byPage.get(rect.page)
        if (!list) byPage.set(rect.page, (list = []))
        list.push({ mark, rect })
      }
    }
    return byPage
  }

  /** Draws one page's highlights. Percentages, so a zoom needs no redraw. */
  function paintMarks (page, marks = marksOn(page.n)) {
    /* A page with no marks that has none drawn is left alone: `repaintMarks`
       comes here for every page of the document, most of which are neither
       marked nor even drawn, and emptying an empty layer is a DOM write for
       nothing. */
    if (!marks.length && !page.marks.firstChild) return
    const frag = document.createDocumentFragment()
    let pending = false
    for (const { mark, rect } of marks) {
      const div = document.createElement('div')
      div.className = 'pdf-mark'
      div.dataset.mark = mark.id
      div.dataset.color = mark.color
      div.style.left = `${rect.x * 100}%`
      div.style.top = `${rect.y * 100}%`
      div.style.width = `${rect.w * 100}%`
      div.style.height = `${rect.h * 100}%`
      if (mark.id === state.flashing) pending = true
      frag.append(div)
    }
    page.marks.replaceChildren(frag)
    // The jump the reader made before this page was drawn, kept its promise.
    if (pending) { const id = state.flashing; state.flashing = null; flash(id) }
  }

  /* Every change to the marks — a new one, a colour, an undo — ends here.
     Scanning the whole mark list once per page made it pages × marks a
     change; grouped once, it is marks + pages. */
  const repaintMarks = () => {
    const byPage = marksByPage()
    for (const page of state.pages) paintMarks(page, byPage.get(page.n) || [])
  }

  /** Writes the sidecar. Debounced: dragging a colour through five swatches is
   *  one intention, not five files. */
  function save () {
    clearTimeout(state.saveTimer)
    const path = state.path
    const marks = state.marks.map((m) => ({ ...m }))
    state.saveTimer = setTimeout(() => {
      api.pdf.marks.save(path, marks).catch((err) => {
        console.error('saving highlights failed', err)
        // Said out loud: a highlight that never reached the sidecar is data
        // loss the reader would otherwise discover on the next open.
        onError('The highlights could not be saved.')
      })
    }, 400)
  }

  /** Flushes a pending save now — before the document closes or the app quits. */
  async function flush () {
    if (!state.saveTimer) return
    clearTimeout(state.saveTimer)
    state.saveTimer = null
    try { await api.pdf.marks.save(state.path, state.marks) } catch {
      onError('The highlights could not be saved.')
    }
  }

  /**
   * The rectangles of a selection, in page fractions.
   *
   * A selection is a run of client rectangles — one per line, sometimes one per
   * span — and each has to be told which page it fell on. Only pages whose text
   * layer exists can be selected from, so the search is over what is on screen.
   */
  function rectsOf (range) {
    const out = []
    const visible = state.pages.filter((p) => p.hasText)

    for (const rect of range.getClientRects()) {
      if (rect.width < 0.5 || rect.height < 0.5) continue

      for (const page of visible) {
        const box = pageBox(page)
        // The rectangle belongs to the page holding its middle, so a line that
        // grazes the gap between two pages is not counted twice.
        const midY = rect.top + rect.height / 2
        if (midY < box.top || midY > box.bottom) continue
        if (rect.right < box.left || rect.left > box.right) continue

        out.push({
          page: page.n,
          x: clamp01((rect.left - box.left) / box.width),
          y: clamp01((rect.top - box.top) / box.height),
          w: clamp01(rect.width / box.width),
          h: clamp01(rect.height / box.height)
        })
        break
      }
    }
    return merge(out)
  }

  const clamp01 = (n) => Math.max(0, Math.min(1, n))

  /**
   * Drops rectangles already covered by another.
   *
   * A selection over styled text yields one rectangle per span, and a marked-up
   * paragraph can yield a hundred nested ones — each drawn as its own
   * translucent div, which is what makes a highlight look blotchy where the
   * words happen to be bold.
   */
  function merge (rects) {
    const kept = []
    for (const rect of rects) {
      const inside = (a, b) =>
        a.page === b.page && a.x >= b.x - 0.001 && a.y >= b.y - 0.002 &&
        a.x + a.w <= b.x + b.w + 0.001 && a.y + a.h <= b.y + b.h + 0.002

      if (kept.some((k) => inside(rect, k))) continue
      for (let i = kept.length - 1; i >= 0; i--) if (inside(kept[i], rect)) kept.splice(i, 1)
      kept.push(rect)
    }
    return joinLines(kept)
  }

  /**
   * Joins what is really one stroke of the pen.
   *
   * A PDF's text is a scatter of positioned runs — often one per word — so a
   * selected line arrives as a dozen rectangles with the spaces missing between
   * them. Drawn as they come, a highlight is a row of separate blocks; joined
   * along each line, it is a stroke through the sentence, which is what the
   * reader drew.
   */
  function joinLines (rects) {
    const sorted = [...rects].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
    const out = []

    for (const rect of sorted) {
      const last = out[out.length - 1]
      const sameLine = last && last.page === rect.page &&
        Math.abs(last.y - rect.y) < Math.min(last.h, rect.h) * 0.5 &&
        Math.abs(last.h - rect.h) < Math.max(last.h, rect.h) * 0.5
      // A gap wider than a space is a column break or a jump across a figure,
      // and joining across it would draw a stroke through untouched text.
      const near = last && rect.x - (last.x + last.w) < 0.02

      if (!sameLine || !near) { out.push({ ...rect }); continue }

      const right = Math.max(last.x + last.w, rect.x + rect.w)
      const bottom = Math.max(last.y + last.h, rect.y + rect.h)
      last.y = Math.min(last.y, rect.y)
      last.x = Math.min(last.x, rect.x)
      last.w = right - last.x
      last.h = bottom - last.y
    }
    return out
  }

  /** The mark under a point on a page, if any — topmost first. */
  function markAt (page, clientX, clientY) {
    const box = pageBox(page)
    const x = (clientX - box.left) / box.width
    const y = (clientY - box.top) / box.height

    const hits = marksOn(page.n).filter(({ rect }) =>
      x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h)
    return hits.length ? hits[hits.length - 1].mark : null
  }

  const pageOf = (node) => {
    const wrap = node instanceof Element ? node.closest('.pdf-page') : null
    return wrap ? state.pages[Number(wrap.getAttribute('data-page')) - 1] : null
  }

  /* ---------------------------------------------------------- the popups */

  /* Two: one offering to mark what is selected, one acting on a mark already
     there. Both are children of the scroller, so they travel with the page
     rather than needing to be repositioned on every scroll event. */
  const pop = document.createElement('div')
  pop.className = 'pdf-pop'
  pop.hidden = true
  host.append(pop)

  function place (rect) {
    const box = host.getBoundingClientRect()
    pop.hidden = false
    // Measured after it is shown and before it is placed: an empty popup has no
    // size, and a popup placed from a stale size lands beside the words.
    const width = pop.offsetWidth
    /* Kept inside what can actually be seen, not inside the whole sheet: at a
       zoom where the page is wider than the window, half of the scrollable
       width is off-screen. */
    const left = rect.left - box.left + host.scrollLeft + rect.width / 2 - width / 2
    const min = host.scrollLeft + 8
    const max = host.scrollLeft + host.clientWidth - width - 8
    pop.style.left = `${Math.round(Math.max(min, Math.min(left, Math.max(min, max))))}px`
    pop.style.top = `${rect.bottom - box.top + host.scrollTop + 8}px`
  }

  const hidePop = () => { pop.hidden = true; pop.replaceChildren() }

  function button (label, title, onClick, className = '') {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `pdf-pop-btn ${className}`.trim()
    b.title = title
    b.textContent = label
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', onClick)
    return b
  }

  function swatches (onPick, current = '') {
    const frag = document.createDocumentFragment()
    for (const colour of MARK_COLORS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `pdf-swatch${colour.id === current ? ' is-on' : ''}`
      b.dataset.color = colour.id
      b.title = colour.label
      b.setAttribute('aria-label', colour.label)
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', () => onPick(colour.id))
      frag.append(b)
    }
    return frag
  }

  const divider = () => {
    const hr = document.createElement('span')
    hr.className = 'pdf-pop-line'
    return hr
  }

  /** Offered as soon as something is selected. */
  /**
   * The popup both offers, built once: the colours, then Copy, then Ask.
   *
   * The two callers differ in what a colour means (draw a new highlight, or
   * recolour the one clicked) and in what Remove is offered on — not in the
   * spine, which they each used to spell out. `Ask` in particular was
   * character-identical in both.
   *
   * @param at       where to put it
   * @param pick     given the chosen colour
   * @param current  the colour to show as chosen
   * @param copy     the text Copy puts on the clipboard
   * @param copyHint that button's tooltip
   * @param extra    buttons for the end, if any
   */
  function showPop (at, { pick, current, copy, copyHint, extra = /** @type {HTMLElement[]} */ ([]) }) {
    pop.replaceChildren()
    pop.append(swatches(pick, current))
    pop.append(divider())
    pop.append(button('Copy', copyHint, () => {
      /* Electron's clipboard, not the page's: `navigator.clipboard` refuses
         whenever the window is not focused — which it is not when the click
         came from a popup the reader tore their attention to — and the
         optional chain made that refusal a silent nothing. */
      api.copy(copy)
      window.getSelection()?.removeAllRanges()
      hidePop()
    }))
    pop.append(button('Ask', 'Ask the copilot about this passage', () => {
      onAsk({ ...state.quote })
      hidePop()
    }))
    pop.append(...extra)
    place(at)
  }

  function offerMark (range, text) {
    const rects = rectsOf(range)
    if (!rects.length) { hidePop(); return }

    state.quote = { text, page: rects[0].page }

    const last = range.getClientRects()
    showPop(last[last.length - 1] || range.getBoundingClientRect(), {
      current: state.pen,
      pick: (color) => {
        addMark({ color, text, rects })
        /* The pen follows the last colour drawn with, so the toolbar agrees
           with what just happened — but the arrow stays in hand: choosing a
           colour here is about this passage, not a decision to start
           highlighting. */
        setPen(color, { arm: false })
        window.getSelection()?.removeAllRanges()
        hidePop()
      },
      copy: text,
      copyHint: 'Copy the selected text'
    })
  }

  /** Offered when an existing highlight is clicked. */
  function offerEdit (mark, rect) {
    state.quote = { text: mark.text, page: mark.rects[0]?.page || state.at }

    showPop(rect, {
      current: mark.color,
      pick: (color) => { recolour(mark, color); hidePop() },
      copy: mark.text,
      copyHint: 'Copy this passage',
      extra: [button('Remove', 'Remove this highlight', () => {
        removeMark(mark.id)
        hidePop()
      }, 'is-danger')]
    })
  }

  /* ------------------------------------------------------ taking it back */

  /**
   * The highlights' own undo stack.
   *
   * A PDF has no text to edit, so ⌘Z here can only mean the marking-up — and
   * with a highlighter that draws on mouse-up, a stray drag is easy enough to
   * make that there has to be a way back from one. Each entry is a pair of
   * closures over the mark itself rather than a snapshot of the whole set:
   * undoing an accidental highlight on page 300 should not rewrite page 1.
   *
   * The mark object is the same object throughout, so an id that comes back
   * after an undo is the id it was — which is what lets the sidecar, the
   * highlight list and a second undo all go on meaning the same thing.
   */
  const HISTORY_LIMIT = 200

  /** Everything a change to the marks has to do afterwards, in one place. */
  function committed () {
    order()
    repaintMarks()
    save()
    onMarks()
  }

  function record (entry) {
    state.past.push(entry)
    if (state.past.length > HISTORY_LIMIT) state.past.shift()
    // A new change is a new branch: what was undone is no longer ahead of us.
    state.future.length = 0
  }

  /** Takes a mark out and hands it back, or null if it had already gone. */
  function cut (id) {
    const at = state.marks.findIndex((m) => m.id === id)
    return at === -1 ? null : state.marks.splice(at, 1)[0]
  }

  /** Says what it undid, so the app can name it; null when there was nothing. */
  function undo () {
    const entry = state.past.pop()
    if (!entry) return null
    entry.undo()
    state.future.push(entry)
    committed()
    return entry.label
  }

  function redo () {
    const entry = state.future.pop()
    if (!entry) return null
    entry.redo()
    state.past.push(entry)
    committed()
    return entry.label
  }

  function addMark ({ color, text, rects }) {
    const mark = {
      id: uid(),
      color: COLOR_IDS.has(color) ? color : DEFAULT_COLOR,
      text,
      rects,
      at: new Date().toISOString()
    }
    state.marks.push(mark)
    record({
      label: 'highlight',
      undo: () => cut(mark.id),
      redo: () => { if (!state.marks.includes(mark)) state.marks.push(mark) }
    })
    committed()
    return mark
  }

  function removeMark (id) {
    const mark = cut(id)
    if (!mark) return
    record({
      label: 'removing a highlight',
      undo: () => { if (!state.marks.includes(mark)) state.marks.push(mark) },
      redo: () => cut(mark.id)
    })
    committed()
  }

  /** Recolouring, as its own step: five swatches dragged through are five
   *  colours tried, and ⌘Z should walk back through them. */
  function recolour (mark, color) {
    if (!COLOR_IDS.has(color) || mark.color === color) return
    const was = mark.color
    mark.color = color
    record({
      label: 'recolouring a highlight',
      undo: () => { mark.color = was },
      redo: () => { mark.color = color }
    })
    committed()
  }

  /** Reading order: down the document, then down each page. What the highlight
   *  list shows, and the order the copilot is given them in. */
  function order () {
    state.marks.sort((a, b) => {
      const pa = a.rects[0] || { page: 0, y: 0 }
      const pb = b.rects[0] || { page: 0, y: 0 }
      return pa.page - pb.page || pa.y - pb.y
    })
  }

  /* ------------------------------------------------------------ the tools */

  /**
   * Which tool the reader has in hand, and which colour is in it.
   *
   * Both are on the host as data attributes rather than only in this closure:
   * the cursor over the pages is a stylesheet's business, and the toolbar reads
   * them back through the accessors below.
   */
  function markTool () {
    host.dataset.tool = state.tool
    host.dataset.pen = state.pen
  }
  /* Only the attributes at mount: `onTool` belongs to the toolbar, which is
     wired to a viewer that does not exist until this call returns. */
  markTool()

  const paintTool = () => { markTool(); onTool() }

  function setTool (tool) {
    state.tool = tool === 'mark' ? 'mark' : 'select'
    // The popup is an answer to a selection made with the other tool, and the
    // selection itself is about to mean something different.
    hidePop()
    paintTool()
    return state.tool
  }

  /** Picking a colour is picking up the highlighter: a reader reaching for the
   *  green pen wants to draw in green, not to nominate a colour for later. */
  function setPen (color, { arm = true } = {}) {
    if (!COLOR_IDS.has(color)) return state.pen
    state.pen = color
    if (arm) state.tool = 'mark'
    paintTool()
    return state.pen
  }

  /* ------------------------------------------------------------- gestures */

  host.addEventListener('mouseup', (event) => {
    if (!state.doc || event.button !== 0 || !selectionMenu) return
    // A click that lands in the popup is the popup's own business.
    if (pop.contains(/** @type {Node|null} */ (event.target))) return

    const selection = window.getSelection()
    const text = selection ? selection.toString().replace(/\s+/g, ' ').trim() : ''

    if (text && selection && selection.rangeCount && host.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0)
      /* The highlighter draws straight away. No popup: the whole point of
         holding it is that selecting the words is the entire gesture, and a
         menu asking which colour would put back the step it removes. What was
         drawn is still kept as the quote, so the copilot can be asked about
         the passage afterwards without selecting it again. */
      if (state.tool === 'mark') {
        const rects = rectsOf(range)
        if (rects.length) {
          addMark({ color: state.pen, text, rects })
          state.quote = { text, page: rects[0].page }
        }
        selection.removeAllRanges()
        hidePop()
        return
      }
      offerMark(range, text)
      return
    }

    // Not a selection, so it may be a click on something already marked.
    const page = pageOf(event.target)
    const mark = page ? markAt(page, event.clientX, event.clientY) : null
    if (mark) {
      // Anchored to the click rather than to the highlight: a mark spanning
      // four lines has no one edge the popup obviously belongs under.
      offerEdit(mark, { left: event.clientX, right: event.clientX, width: 0, bottom: event.clientY })
      return
    }
    hidePop()
  })

  /* A highlight is clickable, but the layer holding it must not be: the text
     over it is what a selection is made from. So the hit-test happens here
     rather than through the element under the mouse, and what it finds is said
     by lightening the mark itself — see `is-hot`. It used to be said a second
     time by turning the cursor into a hand, which was set on the whole pane
     because the marks cannot be hit; that is gone, and with it the class that
     carried it. */
  let hoverTick = /** @type {any} */ (null)
  host.addEventListener('mousemove', (event) => {
    if (!state.marks.length || hoverTick) return
    hoverTick = requestAnimationFrame(() => {
      hoverTick = null
      const page = pageOf(event.target)
      const mark = page ? markAt(page, event.clientX, event.clientY) : null
      for (const div of host.querySelectorAll('.pdf-mark.is-hot')) div.classList.remove('is-hot')
      if (!mark) return
      for (const div of host.querySelectorAll(`.pdf-mark[data-mark="${mark.id}"]`)) {
        div.classList.add('is-hot')
      }
    })
  })

  host.addEventListener('mousedown', (event) => {
    if (!pop.hidden && !pop.contains(/** @type {Node|null} */ (event.target))) hidePop()
  })

  /* --------------------------------------------------------- the document */

  /* The password card, for the document that arrives locked. It lives in the
     viewer rather than in the app's chrome because only the viewer knows the
     question is being asked: pdf.js raises it from inside `getDocument`, calls
     again if the answer was wrong, and simply waits in between. The card is a
     form so that Enter submits, the way every password box a reader has ever
     met does. */
  let passwordCard = /** @type {HTMLFormElement|null} */ (null)

  function closePassword () {
    passwordCard?.remove()
    passwordCard = null
  }

  /**
   * @param wrong  whether this is the second (or later) asking — the reader
   *               typed something, and the document refused it
   * @returns the password, or null for a reader who has decided not to answer
   */
  function askPassword (wrong) {
    return new Promise((resolve) => {
      // One question at a time: a new asking replaces the old card outright,
      // whose promise has already been settled by the submit that led here.
      closePassword()

      const card = document.createElement('form')
      card.className = 'pdf-password'

      const box = document.createElement('div')
      box.className = 'pdf-password-card'

      const title = document.createElement('p')
      title.className = 'pdf-password-title'
      title.textContent = 'This PDF is password-protected.'

      const note = document.createElement('p')
      note.className = 'pdf-password-note'
      note.textContent = wrong
        ? 'That password was not right — try again.'
        : 'Enter its password to open it.'
      note.classList.toggle('is-wrong', wrong)

      const input = document.createElement('input')
      input.type = 'password'
      input.className = 'pdf-password-input'
      input.autocomplete = 'off'
      input.setAttribute('aria-label', 'PDF password')

      const row = document.createElement('div')
      row.className = 'pdf-password-row'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'pdf-password-btn'
      cancel.textContent = 'Cancel'
      const unlock = document.createElement('button')
      unlock.type = 'submit'
      unlock.className = 'pdf-password-btn is-primary'
      unlock.textContent = 'Unlock'
      row.append(cancel, unlock)

      box.append(title, note, input, row)
      card.append(box)

      /* Settled exactly once, whichever way the reader goes. The card is left
         standing on submit — pdf.js takes a moment to check the answer, and a
         blank viewer in that moment reads as the app having eaten the prompt —
         and taken down by `closePassword` when the load settles or asks again. */
      let done = false
      const answer = (value) => {
        if (done) return
        done = true
        if (value === null) closePassword()
        resolve(value)
      }
      card.addEventListener('submit', (event) => {
        event.preventDefault()
        answer(input.value)
      })
      cancel.addEventListener('click', () => answer(null))
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); answer(null) }
      })

      host.append(card)
      passwordCard = card
      input.focus()
    })
  }

  /**
   * @param {string} path
   * @param {{page?:number, top?:number}|null} place  where to restore to
   */
  async function open (path, place = null) {
    await close()

    const epoch = ++state.epoch
    state.path = path
    host.classList.add('is-loading')

    let source
    try {
      /* Together: pdf.js and the guarded document URL are independent. The
         library fetches the latter in ranges instead of receiving one giant
         structured clone over IPC. */
      ;[source] = await Promise.all([api.pdf.source(path), loadPdfjs()])
    } catch (err) {
      host.classList.remove('is-loading')
      throw err
    }
    if (epoch !== state.epoch) return null

    const loading = pdfjsLib.getDocument({ url: source, ...PDF_DATA })
    /* A protected document used to be a dead end: pdf.js asked for a password,
       nothing was listening, and the reader got "That PDF is
       password-protected" and no way to say what it was. The callback is the
       whole of the mechanism — pdf.js waits on whatever it is handed, calls
       again with INCORRECT_PASSWORD if the answer was wrong, and takes an
       Error as "the reader has given up", which rejects the load below. */
    loading.onPassword = (answer, reason) => {
      if (epoch !== state.epoch) { answer(new Error('cancelled')); return }
      askPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then((password) => {
        if (password === null || epoch !== state.epoch) answer(new Error('cancelled'))
        else answer(password)
      })
    }

    let doc
    try {
      doc = await loading.promise
    } catch (err) {
      host.classList.remove('is-loading')
      closePassword()
      if (epoch !== state.epoch) return null
      /* A cancelled password prompt is not a failure to report: the reader was
         asked a question and answered "no". The tab is left empty, which is
         what an unopened document looks like. */
      if (err?.message === 'cancelled') return null
      throw new Error(err?.name === 'PasswordException'
        ? 'That PDF is password-protected.'
        : 'That PDF could not be read.')
    }
    closePassword()
    if (epoch !== state.epoch) { loading.destroy().catch(() => {}); return null }

    state.doc = doc
    state.loading = loading
    // Whatever this document was last turned to, or square if it is new here.
    state.turn = turns.get(path) || 0
    /* From here on, every await is re-checked. Loading the marks, fetching the
       first page and walking a big outline are all slow enough for the reader
       to have opened something else meanwhile — and an open that settles late
       must not overwrite the toolbar, outline and marks of the document that
       is actually on screen. `close` has destroyed this doc by then. */
    const marks = await api.pdf.marks.load(path)
    if (epoch !== state.epoch) return null
    state.marks = normalise(marks)
    order()

    const first = await doc.getPage(1)
    if (epoch !== state.epoch) return null
    state.base = unitOf(first)
    // The scale is settled before the wrappers are laid out, so the document
    // has its final height from the first frame and the place restored below
    // means what it meant when it was recorded.
    markFit()
    state.scale = scaleFor()
    build(doc.numPages)
    state.pages[0].proxy = first

    /* Restored before the first paint rather than after: scrolling a document
       that has already drawn its opening pages throws away that work. */
    state.at = Math.min(Math.max(1, Math.round(place?.page || 1)), doc.numPages)
    if (place?.top) host.scrollTop = place.top
    else if (state.at > 1) host.scrollTop = state.pages[state.at - 1].wrap.offsetTop - 12

    host.classList.remove('is-loading')
    buildThumbs()
    refresh()

    /**
     * The toolbar is told about the document now, and the contents follow.
     *
     * They used to be one thing, and the wait was the outline's: every entry
     * was resolved to a page number with a pair of worker round-trips, made one
     * after another, so a textbook with four hundred bookmarks meant eight
     * hundred of them before the toolbar could say how many pages the document
     * had. The page count, the zoom readout and the reader's own toolbar were
     * all held behind a table of contents nobody had opened the sidebar to
     * look at — for seconds, on a real book.
     *
     * So `onDoc` fires the moment the pages are on screen, with an outline it
     * says is empty, and the contents follow through a second `onDoc` when
     * the worker has answered — the callback is idempotent in every host this
     * app has.
     */
    const info = { path, pages: doc.numPages, page: state.at, outline: /** @type {OutlineEntry[]} */ ([]) }
    onDoc(info)
    onMarks()

    const outline = await contents(doc)
    if (epoch !== state.epoch) return null
    state.outline = outline
    info.outline = outline
    // The reader may have moved while the worker resolved the entries, and a
    // host re-told through onDoc paints the toolbar from this very field.
    info.page = state.at
    if (outline.length) onDoc(info)
    return info
  }

  /**
   * The document's own bookmarks, flattened with their depth.
   *
   * Two halves, and they used to be one. Flattening the tree is a single
   * message to the worker and is over in a moment; turning each entry's
   * destination into a page number is a pair of round-trips *each*, and doing
   * them one after another inside the walk is what made opening a textbook feel
   * like the app had hung. They are now asked for together, so four hundred
   * entries cost one worker queue rather than four hundred latencies in a row.
   *
   * Each answer is still worked out once and kept — the entry a reader clicks
   * must not wait for the worker — and a destination named by more than one
   * entry, which is common in a book whose parts and chapters share an anchor,
   * is looked up once for all of them.
   *
   * @returns {Promise<OutlineEntry[]>}
   */
  async function contents (doc) {
    let tree
    try { tree = await doc.getOutline() } catch { return [] }
    if (!tree?.length) return []

    const { entries, truncated } = flattenOutline(tree)
    /* Said out loud rather than dropped in silence. The old ceiling was four
       hundred and nothing anywhere mentioned it, so a document with a long
       index simply had half a table of contents in the sidebar and no
       explanation for the half that was missing. */
    if (truncated) {
      onError(`This PDF's contents run past ${MAX_OUTLINE} entries; the sidebar lists the first ${MAX_OUTLINE}.`)
    }

    const known = new Map()
    const pageFor = (dest) => {
      const key = typeof dest === 'string' ? `n:${dest}` : JSON.stringify(dest ?? null)
      if (!known.has(key)) known.set(key, resolvePage(doc, dest))
      return known.get(key)
    }
    const pages = await Promise.all(entries.map((entry) => pageFor(entry.dest)))
    for (const [at, entry] of entries.entries()) entry.page = pages[at]
    return entries
  }

  /** Which page a destination lands on, counting from one. Falls back to the
   *  first page: an entry that cannot be resolved is still an entry, and a
   *  table of contents with a hole in it is worse than one that guesses. */
  async function resolvePage (doc, dest) {
    try {
      const target = typeof dest === 'string' ? await doc.getDestination(dest) : dest
      if (!Array.isArray(target)) return 1
      return (await doc.getPageIndex(target[0])) + 1
    } catch {
      return 1
    }
  }

  /** Stored highlights, checked before anything is drawn from them. A sidecar
   *  is a file on disk that anything could have written.
   *  @returns {Mark[]} */
  function normalise (stored) {
    if (!Array.isArray(stored)) return []
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

    return stored.flatMap((mark) => {
      const rects = Array.isArray(mark?.rects)
        ? mark.rects.filter((r) => num(r?.x) !== null && num(r?.y) !== null &&
            num(r?.w) !== null && num(r?.h) !== null && Number.isInteger(r?.page))
          .map((r) => ({ page: r.page, x: clamp01(r.x), y: clamp01(r.y), w: clamp01(r.w), h: clamp01(r.h) }))
        : []
      if (!rects.length) return []
      return [{
        id: typeof mark.id === 'string' && mark.id ? mark.id : uid(),
        color: COLOR_IDS.has(mark.color) ? mark.color : DEFAULT_COLOR,
        text: typeof mark.text === 'string' ? mark.text : '',
        rects,
        at: typeof mark.at === 'string' ? mark.at : ''
      }]
    })
  }

  async function close () {
    if (!state.doc) return
    await flush()
    // Bumped first: whatever is in flight now belongs to a document nobody is
    // looking at, and every await in `draw` checks this before writing anything.
    state.epoch++
    state.queue = []
    /* Destroying a document under a live render wedges pdf.js exactly the way
       cancelling one does, so the render is allowed to finish first. It is one
       page, and it is already most of the way through. */
    try { await state.inFlight } catch { /* its own business */ }

    for (const page of state.pages) undraw(page)
    drawnPages.clear()
    /* A gesture over the document that is going belongs to it. Left running,
       its settle would fire against the next one — holding that document's
       first pages back, and then refreshing a viewer that had moved on. */
    release()
    const loading = state.loading

    Object.assign(state, {
      path: '', doc: null, loading: null, pages: [], marks: [], base: null, at: 1, quote: null, flashing: null,
      /* Not the tool or the pen — those are the reader's, not the document's.
         The turn goes, though: it was this document's, and it is waiting in
         `turns` for the next time this file is opened. */
      turn: 0, outline: [], hits: [], thumbQueue: [],
      past: [], future: []
    })
    /* A search still walking belongs to that document, and the band it left on
       a page went with the wrappers — but the state that would let a stale walk
       finish must not survive into the next document. */
    stopFind()
    clearHit()
    closePassword()
    thumbWatcher.disconnect()
    thumbRows = []
    rail.replaceChildren()
    thumbsBox.hidden = true
    host.classList.remove('has-thumbs')
    hidePop()
    sheet.replaceChildren()
    // The words belonged to that document; the next one has its own.
    pageText.clear()
    try { await loading?.destroy() } catch { /* going away regardless */ }
  }

  /* ------------------------------------------------------------ moving about */

  /* A page number as the reader might give it — off the end, fractional, or a
     string that rounded oddly — turned into the page it must mean. Named
     because the clamp is the non-obvious part and three callers need it. */
  const pageAt = (n) =>
    state.pages[Math.min(Math.max(1, Math.round(n)), state.pages.length) - 1]

  /**
   * A page's true size at scale 1, fetched if it is not known yet.
   *
   * Until a page has been drawn, its wrapper is sized from page one's — see
   * `layOut` — and anything aimed at a fraction *down* that wrapper is aimed
   * at the wrong number of pixels. That is fine for the page number, which is
   * a whole page either way, and wrong for everything that names a point on
   * one: a search hit, a highlight in the list, a section that starts halfway
   * down. Those all go through here first, which is one round-trip to the
   * worker for a page the reader is about to look at anyway.
   */
  async function measure (page) {
    if (page.unit) return
    const epoch = state.epoch
    try {
      if (!page.proxy) page.proxy = await state.doc.getPage(page.n)
      if (epoch !== state.epoch || page.unit) return
      page.unit = unitOf(page.proxy)
      size(page)
    } catch { /* a page that will not answer keeps page one's shape */ }
  }

  /** The scroll itself, once the page is known to be the shape it claims. */
  function land (page, y) {
    host.scrollTo({ top: Math.max(0, page.wrap.offsetTop + y * page.wrap.offsetHeight - 12) })
    refresh()
  }

  /**
   * @param {number} n    the page to bring into view
   * @param {number} [y]  how far down that page to stop, 0–1
   */
  function goToPage (n, y = 0) {
    if (!state.doc) return
    state.flashing = null   // going somewhere else is a change of mind
    const page = pageAt(n)
    if (!page) return
    /* A page turn needs no measurement — the top of a page is its top whatever
       shape it is — so the common case stays synchronous, and only a jump to a
       point on an unvisited page waits for the worker. */
    if (y && !page.unit) {
      measure(page).then(() => { if (state.pages[page.n - 1] === page) land(page, y) })
      return
    }
    land(page, y)
  }

  /* ----------------------------------------------------------- the found line

     Where a search hit is, marked on the page it is on.

     A band across the line rather than a box around the words: what a hit's
     position is known to is the text item it falls in, which gives the height
     down the page and nothing about where along it the phrase sits. A box drawn
     from a guess at the rest would be wrong by a word most of the time, and a
     highlight in the wrong place is worse than none — so the band claims only
     the line, which is what is actually known.

     One element, moved. A search steps from hit to hit and only ever has one
     current, so a second would be a stale answer left on the page. */
  const hitBand = document.createElement('div')
  hitBand.className = 'pdf-hit'
  hitBand.setAttribute('aria-hidden', 'true')

  /**
   * @param where  the hit itself, or the page it is on
   * @param y      how far down that page, when `where` is a page number
   *
   * Both, because the find bar walks the hits this module handed it and asks
   * with the two numbers it needed for the scroll. The hit knows more than
   * that — where along the line its words are — so when it is not given, it is
   * looked back up among the hits last reported rather than thrown away. A
   * caller that passes the hit gets the exact one; a caller that passes a page
   * and a height gets the first hit on that line, which differs only where the
   * same phrase appears twice on one line.
   */
  function markHit (where, y = 0) {
    const hit = (where && typeof where === 'object')
      ? where
      : state.hits.find((h) => h.page === where && h.y === y) || { page: where, y }
    const page = pageAt(hit.page)
    if (!page) { clearHit(); return }

    hitBand.style.top = `${(hit.y || 0) * 100}%`
    /* A box around the words when their extent is known, and the old band
       across the whole line when it is not — a scanned page with no text layer,
       or an item that carried no width. The band is not wrong, it is only
       vague, so it stays as the answer for the cases that cannot do better. */
    const words = typeof hit.x === 'number' && hit.w > 0.002
    hitBand.classList.toggle('is-words', words)
    hitBand.style.left = words ? `${hit.x * 100}%` : ''
    hitBand.style.width = words ? `${hit.w * 100}%` : ''
    page.wrap.append(hitBand)
    restart(hitBand, 'is-lit')
  }

  const clearHit = () => hitBand.remove()

  /**
   * A table-of-contents entry, which is a point rather than a page: a section
   * beginning halfway down page two should put its own heading at the top of
   * the window, not the page it happens to start on.
   *
   * Resolved here, at the click, rather than alongside the page numbers when
   * the outline is read. The y needs the page itself, and asking the worker for
   * four hundred of them to open a document nobody has scrolled yet costs more
   * than the one round trip a click can afford — and pdf.js has the page cached
   * by the time anyone clicks a section they can see.
   */
  const goToOutline = (entry) => goToDest(entry?.dest, entry?.page)

  /**
   * A destination, from wherever it came: a table-of-contents entry, or a link
   * drawn over the words on a page.
   *
   * @param dest  the destination as the document wrote it
   * @param hint  a page number already known for it, if there is one — the
   *              outline's entries carry theirs, a link's do not
   */
  async function goToDest (dest, hint = null) {
    if (!state.doc) return
    const epoch = state.epoch
    const where = await placeOf(dest)
    // The document may have been closed or swapped while the worker answered.
    if (epoch !== state.epoch) return
    goToPage(where.page || hint || 1, where.y)
  }

  /**
   * Where a destination points: its page, and how far down that page, as a
   * fraction — 0 for one that names no point of its own.
   *
   * Only some destinations carry a height: /XYZ names a corner and /FitH a top
   * edge, while /Fit and friends mean the whole page and are already answered
   * by scrolling to it.
   *
   * Both halves are worked out from one resolution of the destination. They
   * were two — the page here, the height there — which meant a click on a
   * contents entry resolved the same named destination the open had already
   * resolved, and a link on a page had no way to ask for a page at all.
   */
  async function placeOf (dest) {
    try {
      if (!dest) return { page: 0, y: 0 }
      const target = typeof dest === 'string' ? await state.doc.getDestination(dest) : dest
      if (!Array.isArray(target)) return { page: 0, y: 0 }

      /* A destination names its page either by reference or, in a document
         written against an explicit page tree, by index. Only the first has to
         go to the worker. */
      const page = typeof target[0] === 'number'
        ? target[0] + 1
        : (await state.doc.getPageIndex(target[0])) + 1

      const kind = target[1]?.name
      const top = kind === 'XYZ' ? target[3]
        : kind === 'FitH' || kind === 'FitBH' ? target[2]
          : null
      if (typeof top !== 'number') return { page, y: 0 }

      /* The page's own viewport does the conversion, because a destination is
         in PDF space — up from the bottom of the crop box, and turned with
         whatever rotation the page carries and whatever the reader has added. */
      const proxy = state.pages[page - 1]?.proxy || await state.doc.getPage(page)
      const view = proxy.getViewport({ scale: 1, rotation: proxy.rotate + state.turn })
      const left = kind === 'XYZ' && typeof target[2] === 'number' ? target[2] : 0
      return { page, y: clamp01(view.convertToViewportPoint(left, top)[1] / view.height) }
    } catch {
      return { page: 0, y: 0 }
    }
  }

  /* ------------------------------------------------------------- finding

     ⌘F inside a document. The words are already there — every page's text is
     asked for to build the selectable layer over it — so the search is a walk
     of that same content rather than anything new, and the answer is a page
     number and a place down it, which is exactly what `goToPage` takes.

     The text of each page is kept once it has been read: a search is a pass
     over the whole document, and typing in the box is a search per keystroke.
     Cleared with the document, like everything else keyed to it. */
  const pageText = new Map()

  async function textOf (n) {
    if (pageText.has(n)) return pageText.get(n)
    const epoch = state.epoch
    const pending = (async () => {
      let out = /** @type {{display:string, search:string,
        items:Array<{at:number, y:number, span?:number, x?:number, w?:number}>}} */ (
        { display: '', search: '', items: [] })
      try {
        const page = state.pages[n - 1]
        const proxy = page?.proxy || await state.doc.getPage(n)
        if (epoch !== state.epoch) return out
        /* The page's own shape, learnt here and kept — the words of a page and
           its dimensions arrive together, and the dimensions used to be thrown
           away. Everything that aims at a point *down* a page divides by them,
           so a search hit on a page nobody had scrolled to yet was measured
           against page one's height and scrolled to the top of its page
           instead of to the match. The proxy is kept for the same reason: it is
           what turns the hit's PDF coordinates into a place on the page. */
        if (page) {
          if (!page.proxy) page.proxy = proxy
          if (!page.unit) { page.unit = unitOf(proxy); size(page) }
        }

        const content = await proxy.getTextContent()
        // The document may have been closed or swapped while the worker answered.
        if (epoch !== state.epoch) return out
        /* Where each item begins in the joined string, so a hit found in the
           normalized string can be traced back to the item — and therefore to
           the place on the page — that carries it. */
        const items = /** @type {Array<{at:number, y:number}>} */ ([])
        const extents = /** @type {Array<{x:number, w:number}>} */ ([])
        let text = ''
        for (const item of content.items) {
          if (typeof item.str !== 'string') continue
          items.push({ at: text.length, y: item.transform?.[5] })
          /* Where along the line the run starts and how wide it is, both in the
             page's own space. The height alone could only ever mark the line a
             hit was on; with these the words themselves can be boxed. */
          extents.push({ x: item.transform?.[4], w: item.width })
          text += item.str
          if (item.hasEOL) text += '\n'
        }
        out = searchablePage(text, items)
        /* `searchablePage` answers with one entry per item it was handed, in
           the order it was handed them, with the offsets moved into the
           flattened string — so the extents line up by index. Each item is also
           told how long it is in that flattened string, which is what turns a
           character offset inside it into a distance along the line. */
        for (const [at, item] of out.items.entries()) {
          const next = out.items[at + 1]
          item.span = (next ? next.at : out.display.length) - item.at
          Object.assign(item, extents[at])
        }
      } catch { /* an unreadable page finds nothing */ }
      return out
    })()
    // Stored before awaiting so overlapping queries share the extraction.
    pageText.set(n, pending)
    const out = await pending
    if (epoch !== state.epoch && pageText.get(n) === pending) pageText.delete(n)
    return out
  }

  /**
   * Every place a query appears, in reading order.
   *
   * Whitespace-flattened, because a phrase that runs across a line break in a
   * two-column paper is still the phrase the reader typed — and case-insensitive
   * unless asked otherwise, since a printed page capitalises for typography as
   * often as for meaning. Capped: a one-letter query in a four-hundred-page book
   * has tens of thousands of hits and nobody is walking them.
   */
  let findGeneration = 0

  /**
   * @param onProgress  told after every page that added something, with the
   *        hits so far. The first search of a long book is a walk of every page
   *        — the text has to be asked for, page by page, and the pages are only
   *        cached once — and until this existed the bar showed nothing at all
   *        until the last page had been read. A reader searching a
   *        four-hundred-page book got a blank tally for several seconds and no
   *        sign that anything was happening, which is indistinguishable from a
   *        search that has failed. Optional, so a caller that only wants the
   *        answer can go on awaiting it.
   */
  async function find (query, { limit = 500, caseSensitive = false, onProgress = /** @type {any} */ (null) } = {}) {
    const generation = ++findGeneration
    const typed = String(query || '').replace(/\s+/g, ' ').trim()
    // The same fold the page went through, or the two disagree about the
    // characters that do not fold one-for-one — see foldCase.
    const needle = caseSensitive ? typed : foldCase(typed)
    if (!state.doc || !needle) { state.hits = []; return [] }

    const epoch = state.epoch
    const hits = []
    const total = state.pages.length
    for (let n = 1; n <= total && hits.length < limit; n++) {
      const { display, search, items } = await textOf(n)
      /* Abandoned the moment the reader types on, closes the document or asks
         for a different search: the check is per page, so a walk nobody wants
         stops within one page rather than reading to the end of the book. What
         it has read is not wasted — `pageText` keeps every page it extracted,
         so the search that replaced this one carries straight on. */
      if (epoch !== state.epoch || generation !== findGeneration) return []
      state.hits = hits

      /* `search` is the page folded to lower case, kept alongside `display` so
         the common search does no work per keystroke; matching case is a search
         of the page as it is actually written. Both are the same string
         otherwise — same length, same offsets — so a hit found in either points
         at the same place. */
      const hay = caseSensitive ? display : search
      let at = hay.indexOf(needle)
      const had = hits.length
      while (at !== -1 && hits.length < limit) {
        hits.push({ page: n, at, length: needle.length, ...placeHit(items, at, needle.length, n) })
        at = hay.indexOf(needle, at + needle.length)
      }
      if (onProgress && hits.length !== had) {
        onProgress({ hits: [...hits], scanned: n, pages: total, done: false })
      }
    }
    state.hits = hits
    if (onProgress) onProgress({ hits: [...hits], scanned: total, pages: total, done: true })
    return hits
  }

  /** Abandons a walk nobody is waiting for — a bar being closed, a document
   *  being put away. The walk itself notices at its next page. */
  const stopFind = () => { findGeneration++ }

  /**
   * Where a hit sits on its page: how far down it, and how far along the line
   * the matched words themselves are.
   *
   * The band used to claim the whole line, because the height was all that was
   * known. The text items carry a position and a width as well, so the words
   * can be found by proportion inside the run they fall in — see `hitExtent`,
   * which is the arithmetic — and the page's own viewport turns that from PDF
   * space, which runs up from the bottom of the crop box, into the fractions
   * the mark is drawn from.
   */
  function placeHit (items, at, length, n) {
    const extent = hitExtent(items, at, length)
    if (!extent || typeof extent.y !== 'number') return { y: 0 }
    const page = state.pages[n - 1]
    const proxy = page?.proxy

    if (proxy) {
      const view = proxy.getViewport({ scale: 1, rotation: proxy.rotate + state.turn })
      const from = view.convertToViewportPoint(extent.x, extent.y)
      const to = view.convertToViewportPoint(extent.x + extent.w, extent.y)
      return {
        y: clamp01(Math.min(from[1], to[1]) / view.height),
        x: clamp01(Math.min(from[0], to[0]) / view.width),
        w: clamp01(Math.abs(to[0] - from[0]) / view.width)
      }
    }

    /* No proxy — a page whose text came from somewhere other than this viewer's
       own extraction. The height alone, worked out the flat way: PDF text
       coordinates run up from the bottom of the page, so the fraction is turned
       over to match the way the viewer scrolls. */
    const height = page?.unit?.height
    if (!height) return { y: 0 }
    return { y: clamp01(1 - extent.y / height) }
  }

  /** The flash itself, on every rectangle the mark has on screen. Says whether
   *  there were any — a mark on an undrawn page has none yet. */
  function flash (id) {
    const divs = host.querySelectorAll(`.pdf-mark[data-mark="${id}"]`)
    for (const div of divs) restart(div, 'is-found')
    return divs.length > 0
  }

  /** Scrolls to a highlight and flashes it, so a click in the list lands
   *  somewhere the eye can find on a page of prose. */
  async function goToMark (id) {
    const mark = state.marks.find((m) => m.id === id)
    const rect = mark?.rects[0]
    if (!rect) return

    const page = state.pages[rect.page - 1]
    if (!page) return
    state.flashing = null
    /* The same measurement a search hit needs, and for the same reason: a
       highlight is a fraction down its page, and until that page has been drawn
       its wrapper is page one's height. On a book of even pages the aim was
       right by luck; on anything with a plate or a landscape appendix in it,
       clicking a passage in the sidebar landed a paragraph or a page away. */
    await measure(page)
    if (state.pages[rect.page - 1] !== page) return

    const top = page.wrap.offsetTop + rect.y * page.wrap.offsetHeight
    host.scrollTo({ top: Math.max(0, top - host.clientHeight / 3) })
    refresh()

    /* After the frame the scroll settles on. A page that has yet to render has
       no mark to flash — its id is left for `paintMarks`, which fires the
       flash the moment that page's marks reach the DOM. */
    requestAnimationFrame(() => {
      if (!flash(id)) state.flashing = id
    })
  }

  /** `+1`, `-1`, a scale, or one of the three fits: `'fit'` (the width),
   *  `'height'`, or `'page'` (both). */
  function setZoom (next) {
    if (!state.doc) return state.zoom
    if (FITS.has(next)) {
      state.zoom = next
    } else if (next === 1 || next === -1) {
      const current = FITS.has(state.zoom) ? state.scale : /** @type {number} */ (state.zoom)
      const steps = next > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse()
      state.zoom = steps.find((s) => (next > 0 ? s > current + 0.01 : s < current - 0.01)) ?? current
    } else if (typeof next === 'number') {
      state.zoom = Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], next))
    }
    markFit()
    rescale()
    return state.zoom
  }

  /**
   * Turns the whole document a quarter at a time — `1` clockwise, `-1` back —
   * on top of whatever rotation its pages already carry. For the scanned book
   * bound sideways, which is the case that makes this worth having at all.
   *
   * Remembered per document for as long as the app is open, the way the zoom
   * is: a fact about how this file has to be read, not a mood, and not worth a
   * file in the vault either.
   */
  function rotate (dir = 1) {
    if (!state.doc) return state.turn
    state.turn = quarter(state.turn + 90 * (dir < 0 ? -1 : 1))
    turns.set(state.path, state.turn)
    /* Every size this module knows swaps its axes on the spot, so the layout
       takes its new shape this frame instead of page by page as renders land —
       a quarter turn exchanges width and height exactly, no worker needed. */
    state.base = swap(state.base, 90)
    for (const page of state.pages) if (page.unit) page.unit = swap(page.unit, 90)
    /* The rail's bitmaps are all the old way up. Freed rather than stretched:
       a sideways thumbnail is not a rough version of the right one. */
    for (const row of thumbRows) {
      if (!row.drawn) continue
      row.gen++
      row.canvas.width = row.canvas.height = 0
      row.drawn = false
      row.el.classList.remove('is-drawn')
    }
    rescale({ relayer: true })
    queueThumbs()
    return state.turn
  }

  /** The night rendering toggle: pages inverted for reading in the dark.
   *  A preference, so it is remembered — see `nightOn` for why it is off by
   *  default. Pure CSS, so no page has to redraw. */
  function setNight (on) {
    nightOn = !!on
    remember(NIGHT_KEY, nightOn)
    host.classList.toggle('is-night', nightOn)
    return nightOn
  }

  /** The thumbnail rail, shown or put away — remembered like the night toggle,
   *  because a reader who navigates by the shape of pages always does. */
  function setThumbs (on) {
    thumbsOn = !!on
    remember(THUMBS_KEY, thumbsOn)
    buildThumbs()
    queueThumbs()
    return thumbsOn
  }

  /* The keys that move by pages rather than by lines. On the scroller itself —
     it is the focused element while a document is being read — and bare, like
     the viewer's other keys: there is nothing on a page to type into, so Home
     does not have to mean anything but the beginning. PageUp and PageDown step
     whole pages rather than window-heights because in a paged document that is
     what the keys' names promise. */
  host.addEventListener('keydown', (event) => {
    if (!state.doc || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.target instanceof Element &&
        event.target.closest('input, textarea, [contenteditable]')) return

    if (event.key === 'Home') { event.preventDefault(); goToPage(1) }
    else if (event.key === 'End') { event.preventDefault(); goToPage(state.pages.length) }
    else if (event.key === 'PageDown') { event.preventDefault(); goToPage(state.at + 1) }
    else if (event.key === 'PageUp') { event.preventDefault(); goToPage(state.at - 1) }
  })

  window.addEventListener('beforeunload', () => {
    if (!state.saveTimer) return
    clearTimeout(state.saveTimer)
    // Fire-and-forget: the window is going, and an unsaved highlight is worse
    // than a write nobody waits for.
    api.pdf.marks.save(state.path, state.marks)
  })

  return {
    open,
    close,
    flush,
    goToPage,
    goToOutline,
    goToMark,

    /**
     * Every place a phrase appears in the open document, as `{ page, y }` in
     * reading order — `y` being how far down its page a hit sits, which is what
     * `goToPage` and `markHit` both take as their second argument.
     */
    find,
    /* Where the hit the reader is standing on is, and taking the mark off again
       when the search is done with. Kept here rather than in the find bar
       because it is drawn into a page, and the pages are this module's. */
    markHit,
    clearHit,
    /* Abandons the walk `find` is in the middle of — for a bar being closed
       with a long first search still reading pages. */
    stopFind,
    setZoom,
    /* A quarter turn at a time, and what the document currently stands at —
       0, 90, 180 or 270, clockwise from the way its publisher set it. */
    rotate,
    turn: () => state.turn,
    /* The night rendering and the thumbnail rail, each a toggle that answers
       with where it ended up, and each remembered — see their setters. */
    setNight,
    night: () => nightOn,
    setThumbs,
    thumbs: () => thumbsOn,
    setTool,
    setPen,
    tool: () => state.tool,
    pen: () => state.pen,
    zoom: () => state.zoom,
    page: () => state.at,
    pages: () => state.pages.length,
    marks: () => state.marks.map((m) => ({ ...m })),
    removeMark,
    undo,
    redo,

    /**
     * Where the reader is, for the tab's history to bring them back to — and
     * null once the document has gone, because a closed viewer has no place in
     * it. `close` resets `at` to 1 and empties the host, so an answer given
     * after it is page one every time, which is precisely the wrong page to
     * write into a history entry.
     */
    place: () => (state.doc ? { page: state.at, top: host.scrollTop } : null),

    /**
     * What the reader has in hand for the copilot: the live selection if
     * there is one, otherwise the last thing they selected or marked. Kept
     * because reaching the message box costs them the selection itself.
     */
    quote: () => {
      const selection = window.getSelection()
      const text = selection ? selection.toString().replace(/\s+/g, ' ').trim() : ''
      if (text && selection && selection.rangeCount && host.contains(selection.anchorNode)) {
        state.quote = { text, page: state.at }
      }
      return state.quote ? { ...state.quote } : null
    }
  }
}
