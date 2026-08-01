/**
 * A PDF's words, without a window.
 *
 * The odd one out in `src/`: this runs in the *main* process, not the page. It
 * is here rather than in `electron/` because it is the only file in the app
 * that both needs pdf.js and cannot have it — the packaged bundle carries no
 * node_modules (see scripts/build-app.sh), so it is compiled into
 * `dist/pdf-text.cjs` alongside the renderer and required from there.
 *
 * The legacy build is the one that runs outside a browser. Nothing here draws:
 * a page is asked for its text and then dropped, so no canvas is ever made and
 * the parse is a second of CPU on a thread that is not painting anything.
 */

/* pdf.js expects the two classes a browser would have given it. Outside one it
   borrows them from `@napi-rs/canvas` — a native module, installed here as one
   of its optional dependencies and absent from the packaged app, which ships no
   node_modules at all. So they are stubbed instead. Constructible is the whole
   requirement: the canvas code holds one at module scope, and everything that
   would *call* a method on either belongs to rendering, which this file never
   reaches. A stack coming back through one of these means the extraction asked
   pdf.js to draw, and the bug is here.

   Declared before pdf.js loads, which is why the import below is dynamic: a
   static one is hoisted above this and the library would evaluate first. */
if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class DOMMatrix {}
if (!globalThis.Path2D) globalThis.Path2D = class Path2D {}

/* Roughly a short paragraph per page. Under this the document is images of
   text rather than text — a scan, or a deck of screenshots — and what pdf.js
   returns is the handful of stray characters its fonts happen to spell. Saying
   so is worth more than handing back a page of nothing: a copilot given an
   empty file reports an empty paper, and the reader is left arguing with it. */
const TEXT_PER_PAGE = 100

/**
 * @param {Uint8Array} bytes  the PDF itself
 * @param {object} [opts]
 * @param {string} [opts.name]   what to call it at the top of the file
 * @param {string} [opts.fonts]  `dist/pdfjs/standard_fonts/`, for documents that
 *   name a standard font rather than embedding one — without it their glyphs
 *   have no character codes to come back as.
 * @returns {Promise<{ text: string, pages: number, scanned: boolean }>}
 */
export async function extract (bytes, { name = 'document.pdf', fonts } = {}) {
  /* pdf.js parses in a worker, and out of a browser it makes a fake one by
     importing its worker file by path — which a bundle does not have, and the
     packaged app has nowhere to put. `globalThis.pdfjsWorker` is the door it
     checks first: hand it the module and it never looks for the file. Both are
     compiled into this one, so parsing happens on this thread. That is the
     right thread anyway — main is not painting, and a document is a second. */
  const [pdfjs, pdfjsWorker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs')
  ])
  globalThis.pdfjsWorker ||= pdfjsWorker

  const loading = pdfjs.getDocument({
    data: bytes,
    standardFontDataUrl: fonts,
    // No `eval`, and nothing fetched: this parses files the user did not write,
    // in the process that has the filesystem.
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true
  })
  const doc = await loading.promise

  const pages = []
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      try {
        const content = await page.getTextContent()
        /* pdf.js hands back positioned runs rather than lines. `hasEOL` is
           where it believes one ended, and that is the only line structure a
           PDF has to give — the rest is coordinates. */
        pages.push(content.items
          .map((item) => (item.str || '') + (item.hasEOL ? '\n' : ''))
          .join('')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim())
      } finally {
        page.cleanup()
      }
    }
  } finally {
    // The loading task rather than the document: destroying it takes the
    // document, its worker and the buffer with it, and a document proxy has no
    // `destroy` of its own to call.
    await loading.destroy()
  }

  const total = pages.reduce((sum, page) => sum + page.length, 0)
  const header = `${name} — ${pages.length} page${pages.length === 1 ? '' : 's'}, text extracted by Tulip.`

  if (total < TEXT_PER_PAGE * pages.length) {
    return {
      pages: pages.length,
      scanned: true,
      text: `${header}\n\nThis PDF carries no selectable text: it is a scan, or pages of \
images, and only the app's reader can show it. There is nothing below to quote.\n`
    }
  }

  return {
    pages: pages.length,
    scanned: false,
    text: `${header}\n\n${pages
      .map((page, i) => `--- page ${i + 1} of ${pages.length} ---\n\n${page}\n`)
      .join('\n')}`
  }
}
