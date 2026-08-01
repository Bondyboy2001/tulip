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

import { loadPdfjs, PDF_DATA, renderPageToCanvas } from './pdf.js'

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

  const state = {
    dead: false,
    doc: null,
    watcher: null,   // the IntersectionObserver over page wrappers
    sizer: null,     // the ResizeObserver waiting for the box to have a width
    drawing: false,
    queue: [],
    queued: new Set(),
    visible: new Set()
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
    const doc = state.doc
    state.doc = null
    // After the render in flight settles; destroying under one wedges pdf.js.
    if (doc) Promise.resolve(state.inFlight).catch(() => {}).then(() => doc.destroy()).catch(() => {})
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
     A ResizeObserver is the one thing that fires on that moment. */
  state.sizer = new ResizeObserver(() => {
    if (state.dead || !pages.clientWidth) return
    state.sizer.disconnect()
    state.sizer = null
    open().catch((err) => fail(err?.message || 'That PDF could not be read.'))
  })
  state.sizer.observe(pages)

  async function open () {
    const [source, pdfjs] = await Promise.all([
      window.tulip.pdf.source(spec.path),
      loadPdfjs()
    ])
    if (state.dead) return

    const doc = await pdfjs.getDocument({ url: source, ...PDF_DATA }).promise
    if (state.dead) { doc.destroy(); return }
    state.doc = doc
    count.textContent = doc.numPages === 1 ? '1 page' : `${doc.numPages} pages`

    /* Fit to the box's width, sized from page 1 the way the tab viewer is; a
       page of a different shape corrects its own wrapper when it draws. */
    const first = await doc.getPage(1)
    if (state.dead) return
    const base = first.getViewport({ scale: 1 })
    const scale = Math.max(0.1, pages.clientWidth / base.width)

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
        const wrap = entry.target
        if (entry.isIntersecting) {
          state.visible.add(wrap)
          if (!wrap.firstChild && !state.queued.has(wrap)) {
            state.queued.add(wrap)
            state.queue.push({ wrap, n: Number(wrap.dataset.page), scale })
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

  async function draw ({ wrap, n, scale }) {
    if (state.dead || !state.doc || !state.visible.has(wrap)) return
    const page = await state.doc.getPage(n)
    if (state.dead || !state.visible.has(wrap)) return

    // This page's true height, now that it is known.
    wrap.style.height = `${Math.round(page.getViewport({ scale }).height)}px`

    // The viewer's own render, so the resolution and the canvas ceiling are one
    // rule rather than two — the copy this had made did not carry the ceiling.
    const { canvas } = await renderPageToCanvas(page, scale)
    if (state.dead || !state.visible.has(wrap)) {
      releaseCanvas(canvas)
      return
    }

    wrap.replaceChildren(canvas)
    wrap.classList.add('is-drawn')
    onReady()
  }

  return box
}
