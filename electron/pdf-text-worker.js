// @ts-check
'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const run = promisify(execFile)

async function recognize (ocr, pdf, pages) {
  if (!ocr || !pages.length) return []
  try {
    await fs.access(ocr)
    const { stdout } = await run(ocr, [pdf, pages.join(',')], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 8 * 60 * 1000
    })
    const parsed = JSON.parse(stdout)
    return Array.isArray(parsed?.pages) ? parsed.pages : []
  } catch (err) {
    /* Selectable text is still useful when OCR fails or is unavailable. Main
       gets the ordinary sidecar rather than losing the whole document. */
    process.stderr.write(`PDF OCR failed: ${err?.message || err}\n`)
    return []
  }
}

/* A utility process has its own event loop and heap, so parsing a long PDF
   cannot stall the Electron main process that owns the window and IPC. */
process.parentPort.on('message', async ({ data }) => {
  const { pdf, extractor, fonts, cmaps, wasm, name, ocr } = data || {}
  try {
    const { extract, formatPdfText, mergeOcrPages } = require(extractor)
    const bytes = new Uint8Array(await fs.readFile(pdf))
    const extracted = await extract(bytes, {
      name: name || path.basename(pdf),
      fonts,
      cmaps,
      wasm
    })
    const recognized = await recognize(ocr, pdf, extracted.sparsePages)
    const merged = mergeOcrPages(extracted.pageTexts, recognized)
    process.parentPort.postMessage({
      text: formatPdfText(name || path.basename(pdf), merged.pages, {
        ocrPages: merged.ocrPages
      }),
      pages: extracted.pages,
      ocrPages: merged.ocrPages
    })
  } catch (err) {
    process.parentPort.postMessage({
      error: err?.stack || err?.message || String(err)
    })
  }
})
