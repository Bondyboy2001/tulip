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

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  PDF_TEXT_FORMAT, formatPdfText, mergeOcrPages, sparsePages, textFromItems
} from './pdf-text-layout.js'

export { PDF_TEXT_FORMAT, formatPdfText, mergeOcrPages }

/* pdf.js's bundled Node factory discovers `fs` through process.getBuiltinModule,
   which is absent in Electron's utility-process shim. Give it the same narrow
   local reader directly so standard fonts and CJK maps do not fail silently. */
class LocalBinaryDataFactory {
  constructor (sources) { this.sources = sources }

  async fetch ({ kind, filename }) {
    const base = this.sources[kind]
    if (!base) throw new Error(`No local PDF data path for ${kind}.`)
    return new Uint8Array(await fs.readFile(path.join(base, filename)))
  }
}

/**
 * @param {Uint8Array} bytes  the PDF itself
 * @param {object} [opts]
 * @param {string} [opts.name]   what to call it at the top of the file
 * @param {string} [opts.fonts]  `dist/pdfjs/standard_fonts/`, for documents that
 *   name a standard font rather than embedding one — without it their glyphs
 *   have no character codes to come back as.
 * @returns {Promise<{ text: string, pageTexts: string[], pages: number, sparsePages: number[] }>}
 */
export async function extract (bytes, { name = 'document.pdf', fonts, cmaps, wasm } = {}) {
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
    cMapUrl: cmaps,
    cMapPacked: true,
    wasmUrl: wasm,
    BinaryDataFactory: LocalBinaryDataFactory,
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
        pages.push(textFromItems(content.items))
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

  return {
    pages: pages.length,
    pageTexts: pages,
    sparsePages: sparsePages(pages),
    text: formatPdfText(name, pages)
  }
}
