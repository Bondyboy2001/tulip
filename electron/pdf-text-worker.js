'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

/* A utility process has its own event loop and heap, so parsing a long PDF
   cannot stall the Electron main process that owns the window and IPC. */
process.parentPort.on('message', async ({ data }) => {
  const { pdf, extractor, fonts, name } = data || {}
  try {
    const { extract } = require(extractor)
    const bytes = new Uint8Array(await fs.readFile(pdf))
    const { text } = await extract(bytes, {
      name: name || path.basename(pdf),
      fonts
    })
    process.parentPort.postMessage({ text })
  } catch (err) {
    process.parentPort.postMessage({
      error: err?.stack || err?.message || String(err)
    })
  }
})
