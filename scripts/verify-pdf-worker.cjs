'use strict'

/* Manual probe for the exact Electron utility-process boundary used by main:
 *   electron scripts/verify-pdf-worker.cjs /path/to/document.pdf
 * It prints a summary and never writes a vault sidecar. */

const path = require('node:path')
const { app, utilityProcess } = require('electron')

const pdf = process.argv[2]
if (!pdf) throw new Error('Pass a PDF path.')

app.whenReady().then(() => {
  const child = utilityProcess.fork(path.resolve('electron/pdf-text-worker.js'), [], {
    serviceName: 'Tulip PDF verification'
  })
  const timer = setTimeout(() => {
    console.error('worker timed out')
    child.kill()
    app.exit(1)
  }, 10 * 60 * 1000)
  child.on('message', (message) => {
    clearTimeout(timer)
    if (message.error) {
      console.error(message.error)
      app.exit(1)
      return
    }
    console.log(JSON.stringify({
      pages: message.pages,
      ocrPages: message.ocrPages,
      characters: message.text?.length || 0,
      preview: message.text?.slice(0, 500) || ''
    }, null, 2))
    child.kill()
    app.quit()
  })
  child.on('exit', (code) => {
    if (code && app.isReady()) app.exit(code)
  })
  child.on('spawn', () => child.postMessage({
    pdf: path.resolve(pdf),
    name: path.basename(pdf),
    extractor: path.resolve('dist/pdf-text.cjs'),
    ocr: path.resolve('dist/pdf-ocr'),
    fonts: path.resolve('dist/pdfjs/standard_fonts') + path.sep,
    cmaps: path.resolve('dist/pdfjs/cmaps') + path.sep,
    wasm: path.resolve('dist/pdfjs/wasm') + path.sep
  }))
})
