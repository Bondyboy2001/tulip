'use strict'

const fs = require('node:fs')
const { Readable } = require('node:stream')

function parseByteRange (header, size, maxLength = 8 * 1024 * 1024) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!match) return null
  if (!match[1] && !match[2]) return null
  let start = 0
  let end = Math.max(0, size - 1)
  if (match[1]) start = Number(match[1])
  if (match[2]) end = Number(match[2])
  if (!match[1] && match[2]) {
    const suffix = Number(match[2])
    start = Math.max(0, size - suffix)
    end = Math.max(0, size - 1)
  }
  end = Math.min(end, Math.max(0, size - 1), start + maxLength - 1)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null
  return { start, end }
}

function streamFileRange (file, start, end, signal) {
  const source = fs.createReadStream(file, { start, end, highWaterMark: 64 * 1024 })
  const abort = () => source.destroy()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  source.once('close', () => signal?.removeEventListener('abort', abort))
  return Readable.toWeb(source)
}

module.exports = { parseByteRange, streamFileRange }
