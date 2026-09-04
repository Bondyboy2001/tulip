/**
 * A PDF standing inside a note.
 *
 * The full viewer in pdf.js owns a whole tab — highlights, zoom, an outline.
 * An *embedded* PDF is a quotation, not a workspace: the pages, readable, in a
 * scrollable box, with the file's name as the way through to the real viewer.
 * So this is deliberately the small half of that module: same pdf.js, same
 * data URLs, none of the machinery a tab needs.
 *
 * Pages are drawn lazily as they scroll into the box, one at a time per
 * document — the render discipline pdf.js demands (see src/pdf.js on wedged
 * workers) — and each document is destroyed the moment its element leaves the
 * page, because a forgotten document is a worker that never exits.
 */

/* How tall the box is unless the note says otherwise — enough for most of an
   A4 page at column width, small enough that the note stays a note — lives in
   the stylesheet, as the fallback of `--embed-pdf-h`. Keeping it there is what
   lets a container say the document should fill it instead. */

/**
 * The element for an embedded PDF, wired to clean up after itself.
 *
 * `element.embedDestroy` is the teardown; both views call it — the editor from
 * its widget's `destroy`, the reading view before it re-renders. Everything
 * async checks `dead` before touching the DOM.
 */
export function renderPdfEmbed (spec, onReady = () => {}, fileChip) {
  /** @type {any} */
  const box = document.createElement('figure')
  box.className = 'embed-pdf'
  if (spec.width) box.style.width = `${spec.width}px`

  const head = document.createElement('div')
  head.className = 'embed-pdf-head'

  /* The name opens the document in its own tab — the same `data-asset` path
     every plain file chip already takes, so neither view needs new wiring. */
  const name = document.createElement('a')
  name.className = 'embed-pdf-name'
  name.textContent = spec.label
  name.dataset.asset = spec.path
  name.title = 'Open in its own tab'

  const count = document.createElement('span')
  count.className = 'embed-pdf-count'

  head.append(name, count)

  const pages = document.createElement('div')
  pages.className = 'embed-pdf-pages'
  /* Only what the note asked for. The ordinary height is the stylesheet's
     default and a container that wants the document to fill it — the side
     pane — overrides the property there; writing the default inline would
     outrank both, and the pane would need `!important` to get out from under
     a value nobody chose. */
  if (spec.height) pages.style.setProperty('--embed-pdf-h', `${spec.height}px`)

  box.append(head, pages)

  /**
   * @type {{dead: boolean, doc: any, loading: any,
   *         watcher: IntersectionObserver | null, sizer: ResizeObserver | null,
   *         opening: boolean, base: any, width: number, scale: number,
   *         drawing: boolean, queue: {wrap: any, n: number}[],
   *         queued: Set<any>, visible: Set<any>, runtime: any, inFlight: any}}
   */
  const state = {
    dead: false,
    doc: null,
    /* What actually closes the document — a document proxy has no `destroy` of
       its own; the loading task it came from does, and it takes the worker and
       the buffer with it. Same reasoning as src/pdf-text.js. */
    loading: null,
    watcher: null,   // the IntersectionObserver over page wrappers
    sizer: null,     // the ResizeObserver watching the box's width
    opening: false,
    base: null,      // page 1 at scale 1, the shape everything is fitted to
    width: 0,        // the width the current scale was computed from
    scale: 1,
    drawing: false,
    queue: [],
    queued: new Set(),
    visible: new Set(),
    runtime: null,    // set when the document opens — see below
    inFlight: null    // the draw currently awaited, if any
  }

  const releaseCanvas = (canvas) => {
    canvas.width = 0
    canvas.height = 0
  }

  const clearPage = (wrap) => {
    const canvas = wrap.querySelector('canvas')
    if (!canvas) return
    releaseCanvas(canvas)
    wrap.replaceChildren()
    wrap.classList.remove('is-drawn')
  }

  box.embedDestroy = () => {
    state.dead = true
    state.watcher?.disconnect()
    state.sizer?.disconnect()
    const loading = state.loading
    state.doc = null
    state.loading = null
    // After the render in flight settles; destroying under one wedges pdf.js.
    if (loading) {
      Promise.resolve(state.inFlight).catch(() => {}).then(() => loading.destroy()).catch(() => {})
    }
  }

  /** The whole embed becomes a plain chip if the document cannot be shown —
   *  the same chip any other unviewable file in a note gets. */
  const fail = (why) => {
    if (state.dead) return
    const chip = fileChip(spec)
    chip.title = why
    box.replaceWith(chip)
    box.embedDestroy()
    onReady()
  }

  /* Layout cannot start until the element is in the page with a real width —
     which, inside an editor widget, is strictly after this function returns.
     A ResizeObserver is the one thing that fires on that moment. It keeps
     watching afterwards, because the column can be widened under a document
     that is already drawn — turning readable line length off does exactly
     that — and pages fitted to the old width would be stretched to the new
     one. */
  state.sizer = new ResizeObserver(() => {
    if (state.dead || !pages.clientWidth) return
    if (!state.doc) {
      if (state.opening) return
      state.opening = true
      open().catch((err) => fail(err?.message || 'That PDF could not be read.'))
      return
    }
    refit()
  })
  state.sizer.observe(pages)

  /**
   * Re-fit the pages to the box's current width.
   *
   * The wrappers take their new heights at once, so the aspect ratio is right
   * in the same frame the column changes — a canvas stretched into a stale
   * wrapper is the visible bug. What is already drawn is then queued for a
   * redraw at the new scale, which only sharpens it; nothing is cleared, so
   * the resize does not flash the paper blank.
   */
  function refit () {
    const width = pages.clientWidth
    if (!state.base || width === state.width) return
    state.width = width
    state.scale = Math.max(0.1, width / state.base.width)

    const fallback = state.base.height / state.base.width
    for (const wrap of /** @type {HTMLElement[]} */ ([...pages.children])) {
      const ratio = Number(wrap.dataset.ratio) || fallback
      wrap.style.height = `${Math.round(width * ratio)}px`
      if (wrap.firstChild && state.visible.has(wrap) && !state.queued.has(wrap)) {
        state.queued.add(wrap)
        state.queue.push({ wrap, n: Number(wrap.dataset.page) })
      }
    }
    pump()
  }

  async function open () {
    const [source, runtime] = await Promise.all([
      /** @type {any} */ (window).tulip.pdf.source(spec.path),
      import('./pdf.js')
    ])
    const pdfjs = await runtime.loadPdfjs()
    if (state.dead) return

    state.runtime = runtime
    const loading = pdfjs.getDocument({ url: source, ...runtime.PDF_DATA })
    const doc = await loading.promise
    if (state.dead) { loading.destroy().catch(() => {}); return }
    state.doc = doc
    state.loading = loading
    count.textContent = doc.numPages === 1 ? '1 page' : `${doc.numPages} pages`

    /* Fit to the box's width, sized from page 1 the way the tab viewer is; a
       page of a different shape corrects its own wrapper when it draws. */
    const first = await doc.getPage(1)
    if (state.dead) return
    const base = first.getViewport({ scale: 1 })
    state.base = base
    state.width = pages.clientWidth
    const scale = state.scale = Math.max(0.1, state.width / base.width)

    const wraps = []
    for (let n = 1; n <= doc.numPages; n++) {
      const wrap = document.createElement('div')
      wrap.className = 'embed-pdf-page'
      wrap.dataset.page = String(n)
      wrap.style.height = `${Math.round(base.height * scale)}px`
      wraps.push(wrap)
    }
    pages.replaceChildren(...wraps)

    /* Pages draw as they are scrolled to, nearest first. The box is the scroll
       root, so a PDF far down the note costs nothing until it is looked at. */
    state.watcher = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const wrap = /** @type {HTMLElement} */ (entry.target)
        if (entry.isIntersecting) {
          state.visible.add(wrap)
          if (!wrap.firstChild && !state.queued.has(wrap)) {
            state.queued.add(wrap)
            state.queue.push({ wrap, n: Number(wrap.dataset.page) })
          }
        } else {
          state.visible.delete(wrap)
          state.queued.delete(wrap)
          clearPage(wrap)
        }
      }
      pump()
    }, { root: pages, rootMargin: '200% 0px' })
    for (const wrap of wraps) state.watcher.observe(wrap)

    // The note said which page to show first.
    if (spec.page && spec.page > 1 && spec.page <= wraps.length) {
      pages.scrollTop = wraps[spec.page - 1].offsetTop - 4
    }
    onReady()
  }

  async function pump () {
    if (state.drawing || state.dead) return
    let job = state.queue.shift()
    while (job && !state.visible.has(job.wrap)) {
      state.queued.delete(job.wrap)
      job = state.queue.shift()
    }
    if (!job) return
    state.queued.delete(job.wrap)
    state.drawing = true
    state.inFlight = draw(job).catch(() => {})
    await state.inFlight
    state.drawing = false
    pump()
  }

  async function draw ({ wrap, n }) {
    if (state.dead || !state.doc || !state.visible.has(wrap)) return
    const page = await state.doc.getPage(n)
    if (state.dead || !state.visible.has(wrap)) return

    /* The scale is read here rather than carried in the job, so a page that
       was queued before a resize is drawn at the width it will be shown at. */
    const scale = state.scale
    // This page's true shape, now that it is known — kept on the element so a
    // later resize can size the wrapper without re-reading the document.
    const shape = page.getViewport({ scale })
    wrap.dataset.ratio = String(shape.height / shape.width)
    wrap.style.height = `${Math.round(shape.height)}px`

    // The viewer's own render, so the resolution and the canvas ceiling are one
    // rule rather than two — the copy this had made did not carry the ceiling.
    const { canvas } = await state.runtime.renderPageToCanvas(page, scale)
    if (state.dead || !state.visible.has(wrap)) {
      releaseCanvas(canvas)
      return
    }

    wrap.replaceChildren(canvas)
    wrap.classList.add('is-drawn')
    /* The box was re-fitted while this page was rendering: what just landed is
       the old width's picture, so ask for it again at the new one. */
    if (state.scale !== scale && !state.queued.has(wrap)) {
      wrap.style.height = `${Math.round(state.width * Number(wrap.dataset.ratio))}px`
      state.queued.add(wrap)
      state.queue.push({ wrap, n })
    }
    onReady()
  }

  return box
}
