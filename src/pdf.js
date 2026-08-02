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
import { ZOOM_STEPS } from './zoom.js'

/* pdf.js is the largest thing the app can load and most sessions never open a
   document, so it is fetched the first time one is opened rather than sitting
   in the bundle everything waits on. Every use of it is downstream of `open`,
   which awaits this — by the time a page renders or a text layer is built, the
   module is here. */
let pdfjsLib = null

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
  useWorkerFetch: true,
  /* The page's CSP has no `unsafe-eval`, so the paths in pdf.js that would
     compile a function have to be told not to. They have a slower fallback. */
  isEvalSupported: false
}

/** The pens. Named rather than given as colour values, so the palette is one
 *  edit in the stylesheet and a stored highlight keeps meaning what it said.
 *  Exported because the toolbar draws the same palette the popups do, and two
 *  lists of colours would be two lists to keep in step. */
export const MARK_COLORS = [
  { id: 'yellow', label: 'Yellow' },
  { id: 'rose', label: 'Rose' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
  { id: 'violet', label: 'Violet' }
]

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
 */
export async function renderPageToCanvas (proxy, scale, { settle = (p) => p } = {}) {
  const viewport = proxy.getViewport({ scale })
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

const uid = () => `h${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

/**
 * @param {object} o
 * @param {HTMLElement} o.host    the scrolling element the pages go in
 * @param {object} o.api          the preload bridge
 * @param {(info:object)=>void} o.onDoc     told once a document is open
 * @param {(page:number)=>void} o.onPage    told which page is being read
 * @param {()=>void} o.onMarks              told when the highlight set changes
 * @param {()=>void} o.onZoom               told when the viewer zooms itself
 * @param {()=>void} o.onStuck              the document stopped answering
 * @param {(quote:object)=>void} o.onAsk    the reader wants the copilot
 * @param {()=>void} o.onTool               told when the tool or the pen changes
 * @param {(message:string)=>void} o.onError  something failed that the reader
 *                                            would otherwise learn from a lost
 *                                            highlight much later
 */
export function mountPdf ({
  host, api,
  onDoc = () => {}, onPage = () => {}, onMarks = () => {}, onZoom = () => {},
  onStuck = () => {}, onAsk = () => {}, onTool = () => {}, onError = () => {}
}) {
  const state = {
    path: '',
    doc: null,
    pages: [],          // one entry per page, in order
    scale: 1,           // what pages are currently drawn at
    zoom: 'fit',        // 'fit' or a number from ZOOM_STEPS
    base: null,         // page 1's unscaled viewport, the layout's yardstick
    marks: [],
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
    past: [],
    future: [],
    /* The last thing selected, kept after the selection itself is gone: asking
       the copilot means clicking into the message box, which clears it. */
    quote: null,
    /* A highlight the reader jumped to before its page had been drawn: the id
       waits here for `paintMarks` to put the mark on screen, and the flash
       fires then. Cleared once fired, or when they navigate somewhere else. */
    flashing: null,
    /* Bumped on every open. An await that resolves after the reader has moved
       on belongs to a document that is no longer on screen, and every one of
       them checks this before touching the DOM. */
    epoch: 0,
    saveTimer: null,
    /* Rendering is strictly serial. `queue` is the pages worth drawing, nearest
       the fold first, and `drawing` is the one in flight — the two together are
       the whole scheduler. */
    queue: [],
    drawing: null,
    inFlight: null,     // the promise of that render, so a close can wait on it
    stuck: false,       // a render went quiet; the document needs parsing again
    recovering: false,
    recoveries: 0
  }

  /* The pages live in a sheet of their own inside the scroller, so the popups
     can be positioned against the scroller without the page flow moving them. */
  const sheet = document.createElement('div')
  sheet.className = 'pdf-sheet'
  host.replaceChildren(sheet)

  /* ------------------------------------------------------------- geometry */

  /**
   * Fit is edge-to-edge: the sheet gives up its gutter so the page meets the
   * window on both sides, which is what the stylesheet's `is-fit` does. Set
   * before any scale is worked out, because `scaleFor` reads that gutter back.
   */
  function markFit () {
    host.classList.toggle('is-fit', state.zoom === 'fit')
  }

  /** The scale a page is drawn at: fit-to-width, or the chosen step. */
  function scaleFor () {
    if (!state.base) return 1
    if (state.zoom !== 'fit') return state.zoom
    // The gutter either side is the stylesheet's, read back rather than
    // duplicated here, so the page cannot be drawn wider than its own margin.
    const style = getComputedStyle(sheet)
    const gutter = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    /* Floored to a whole pixel: the page's width is rounded when it is laid
       out, and a fit that came to a fraction over the window would round up
       into a scroll bar the reader never asked for. */
    const room = Math.floor(host.clientWidth - gutter)
    /* Floored: with the sidebar, the outline and the copilot all open there
       may be two hundred pixels left, and a page shrunk to fit that is not a
       page anyone can read. Below the floor the sheet scrolls sideways instead. */
    return Math.max(MIN_FIT, Math.min(4, room / state.base.width))
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

      const number = document.createElement('span')
      number.className = 'pdf-page-number'
      number.textContent = String(n)

      wrap.append(canvas, marks, text, number)
      state.pages.push({
        n, wrap, canvas, marks, text,
        unit: null,      // the page's size at scale 1, once it is known
        proxy: null,
        drawn: 0,        // the scale the canvas holds, 0 when it holds nothing
        layer: null,     // the text layer, held so its stream can be closed
        hasText: false,  // whether the text layer is built; it needs no rebuild
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
        const unit = page.proxy.getViewport({ scale: 1 })
        page.unit = { width: unit.width, height: unit.height }
        size(page)
      }

      // `watch` is the per-page timeout: a render that never comes back would
      // otherwise leave the reader on a page that stays blank forever.
      const { canvas, viewport } = await renderPageToCanvas(page.proxy, scale, { settle: watch })
      if (stale()) return

      /* Drawn off-screen and swapped in, so the page never shows a half-painted
         canvas or a blank one: what is on screen goes on being the old bitmap,
         stretched, until the moment there is a better one. */
      canvas.className = 'pdf-canvas'
      page.canvas.replaceWith(canvas)
      page.canvas = canvas
      page.drawn = scale
      state.recoveries = 0
      size(page)
      page.wrap.classList.add('is-drawn')

      await layText(page, viewport, stale)
      if (stale()) return
      paintMarks(page)
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
    let timer = null
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

  /** Gives back the canvas of a page nobody is near. */
  function undraw (page) {
    // Left alone while it is drawing: resizing the canvas under a live render
    // would be the same mistake as cancelling it. The refresh that follows will
    // find the page far away and free it then.
    if (page === state.drawing) return
    page.gen++
    if (page.drawn) {
      page.canvas.width = page.canvas.height = 0
      page.drawn = 0
      size(page)
    }
    dropText(page)
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

    for (const page of state.pages) {
      const from = page.wrap.offsetTop
      const to = from + page.wrap.offsetHeight

      if (to > near.from && from < near.to) {
        if (page.drawn !== state.scale && page.failed !== state.scale) {
          // Sorted below by how far the page is from the middle of the screen,
          // so the reader always gets what they are looking at first.
          wanted.push({ page, distance: Math.abs((from + to) / 2 - middle) })
        }
      } else if (page.drawn && (to < keep.from || from > keep.to)) undraw(page)

      /* The page being read is the one showing most of itself, not the first
         one intersecting the fold — on a two-page-wide fold those differ, and
         the wrong answer makes the page number flicker while scrolling. */
      const overlap = Math.min(to, top + height) - Math.max(from, top)
      if (overlap > bestOverlap) { bestOverlap = overlap; reading = page.n }
    }

    wanted.sort((a, b) => a.distance - b.distance)
    state.queue = wanted.map((w) => w.page)
    pump()

    if (reading !== state.at) {
      state.at = reading
      onPage(reading)
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
    const page = state.queue.shift()
    if (!page) return
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
  let refreshTick = null
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
   * Coalesced onto a frame: a drag delivers a size on every mouse move, and each
   * one would otherwise be a full re-render of every visible page.
   */
  let fitTick = null
  const observer = new ResizeObserver(() => {
    if (!state.doc || state.zoom !== 'fit' || fitTick) return
    fitTick = requestAnimationFrame(() => {
      fitTick = null
      const next = scaleFor()
      // A hair either way is not worth repainting every page over.
      if (Math.abs(next - state.scale) > 0.004) rescale()
    })
  })
  observer.observe(host)

  /**
   * Pinch, and ⌘-scroll, zoom the document rather than the app.
   *
   * A trackpad pinch arrives as a wheel event with ctrlKey set, which is also
   * what the window's own zoom listens for — so this has to say it has handled
   * it, or a pinch over a PDF would zoom the interface around it.
   */
  host.addEventListener('wheel', (event) => {
    if (!state.doc || !(event.ctrlKey || event.metaKey)) return
    event.preventDefault()

    /* Continuous rather than stepped: a pinch is a continuous gesture, and
       snapping it to the stops the buttons use makes it feel broken. */
    const current = state.zoom === 'fit' ? state.scale : state.zoom
    const factor = Math.exp(-event.deltaY / 220)
    setZoom(Math.round(current * factor * 1000) / 1000)
    onZoom()
  }, { passive: false })

  /**
   * Redraws the document at the current zoom, holding the reader's place.
   *
   * The place is kept as a fraction of the document rather than in pixels: the
   * whole point of a zoom is that the pixel heights change underneath it.
   */
  function rescale () {
    const before = host.scrollHeight - host.clientHeight
    const ratio = before > 0 ? host.scrollTop / before : 0

    state.scale = scaleFor()
    for (const page of state.pages) {
      // Abandons whatever was in flight rather than cancelling it: its result is
      // for the old size and must not be mistaken for this one — see `draw`.
      page.gen++
      page.drawn = 0
      page.failed = 0
    }
    // Every page resized on this frame; the bitmaps catch up from the queue.
    layOut()

    const after = host.scrollHeight - host.clientHeight
    host.scrollTop = Math.round(ratio * Math.max(0, after))
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

  /** Draws one page's highlights. Percentages, so a zoom needs no redraw. */
  function paintMarks (page) {
    const frag = document.createDocumentFragment()
    let pending = false
    for (const { mark, rect } of marksOn(page.n)) {
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

  const repaintMarks = () => { for (const page of state.pages) paintMarks(page) }

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
    return wrap ? state.pages[Number(wrap.dataset.page) - 1] : null
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
  function showPop (at, { pick, current, copy, copyHint, extra = [] }) {
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
    if (!state.doc || event.button !== 0) return
    // A click that lands in the popup is the popup's own business.
    if (pop.contains(event.target)) return

    const selection = window.getSelection()
    const text = selection ? selection.toString().replace(/\s+/g, ' ').trim() : ''

    if (text && selection.rangeCount && host.contains(selection.anchorNode)) {
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
     over it is what a selection is made from. So the cursor is the only hint,
     and it comes from hit-testing rather than from the element under the mouse. */
  let hoverTick = null
  host.addEventListener('mousemove', (event) => {
    if (!state.marks.length || hoverTick) return
    hoverTick = requestAnimationFrame(() => {
      hoverTick = null
      const page = pageOf(event.target)
      const mark = page ? markAt(page, event.clientX, event.clientY) : null
      host.classList.toggle('on-mark', Boolean(mark))
      for (const div of host.querySelectorAll('.pdf-mark.is-hot')) div.classList.remove('is-hot')
      if (!mark) return
      for (const div of host.querySelectorAll(`.pdf-mark[data-mark="${mark.id}"]`)) {
        div.classList.add('is-hot')
      }
    })
  })

  host.addEventListener('mousedown', (event) => {
    if (!pop.hidden && !pop.contains(event.target)) hidePop()
  })

  /* --------------------------------------------------------- the document */

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
    let doc
    try {
      doc = await loading.promise
    } catch (err) {
      host.classList.remove('is-loading')
      if (epoch !== state.epoch) return null
      throw new Error(err?.name === 'PasswordException'
        ? 'That PDF is password-protected.'
        : 'That PDF could not be read.')
    }
    if (epoch !== state.epoch) { doc.destroy(); return null }

    state.doc = doc
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
    state.base = first.getViewport({ scale: 1 })
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
    refresh()

    const outline = await contents(doc)
    if (epoch !== state.epoch) return null

    const info = { path, pages: doc.numPages, page: state.at, outline }
    onDoc(info)
    onMarks()
    return info
  }

  /**
   * The document's own bookmarks, flattened with their depth.
   *
   * Destinations are resolved to page numbers here rather than when one is
   * clicked, because that answer never changes and the click should not wait
   * for the worker.
   */
  async function contents (doc) {
    let tree
    try { tree = await doc.getOutline() } catch { return [] }
    if (!tree?.length) return []

    const out = []
    const walk = async (items, level) => {
      for (const item of items) {
        if (out.length > 400) return   // a table of contents, not a database
        out.push({
          title: item.title?.trim() || 'Untitled',
          level,
          page: await pageFor(doc, item.dest),
          /* Kept as the document wrote it, for `goToOutline` to resolve when the
             entry is clicked: it names a point on the page, and the page number
             alone throws away the half of that answer the reader can see. */
          dest: item.dest ?? null
        })
        if (item.items?.length) await walk(item.items, level + 1)
      }
    }
    await walk(tree, 1)
    return out
  }

  async function pageFor (doc, dest) {
    try {
      const target = typeof dest === 'string' ? await doc.getDestination(dest) : dest
      if (!Array.isArray(target)) return 1
      return (await doc.getPageIndex(target[0])) + 1
    } catch {
      return 1
    }
  }

  /** Stored highlights, checked before anything is drawn from them. A sidecar
   *  is a file on disk that anything could have written. */
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
    const doc = state.doc

    Object.assign(state, {
      path: '', doc: null, pages: [], marks: [], base: null, at: 1, quote: null, flashing: null,
      // Not the tool or the pen — those are the reader's, not the document's.
      past: [], future: []
    })
    hidePop()
    sheet.replaceChildren()
    host.classList.remove('on-mark')
    // The words belonged to that document; the next one has its own.
    pageText.clear()
    try { await doc.destroy() } catch { /* going away regardless */ }
  }

  /* ------------------------------------------------------------ moving about */

  /**
   * @param {number} n    the page to bring into view
   * @param {number} [y]  how far down that page to stop, 0–1
   */
  function goToPage (n, y = 0) {
    if (!state.doc) return
    state.flashing = null   // going somewhere else is a change of mind
    const page = state.pages[Math.min(Math.max(1, Math.round(n)), state.pages.length) - 1]
    if (!page) return
    const top = page.wrap.offsetTop + y * page.wrap.offsetHeight
    host.scrollTo({ top: Math.max(0, top - 12) })
    refresh()
  }

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
  async function goToOutline (entry) {
    if (!state.doc) return
    const epoch = state.epoch
    const y = await destOffset(entry?.dest, entry?.page)
    // The document may have been closed or swapped while the worker answered.
    if (epoch !== state.epoch) return
    goToPage(entry?.page ?? 1, y)
  }

  /**
   * Where on its page a destination points, as a fraction of the page's height,
   * or 0 for one that names no point of its own.
   *
   * Only some destinations carry a y: /XYZ names a corner and /FitH a top edge,
   * while /Fit and friends mean the whole page and are already answered by
   * scrolling to it.
   */
  async function destOffset (dest, n) {
    try {
      if (!dest) return 0
      const target = typeof dest === 'string' ? await state.doc.getDestination(dest) : dest
      if (!Array.isArray(target)) return 0

      const kind = target[1]?.name
      const top = kind === 'XYZ' ? target[3]
        : kind === 'FitH' || kind === 'FitBH' ? target[2]
          : null
      if (typeof top !== 'number') return 0

      /* The page's own viewport does the conversion, because a destination is
         in PDF space — up from the bottom of the crop box, and turned with
         whatever rotation the page carries. */
      const page = state.pages[n - 1]
      const proxy = page?.proxy || await state.doc.getPage(n)
      const view = proxy.getViewport({ scale: 1 })
      return clamp01(view.convertToViewportPoint(0, top)[1] / view.height)
    } catch {
      return 0
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
    let out = { text: '', items: [] }
    try {
      const proxy = state.pages[n - 1]?.proxy || await state.doc.getPage(n)
      const content = await proxy.getTextContent()
      // The document may have been closed or swapped while the worker answered.
      if (epoch !== state.epoch) return out
      /* Where each item begins in the joined string, so a hit found in the
         string can be traced back to the item — and therefore to the height on
         the page — that carries it. */
      const items = []
      let text = ''
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue
        items.push({ at: text.length, y: item.transform?.[5] })
        text += item.str
        if (item.hasEOL) text += '\n'
      }
      out = { text, items }
    } catch { /* an unreadable page finds nothing */ }
    if (epoch === state.epoch) pageText.set(n, out)
    return out
  }

  /**
   * Every place a query appears, in reading order.
   *
   * Case-insensitive and whitespace-flattened, because a phrase that runs
   * across a line break in a two-column paper is still the phrase the reader
   * typed. Capped: a one-letter query in a four-hundred-page book has tens of
   * thousands of hits and nobody is walking them.
   */
  async function find (query, { limit = 500 } = {}) {
    const needle = String(query || '').replace(/\s+/g, ' ').trim().toLowerCase()
    if (!state.doc || !needle) return []

    const epoch = state.epoch
    const hits = []
    for (let n = 1; n <= state.pages.length && hits.length < limit; n++) {
      const { text, items } = await textOf(n)
      if (epoch !== state.epoch) return []
      const hay = text.replace(/\s+/g, ' ').toLowerCase()

      let at = hay.indexOf(needle)
      while (at !== -1 && hits.length < limit) {
        hits.push({
          page: n,
          at,
          // A line of context either side, tidied, for the results list.
          excerpt: text.replace(/\s+/g, ' ').slice(Math.max(0, at - 40), at + needle.length + 40).trim(),
          y: offsetOf(items, at, n)
        })
        at = hay.indexOf(needle, at + needle.length)
      }
    }
    return hits
  }

  /* How far down its page a hit sits, 0–1, from the text item it falls in.
     PDF text coordinates run up from the bottom of the page, so the fraction is
     turned over to match the way the viewer scrolls. */
  function offsetOf (items, at, n) {
    let found = null
    for (const item of items) {
      if (item.at > at) break
      found = item
    }
    if (typeof found?.y !== 'number') return 0
    // `unit` is the page's size at scale 1, filled in when the page is first
    // measured; a page nobody has scrolled to yet has none, and 0 puts the jump
    // at its top, which is the right answer in the absence of a better one.
    const height = state.pages[n - 1]?.unit?.height
    if (!height) return 0
    return clamp01(1 - found.y / height)
  }

  /** The flash itself, on every rectangle the mark has on screen. Says whether
   *  there were any — a mark on an undrawn page has none yet. */
  function flash (id) {
    const divs = host.querySelectorAll(`.pdf-mark[data-mark="${id}"]`)
    for (const div of divs) {
      div.classList.remove('is-found')
      // Reading offsetWidth restarts the animation rather than skipping it.
      void div.offsetWidth
      div.classList.add('is-found')
    }
    return divs.length > 0
  }

  /** Scrolls to a highlight and flashes it, so a click in the list lands
   *  somewhere the eye can find on a page of prose. */
  function goToMark (id) {
    const mark = state.marks.find((m) => m.id === id)
    const rect = mark?.rects[0]
    if (!rect) return

    const page = state.pages[rect.page - 1]
    if (!page) return
    state.flashing = null
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

  /** `+1`, `-1`, a number of pages, or `'fit'`. */
  function setZoom (next) {
    if (!state.doc) return state.zoom
    if (next === 'fit') {
      state.zoom = 'fit'
    } else if (next === 1 || next === -1) {
      const current = state.zoom === 'fit' ? state.scale : state.zoom
      const steps = next > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse()
      state.zoom = steps.find((s) => (next > 0 ? s > current + 0.01 : s < current - 0.01)) ?? current
    } else if (typeof next === 'number') {
      state.zoom = Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], next))
    }
    markFit()
    rescale()
    return state.zoom
  }

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
    goToPage,
    goToOutline,
    goToMark,

    /**
     * Every place a phrase appears in the open document, as
     * `{ page, y, excerpt }` in reading order — `y` being how far down its page
     * a hit sits, which is what `goToPage` takes as its second argument.
     */
    find,
    setZoom,
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
      if (text && selection.rangeCount && host.contains(selection.anchorNode)) {
        state.quote = { text, page: state.at }
      }
      return state.quote ? { ...state.quote } : null
    }
  }
}
