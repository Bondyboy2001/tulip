'use strict'

/* Manual end-to-end probe for the packaged extraction pieces:
 *   node scripts/verify-pdf-extraction.cjs /path/to/document.pdf
 * It does not write a sidecar; it reports what pdf.js and Vision recovered. */

const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const run = promisify(execFile)

async function main () {
  const pdf = process.argv[2]
  if (!pdf) throw new Error('Pass a PDF path.')
  const extractor = require('../dist/pdf-text.cjs')
  const bytes = new Uint8Array(await fs.readFile(pdf))
  const extracted = await extractor.extract(bytes, {
    name: path.basename(pdf),
    fonts: path.resolve('dist/pdfjs/standard_fonts') + path.sep,
    cmaps: path.resolve('dist/pdfjs/cmaps') + path.sep,
    wasm: path.resolve('dist/pdfjs/wasm') + path.sep
  })
  let recognized = []
  if (extracted.sparsePages.length) {
    const { stdout } = await run(path.resolve('dist/pdf-ocr'), [pdf, extracted.sparsePages.join(',')], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 8 * 60 * 1000
    })
    recognized = JSON.parse(stdout).pages || []
  }
  const merged = extractor.mergeOcrPages(extracted.pageTexts, recognized)
  const text = extractor.formatPdfText(path.basename(pdf), merged.pages, { ocrPages: merged.ocrPages })
  const layout = recognized.map((page) => {
    const lines = page.lines || []
    if (!lines.length) return { page: page.page, left: 0, right: 0, wide: 0 }
    const leftEdge = Math.min(...lines.map((line) => line.x))
    const rightEdge = Math.max(...lines.map((line) => line.x + line.width))
    const split = (leftEdge + rightEdge) / 2
    const gutter = (rightEdge - leftEdge) * 0.025
    return {
      page: page.page,
      left: lines.filter((line) => line.x + line.width <= split + gutter).length,
      right: lines.filter((line) => line.x >= split - gutter).length,
      wide: lines.filter((line) => line.x + line.width > split + gutter && line.x < split - gutter).length
    }
  })
  console.log(JSON.stringify({
    pages: extracted.pages,
    sparsePages: extracted.sparsePages,
    ocrPages: merged.ocrPages,
    layout,
    characters: text.length,
    preview: text.slice(0, 600)
  }, null, 2))
}

main().catch((err) => {
  console.error(err?.stack || err)
  process.exitCode = 1
})
