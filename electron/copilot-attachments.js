const fs = require('node:fs/promises')
const { decodeText } = require('./text-encoding.js')

/** Decode a small attachment exactly as the editor does. The caller supplies
 * its vault resolver so symlinks and vault boundaries retain the same checks. */
async function readInlineAttachment (file, resolve, limit) {
  const abs = await resolve(file)
  const stat = await fs.stat(abs)
  if (!stat.isFile() || stat.size > limit) return null
  const bytes = await fs.readFile(abs)
  if (bytes.length > limit) return null
  const decoded = decodeText(bytes)
  if (!decoded.clean) return null
  return { path: file, text: decoded.text, bytes: bytes.length }
}

module.exports = { readInlineAttachment }
